// [LDB-DDB43] Lane J: the DynamoDB ReviewStore (history, reopen) reproduces src/store/d1/review.ts.
import { describe, expect, it } from "vitest";
import { AT, comments, eventsOf, expectIndexesConsistent, history, id, itemOf, moderation, MOD, OTHER, outbox, review, scanMain, seedLayout, seedRows, USER, wpm } from "./community-support";

const comment = (layoutId: string, over: Record<string, unknown> = {}) => ({ id: id(), layout_id: layoutId, user_id: USER, body: "text", via: "discord", submitted_at: AT, ...over });
const wpmRow = (layoutId: string, over: Record<string, unknown> = {}) => ({ id: id(), layout_id: layoutId, user_id: USER, wpm: 120, proof: "https://example.org/p", submitted_by: USER, via: "discord", submitted_at: AT, ...over });

async function rejectComment(layoutId: string, c: { id: string }, rv = 0, withOutbox = true) {
  return comments.reject({
    id: c.id, by: MOD, at: AT, reason: `reason ${rv}`, reviewVersion: rv,
    event: moderation({ kind: "comment_rejected", layoutId }),
    ...(withOutbox ? { outbox: outbox({ kind: "comment", submissionId: c.id, layoutId, reviewVersion: rv }) } : {}),
    history: history({ kind: "comment", submissionId: c.id, action: "rejected", reason: `reason ${rv}`, reviewVersion: rv }),
  });
}

function reopenComment(layoutId: string, c: { id: string }, status: "approved" | "rejected", rv: number, at = AT) {
  return review.reopen({
    kind: "comment", id: c.id, expected: { status, review_version: rv }, at,
    event: moderation({ kind: "comment_reopened", layoutId, detail: { submission_id: c.id } }),
    history: history({ kind: "comment", submissionId: c.id, action: "reopened", reviewVersion: rv + 1, at }),
  });
}

describe("[LDB-DDB43] review history and reopen", () => {
  it("[LDB-DDB43] repeated rejection cycles: reopen is a new review cycle, expires the pending DM, and keeps the private history", async () => {
    const l = await seedLayout();
    const c = comment(l.id);
    await comments.submit({ by: USER, at: AT, row: c });
    expect(await rejectComment(l.id, c)).toEqual({ claimed: true, eventAppended: true });
    const dm0 = `rejection:comment:${c.id}`;
    expect(await itemOf(`DMO#${dm0}`, "ROW")).toMatchObject({ status: "pending" });
    expect(await itemOf("IX#dmo#due", `pending#${AT}#${dm0}`)).toBeDefined();

    const reopenAt = "2026-10-18T02:00:00.000Z";
    expect(await reopenComment(l.id, c, "rejected", 0, reopenAt)).toEqual({ claimed: true, eventAppended: true });
    expect(await comments.get(c.id)).toMatchObject({ status: "pending", review_version: 1, decided_by: null, decided_at: null, reason: null, body: "text" });
    expect(await itemOf(`DMO#${dm0}`, "ROW")).toMatchObject({ status: "expired", lease_token: null, lease_until: null, updated_at: reopenAt, last_error_class: "review_reopened" });
    expect(await itemOf("IX#dmo#due", `pending#${AT}#${dm0}`)).toBeUndefined();
    expect(await eventsOf("comment_reopened")).toHaveLength(1);
    // The stale review_version loses; the new cycle decides at version 1.
    expect(await rejectComment(l.id, c, 0)).toEqual({ claimed: false, eventAppended: false });
    expect(await rejectComment(l.id, c, 1)).toEqual({ claimed: true, eventAppended: true });
    expect(await reopenComment(l.id, c, "rejected", 0)).toEqual({ claimed: false, eventAppended: false });
    expect(await reopenComment(l.id, c, "rejected", 1)).toEqual({ claimed: true, eventAppended: true });
    expect(await itemOf(`DMO#rejection:comment:${c.id}:1`, "ROW")).toMatchObject({ status: "expired" });

    expect(await review.history("comment", c.id)).toEqual([
      { action: "rejected", actor: MOD, at: AT, reason: "reason 0", review_version: 0 },
      { action: "reopened", actor: MOD, at: reopenAt, reason: null, review_version: 1 },
      { action: "rejected", actor: MOD, at: AT, reason: "reason 1", review_version: 1 },
      { action: "reopened", actor: MOD, at: AT, reason: null, review_version: 2 },
    ]);
    expect(await review.reopenRecorded({ kind: "comment", id: c.id, reviewVersion: 1, actor: MOD })).toBe(true);
    expect(await review.reopenRecorded({ kind: "comment", id: c.id, reviewVersion: 1, actor: OTHER })).toBe(false);
    expect(await review.reopenRecorded({ kind: "comment", id: c.id, reviewVersion: 3, actor: MOD })).toBe(false);
    expect(await review.reopenRecorded({ kind: "link", id: c.id, reviewVersion: 0, actor: MOD })).toBe(false);
    expect(await review.decisionState("comment", c.id)).toEqual({ status: "pending", decided_by: null, decided_at: null, reason: null, review_version: 2 });
    expect(await review.submissionDecision("comment", c.id)).toEqual({ status: "pending", decided_by: null, review_version: 2 });
    expect(await review.submissionLayout("comment", c.id)).toBe(l.id);
    expect(await review.submissionLayout("comment", "missing")).toBeNull();
    expect(await review.decisionState("wpm", "missing")).toBeNull();
    await expectIndexesConsistent();
  });

  it("[LDB-DDB43] a decision that predates private history is back-filled before the reopen", async () => {
    const l = await seedLayout();
    const c = comment(l.id, { status: "approved", decided_by: MOD, decided_at: "2026-10-17T00:00:00.000Z", reason: null, review_version: 0 });
    await seedRows({ layout_comments: [c] });
    expect(await review.history("comment", c.id)).toEqual([]);
    expect(await reopenComment(l.id, c, "approved", 0)).toEqual({ claimed: true, eventAppended: true });
    expect(await review.history("comment", c.id)).toEqual([
      { action: "approved", actor: MOD, at: "2026-10-17T00:00:00.000Z", reason: null, review_version: 0 },
      { action: "reopened", actor: MOD, at: AT, reason: null, review_version: 1 },
    ]);
    // The approved text left the slot: the counter followed.
    expect(await itemOf("CC", l.id)).toMatchObject({ count: 0 });
    await expectIndexesConsistent();
  });

  it("[LDB-DDB43] reopen refuses a newer row in the pair, a deleted layout, a missing body and a wrong expectation", async () => {
    const l = await seedLayout();
    const older = comment(l.id, { submitted_at: "2026-10-18T01:00:00.000Z", status: "rejected", decided_by: MOD, decided_at: AT, review_version: 0 });
    const newer = comment(l.id, { submitted_at: "2026-10-18T02:00:00.000Z", status: "pending", review_version: 0 });
    await seedRows({ layout_comments: [older, newer] });
    expect(await reopenComment(l.id, older, "rejected", 0)).toEqual({ claimed: false, eventAppended: false });
    expect(await reopenComment(l.id, newer, "rejected", 0)).toEqual({ claimed: false, eventAppended: false });

    const gone = await seedLayout({ deleted: 1 });
    const g = comment(gone.id, { status: "rejected", decided_by: MOD, decided_at: AT, review_version: 0 });
    await seedRows({ layout_comments: [g] });
    expect(await reopenComment(gone.id, g, "rejected", 0)).toEqual({ claimed: false, eventAppended: false });

    const l2 = await seedLayout();
    const erased = comment(l2.id, { body: null, status: "rejected", decided_by: MOD, decided_at: AT, review_version: 0 });
    await seedRows({ layout_comments: [erased] });
    expect(await reopenComment(l2.id, erased, "rejected", 0)).toEqual({ claimed: false, eventAppended: false });
    expect(await reopenComment(l2.id, erased, "approved", 0)).toEqual({ claimed: false, eventAppended: false });
    expect(await review.history("comment", erased.id)).toEqual([]);
    await expectIndexesConsistent();
  });

  it("[LDB-DDB45] concurrent reopens: exactly one wins, and a decision racing a reopen leaves one consistent row", async () => {
    const l = await seedLayout();
    const c = comment(l.id);
    await comments.submit({ by: USER, at: AT, row: c });
    await rejectComment(l.id, c, 0, false);
    const race = await Promise.all([0, 1, 2].map(() => reopenComment(l.id, c, "rejected", 0)));
    expect(race.filter((r) => r.claimed)).toHaveLength(1);
    const decide = await Promise.all([
      comments.approve({ id: c.id, layoutId: l.id, userId: USER, by: MOD, at: AT, reviewVersion: 1, event: moderation({ kind: "comment_approved", layoutId: l.id }), history: history({ kind: "comment", submissionId: c.id, action: "approved", reviewVersion: 1 }) }),
      rejectComment(l.id, c, 1, false),
    ]);
    expect(decide.filter((r) => r.claimed)).toHaveLength(1);
    expect(await review.history("comment", c.id)).toHaveLength(3);
    await expectIndexesConsistent();
  });

  it("[LDB-DDB47] a removal racing a reopening can never clear the preserved slot likes", async () => {
    for (let round = 0; round < 6; round++) {
      const l = await seedLayout();
      const c = comment(l.id);
      await comments.submit({ by: USER, at: AT, row: c });
      await comments.approve({ id: c.id, layoutId: l.id, userId: USER, by: MOD, at: AT, reviewVersion: 0, event: moderation({ kind: "comment_approved", layoutId: l.id }), history: history({ kind: "comment", submissionId: c.id, action: "approved" }) });
      await comments.like({ layoutId: l.id, authorId: USER, userId: OTHER, via: "discord", at: AT });
      const [removed, reopened] = await Promise.all([
        comments.remove({ id: c.id, layoutId: l.id, userId: USER, by: MOD, at: AT, reason: null, reviewVersion: 0 }),
        reopenComment(l.id, c, "approved", 0),
      ]);
      // Whoever lost changed nothing; the winner's effect on the likes is its own.
      expect(removed.claimed !== reopened.claimed).toBe(true);
      const likes = (await scanMain()).filter((i) => i.pk === `CL#${l.id}`);
      expect(await comments.get(c.id)).toMatchObject(reopened.claimed ? { status: "pending", review_version: 1 } : { status: "removed", review_version: 0 });
      expect(likes).toHaveLength(reopened.claimed ? 1 : 0);
      await expectIndexesConsistent();
    }
  });

  it("[LDB-DDB43] WPM reopen: new cycle at review_version + 1, the pair guard moves, and the best record leaves the board", async () => {
    const l = await seedLayout();
    const w = wpmRow(l.id);
    await wpm.submit({ by: USER, at: AT, row: w });
    await wpm.approve({ id: w.id, by: MOD, at: AT, reviewVersion: 0, event: moderation({ kind: "wpm_approved", layoutId: l.id }), outbox: outbox({ kind: "wpm", submissionId: w.id, layoutId: l.id, decision: "approval" }), history: history({ kind: "wpm", submissionId: w.id, action: "approved" }) });
    expect((await wpm.records({ layoutId: l.id })).map((r) => r.submission_id)).toEqual([w.id]);
    const out = await review.reopen({
      kind: "wpm", id: w.id, expected: { status: "approved", review_version: 0 }, at: "2026-10-18T05:00:00.000Z",
      event: moderation({ kind: "wpm_reopened", layoutId: l.id }), history: history({ kind: "wpm", submissionId: w.id, action: "reopened", reviewVersion: 1 }),
    });
    expect(out).toEqual({ claimed: true, eventAppended: true });
    expect(await wpm.get(w.id)).toMatchObject({ status: "pending", review_version: 1, decided_by: null });
    expect(await wpm.records({ layoutId: l.id })).toEqual([]);
    expect(await itemOf(`DMO#approval:wpm:${w.id}`, "ROW")).toMatchObject({ status: "expired" });
    expect((await review.history("wpm", w.id)).map((h) => [h.action, h.review_version])).toEqual([["approved", 0], ["reopened", 1]]);
    // A fresh submit now supersedes the reopened pending row.
    const w2 = wpmRow(l.id, { submitted_at: "2026-10-18T06:00:00.000Z" });
    await wpm.submit({ by: USER, at: w2.submitted_at, row: w2 });
    expect((await wpm.get(w.id))?.status).toBe("superseded");
    await expectIndexesConsistent();
  });
});
