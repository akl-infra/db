// [LDB-DDB49] Lane J: review-history ids are one global ascending sequence, as D1's AUTOINCREMENT.
import { describe, expect, it } from "vitest";
import { AT, expectIndexesConsistent, history, id, itemOf, moderation, MOD, review, scanMain, seedLayout, seedRows, USER, wpm } from "./community-support";

const hist = async () => (await scanMain()).filter((i) => String(i.sk).startsWith("H#")).sort((a, b) => (a.id as number) - (b.id as number));
const sub = (layoutId: string) => ({ id: id(), layout_id: layoutId, user_id: USER, wpm: 100, proof: "https://example.org/p", submitted_by: USER, via: "discord", submitted_at: AT });
const reject = (layoutId: string, subId: string, rv = 0) =>
  wpm.reject({ id: subId, by: MOD, at: AT, reason: "r", reviewVersion: rv, event: moderation({ kind: "wpm_rejected", layoutId }), history: history({ kind: "wpm", submissionId: subId, action: "rejected", reviewVersion: rv }) });
const reopen = (layoutId: string, subId: string, rv: number) =>
  review.reopen({ kind: "wpm", id: subId, expected: { status: "rejected", review_version: rv }, at: AT, event: moderation({ kind: "wpm_reopened", layoutId }), history: history({ kind: "wpm", submissionId: subId, action: "reopened", reviewVersion: rv + 1 }) });

describe("[LDB-DDB49] review history ids", () => {
  it("[LDB-DDB49] a sequence of actions yields ids 1, 2, 3 ... exactly", async () => {
    const l = await seedLayout();
    const w = sub(l.id);
    await wpm.submit({ by: USER, at: AT, row: w });
    await reject(l.id, w.id);
    await reopen(l.id, w.id, 0);
    await reject(l.id, w.id, 1);
    await reopen(l.id, w.id, 1);
    expect((await hist()).map((h) => [h.id, h.action])).toEqual([[1, "rejected"], [2, "reopened"], [3, "rejected"], [4, "reopened"]]);
    expect(await itemOf("META", "REVIEW_HISTORY")).toMatchObject({ last: 4 });
    // A legacy decision back-filled in the same transaction takes the next two ids, in D1's statement order.
    const l2 = await seedLayout();
    const legacy = { ...sub(l2.id), status: "rejected", decided_by: MOD, decided_at: AT, reason: null, review_version: 0 };
    await seedRows({ wpm_submissions: [legacy] });
    await reopen(l2.id, legacy.id, 0);
    expect((await hist()).filter((h) => h.submission_id === legacy.id).map((h) => [h.id, h.action])).toEqual([[5, "rejected"], [6, "reopened"]]);
    expect(await itemOf("META", "REVIEW_HISTORY")).toMatchObject({ last: 6 });
    await expectIndexesConsistent();
  });

  it("[LDB-DDB49] concurrent actions never share an id and leave no gap", async () => {
    const l = await seedLayout();
    const subs = Array.from({ length: 8 }, () => sub(l.id));
    for (const s of subs) await wpm.submit({ by: USER, at: AT, row: { ...s, user_id: `u-${s.id}`, submitted_by: `u-${s.id}` } });
    const before = (await hist()).length;
    const out = await Promise.all(subs.map((s) => reject(l.id, s.id)));
    expect(out.every((o) => o.claimed)).toBe(true);
    const ids = (await hist()).map((h) => h.id as number);
    expect(ids).toHaveLength(before + 8);
    expect(ids).toEqual(Array.from({ length: ids.length }, (_, i) => i + 1));
    await expectIndexesConsistent();
  });
});
