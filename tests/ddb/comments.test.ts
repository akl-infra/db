// [LDB-DDB42] Lane J: the DynamoDB CommentStore reproduces src/store/d1/comments.ts.
import { describe, expect, it } from "vitest";
import { AT, comments, eventsOf, expectIndexesConsistent, history, id, itemOf, moderation, MOD, OTHER, outbox, putItems, review, scanMain, seedLayout, USER } from "./community-support";

const base = (layoutId: string, over: Record<string, unknown> = {}) => ({ id: id(), layout_id: layoutId, user_id: USER, body: "first words", via: "discord", submitted_at: AT, ...over });

async function submit(r: ReturnType<typeof base>, by = r.user_id as string) {
  await comments.submit({ by, at: r.submitted_at, row: r as never });
  return r;
}

function approve(layoutId: string, c: { id: string; user_id: unknown }, over: { at?: string; reviewVersion?: number; withOutbox?: boolean } = {}) {
  const rv = over.reviewVersion ?? 0;
  return comments.approve({
    id: c.id, layoutId, userId: c.user_id as string, by: MOD, at: over.at ?? AT, reviewVersion: rv,
    event: moderation({ kind: "comment_approved", layoutId, detail: { submission_id: c.id } }),
    ...(over.withOutbox ? { outbox: outbox({ kind: "comment", submissionId: c.id, layoutId, decision: "approval", reviewVersion: rv }) } : {}),
    history: history({ kind: "comment", submissionId: c.id, action: "approved", reviewVersion: rv, at: over.at ?? AT }),
  });
}

describe("[LDB-DDB42] comments", () => {
  it("[LDB-DDB42] submit supersedes the pair's older pending row; pairRows lists submitted_at then id", async () => {
    const l = await seedLayout();
    const a = await submit(base(l.id, { submitted_at: "2026-10-18T01:00:00.000Z" }));
    const o = await submit(base(l.id, { user_id: OTHER }));
    const b = await submit(base(l.id, { body: "second", submitted_at: "2026-10-18T02:00:00.000Z" }));
    expect((await comments.pairRows(l.id, USER)).map((r) => [r.id, r.status])).toEqual([[a.id, "superseded"], [b.id, "pending"]]);
    expect(await comments.get(a.id)).toMatchObject({ status: "superseded", decided_by: USER, decided_at: b.submitted_at, review_version: 0 });
    expect((await comments.get(o.id))?.status).toBe("pending");
    expect(await comments.hasBody(l.id, USER)).toBe(true);
    expect(await comments.hasBody(l.id, "nobody")).toBe(false);
    await expectIndexesConsistent();
  });

  it("[LDB-DDB42] approve claims, replaces the prior approved text, counts, and appends event/outbox/history together", async () => {
    const l = await seedLayout({ name: "Approve Comments" });
    const a = await submit(base(l.id));
    expect(await approve(l.id, a, { reviewVersion: 3 })).toEqual({ claimed: false, eventAppended: false });
    expect(await approve(l.id, a, { withOutbox: true })).toEqual({ claimed: true, eventAppended: true });
    expect(await comments.get(a.id)).toMatchObject({ status: "approved", decided_by: MOD, body: "first words" });
    expect(await itemOf(`CC`, l.id)).toMatchObject({ count: 1 });
    const b = await submit(base(l.id, { body: "edited", submitted_at: "2026-10-18T02:00:00.000Z" }));
    expect(await approve(l.id, b, { at: "2026-10-18T03:00:00.000Z" })).toEqual({ claimed: true, eventAppended: true });
    expect(await comments.get(a.id)).toMatchObject({ status: "replaced", body: null, decided_at: "2026-10-18T03:00:00.000Z", decided_by: MOD });
    expect(await comments.get(b.id)).toMatchObject({ status: "approved", body: "edited" });
    expect(await itemOf(`CC`, l.id)).toMatchObject({ count: 1 });
    expect(await comments.approvedSlotExists(l.id, USER)).toBe(true);
    expect(await comments.approvedSlotExists(l.id, OTHER)).toBe(false);
    const ev = (await eventsOf("comment_approved")).find((e) => String(e.detail_json).includes(a.id))!;
    expect(ev).toMatchObject({ name: "Approve Comments", admin: 1 });
    expect(await itemOf(`DMO#approval:comment:${a.id}`, "ROW")).toMatchObject({ event_seq: ev.seq });
    expect(await review.history("comment", b.id)).toHaveLength(1);
    // A deleted layout cannot be approved into.
    const gone = await seedLayout({ deleted: 1 });
    const d = await submit(base(gone.id));
    expect(await approve(gone.id, d)).toEqual({ claimed: false, eventAppended: false });
    await expectIndexesConsistent();
  });

  it("[LDB-DDB42] reject keeps the text; the row needs a body", async () => {
    const l = await seedLayout();
    const a = await submit(base(l.id));
    const out = await comments.reject({
      id: a.id, by: MOD, at: AT, reason: "rude", reviewVersion: 0,
      event: moderation({ kind: "comment_rejected", layoutId: l.id }), history: history({ kind: "comment", submissionId: a.id, action: "rejected", reason: "rude" }),
    });
    expect(out).toEqual({ claimed: true, eventAppended: true });
    expect(await comments.get(a.id)).toMatchObject({ status: "rejected", reason: "rude", body: "first words" });
    await expectIndexesConsistent();
  });

  it("[LDB-DDB42] list: the owner first, then likes, newest approval, id; liked and edited flags", async () => {
    const l = await seedLayout({ owner: OTHER });
    await putItems([{ pk: "AUTHORS", sk: USER, user_id: USER, name: "Commenter" }]);
    const third = "900000000000000004";
    const a = await submit(base(l.id, { body: "mine" }));
    const o = await submit(base(l.id, { user_id: OTHER, body: "owner's", submitted_at: "2026-10-18T00:30:00.000Z" }));
    const t = await submit(base(l.id, { user_id: third, body: "third" }));
    await approve(l.id, a, { at: "2026-10-18T05:00:00.000Z" });
    await approve(l.id, o, { at: "2026-10-18T04:00:00.000Z" });
    await approve(l.id, t, { at: "2026-10-18T06:00:00.000Z" });
    expect(await comments.like({ layoutId: l.id, authorId: USER, userId: third, via: "discord", at: AT })).toBe(true);
    expect(await comments.like({ layoutId: l.id, authorId: USER, userId: third, via: "discord", at: AT })).toBe(false);
    expect(await comments.like({ layoutId: l.id, authorId: USER, userId: OTHER, via: "discord", at: AT })).toBe(true);
    expect(await comments.like({ layoutId: l.id, authorId: "stranger", userId: OTHER, via: "discord", at: AT })).toBe(false);
    const byLikes = await comments.list({ layoutId: l.id, owner: OTHER, viewer: third, sort: "likes" });
    expect(byLikes.map((r) => [r.user_id, r.likes, r.liked, r.is_author, r.edited])).toEqual([[OTHER, 0, 0, 1, 0], [USER, 2, 1, 0, 0], [third, 0, 0, 0, 0]]);
    expect(byLikes[1]).toMatchObject({ name: "Commenter", id: a.id, approved_at: "2026-10-18T05:00:00.000Z", body: "mine" });
    expect(byLikes[0]!.name).toBeNull();
    const newest = await comments.list({ layoutId: l.id, owner: OTHER, viewer: "", sort: "newest" });
    expect(newest.map((r) => r.user_id)).toEqual([OTHER, third, USER]);
    // Editing marks the slot edited; the likes survive the approved edit.
    const a2 = await submit(base(l.id, { body: "mine, revised", submitted_at: "2026-10-18T07:00:00.000Z" }));
    await approve(l.id, a2, { at: "2026-10-18T08:00:00.000Z" });
    const edited = (await comments.list({ layoutId: l.id, owner: OTHER, viewer: third, sort: "likes" })).find((r) => r.user_id === USER)!;
    expect(edited).toMatchObject({ edited: 1, likes: 2, body: "mine, revised", id: a2.id });
    expect(await comments.list({ layoutId: "no-comments", owner: OTHER, viewer: "", sort: "likes" })).toEqual([]);
    await expectIndexesConsistent();
  });

  it("[LDB-DDB42] unlike, and deleteOwn clears bodies, the slot's likes and the count; edited resets after a delete", async () => {
    const l = await seedLayout();
    const a = await submit(base(l.id));
    await approve(l.id, a);
    await comments.like({ layoutId: l.id, authorId: USER, userId: OTHER, via: "discord", at: AT });
    await comments.like({ layoutId: l.id, authorId: USER, userId: MOD, via: "discord", at: AT });
    expect(await comments.unlike(l.id, USER, OTHER)).toBe(true);
    expect(await comments.unlike(l.id, USER, OTHER)).toBe(false);
    expect(await comments.unlike(l.id, "nobody", OTHER)).toBe(false);
    const rejected = await submit(base(l.id, { body: "pending text", submitted_at: "2026-10-18T02:00:00.000Z" }));
    const at = "2026-10-18T09:00:00.000Z";
    await comments.deleteOwn({ layoutId: l.id, userId: USER, at });
    expect(await comments.get(a.id)).toMatchObject({ status: "deleted", body: null, decided_by: USER, decided_at: at });
    expect(await comments.get(rejected.id)).toMatchObject({ status: "deleted", body: null });
    expect(await comments.hasBody(l.id, USER)).toBe(false);
    expect(await comments.approvedSlotExists(l.id, USER)).toBe(false);
    expect((await scanMain()).filter((i) => i.pk === `CL#${l.id}` || (i.pk === `CLA#${USER}` && String(i.sk).startsWith(`${l.id}#`)))).toEqual([]);
    expect(await itemOf("CC", l.id)).toMatchObject({ count: 0 });
    expect(await comments.counts()).not.toContainEqual(expect.objectContaining({ layout_id: l.id }));
    await expectIndexesConsistent();
  });

  it("[LDB-DDB42] deleteOwn erases a lone rejected text without changing its status", async () => {
    const l = await seedLayout();
    const a = await submit(base(l.id));
    await comments.reject({ id: a.id, by: MOD, at: AT, reason: "no", reviewVersion: 0, event: moderation({ kind: "comment_rejected", layoutId: l.id }), history: history({ kind: "comment", submissionId: a.id, action: "rejected" }) });
    await comments.deleteOwn({ layoutId: l.id, userId: USER, at: "2026-10-18T09:00:00.000Z" });
    expect(await comments.get(a.id)).toMatchObject({ status: "rejected", body: null, reason: "no" });
    await expectIndexesConsistent();
  });

  it("[LDB-DDB42] remove claims an approved comment, keeps the text, clears the likes only when it wins", async () => {
    const l = await seedLayout();
    const a = await submit(base(l.id));
    await approve(l.id, a);
    await comments.like({ layoutId: l.id, authorId: USER, userId: OTHER, via: "discord", at: AT });
    const stale = await comments.remove({ id: a.id, layoutId: l.id, userId: USER, by: MOD, at: AT, reason: "x", reviewVersion: 9 });
    expect(stale).toEqual({ claimed: false });
    expect((await scanMain()).filter((i) => i.pk === `CL#${l.id}`)).toHaveLength(1);
    expect(await comments.remove({ id: a.id, layoutId: l.id, userId: USER, by: MOD, at: AT, reason: "spam", reviewVersion: 0 })).toEqual({ claimed: true });
    expect(await comments.get(a.id)).toMatchObject({ status: "removed", reason: "spam", body: "first words", decided_by: MOD });
    expect((await scanMain()).filter((i) => i.pk === `CL#${l.id}` || (i.pk === `CLA#${USER}` && String(i.sk).startsWith(`${l.id}#`)) || (i.pk === `L#${l.id}` && i.sk === `SET#cl#${USER}`))).toEqual([]);
    expect(await comments.remove({ id: a.id, layoutId: l.id, userId: USER, by: MOD, at: AT, reason: "again", reviewVersion: 0 })).toEqual({ claimed: false });
    await expectIndexesConsistent();
  });

  it("[LDB-DDB42] counts: live layouts with approved text, NOCASE name order then id", async () => {
    const mk = async (name: string, deleted = 0) => {
      const l = await seedLayout({ name, deleted });
      const c = await submit(base(l.id));
      if (deleted === 0) await approve(l.id, c);
      else await comments.approve({ id: c.id, layoutId: l.id, userId: USER, by: MOD, at: AT, reviewVersion: 0, event: moderation({ kind: "comment_approved", layoutId: l.id }), history: history({ kind: "comment", submissionId: c.id, action: "approved" }) });
      return l;
    };
    const [b, a, hidden] = [await mk("zz-banana"), await mk("ZZ-Apple"), await mk("zz-hidden", 1)];
    const second = await submit(base(a.id, { user_id: OTHER }));
    await approve(a.id, second);
    const mine = (await comments.counts()).filter((r) => r.layout_name.toLowerCase().startsWith("zz-"));
    expect(mine).toEqual([{ layout_id: a.id, layout_name: "ZZ-Apple", count: 2 }, { layout_id: b.id, layout_name: "zz-banana", count: 1 }]);
    expect(mine.map((r) => r.layout_id)).not.toContain(hidden.id);
  });

  it("[LDB-DDB42] queue shows the user's live text beside a pending edit; mine lists live layouts with like counts", async () => {
    const l = await seedLayout({ name: "Queue Layout", owner: OTHER });
    const gone = await seedLayout({ deleted: 1 });
    await putItems([{ pk: "AUTHORS", sk: USER, user_id: USER, name: "Queuer" }]);
    const a = await submit(base(l.id, { body: "live one" }));
    await approve(l.id, a);
    await comments.like({ layoutId: l.id, authorId: USER, userId: OTHER, via: "discord", at: AT });
    const edit = await submit(base(l.id, { body: "new draft", submitted_at: "2026-10-18T03:00:00.000Z" }));
    await submit(base(gone.id));
    const q = (await comments.queue("pending")).filter((r) => [l.id, gone.id].includes(r.layout_id));
    expect(q).toHaveLength(1);
    expect(q[0]).toMatchObject({ id: edit.id, layout_name: "Queue Layout", user_name: "Queuer", live_body: "live one" });
    const approvedQ = (await comments.queue("approved")).filter((r) => r.layout_id === l.id);
    expect(approvedQ[0]).toMatchObject({ id: a.id, live_body: null });
    const mine = await comments.mine(USER);
    expect(mine.rows.filter((r) => r.layout_id === l.id).map((r) => [r.id, r.layout_owner, r.layout_name])).toEqual([[a.id, OTHER, "Queue Layout"], [edit.id, OTHER, "Queue Layout"]]);
    expect(mine.rows.some((r) => r.layout_id === gone.id)).toBe(false);
    expect(mine.likeCounts.get(l.id)).toBe(1);
    await expectIndexesConsistent();
  });

  it("[LDB-DDB45] [LDB-DDB47] concurrent approve and reject of one pending row: exactly one claims; concurrent likes keep the slot guard exact", async () => {
    const l = await seedLayout();
    const a = await submit(base(l.id));
    const reject = () => comments.reject({ id: a.id, by: MOD, at: AT, reason: "x", reviewVersion: 0, event: moderation({ kind: "comment_rejected", layoutId: l.id }), history: history({ kind: "comment", submissionId: a.id, action: "rejected" }) });
    const res = await Promise.all([approve(l.id, a), reject(), approve(l.id, a), reject()]);
    expect(res.filter((r) => r.claimed)).toHaveLength(1);
    expect(await review.history("comment", a.id)).toHaveLength(1);
    const b = await submit(base(l.id, { user_id: OTHER, body: "likeable" }));
    await approve(l.id, b);
    const likes = await Promise.all([0, 1, 2].map(() => comments.like({ layoutId: l.id, authorId: OTHER, userId: USER, via: "discord", at: AT })));
    expect(likes.filter(Boolean)).toHaveLength(1);
    const many = await Promise.all(["a1", "a2", "a3", "a4"].map((u) => comments.like({ layoutId: l.id, authorId: OTHER, userId: u, via: "discord", at: AT })));
    expect(many.every(Boolean)).toBe(true);
    expect((await scanMain()).find((i) => i.sk === `SET#cl#${OTHER}`)).toMatchObject({ ver: 5 });
    await expectIndexesConsistent();
  });

  it("[LDB-DDB47] a slot with more likes than one transaction holds is still cleared by remove", async () => {
    const l = await seedLayout();
    const a = await submit(base(l.id));
    await approve(l.id, a);
    const likers = Array.from({ length: 60 }, (_, i) => `liker-${String(i).padStart(3, "0")}`);
    for (const u of likers) await comments.like({ layoutId: l.id, authorId: USER, userId: u, via: "discord", at: AT });
    expect(await comments.remove({ id: a.id, layoutId: l.id, userId: USER, by: MOD, at: AT, reason: null, reviewVersion: 0 })).toEqual({ claimed: true });
    expect((await scanMain()).filter((i) => i.pk === `CL#${l.id}` || (i.pk === `CLA#${USER}` && String(i.sk).startsWith(`${l.id}#`)) || (i.pk === `L#${l.id}` && i.sk === `SET#cl#${USER}`))).toEqual([]);
    await expectIndexesConsistent();
  });

  it("[LDB-DDB42] comment events: every decision's event carries the layout name", async () => {
    expect((await eventsOf("comment_approved")).every((e) => typeof e.name === "string")).toBe(true);
  });
});

describe("[LDB-DDB46] the lane J codec", () => {
  it("[LDB-DDB46] fromItems(toItems(rows)) returns the rows, and derived items are a function of the rows alone", async () => {
    const { communitySchema } = await import("../../src/store/ddb/schema/community");
    const link = { id: "01L1", layout_id: "lay1", url: "https://e.org", submitted_by: "u1", submitted_at: AT, status: "approved", decided_by: "m", decided_at: AT, reason: null, notified_at: AT };
    const w = (n: string, status: string, rv: number) => ({ id: `01W${n}`, layout_id: "lay1", user_id: "u1", wpm: 90 + rv, proof: "https://e.org/p", submitted_by: "u1", via: "discord", submitted_at: AT, status, decided_by: "m", decided_at: AT, reason: null, notified_at: null, review_version: rv, source_message_url: n === "1" ? "https://discord.com/channels/1/2/3" : null });
    const c = (n: string, status: string, body: string | null) => ({ id: `01C${n}`, layout_id: "lay1", user_id: "u1", body, via: "discord", submitted_at: `2026-10-18T0${n}:00:00.000Z`, status, decided_by: "m", decided_at: AT, reason: null, review_version: 0 });
    const rows = {
      link_submissions: [link],
      wpm_submissions: [w("1", "approved", 0), w("2", "rejected", 2)],
      layout_comments: [c("1", "replaced", null), c("2", "approved", "live"), c("3", "pending", "draft")],
      comment_likes: [{ layout_id: "lay1", author_id: "u1", user_id: "u2", via: "discord", created_at: AT }, { layout_id: "lay1", author_id: "u1", user_id: "u3", via: "discord", created_at: AT }],
      moderation_review_history: [
        { id: 7, kind: "wpm", submission_id: "01W2", action: "rejected", actor: "m", at: AT, reason: "r", review_version: 0 },
        { id: 3, kind: "wpm", submission_id: "01W2", action: "reopened", actor: "m", at: AT, reason: null, review_version: 1 },
      ],
    };
    const items = communitySchema.toItems(rows);
    const back = communitySchema.fromItems(items);
    expect(back.link_submissions).toEqual(rows.link_submissions);
    expect(back.wpm_submissions).toEqual(rows.wpm_submissions);
    expect(back.layout_comments).toEqual(rows.layout_comments);
    expect(back.comment_likes).toEqual(rows.comment_likes);
    expect(back.moderation_review_history).toEqual([...rows.moderation_review_history].sort((a, b) => (a.id as number) - (b.id as number)));
    // Counters are sums over the rows: guards count rows + review versions, CC counts live text.
    const by = (pk: string, sk: string) => items.main.find((i) => i.pk === pk && i.sk === sk);
    expect(by("L#lay1", "SET#link")).toMatchObject({ ver: 1 });
    expect(by("L#lay1", "SET#wpm#u1")).toMatchObject({ ver: 2 + 2 });
    expect(by("L#lay1", "SET#cmt#u1")).toMatchObject({ ver: 3 });
    expect(by("L#lay1", "SET#cl#u1")).toMatchObject({ ver: 2 });
    expect(by("CC", "lay1")).toMatchObject({ count: 1 });
    // History ordinals follow id order, and every item is claimed by exactly one table.
    expect(by("SUB#wpm#01W2", "H#000001")).toMatchObject({ id: 3, action: "reopened" });
    expect(items.main.every((i) => communitySchema.tableOf(i) !== null)).toBe(true);
    expect(communitySchema.toItems(rows)).toEqual(items);
  });
});
