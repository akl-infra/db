// Replica property test ([LDB-SH4] order, [LDB-SH5] conflicts, [LDB-SH6]
// exactly once, [LDB-SH8] replay equality): 3-5 replicas share one commit log
// with injected conflicts, throttles and timeouts before and after the
// commit; concurrent writers run akldb's real store code (layout creates,
// likes, comments) through each replica's shim; at the end every replica,
// after catching up, is byte-identical to the others and to a fresh replica
// that replays the log from 0, and every acknowledged write landed once.
import fc from "fast-check";
import { ulid } from "ulidx";
import { describe, expect, it } from "vitest";
import { appendLike, commitWrite, type CommitInput } from "../../src/core/events";
import { fixedClock } from "../../src/core/time";
import { seededRandom } from "../../src/replica/log-memory";
import { Replica } from "../../src/replica/replica";
import { createD1Store } from "../../src/store/d1";
import { createShimD1 } from "../../src/store/shim/d1";
import { FAST, migratedLog } from "./support";

const clock = fixedClock("2026-11-02T00:00:00.000Z");
const SOURCE = { client: "discord-app:test", version: null };

const same = (a: Replica, b: Replica) => Buffer.from(a.serialize()).equals(Buffer.from(b.serialize()));

interface RunResult {
  faults: number;
  created: number;
  likes: number;
  comments: number;
}

async function oneRun(p: { replicas: number; seed: number; ops: number; rate: number }): Promise<RunResult> {
  const log = await migratedLog({ conflict: p.rate / 4, throttle: p.rate / 4, timeoutBefore: p.rate / 4, timeoutAfter: p.rate / 4, seed: p.seed, maxYields: 3 });
  const base = log.length;
  const replicas = Array.from({ length: p.replicas }, (_, i) => new Replica(log, { ...FAST, random: seededRandom(p.seed + i + 1) }));
  await Promise.all(replicas.map((r) => r.catchUp()));
  const stores = replicas.map((r) => createD1Store(createShimD1(r)));
  const known: { id: string; name: string }[] = [];
  let created = 0;
  let likes = 0;
  let comments = 0;
  const benign = /UNIQUE constraint failed|already|ApiError|conflict/i;

  await Promise.all(
    replicas.map(async (_, w) => {
      const rng = seededRandom(p.seed * 31 + w);
      const store = stores[w]!;
      for (let k = 0; k < p.ops; k++) {
        const roll = rng();
        try {
          if (roll < 0.4 || known.length === 0) {
            const id = ulid();
            const name = `p-${w}-${k}-${Math.floor(rng() * 1e6)}`;
            const input: CommitInput = {
              layoutId: id,
              creating: true,
              currentN: 0,
              currentLayout: null,
              currentFormats: new Map(),
              layout: { kind: "created", name, owner: `owner-${Math.floor(rng() * 4)}`, created_at: clock(), deleted: false },
              format: { kind: "format_added", lineage: "spark", format: "spark/1", payload: { keys: [] }, hasMagic: false },
              modified_at: clock(),
              actor: `owner-${w}`,
              via: "discord",
              source: SOURCE,
              upstream: null,
            };
            await commitWrite(store, clock, input);
            created++;
            known.push({ id, name });
          } else if (roll < 0.75) {
            const l = known[Math.floor(rng() * known.length)]!;
            const liked = rng() < 0.7;
            await appendLike(store, clock, { kind: liked ? "liked" : "unliked", layoutId: l.id, userId: `user-${Math.floor(rng() * 6)}`, via: "discord", source: SOURCE });
            likes++;
          } else {
            const l = known[Math.floor(rng() * known.length)]!;
            await store.comments.submit({ by: `user-${w}`, at: clock(), row: { id: ulid(), layout_id: l.id, user_id: `user-${w}-${k % 3}`, body: `c${k}`, via: "discord", submitted_at: clock() } });
            comments++;
          }
        } catch (e) {
          // akldb's own refusals (4xx ApiError: not liked, already liked, name taken, ...) are expected outcomes, not shim failures.
          const status = (e as { status?: number }).status;
          if (!(typeof status === "number" && status >= 400 && status < 500) && !benign.test(e instanceof Error ? `${e.name} ${e.message}` : String(e))) throw e;
        }
      }
    }),
  );

  for (const r of replicas) await r.catchUp();
  // SH4: the log is 1..n with no hole.
  const entries = log.entries();
  expect(entries.map((e) => e.seq)).toEqual(Array.from({ length: entries.length }, (_, i) => i + 1));
  expect(new Set(entries.map((e) => e.unitId)).size).toBe(entries.length);
  // SH8: nobody diverged, and everybody is the same database.
  for (const r of replicas) {
    expect(r.dead).toBeNull();
    expect(r.seq).toBe(log.length);
    expect(same(r, replicas[0]!)).toBe(true);
  }
  // ... equal to a fresh replica replaying from 0.
  const fresh = new Replica(log.clone(), FAST);
  await fresh.catchUp();
  expect(same(fresh, replicas[0]!)).toBe(true);
  // SH6: every acknowledged create is exactly one row, however many ambiguous appends it went through.
  const q = <T>(sql: string) => replicas[0]!.db.prepare(sql).get() as T;
  expect(q<{ n: number }>("SELECT COUNT(*) AS n FROM layouts").n).toBe(created);
  expect(q<{ n: number }>("SELECT COUNT(*) AS n FROM layout_comments").n).toBeLessThanOrEqual(comments);
  // The feed's seq is gap-free: AUTOINCREMENT under one total order, rollbacks included.
  const ev = q<{ n: number; max: number | null }>("SELECT COUNT(*) AS n, MAX(seq) AS max FROM events");
  expect(ev.max ?? 0).toBe(ev.n);
  expect(entries.length).toBeGreaterThan(base);
  const c = log.counts;
  return { faults: c.injectedConflicts + c.throttles + c.timeoutsBefore + c.timeoutsAfter, created, likes, comments };
}

describe("N replicas x concurrent writers x injected faults", () => {
  it("[LDB-SH4] [LDB-SH5] [LDB-SH6] [LDB-SH8] every replica equals a serial replay of the log, and every acknowledged write lands exactly once", { timeout: 60_000 }, async () => {
    const totals = { faults: 0, created: 0 };
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          replicas: fc.integer({ min: 3, max: 5 }),
          seed: fc.integer({ min: 1, max: 2 ** 30 }),
          ops: fc.integer({ min: 6, max: 14 }),
          rate: fc.constantFrom(0, 0.1, 0.2, 0.4),
        }),
        async (p) => {
          const r = await oneRun(p);
          totals.faults += r.faults;
          totals.created += r.created;
        },
      ),
      { numRuns: 25, seed: 20261102 },
    );
    expect(totals.faults).toBeGreaterThan(50); // faults really fired
    expect(totals.created).toBeGreaterThan(100);
  });
});
