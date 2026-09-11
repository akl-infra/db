// [LDB-P6] `/v1/changes`'s backing function: seq order, `since` exclusive,
// `next` = last seq returned, `limit` capped at 1000, `kinds` filters.
import { env } from "cloudflare:test";
import type { Bindings } from "../../src/env";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { canonical } from "../../src/core/canonical";
import { headSeq } from "../../src/core/etag";
import { appendAdmin, appendInfo, appendLike, commitWrite, feed, type CommitInput, type EventSnapshot } from "../../src/core/events";
import { formatsForLayout, readById } from "../../src/core/records";
import { fixedClock, steppingClock } from "../../src/core/time";
import { drain, type WebhookFetchImpl } from "../../src/core/webhooks";
import { ulid } from "ulidx";

const db = (env as unknown as Bindings).DB;
const bindings = env as unknown as Bindings;
const SOURCE = { client: "discord-app:test", version: null };

function create(clock: () => string, name: string, owner = "owner-a") {
  const input: CommitInput = {
    layoutId: ulid(),
    creating: true,
    currentN: 0,
    currentLayout: null,
    currentFormats: new Map(),
    layout: { kind: "created", name, owner, created_at: clock(), deleted: false },
    format: { kind: "format_added", lineage: "spark", format: "spark/1", payload: {}, hasMagic: false },
    modified_at: clock(),
    actor: "tester",
    via: "discord",
    source: SOURCE,
    upstream: null,
  };
  return commitWrite(db, clock, input);
}

// Seeds N bare informational-shaped event rows directly (bypassing
// appendInfo's per-row round trip) so the 1000-row cap is exercised without
// 1000+ awaited D1 calls; chunked at <=100 statements/batch.
async function seedBareEvents(n: number, kind: string): Promise<void> {
  const stmts = [];
  for (let i = 0; i < n; i++) {
    stmts.push(
      db
        .prepare(
          `INSERT INTO events (at, kind, layout_id, name, owner, format, rev, actor, via, admin)
           VALUES (?, ?, NULL, NULL, NULL, NULL, NULL, 'system:cmini-import', 'import:cmini', 0)`,
        )
        .bind(`2026-03-01T00:00:${String(i % 60).padStart(2, "0")}.${String(i).padStart(3, "0")}Z`, kind),
    );
  }
  for (let i = 0; i < stmts.length; i += 100) {
    await db.batch(stmts.slice(i, i + 100));
  }
}

describe("feed", () => {
  it("[LDB-P6] returns everything in seq order from since=0", async () => {
    const clock = fixedClock("2026-03-02T00:00:00.000Z");
    const a = await create(clock, "feed-a");
    const b = await create(clock, "feed-b");

    const { items, next } = await feed(db, 0, 1000);
    expect(items.map((e) => e.seq)).toEqual([...items.map((e) => e.seq)].sort((x, y) => x - y));
    const seqs = items.map((e) => e.seq);
    expect(seqs).toContain(a.seqs[0]);
    expect(seqs).toContain(b.seqs[0]);
    expect(next).toBe(items[items.length - 1]!.seq);
  });

  it("[LDB-P6] since is exclusive; next is the last seq returned; a cursor walk covers everything once", async () => {
    const clock = fixedClock("2026-03-03T00:00:00.000Z");
    for (let i = 0; i < 5; i++) {
      await create(clock, `feed-walk-${i}-${Math.random()}`);
    }

    const all = await feed(db, 0, 1000);
    const first = await feed(db, 0, 2);
    expect(first.items.length).toBe(2);
    expect(first.next).toBe(first.items[1]!.seq);

    const second = await feed(db, first.next, 2);
    expect(second.items[0]!.seq).toBeGreaterThan(first.next); // exclusive

    let cursor = 0;
    const walked: number[] = [];
    for (;;) {
      const page = await feed(db, cursor, 2);
      if (page.items.length === 0) break;
      walked.push(...page.items.map((e) => e.seq));
      cursor = page.next;
    }
    expect(walked).toEqual(all.items.map((e) => e.seq));
  });

  it("[LDB-P6] limit is capped at 1000 even when more is requested", async () => {
    await seedBareEvents(1005, "upstream_changed");
    const { items } = await feed(db, 0, 100000);
    expect(items.length).toBe(1000);
  });

  it("[LDB-P6] kinds filters the feed", async () => {
    const clock = fixedClock("2026-03-04T00:00:00.000Z");
    const { layout } = await create(clock, `feed-kinds-${Math.random()}`);
    await appendInfo(db, clock, { kind: "upstream_changed", layoutId: layout.id, actor: "system:cmini-import", via: "import:cmini", source: { client: "system:cmini-import", version: null } });
    await appendLike(db, clock, { kind: "liked", layoutId: layout.id, userId: "u1", via: "discord", source: SOURCE });

    const { items } = await feed(db, 0, 1000, ["liked"]);
    expect(items.length).toBeGreaterThan(0);
    for (const e of items) expect(e.kind).toBe("liked");
  });

  it("[LDB-P6] admin events (NULL layout_id) round-trip through feed()/rowToEvent", async () => {
    const clock = fixedClock("2026-03-05T00:00:00.000Z");
    const { seq } = await appendAdmin(db, clock, { kind: "admin.added", actor: "admin-tester", detail: { user_id: "30000000000000099", note: "x" } });

    const { items } = await feed(db, seq - 1, 1);
    expect(items).toHaveLength(1);
    const e = items[0]!;
    expect(e.seq).toBe(seq);
    expect(e.kind).toBe("admin.added");
    expect(e.layout_id).toBeNull();
    expect(e.name).toBeNull();
    expect(e.owner).toBeNull();
    expect(e.format).toBeNull();
    expect(e.rev).toBeNull();
    expect(e.admin).toBe(true);
    expect(e.via).toBe("discord");
    expect(e.detail).toEqual({ user_id: "30000000000000099", note: "x" });
  });
});

// [LDB-P3]: "feed is truth" made literal -- a follower built ONLY from
// webhook deliveries, over a lossy/duplicating transport, must land on the
// exact same metadata projection as a follower that just folds
// `/v1/changes` from 0. `foldMetaByLayout` below is `core/events.ts`'s
// `foldLayout`, restricted to the LAYOUT scope only (format events are
// folded the same way MF-3's own test covers, and are irrelevant to this
// property, which is about whether the TRANSPORT loses information -- not
// about which scope an event names).
interface FoldableEvent {
  seq: number;
  kind: string;
  layout_id: string | null;
  format: string | null;
  rev: number | null;
  after: EventSnapshot | null;
}

function withLikeDelta(l: EventSnapshot, delta: 1 | -1): EventSnapshot {
  return l.scope === "layout" ? { ...l, like_count: l.like_count + delta } : l;
}

function foldMetaByLayout(events: FoldableEvent[]): Map<string, EventSnapshot> {
  const byLayout = new Map<string, FoldableEvent[]>();
  for (const e of events) {
    if (e.layout_id === null) continue;
    if (!byLayout.has(e.layout_id)) byLayout.set(e.layout_id, []);
    byLayout.get(e.layout_id)!.push(e);
  }
  const out = new Map<string, EventSnapshot>();
  for (const [layoutId, evs] of byLayout) {
    evs.sort((a, b) => a.seq - b.seq);
    let state: EventSnapshot | null = null;
    for (const e of evs) {
      if (e.rev !== null && e.format === null) {
        state = e.after; // this test only tracks the LAYOUT scope's own state
      } else if (state !== null && (e.kind === "liked" || e.kind === "unliked")) {
        state = withLikeDelta(state, e.kind === "liked" ? 1 : -1);
      }
    }
    if (state !== null) out.set(layoutId, state);
  }
  return out;
}

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("LDB-P3: a webhook-only follower matches a feed-only follower", () => {
  it(
    "[LDB-P3] a random write/like/admin sequence: replaying only webhook deliveries (30% dropped, deduped by seq) equals folding the feed",
    async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.array(fc.integer({ min: 0, max: 4 }), { minLength: 1, maxLength: 6 }),
          fc.integer({ min: 1, max: 2 ** 31 - 1 }),
          async (ops, seed) => {
            const rng = mulberry32(seed);
            const pick = <T>(arr: T[]): T => arr[Math.floor(rng() * arr.length)]!;

            const baseline = await headSeq(db);
            const writeClock = steppingClock("2026-04-01T00:00:00.000Z", 1000);
            const drainClock = steppingClock("2026-04-01T02:00:00.000Z", 2 * 3600 * 1000);

            await db.prepare("DELETE FROM webhooks").run();

            const hookId = ulid();
            const seedAt = "2026-04-01T00:00:00.000Z";
            await db
              .prepare(
                `INSERT INTO webhooks (id, owner_user_id, url, secret, kinds, owner_filter, status, cursor, failures, failing_since, next_at, last_error, created_at)
                 VALUES (?, 'p3-owner', 'https://p3.example/hook', 'p3-secret-1234567890ab', NULL, NULL, 'active', ?, 0, NULL, ?, NULL, ?)`,
              )
              .bind(hookId, baseline, seedAt, seedAt)
              .run();

            const liveIds: string[] = [];
            const meta = new Map<string, { name: string; owner: string; n: number }>();
            const ownIds = new Set<string>();
            let counter = 0;

            async function createOne(): Promise<void> {
              const name = `p3-${hookId}-${counter++}`;
              const { layout } = await create(writeClock, name, "p3-owner");
              liveIds.push(layout.id);
              meta.set(layout.id, { name, owner: "p3-owner", n: layout.n });
              ownIds.add(layout.id);
            }

            for (const opRaw of ops) {
              const op = liveIds.length === 0 ? 0 : opRaw % 5;
              if (op === 0) {
                await createOne();
              } else if (op === 1) {
                // A FORMAT-scope write -- deliberately excluded from
                // `meta`/the layout-scope fold: it never touches
                // `layout_rev`, so it must never appear as a bump in
                // `foldMetaByLayout`'s tracked state either.
                const id = pick(liveIds);
                const layout = (await readById(db, id))!;
                const formats = await formatsForLayout(db, id);
                await commitWrite(db, writeClock, {
                  layoutId: id,
                  creating: false,
                  currentN: layout.n,
                  currentLayout: layout,
                  currentFormats: formats,
                  format: { kind: "updated", lineage: "spark", format: "spark/1", payload: { touched: counter++ }, hasMagic: false },
                  modified_at: writeClock(),
                  actor: "p3-owner",
                  via: "discord",
                  source: SOURCE,
                  upstream: layout.upstream,
                });
              } else if (op === 2) {
                const id = pick(liveIds);
                const m = meta.get(id)!;
                const layout = (await readById(db, id))!;
                const formats = await formatsForLayout(db, id);
                await commitWrite(db, writeClock, {
                  layoutId: id,
                  creating: false,
                  currentN: layout.n,
                  currentLayout: layout,
                  currentFormats: formats,
                  layout: { kind: "deleted", name: m.name, owner: m.owner, created_at: layout.created_at, deleted: true },
                  modified_at: writeClock(),
                  actor: "p3-owner",
                  via: "discord",
                  source: SOURCE,
                  upstream: layout.upstream,
                });
                liveIds.splice(liveIds.indexOf(id), 1);
                meta.delete(id);
              } else if (op === 3) {
                const id = pick(liveIds);
                await appendLike(db, writeClock, { kind: "liked", layoutId: id, userId: "p3-liker", via: "discord", source: SOURCE });
              } else {
                await appendAdmin(db, writeClock, { kind: "admin.added", actor: "p3-admin", detail: { user_id: `p3-${counter++}` } });
              }
            }

            const delivered = new Map<number, FoldableEvent>();
            const fakeFetch: WebhookFetchImpl = async (_url, init) => {
              const body = JSON.parse(init.body) as FoldableEvent;
              if (rng() < 0.3) return new Response(null, { status: 500 });
              delivered.set(body.seq, body);
              return new Response(null, { status: 200 });
            };

            const head = await headSeq(db);
            let iterations = 0;
            for (;;) {
              await drain(bindings, drainClock, { fetchImpl: fakeFetch, maxPosts: 50 });
              const row = await db.prepare("SELECT cursor FROM webhooks WHERE id = ?").bind(hookId).first<{ cursor: number }>();
              if (row!.cursor >= head) break;
              iterations++;
              if (iterations > 60) throw new Error("LDB-P3 property: drain loop did not converge within 60 attempts");
            }

            const { items: allEvents } = await feed(db, baseline, 1000);
            const ownEvents = allEvents.filter((e) => e.layout_id !== null && ownIds.has(e.layout_id));
            const ownDelivered = [...delivered.values()].filter((e) => e.layout_id !== null && ownIds.has(e.layout_id));
            const followerA = foldMetaByLayout(ownEvents);
            const followerB = foldMetaByLayout(ownDelivered.sort((a, b) => a.seq - b.seq));

            expect(followerA.size).toBe(ownIds.size);
            expect(new Set(followerB.keys())).toEqual(new Set(followerA.keys()));
            for (const [layoutId, stateA] of followerA) {
              expect(canonical(followerB.get(layoutId))).toBe(canonical(stateA));
            }
          },
        ),
        { numRuns: 20 },
      );
    },
  );
});
