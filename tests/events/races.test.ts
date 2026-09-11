// The concurrency guard lives INSIDE the write batch, not in the pre-checks
// (21-formats.md §2.2): `layouts_name_live` refuses a second create on a
// live name, `layout_revs (layout_id, n)`'s PK refuses a second write at
// the same `n` (whatever its scope), and a lost batch rolls back whole --
// no event, no orphaned rev row, `seq` still gapless. These tests drive the
// races with Promise.all so both pre-checks pass before either batch runs.
import { env } from "cloudflare:test";
import type { Bindings } from "../../src/env";
import { describe, expect, it } from "vitest";
import { ApiError } from "../../src/core/errors";
import { RevConflictError, appendLike, commitWrite, type CommitInput } from "../../src/core/events";
import { formatsForLayout, readById } from "../../src/core/records";
import { fixedClock } from "../../src/core/time";
import { ulid } from "ulidx";

const db = (env as unknown as Bindings).DB;
const clock = fixedClock("2026-05-02T00:00:00.000Z");
const SOURCE = { client: "discord-app:test", version: null };

function create(name: string, owner = "owner-a") {
  const input: CommitInput = {
    layoutId: ulid(),
    creating: true,
    currentN: 0,
    currentLayout: null,
    currentFormats: new Map(),
    layout: { kind: "created", name, owner, created_at: clock(), deleted: false },
    format: { kind: "format_added", lineage: "spark", format: "spark/1", payload: { keys: {} }, hasMagic: false },
    modified_at: clock(),
    actor: owner,
    via: "discord",
    source: SOURCE,
    upstream: null,
  };
  return commitWrite(db, clock, input);
}

async function invariantsHold() {
  const seqs = (await db.prepare("SELECT seq FROM events ORDER BY seq").all<{ seq: number }>()).results.map((r) => r.seq);
  expect(seqs).toEqual(seqs.map((_, i) => i + 1));
  const orphanRevs = await db.prepare("SELECT COUNT(*) AS n FROM layout_revs r LEFT JOIN layouts l ON l.id = r.layout_id WHERE l.id IS NULL").first<{ n: number }>();
  expect(orphanRevs?.n).toBe(0);
  const revsPerWrite = await db.prepare("SELECT COUNT(*) AS n FROM events WHERE rev IS NOT NULL").first<{ n: number }>();
  const revRows = await db.prepare("SELECT COUNT(*) AS n FROM layout_revs").first<{ n: number }>();
  expect(revRows?.n).toBe(revsPerWrite?.n);
}

describe("races resolved inside the batch", () => {
  it("[LDB-P4] two creates racing on one name: exactly one wins, the loser is name_taken, nothing is orphaned", async () => {
    const outcomes = await Promise.allSettled([create("race-name"), create("race-name", "owner-b")]);
    const won = outcomes.filter((o) => o.status === "fulfilled");
    const lost = outcomes.filter((o) => o.status === "rejected");
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);
    const err = (lost[0] as PromiseRejectedResult).reason;
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).body.error).toBe("name_taken");

    const live = await db.prepare("SELECT COUNT(*) AS n FROM layouts WHERE name = ? AND deleted = 0").bind("race-name").first<{ n: number }>();
    expect(live?.n).toBe(1);
    const winner = (won[0] as PromiseFulfilledResult<Awaited<ReturnType<typeof create>>>).value.layout;
    expect(await readById(db, winner.id)).toMatchObject({ id: winner.id, name: "race-name", layout_rev: 1 });
    await invariantsHold();
  });

  it("[MF-6] [LDB-P20] two updates to the SAME format racing from the same rev: exactly one wins, the loser is a RevConflictError, that format's rev advances once", async () => {
    const { layout } = await create("race-rev");
    const update = async (v: number) => {
      const current = (await readById(db, layout.id))!;
      const formats = await formatsForLayout(db, layout.id);
      const input: CommitInput = {
        layoutId: layout.id,
        creating: false,
        currentN: current.n,
        currentLayout: current,
        currentFormats: formats,
        format: { kind: "updated", lineage: "spark", format: "spark/1", payload: { keys: {}, magic: { notes: `v${v}` } }, hasMagic: false },
        modified_at: clock(),
        actor: layout.owner,
        via: "discord",
        source: SOURCE,
        upstream: current.upstream,
      };
      return commitWrite(db, clock, input);
    };
    const outcomes = await Promise.allSettled([update(2), update(3)]);
    const won = outcomes.filter((o) => o.status === "fulfilled");
    const lost = outcomes.filter((o) => o.status === "rejected");
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);
    expect((lost[0] as PromiseRejectedResult).reason).toBeInstanceOf(RevConflictError);
    const formats = await formatsForLayout(db, layout.id);
    expect(formats.get("spark")!.rev).toBe(2);
    const winnerPayload = (won[0] as PromiseFulfilledResult<Awaited<ReturnType<typeof update>>>).value.formats.get("spark")!.payload;
    expect(formats.get("spark")!.payload).toEqual(winnerPayload);
    await invariantsHold();
  });

  // [MF-6] "writers on different scopes both land": a layout-scope rename
  // and a format-scope replace, fired concurrently on the same layout, must
  // BOTH commit -- the `n` counter serializes them (one gets n+1, the other
  // n+2) rather than either refusing the other.
  it("[MF-6] [LDB-P20] a rename and a format replace racing on one layout both land", async () => {
    const { layout } = await create("race-cross-scope");

    const rename = async () => {
      const current = (await readById(db, layout.id))!;
      const formats = await formatsForLayout(db, layout.id);
      const input: CommitInput = {
        layoutId: layout.id,
        creating: false,
        currentN: current.n,
        currentLayout: current,
        currentFormats: formats,
        layout: { kind: "renamed", name: "race-cross-scope-renamed", owner: current.owner, created_at: current.created_at, deleted: false },
        modified_at: clock(),
        actor: layout.owner,
        via: "discord",
        source: SOURCE,
        upstream: current.upstream,
      };
      return commitWrite(db, clock, input);
    };
    const replace = async () => {
      const current = (await readById(db, layout.id))!;
      const formats = await formatsForLayout(db, layout.id);
      const input: CommitInput = {
        layoutId: layout.id,
        creating: false,
        currentN: current.n,
        currentLayout: current,
        currentFormats: formats,
        format: { kind: "updated", lineage: "spark", format: "spark/1", payload: { keys: {}, magic: { notes: "x" } }, hasMagic: false },
        modified_at: clock(),
        actor: layout.owner,
        via: "discord",
        source: SOURCE,
        upstream: current.upstream,
      };
      return commitWrite(db, clock, input);
    };

    // Retry-on-collision wrapper, mirroring `core/write.ts`'s own: a race
    // on `n` (not on either write's OWN scope) is retried, never surfaced.
    async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
      for (let i = 0; i < 5; i++) {
        try {
          return await fn();
        } catch (e) {
          if (e instanceof RevConflictError && i < 4) continue;
          throw e;
        }
      }
      throw new Error("unreachable");
    }

    const [renameResult, replaceResult] = await Promise.all([withRetry(rename), withRetry(replace)]);
    expect(renameResult.layout.layout_rev).toBe(2);
    expect(replaceResult.formats.get("spark")!.rev).toBe(2);
    const final = await readById(db, layout.id);
    expect(final!.name).toBe("race-cross-scope-renamed");
    const finalFormats = await formatsForLayout(db, layout.id);
    expect(finalFormats.get("spark")!.rev).toBe(2);
    await invariantsHold();
  });

  it("[LDB-P1] five users liking at once: like_count is 5 and five events exist; the same user twice at once is one like, one event", async () => {
    const { layout } = await create("race-likes");
    const like = (userId: string) => appendLike(db, clock, { kind: "liked", layoutId: layout.id, userId, via: "discord", source: SOURCE });

    await Promise.all(["u1", "u2", "u3", "u4", "u5"].map(like));
    expect((await readById(db, layout.id))?.like_count).toBe(5);
    const likeEvents = await db.prepare("SELECT COUNT(*) AS n FROM events WHERE layout_id = ? AND kind = 'liked'").bind(layout.id).first<{ n: number }>();
    expect(likeEvents?.n).toBe(5);

    const dup = await Promise.all([like("u6"), like("u6")]);
    expect(dup.filter((r) => r.seq !== null)).toHaveLength(1);
    expect((await readById(db, layout.id))?.like_count).toBe(6);
    const rows = await db.prepare("SELECT COUNT(*) AS n FROM likes WHERE layout_id = ?").bind(layout.id).first<{ n: number }>();
    expect(rows?.n).toBe(6);
    await invariantsHold();
  });
});
