// [LDB-DDB41] Lane J: the DynamoDB WpmStore reproduces src/store/d1/wpm.ts.
import { describe, expect, it } from "vitest";
import { AT, eventsOf, expectIndexesConsistent, history, id, itemOf, moderation, MOD, OTHER, outbox, putItems, review, scanMain, seedLayout, USER, wpm } from "./community-support";

const base = (layoutId: string, over: Record<string, unknown> = {}) => ({
  id: id(), layout_id: layoutId, user_id: USER, wpm: 100, proof: "https://example.org/proof", submitted_by: USER, via: "discord", submitted_at: AT, ...over,
});

async function approve(layoutId: string, subId: string, over: { reviewVersion?: number; withOutbox?: boolean } = {}) {
  const rv = over.reviewVersion ?? 0;
  return wpm.approve({
    id: subId, by: MOD, at: AT, reviewVersion: rv,
    event: moderation({ kind: "wpm_approved", layoutId, detail: { submission_id: subId } }),
    ...(over.withOutbox ? { outbox: outbox({ kind: "wpm", submissionId: subId, layoutId, decision: "approval", reviewVersion: rv }) } : {}),
    history: history({ kind: "wpm", submissionId: subId, action: "approved", reviewVersion: rv }),
  });
}

describe("[LDB-DDB41] wpm", () => {
  it("[LDB-DDB41] submit supersedes the pair's pending rows, not another user's", async () => {
    const l = await seedLayout();
    const a = base(l.id, { submitted_at: "2026-10-18T01:00:00.000Z" });
    const o = base(l.id, { user_id: OTHER, submitted_by: OTHER });
    await wpm.submit({ by: USER, at: a.submitted_at, row: a });
    await wpm.submit({ by: OTHER, at: AT, row: o });
    const b = base(l.id, { wpm: 130, submitted_at: "2026-10-18T02:00:00.000Z" });
    await wpm.submit({ by: USER, at: b.submitted_at, row: b });
    expect(await wpm.get(a.id)).toMatchObject({ status: "superseded", decided_by: USER, decided_at: b.submitted_at, review_version: 0 });
    expect(await wpm.get(b.id)).toMatchObject({ status: "pending", wpm: 130 });
    expect((await wpm.get(o.id))?.status).toBe("pending");
    // [LDB-WPM9] neither notified_at nor the receipt URL leave the store.
    expect(Object.keys((await wpm.get(a.id))!).sort()).toEqual(
      ["id", "layout_id", "user_id", "wpm", "proof", "submitted_by", "via", "submitted_at", "status", "decided_by", "decided_at", "reason", "review_version"].sort(),
    );
    await expectIndexesConsistent();
  });

  it("[LDB-DDB41] [LDB-DDB48] approve needs pending + the review_version + a live layout, and commits event, outbox and history together", async () => {
    const l = await seedLayout({ name: "Approve Me" });
    const a = base(l.id);
    await wpm.submit({ by: USER, at: AT, row: a });
    expect(await approve(l.id, a.id, { reviewVersion: 1 })).toEqual({ claimed: false, eventAppended: false });
    expect(await approve(l.id, a.id, { withOutbox: true })).toEqual({ claimed: true, eventAppended: true });
    expect(await wpm.get(a.id)).toMatchObject({ status: "approved", decided_by: MOD, decided_at: AT, reason: null });
    const ev = (await eventsOf("wpm_approved")).find((e) => String(e.detail_json).includes(a.id))!;
    expect(ev).toMatchObject({ name: "Approve Me", owner: USER, admin: 1 });
    expect(await itemOf(`SUB#wpm#${a.id}`, "H#000001")).toMatchObject({ action: "approved", actor: MOD, review_version: 0 });
    expect(await itemOf(`SUB#wpm#${a.id}`, "HK#0#approved")).toBeDefined();
    expect(await itemOf(`DMO#approval:wpm:${a.id}`, "ROW")).toMatchObject({ event_seq: ev.seq, decision: "approval" });
    expect(await approve(l.id, a.id)).toEqual({ claimed: false, eventAppended: false });
    const gone = await seedLayout({ deleted: 1 });
    const d = base(gone.id);
    await wpm.submit({ by: USER, at: AT, row: d });
    expect(await approve(gone.id, d.id)).toEqual({ claimed: false, eventAppended: false });
    expect((await wpm.get(d.id))?.status).toBe("pending");
    await expectIndexesConsistent();
  });

  it("[LDB-DDB41] reject works on a deleted layout (D1 has no live check) and records history", async () => {
    const gone = await seedLayout({ deleted: 1 });
    const d = base(gone.id);
    await wpm.submit({ by: USER, at: AT, row: d });
    const r = await wpm.reject({
      id: d.id, by: MOD, at: AT, reason: "blurry", reviewVersion: 0,
      event: moderation({ kind: "wpm_rejected", layoutId: gone.id }), history: history({ kind: "wpm", submissionId: d.id, action: "rejected", reason: "blurry" }),
    });
    expect(r).toEqual({ claimed: true, eventAppended: true });
    expect(await wpm.get(d.id)).toMatchObject({ status: "rejected", reason: "blurry" });
    expect(await review.history("wpm", d.id)).toEqual([{ action: "rejected", actor: MOD, at: AT, reason: "blurry", review_version: 0 }]);
    await expectIndexesConsistent();
  });

  it("[LDB-DDB41] a duplicate history entry is D1's UNIQUE error and rolls the decision back", async () => {
    const l = await seedLayout();
    const a = base(l.id);
    await wpm.submit({ by: USER, at: AT, row: a });
    // A history row for (approved, v0) already exists.
    await putItems([
      { pk: `SUB#wpm#${a.id}`, sk: "H#000001", id: 1, n: 1, kind: "wpm", submission_id: a.id, action: "approved", actor: MOD, at: AT, reason: null, review_version: 0 },
      { pk: `SUB#wpm#${a.id}`, sk: "HK#0#approved", n: 1, kind: "wpm", submission_id: a.id, action: "approved", actor: MOD, review_version: 0 },
    ]);
    await expect(approve(l.id, a.id)).rejects.toThrow(/UNIQUE/);
    expect((await wpm.get(a.id))?.status).toBe("pending");
  });

  it("[LDB-DDB45] two concurrent decisions: exactly one claims", async () => {
    const l = await seedLayout();
    const a = base(l.id);
    await wpm.submit({ by: USER, at: AT, row: a });
    const reject = () =>
      wpm.reject({ id: a.id, by: MOD, at: AT, reason: "x", reviewVersion: 0, event: moderation({ kind: "wpm_rejected", layoutId: l.id }), history: history({ kind: "wpm", submissionId: a.id, action: "rejected" }) });
    const results = await Promise.all([approve(l.id, a.id), reject(), approve(l.id, a.id), reject()]);
    expect(results.filter((r) => r.claimed)).toHaveLength(1);
    expect(await review.history("wpm", a.id)).toHaveLength(1);
    await expectIndexesConsistent();
  });

  it("[LDB-DDB41] insertApproved writes the approved row, its event and history; records takes the best per pair", async () => {
    const l = await seedLayout({ name: "Records Layout" });
    const mk = (over: Record<string, unknown>) => {
      const r = base(l.id, { decided_by: MOD, decided_at: AT, ...over });
      return r as typeof r & { decided_by: string; decided_at: string };
    };
    const rows = [
      mk({ id: "01A", wpm: 120, decided_at: "2026-10-18T02:00:00.000Z" }),
      mk({ id: "01B", wpm: 120, decided_at: "2026-10-18T01:00:00.000Z" }),
      mk({ id: "01C", wpm: 90 }),
      mk({ id: "01D", wpm: 100, user_id: OTHER }),
    ].map((r) => ({ ...r, id: `${r.id}${l.id.slice(3)}` }));
    for (const r of rows) {
      const out = await wpm.insertApproved({ row: r, event: moderation({ kind: "wpm_approved", layoutId: l.id, detail: { submission_id: r.id } }), history: history({ kind: "wpm", submissionId: r.id, action: "approved" }) });
      expect(out).toBeUndefined();
    }
    expect(await wpm.get(rows[0]!.id)).toMatchObject({ status: "approved", decided_by: MOD, review_version: 0 });
    const recs = await wpm.records({ layoutId: l.id });
    // wpm DESC, then decided_at ASC: the pair (USER) keeps its earlier-approved 120.
    expect(recs.map((r) => [r.submission_id, r.wpm, r.user_id])).toEqual([[rows[1]!.id, 120, USER], [rows[3]!.id, 100, OTHER]]);
    expect(recs[0]).toMatchObject({ layout_name: "Records Layout", approved_at: "2026-10-18T01:00:00.000Z", proof: "https://example.org/proof", user_name: null });
    expect((await wpm.records({ layoutId: l.id, userId: OTHER })).map((r) => r.submission_id)).toEqual([rows[3]!.id]);
    expect((await wpm.records({ userId: USER })).filter((r) => r.layout_id === l.id)).toHaveLength(1);
    // A deleted layout drops out.
    const gone = await seedLayout({ deleted: 1 });
    const g = { ...base(gone.id), decided_by: MOD, decided_at: AT };
    await wpm.insertApproved({ row: g, event: moderation({ kind: "wpm_approved", layoutId: gone.id }), history: history({ kind: "wpm", submissionId: g.id, action: "approved" }) });
    expect(await wpm.records({ layoutId: gone.id })).toEqual([]);
    await expectIndexesConsistent();
  });

  it("[LDB-DDB41] queue: by status, oldest first, with names, live layouts only", async () => {
    const l = await seedLayout({ name: "Wq" });
    const gone = await seedLayout({ deleted: 1 });
    await putItems([{ pk: "AUTHORS", sk: USER, user_id: USER, name: "Speedy" }]);
    const late = base(l.id, { user_id: OTHER, submitted_by: OTHER, submitted_at: "2026-10-18T05:00:00.000Z" });
    const early = base(l.id, { submitted_at: "2026-10-18T04:00:00.000Z" });
    const hidden = base(gone.id, { submitted_at: "2026-10-18T04:30:00.000Z" });
    for (const r of [late, hidden, early]) await wpm.submit({ by: r.submitted_by, at: r.submitted_at, row: r });
    const q = (await wpm.queue("pending")).filter((r) => [l.id, gone.id].includes(r.layout_id));
    expect(q.map((r) => r.id)).toEqual([early.id, late.id]);
    expect(q[0]).toMatchObject({ layout_name: "Wq", user_name: "Speedy" });
    expect(q[1]).toMatchObject({ user_name: null });
    await expectIndexesConsistent();
  });

  it("[LDB-DDB41] bindSourceMessage binds once for the submitter or an admin; sourceMessage hides it from strangers", async () => {
    const l = await seedLayout();
    const a = base(l.id);
    await wpm.submit({ by: USER, at: AT, row: a });
    const url = "https://discord.com/channels/1/2/3";
    expect(await wpm.sourceMessage({ id: a.id, actorId: OTHER, admin: false })).toBeNull();
    expect(await wpm.sourceMessage({ id: a.id, actorId: USER, admin: false })).toEqual({ source_message_url: null });
    expect(await wpm.bindSourceMessage({ id: a.id, url, actorId: OTHER, admin: false })).toBe(false);
    expect(await wpm.bindSourceMessage({ id: a.id, url, actorId: USER, admin: false })).toBe(true);
    expect(await wpm.bindSourceMessage({ id: a.id, url: "https://discord.com/channels/1/2/4", actorId: USER, admin: false })).toBe(false);
    expect(await wpm.bindSourceMessage({ id: a.id, url, actorId: MOD, admin: true })).toBe(false);
    expect(await wpm.sourceMessage({ id: a.id, actorId: MOD, admin: true })).toEqual({ source_message_url: url });
    expect(await wpm.bindSourceMessage({ id: "missing", url, actorId: MOD, admin: true })).toBe(false);
    expect(await itemOf("IX#mqn#dirty", `wpm#${a.id}`)).toBeUndefined(); // no card, no mark
    await putItems([{ pk: `MQN#wpm#${a.id}`, sk: "ROW", kind: "wpm", submission_id: a.id }]);
    await wpm.reject({ id: a.id, by: MOD, at: AT, reason: null, reviewVersion: 0, event: moderation({ kind: "wpm_rejected", layoutId: l.id }), history: history({ kind: "wpm", submissionId: a.id, action: "rejected" }) });
    expect(await itemOf("IX#mqn#dirty", `wpm#${a.id}`)).toBeDefined();
    const b = base(l.id, { user_id: OTHER, submitted_by: OTHER });
    await wpm.submit({ by: OTHER, at: AT, row: b });
    expect(await wpm.bindSourceMessage({ id: b.id, url, actorId: MOD, admin: true })).toBe(true);
    expect((await scanMain()).filter((i) => i.pk === `SUB#wpm#${b.id}`)[0]).toMatchObject({ source_message_url: url });
    await expectIndexesConsistent();
  });
});
