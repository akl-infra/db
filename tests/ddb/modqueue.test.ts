// [LDB-DDB55..DDB58] The DynamoDB ModqueueStore (lane K): the notification lease and card bookkeeping, the dirty set that
// replaces the stale-card join, the announce claim and candidate reads, and the delivery gate. Submission, layout and author
// items are seeded the way lanes J/G/I write them (design/aws-port.md §2.3).
import { PutCommand, GetCommand, ScanCommand, DeleteCommand } from "@aws-sdk/lib-dynamodb";
import { beforeEach, describe, expect, it } from "vitest";
import { ddbHarness } from "../harness/ddb";
import { MQGATE_KEY, mqnDirtyKey, mqnKey, submissionKey, type SubKind } from "../../src/store/ddb/keys-discord";

const { raw, tables, store } = ddbHarness;
const T = tables.main;
const q = store.modqueue;
const t0 = "2026-10-25T00:00:00.000Z";
const later = "2026-10-25T01:00:00.000Z";

const put = (item: Record<string, unknown>) => raw.send(new PutCommand({ TableName: T, Item: item }));
const get = async (k: { pk: string; sk: string }) => (await raw.send(new GetCommand({ TableName: T, Key: k, ConsistentRead: true }))).Item;
const hasMark = async (kind: SubKind, id: string) => (await get(mqnDirtyKey(kind, id))) !== undefined;

beforeEach(async () => {
  const all = (await raw.send(new ScanCommand({ TableName: T, ConsistentRead: true }))).Items ?? [];
  for (const i of all) await raw.send(new DeleteCommand({ TableName: T, Key: { pk: i.pk, sk: i.sk } }));
});

const layout = (id: string, name: string, owner = "owner1") => put({ pk: "CAT", sk: id, id, name, owner, deleted: 0 });
const author = (id: string, name: string) => put({ pk: "AUTHORS", sk: id, user_id: id, name });
const link = (id: string, over: Record<string, unknown> = {}) =>
  put({
    ...submissionKey("link", id), id, layout_id: "LAY1", url: `https://example.org/${id}`, submitted_by: "u1", submitted_at: t0, status: "pending",
    decided_by: null, decided_at: null, reason: null, notified_at: null, ...over,
  });
const wpm = (id: string, over: Record<string, unknown> = {}) =>
  put({
    ...submissionKey("wpm", id), id, layout_id: "LAY1", user_id: "u1", wpm: 90, proof: "https://example.org/p", submitted_by: "u1", via: "discord", submitted_at: t0,
    status: "pending", decided_by: null, decided_at: null, reason: null, notified_at: null, review_version: 0, source_message_url: null, ...over,
  });
const comment = (id: string, over: Record<string, unknown> = {}) =>
  put({
    ...submissionKey("comment", id), id, layout_id: "LAY1", user_id: "u1", body: "hello", via: "discord", submitted_at: t0, status: "pending",
    decided_by: null, decided_at: null, reason: null, review_version: 0, ...over,
  });
const idx = (pk: string, sk: string) => put({ pk, sk });

const card = (kind: SubKind, id: string, over: Partial<Parameters<typeof q.insertNotification>[0]> = {}) =>
  q.insertNotification({ kind, id, messageId: `m-${id}`, format: "components_v2", transport: "bot", channelId: "c1", reviewVersion: 0, sourceMessageUrl: null, ...over });

describe("notifications", () => {
  it("[LDB-DDB55] insert is once-only and records a pending card", async () => {
    await card("link", "A");
    await q.insertNotification({ kind: "link", id: "A", messageId: "other", format: "text", transport: "legacy_webhook", channelId: null, reviewVersion: 0, sourceMessageUrl: null });
    expect(await q.notification("link", "A")).toEqual({
      message_id: "m-A", shown_status: "pending", shown_review_version: 0, shown_source_message_url: null, message_format: "components_v2", transport: "bot", channel_id: "c1",
    });
    expect(await q.notification("link", "nope")).toBeNull();
    expect(await hasMark("link", "A")).toBe(true);
  });

  it("[LDB-DDB55] the reconcile lease is taken when free or expired and released only by its holder", async () => {
    await card("wpm", "W");
    expect(await q.leaseNotification("wpm", "W", "tok1", later, t0)).toBe(true);
    expect(await q.leaseNotification("wpm", "W", "tok2", later, t0)).toBe(false); // held
    expect(await q.leaseNotification("wpm", "W", "tok3", "2026-10-25T02:00:00.000Z", later)).toBe(false); // lease_until == now is not expired
    expect(await q.leaseNotification("wpm", "W", "tok3", "2026-10-25T02:00:00.000Z", "2026-10-25T01:00:00.001Z")).toBe(true); // expired
    await q.releaseNotificationLease("wpm", "W", "tok1"); // not the holder
    expect(await q.leaseNotification("wpm", "W", "tok4", later, t0)).toBe(false);
    await q.releaseNotificationLease("wpm", "W", "tok3");
    expect(await q.leaseNotification("wpm", "W", "tok4", later, t0)).toBe(true);
    expect(await q.leaseNotification("link", "ghost", "t", later, t0)).toBe(false); // no row: an UPDATE changes nothing
    expect(await get(mqnKey("link", "ghost"))).toBeUndefined();
  });

  it("[LDB-DDB55] markShown needs the lease; it records the card and resets the failure count", async () => {
    await card("comment", "C");
    await q.bumpFailedAttempts("comment", "C");
    await q.bumpFailedAttempts("comment", "C");
    await q.bumpFailedAttempts("comment", "ghost");
    expect(await get(mqnKey("comment", "ghost"))).toBeUndefined();
    expect((await get(mqnKey("comment", "C")))?.failed_attempts).toBe(2);
    await q.leaseNotification("comment", "C", "tok", later, t0);
    await q.markShown({ kind: "comment", id: "C", status: "approved", reviewVersion: 3, sourceMessageUrl: null, leaseToken: "other" });
    expect((await q.notification("comment", "C"))?.shown_status).toBe("pending");
    await q.markShown({ kind: "comment", id: "C", status: "approved", reviewVersion: 3, sourceMessageUrl: null, leaseToken: "tok" });
    expect(await q.notification("comment", "C")).toMatchObject({ shown_status: "approved", shown_review_version: 3 });
    expect((await get(mqnKey("comment", "C")))?.failed_attempts).toBe(0);
  });

  it("[LDB-DDB55] deleteNotification removes the card and its mark", async () => {
    await card("link", "D");
    await q.deleteNotification("link", "D");
    expect(await q.notification("link", "D")).toBeNull();
    expect(await hasMark("link", "D")).toBe(false);
  });
});

describe("stale cards", () => {
  const mark = (kind: SubKind, id: string) => put({ ...mqnDirtyKey(kind, id) });

  it("[LDB-DDB56] a card is stale exactly when D1's join would say so, fewest failures first, limited", async () => {
    await layout("LAY1", "Layout One");
    // link: status moved on
    await link("L1");
    await card("link", "L1");
    await link("L2", { status: "approved" });
    await card("link", "L2"); // shows 'pending'
    // link: in sync
    await link("L3");
    await card("link", "L3");
    // wpm: version moved / url differs / in sync
    await wpm("W1", { review_version: 2 });
    await card("wpm", "W1", { reviewVersion: 1 });
    await wpm("W2", { source_message_url: "https://discord.com/x" });
    await card("wpm", "W2");
    await wpm("W3");
    await card("wpm", "W3");
    // comment: version moved / in sync
    await comment("C1", { review_version: 1 });
    await card("comment", "C1", { reviewVersion: 0 });
    await comment("C2");
    await card("comment", "C2");
    for (const [k, i] of [["link", "L1"], ["link", "L2"], ["link", "L3"], ["wpm", "W1"], ["wpm", "W2"], ["wpm", "W3"], ["comment", "C1"], ["comment", "C2"]] as const) await mark(k, i);
    // a mark with no card, and a stale-looking card with no mark (not found: J marks every change)
    await mark("link", "ORPHAN");
    await link("L2"); // restore L2 to pending so only L1.. remain
    await link("L2", { status: "approved" });
    await q.bumpFailedAttempts("link", "L2");
    await q.bumpFailedAttempts("link", "L2");
    await q.bumpFailedAttempts("wpm", "W1");

    // L1 shows pending and is pending: in sync. Make it stale by a status change.
    await link("L1", { status: "rejected" });
    const stale = await q.staleNotifications(50);
    expect(stale.map((s) => `${s.kind}:${s.submission_id}`).sort()).toEqual(["comment:C1", "link:L1", "link:L2", "wpm:W1", "wpm:W2"]);
    // fewest failed attempts first: L2 has 2, W1 has 1, the rest 0
    const order = stale.map((s) => s.submission_id);
    expect(order.indexOf("W1")).toBeGreaterThan(order.indexOf("L1"));
    expect(order[order.length - 1]).toBe("L2");
    expect(await q.staleNotifications(2)).toHaveLength(2);

    // in-sync and orphaned marks were dropped; stale ones kept
    expect(await hasMark("link", "L3")).toBe(false);
    expect(await hasMark("wpm", "W3")).toBe(false);
    expect(await hasMark("comment", "C2")).toBe(false);
    expect(await hasMark("link", "ORPHAN")).toBe(false);
    expect(await hasMark("link", "L1")).toBe(true);
    expect(await hasMark("wpm", "W1")).toBe(true);
  });

  it("[LDB-DDB56] markShown drops the mark only when the source agrees with what the card now shows", async () => {
    await link("A", { status: "approved" });
    await card("link", "A");
    await q.leaseNotification("link", "A", "tok", later, t0);
    await q.markShown({ kind: "link", id: "A", status: "approved", reviewVersion: 0, sourceMessageUrl: null, leaseToken: "tok" });
    expect(await hasMark("link", "A")).toBe(false);
    expect(await q.staleNotifications(10)).toEqual([]);

    // the source moved on while the edit was in flight: the card shows 'approved', the source says 'rejected'
    await link("B", { status: "rejected" });
    await card("link", "B");
    await q.leaseNotification("link", "B", "tok", later, t0);
    await q.markShown({ kind: "link", id: "B", status: "approved", reviewVersion: 0, sourceMessageUrl: null, leaseToken: "tok" });
    expect(await hasMark("link", "B")).toBe(true);
    expect(await q.staleNotifications(10)).toEqual([{ kind: "link", submission_id: "B" }]);

    // a wpm card compares the receipt url too
    await wpm("C", { status: "approved", source_message_url: "https://discord.com/m/1" });
    await card("wpm", "C");
    await q.leaseNotification("wpm", "C", "tok", later, t0);
    await q.markShown({ kind: "wpm", id: "C", status: "approved", reviewVersion: 0, sourceMessageUrl: "https://discord.com/m/OLD", leaseToken: "tok" });
    expect(await hasMark("wpm", "C")).toBe(true);
    await q.markShown({ kind: "wpm", id: "C", status: "approved", reviewVersion: 0, sourceMessageUrl: "https://discord.com/m/1", leaseToken: "tok" });
    expect(await hasMark("wpm", "C")).toBe(false);
  });

  it("[LDB-DDB56] a source change that lands after the read keeps its mark", async () => {
    await link("R", { status: "pending" });
    await card("link", "R");
    // J changes the source and re-puts the mark between the reconciler's read and its clean-up: simulated by clearing with stale values
    await link("R", { status: "approved" });
    await put({ ...mqnDirtyKey("link", "R") });
    expect(await q.staleNotifications(10)).toEqual([{ kind: "link", submission_id: "R" }]);
    expect(await hasMark("link", "R")).toBe(true);
  });
});

describe("announce", () => {
  it("[LDB-DDB57] the announce claim is at-most-once and released only by its claimant", async () => {
    await link("A");
    await wpm("W");
    expect(await q.claimAnnounce("link", "A", t0)).toBe(true);
    expect(await q.claimAnnounce("link", "A", later)).toBe(false);
    await q.releaseAnnounce("link", "A", later); // not the claimant's stamp
    expect(await q.claimAnnounce("link", "A", later)).toBe(false);
    await q.releaseAnnounce("link", "A", t0);
    expect(await q.claimAnnounce("link", "A", later)).toBe(true);
    expect((await get(submissionKey("link", "A")))?.notified_at).toBe(later);
    expect(await q.claimAnnounce("wpm", "W", t0)).toBe(true);
    await link("D", { status: "approved" });
    expect(await q.claimAnnounce("link", "D", t0)).toBe(false); // decided already
    expect(await q.claimAnnounce("link", "missing", t0)).toBe(false);
    expect(await get(submissionKey("link", "missing"))).toBeUndefined();
    await expect(q.claimAnnounce("comment", "x", t0)).rejects.toThrow(/no notified_at/);
  });

  it("[LDB-DDB57] candidates are pending and unannounced, oldest first, joined to layout and author names", async () => {
    await layout("LAY1", "Layout One");
    await author("u1", "Alice");
    for (const [id, at] of [["L3", "2026-10-25T00:00:03.000Z"], ["L1", "2026-10-25T00:00:01.000Z"], ["L2", "2026-10-25T00:00:02.000Z"], ["L4", "2026-10-25T00:00:04.000Z"]] as const) {
      await link(id, { submitted_at: at, submitted_by: id === "L2" ? "ghost" : "u1" });
      await idx("IX#link#st#pending", `${at}#${id}`);
    }
    await link("LN", { submitted_at: "2026-10-25T00:00:00.500Z", notified_at: t0 }); // announced
    await idx("IX#link#st#pending", "2026-10-25T00:00:00.500Z#LN");
    await link("LX", { submitted_at: "2026-10-25T00:00:00.100Z", layout_id: "GONE" }); // layout missing: an inner join drops it
    await idx("IX#link#st#pending", "2026-10-25T00:00:00.100Z#LX");
    const all = await q.linkCandidates(10);
    expect(all.map((c) => c.id)).toEqual(["L1", "L2", "L3", "L4"]);
    expect(all[0]).toEqual({ id: "L1", layout_id: "LAY1", url: "https://example.org/L1", submitted_by: "u1", layout_name: "Layout One", submitter_name: "Alice" });
    expect(all[1]!.submitter_name).toBeNull();
    expect((await q.linkCandidates(2)).map((c) => c.id)).toEqual(["L1", "L2"]);
    expect(await q.linkCandidates(0)).toEqual([]);

    await wpm("W1", { submitted_at: "2026-10-25T00:00:01.000Z", review_version: 2, source_message_url: "https://discord.com/m/1" });
    await idx("IX#wpm#st#pending", "2026-10-25T00:00:01.000Z#W1");
    expect(await q.wpmCandidates(5)).toEqual([
      { id: "W1", review_version: 2, source_message_url: "https://discord.com/m/1", layout_id: "LAY1", user_id: "u1", wpm: 90, proof: "https://example.org/p", layout_name: "Layout One", user_name: "Alice" },
    ]);
  });

  it("[LDB-DDB57] a comment candidate reports the live comment of the same pair", async () => {
    await layout("LAY1", "Layout One", "ownerX");
    await author("u1", "Alice");
    await comment("P", { body: "new text" });
    await idx("IX#cmt#pair#LAY1#u1", `${t0}#P`);
    expect(await q.commentCandidate("P")).toEqual({
      id: "P", review_version: 0, layout_id: "LAY1", user_id: "u1", body: "new text", layout_name: "Layout One", layout_owner: "ownerX", user_name: "Alice", has_live: 0, live_body: null,
    });
    await comment("OLD1", { status: "approved", body: "first", decided_at: "2026-10-01T00:00:00.000Z" });
    await comment("OLD2", { status: "approved", body: "second", decided_at: "2026-10-02T00:00:00.000Z" });
    await comment("OLD3", { status: "approved", body: null, decided_at: "2026-10-03T00:00:00.000Z" });
    await comment("REJ", { status: "rejected", body: null });
    for (const id of ["OLD1", "OLD2", "OLD3", "REJ"]) await idx("IX#cmt#pair#LAY1#u1", `${t0}#${id}`);
    expect(await q.commentCandidate("P")).toMatchObject({ has_live: 1, live_body: "second" });
    expect(await q.commentCandidate("OLD1")).toBeNull(); // not pending
    expect(await q.commentCandidate("nope")).toBeNull();
    await comment("NB", { body: null });
    expect(await q.commentCandidate("NB")).toBeNull(); // pending without a body
  });

  it("[LDB-DDB57] sourceStatus reads the submission with the decider's name", async () => {
    await author("mod1", "Moddy");
    await wpm("W", { status: "rejected", decided_by: "mod1", reason: "no", review_version: 4, source_message_url: "https://discord.com/m/9" });
    await link("L", { status: "approved", decided_by: "ghost", submitted_by: "sub1" });
    await comment("C", { review_version: 2 });
    expect(await q.sourceStatus("wpm", "W")).toEqual({ status: "rejected", reason: "no", submitter_id: "u1", source_message_url: "https://discord.com/m/9", review_version: 4, decider_name: "Moddy" });
    expect(await q.sourceStatus("link", "L")).toEqual({ status: "approved", reason: null, submitter_id: "sub1", source_message_url: null, review_version: 0, decider_name: null });
    expect(await q.sourceStatus("comment", "C")).toMatchObject({ review_version: 2, submitter_id: "u1", decider_name: null });
    expect(await q.sourceStatus("comment", "none")).toBeNull();
  });
});

describe("delivery gate", () => {
  it("[LDB-DDB58] claim, defer (never backwards) and release follow the D1 CASes, on a row that does not exist yet", async () => {
    expect(await get(MQGATE_KEY)).toBeUndefined();
    expect(await q.claimDeliveryGate("a", 10_000, 1_000)).toBe(true);
    expect(await q.claimDeliveryGate("b", 20_000, 5_000)).toBe(false); // leased until 10_000
    await q.deferDeliveryGate("b", 50_000); // not the holder
    expect((await get(MQGATE_KEY))?.retry_at).toBe(0);
    await q.deferDeliveryGate("a", 7_000);
    await q.deferDeliveryGate("a", 6_000); // MAX: no backwards move
    expect((await get(MQGATE_KEY))?.retry_at).toBe(7_000);
    await q.releaseDeliveryGate("b"); // not the holder
    expect((await get(MQGATE_KEY))?.lease_token).toBe("a");
    await q.releaseDeliveryGate("a");
    expect(await get(MQGATE_KEY)).toMatchObject({ lease_token: null, lease_until: 0 });
    expect(await q.claimDeliveryGate("c", 30_000, 6_999)).toBe(false); // retry_at 7_000 still ahead
    expect(await q.claimDeliveryGate("c", 30_000, 7_000)).toBe(true); // retry_at <= now
    expect(await q.claimDeliveryGate("d", 40_000, 30_000)).toBe(true); // lease_until <= now: expired
  });

  it("[LDB-DDB58] only one of many concurrent claimants wins", async () => {
    const wins = await Promise.all(Array.from({ length: 12 }, (_, i) => q.claimDeliveryGate(`t${i}`, 100_000, 1_000)));
    expect(wins.filter(Boolean)).toHaveLength(1);
  });
});
