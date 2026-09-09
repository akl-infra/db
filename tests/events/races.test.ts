// The concurrency guard lives INSIDE the write batch, not in the pre-checks
// (09 §2.3): the `layouts_name_live` partial index refuses a second create
// on a live name, the `layout_revs (layout_id, rev)` PK refuses a second
// write at the same rev, and a lost batch rolls back whole -- no event, no
// orphaned rev row, `seq` still gapless. These tests drive the races with
// Promise.all so both pre-checks pass before either batch runs (miniflare's
// D1 is one sequential connection, so a non-interleaving would show up as
// two successes -- a loud failure, never a silent pass).
import { env } from "cloudflare:test";
import type { Bindings } from "../../src/env";
import { describe, expect, it } from "vitest";
import { ApiError } from "../../src/core/errors";
import { RevConflictError, appendLike, appendWrite } from "../../src/core/events";
import { readById } from "../../src/core/records";
import { fixedClock } from "../../src/core/time";

const db = (env as unknown as Bindings).DB;
const clock = fixedClock("2026-05-02T00:00:00.000Z");

function create(name: string, owner = "owner-a") {
  return appendWrite(db, clock, {
    kind: "created",
    name,
    owner,
    modified_at: clock(),
    format: "cmini/1",
    payload: { v: 1 },
    actor: owner,
    via: "discord",
  });
}

async function invariantsHold() {
  const seqs = (await db.prepare("SELECT seq FROM events ORDER BY seq").all<{ seq: number }>()).results.map((r) => r.seq);
  expect(seqs).toEqual(seqs.map((_, i) => i + 1));
  const orphanRevs = await db
    .prepare("SELECT COUNT(*) AS n FROM layout_revs r LEFT JOIN layouts l ON l.id = r.layout_id WHERE l.id IS NULL")
    .first<{ n: number }>();
  expect(orphanRevs?.n).toBe(0);
  const revsPerWrite = await db
    .prepare("SELECT COUNT(*) AS n FROM events WHERE rev IS NOT NULL")
    .first<{ n: number }>();
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
    const winner = (won[0] as PromiseFulfilledResult<Awaited<ReturnType<typeof create>>>).value.record;
    expect(await readById(db, winner.id)).toMatchObject({ id: winner.id, name: "race-name", rev: 1 });
    await invariantsHold();
  });

  it("[LDB-P1] two updates racing from the same rev: exactly one wins, the loser is a RevConflictError, rev advances once", async () => {
    const { record } = await create("race-rev");
    const update = (payload: unknown) =>
      appendWrite(db, clock, {
        kind: "updated",
        layoutId: record.id,
        name: record.name,
        owner: record.owner,
        modified_at: clock(),
        format: record.format,
        payload,
        actor: record.owner,
        via: "discord",
      });
    const outcomes = await Promise.allSettled([update({ v: 2 }), update({ v: 3 })]);
    const won = outcomes.filter((o) => o.status === "fulfilled");
    const lost = outcomes.filter((o) => o.status === "rejected");
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);
    expect((lost[0] as PromiseRejectedResult).reason).toBeInstanceOf(RevConflictError);
    const after = await readById(db, record.id);
    expect(after?.rev).toBe(2);
    expect(after?.payload).toEqual((won[0] as PromiseFulfilledResult<{ record: { payload: unknown } }>).value.record.payload);
    await invariantsHold();
  });

  it("[LDB-P1] five users liking at once: like_count is 5 and five events exist; the same user twice at once is one like, one event", async () => {
    const { record } = await create("race-likes");
    const like = (userId: string) => appendLike(db, clock, { kind: "liked", layoutId: record.id, userId, via: "discord" });

    await Promise.all(["u1", "u2", "u3", "u4", "u5"].map(like));
    expect((await readById(db, record.id))?.like_count).toBe(5);
    const likeEvents = await db
      .prepare("SELECT COUNT(*) AS n FROM events WHERE layout_id = ? AND kind = 'liked'")
      .bind(record.id)
      .first<{ n: number }>();
    expect(likeEvents?.n).toBe(5);

    const dup = await Promise.all([like("u6"), like("u6")]);
    expect(dup.filter((r) => r.seq !== null)).toHaveLength(1);
    expect((await readById(db, record.id))?.like_count).toBe(6);
    const rows = await db.prepare("SELECT COUNT(*) AS n FROM likes WHERE layout_id = ?").bind(record.id).first<{ n: number }>();
    expect(rows?.n).toBe(6);
    await invariantsHold();
  });
});
