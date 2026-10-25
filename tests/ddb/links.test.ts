// [LDB-DDB40] Lane J: the DynamoDB LinkStore reproduces src/store/d1/links.ts.
import { runEventTx } from "../../src/store/ddb/tx";
import { describe, expect, it } from "vitest";
import { planLinkSettle } from "../../src/store/ddb/links";
import { putItems, AT, ctx, eventsOf, expectIndexesConsistent, id, itemOf, links, moderation, outbox, OTHER, scanMain, seedLayout, USER, MOD } from "./community-support";

const row = (layoutId: string, over: Record<string, unknown> = {}) => ({ id: id(), layout_id: layoutId, url: "https://example.org/a", submitted_by: USER, submitted_at: AT, ...over });

describe("[LDB-DDB40] links", () => {
  it("[LDB-DDB40] [LDB-DDB46] submit inserts a pending row, a newer submit supersedes the older, pending() is the newest", async () => {
    const l = await seedLayout();
    const a = row(l.id, { submitted_at: "2026-10-18T01:00:00.000Z" });
    await links.submit({ supersedeId: null, by: USER, at: a.submitted_at, row: a });
    expect(await links.pending(l.id)).toEqual({ ...a, status: "pending", decided_by: null, decided_at: null, reason: null });
    const b = row(l.id, { url: "https://example.org/b", submitted_at: "2026-10-18T02:00:00.000Z" });
    await links.submit({ supersedeId: a.id, by: USER, at: b.submitted_at, row: b });
    expect((await links.pending(l.id))?.id).toBe(b.id);
    expect(await links.get(a.id)).toMatchObject({ status: "superseded", decided_by: USER, decided_at: b.submitted_at });
    expect(await links.pending("no-such-layout")).toBeNull();
    expect(await links.get("missing")).toBeNull();
    // [LDB-MD11] notified_at never leaves the store.
    expect(Object.keys((await links.get(a.id))!)).not.toContain("notified_at");
    await expectIndexesConsistent();
  });

  it("[LDB-DDB40] a duplicate id is D1's UNIQUE error", async () => {
    const l = await seedLayout();
    const a = row(l.id);
    await links.submit({ supersedeId: null, by: USER, at: AT, row: a });
    await expect(links.submit({ supersedeId: null, by: USER, at: AT, row: a })).rejects.toThrow(/UNIQUE/);
  });

  it("[LDB-DDB40] queue lists a status oldest first with layout and submitter names, hiding deleted layouts", async () => {
    const live = await seedLayout({ name: "Queue Live" });
    const gone = await seedLayout({ deleted: 1 });
    await putAuthor(USER, "Submitter");
    const early = row(live.id, { submitted_at: "2026-10-18T00:00:00.000Z" });
    const late = row(live.id, { submitted_at: "2026-10-18T03:00:00.000Z", submitted_by: OTHER });
    const hidden = row(gone.id);
    for (const r of [late, hidden, early]) await links.submit({ supersedeId: null, by: r.submitted_by, at: r.submitted_at, row: r });
    const q = (await links.queue("pending")).filter((r) => r.layout_id === live.id || r.layout_id === gone.id);
    expect(q.map((r) => r.id)).toEqual([early.id, late.id]);
    expect(q[0]).toMatchObject({ layout_name: "Queue Live", submitter_name: "Submitter" });
    expect(q[1]).toMatchObject({ submitter_name: null });
    await expectIndexesConsistent();
  });

  it("[LDB-DDB40] [LDB-DDB48] reject claims once: the event, the outbox row and its claims commit with the row", async () => {
    const l = await seedLayout({ name: "Reject Me" });
    const a = row(l.id);
    await links.submit({ supersedeId: null, by: USER, at: AT, row: a });
    const intent = outbox({ kind: "link", submissionId: a.id, layoutId: l.id });
    // A card exists for this submission, so its state change leaves a dirty mark.
    await putItems([{ pk: `MQN#link#${a.id}`, sk: "ROW", kind: "link", submission_id: a.id }]);
    const won = await links.reject({ id: a.id, by: MOD, at: AT, reason: "no", event: moderation({ kind: "link_rejected", layoutId: l.id, detail: { submission_id: a.id, reason: "no" } }), outbox: intent });
    expect(won).toEqual({ claimed: true, eventAppended: true });
    expect(await links.get(a.id)).toMatchObject({ status: "rejected", decided_by: MOD, decided_at: AT, reason: "no" });
    const ev = (await eventsOf("link_rejected")).find((e) => String(e.detail_json).includes(a.id))!;
    expect(ev).toMatchObject({ layout_id: l.id, name: "Reject Me", owner: USER, admin: 1, actor: MOD, format: null, rev: null, before_json: null, after_json: null });
    const ob = (await itemOf(`DMO#${intent.deliveryKey}`, "ROW"))!;
    expect(ob).toMatchObject({ event_seq: ev.seq, status: "pending", attempts: 0, kind: "link", submission_id: a.id, review_version: 0, decision: "rejection", sent_at: null });
    expect(await itemOf(`DMO#seq#${ev.seq}`, "CLAIM")).toBeDefined();
    expect(await itemOf(`DMO#nonce#${intent.nonce}`, "CLAIM")).toBeDefined();
    expect(await itemOf("IX#dmo#due", `pending#${AT}#${intent.deliveryKey}`)).toBeDefined();
    expect(await itemOf("IX#mqn#dirty", `link#${a.id}`)).toBeDefined();
    // The second decision loses its claim and writes nothing.
    const before = (await scanMain()).length;
    expect(await links.reject({ id: a.id, by: MOD, at: AT, reason: null, event: moderation({ kind: "link_rejected", layoutId: l.id }) })).toEqual({ claimed: false, eventAppended: false });
    expect((await scanMain()).length).toBe(before);
    expect(await links.reject({ id: "missing", by: MOD, at: AT, reason: null, event: moderation({ kind: "link_rejected", layoutId: l.id }) })).toEqual({ claimed: false, eventAppended: false });
    await expectIndexesConsistent();
  });

  it("[LDB-DDB45] two concurrent rejects: exactly one claims and exactly one event lands", async () => {
    const l = await seedLayout();
    const a = row(l.id);
    await links.submit({ supersedeId: null, by: USER, at: AT, row: a });
    const before = (await eventsOf("link_rejected")).length;
    const results = await Promise.all([0, 1, 2].map((i) => links.reject({ id: a.id, by: MOD, at: AT, reason: `r${i}`, event: moderation({ kind: "link_rejected", layoutId: l.id }) })));
    expect(results.filter((r) => r.claimed)).toHaveLength(1);
    expect((await eventsOf("link_rejected")).length).toBe(before + 1);
    await expectIndexesConsistent();
  });

  it("[LDB-DDB40] a reject that fails after the claim rolls the row back with it", async () => {
    const l = await seedLayout();
    const a = row(l.id);
    await links.submit({ supersedeId: null, by: USER, at: AT, row: a });
    const dispose = (await import("../harness/ddb")).ddbHarness.faults.failWritesFor((t) => t.key.pk.startsWith("EV") && t.item?.kind === "link_rejected");
    try {
      await expect(links.reject({ id: a.id, by: MOD, at: AT, reason: null, event: moderation({ kind: "link_rejected", layoutId: l.id }) })).rejects.toThrow();
    } finally {
      dispose();
    }
    expect(await links.get(a.id)).toMatchObject({ status: "pending", decided_by: null });
    await expectIndexesConsistent();
  });

  it("[LDB-DDB40] planLinkSettle (lane G's link approve) claims one submission and supersedes the other pending ones in the event's transaction", async () => {
    const l = await seedLayout();
    const [a, b, c] = [row(l.id, { submitted_at: "2026-10-18T01:00:00.000Z" }), row(l.id, { submitted_at: "2026-10-18T02:00:00.000Z" }), row(l.id, { submitted_at: "2026-10-18T03:00:00.000Z" })];
    for (const r of [a, b, c]) await links.submit({ supersedeId: null, by: USER, at: r.submitted_at, row: r });
    const plan = (await planLinkSettle(ctx, { layoutId: l.id, submissionId: b.id, by: MOD, at: AT }))!;
    await runEventTx(ctx, (builder) => {
      builder.event({ at: AT, kind: "link_approved", layout_id: l.id, name: l.name, owner: l.owner, format: null, rev: null, actor: MOD, via: "discord", admin: 1, detail_json: null, before_json: null, after_json: null, source_client: null, source_version: null });
      for (const op of plan.ops) builder.item(op.tag, op.item);
    });
    expect((await links.get(b.id))?.status).toBe("approved");
    expect((await links.get(a.id))?.status).toBe("superseded");
    expect((await links.get(c.id))?.status).toBe("superseded");
    expect(await planLinkSettle(ctx, { layoutId: l.id, submissionId: b.id, by: MOD, at: AT })).toBeNull();
    await expectIndexesConsistent();
  });
});

async function putAuthor(userId: string, name: string): Promise<void> {
  const { putItems } = await import("./community-support");
  await putItems([{ pk: "AUTHORS", sk: userId, user_id: userId, name }]);
}
