// [LDB-DDB61..DDB62] The DynamoDB OutboxStore (lane K): due selection, the lease CAS and fencing, the due index moving with
// every status change, the global deferral, and the content read. Outbox rows are inserted with lane J's helper
// (`outboxInsertItems`), submissions and layouts are seeded the way lanes J/G write them.
import { DeleteCommand, GetCommand, PutCommand, ScanCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { beforeEach, describe, expect, it } from "vitest";
import type { RejectionOutboxRow } from "../../src/core/rejection-dm";
import { ddbHarness } from "../harness/ddb";
import { outboxInsertItems, outboxKey, submissionKey, type OutboxInsert } from "../../src/store/ddb/keys-discord";
import { discordSchema } from "../../src/store/ddb/schema/discord";

const { raw, tables, store } = ddbHarness;
const T = tables.main;
const o = store.outbox;
const base = Date.parse("2026-10-25T12:00:00.000Z");
const iso = (secs: number) => new Date(base + secs * 1000).toISOString();
const now = iso(0);

const get = async (k: { pk: string; sk: string }) => (await raw.send(new GetCommand({ TableName: T, Key: k, ConsistentRead: true }))).Item;
const put = (item: Record<string, unknown>) => raw.send(new PutCommand({ TableName: T, Item: item }));
const scan = async () => (await raw.send(new ScanCommand({ TableName: T, ConsistentRead: true }))).Items ?? [];

beforeEach(async () => {
  for (const i of await scan()) await raw.send(new DeleteCommand({ TableName: T, Key: { pk: i.pk, sk: i.sk } }));
});

let seq = 100;
async function enqueue(key: string, over: Partial<OutboxInsert> = {}): Promise<OutboxInsert> {
  const row: OutboxInsert = {
    delivery_key: key, event_seq: ++seq, kind: "comment", submission_id: `S-${key}`, layout_id: "LAY1", recipient_id: "u1", nonce: `n-${key}`.slice(0, 25),
    next_attempt_at: now, created_at: now, updated_at: now, review_version: 0, decision: "rejection", ...over,
  };
  await raw.send(new TransactWriteCommand({ TransactItems: outboxInsertItems(T, row).map((x) => x.item) }));
  return row;
}
/** Make a stored row look like `fields` (and re-derive its index, as a harness insert would). */
async function setRow(key: string, fields: Record<string, unknown>) {
  const row = { ...(await get(outboxKey(key)))!, ...fields };
  for (const i of await scan()) if (i.pk === "IX#dmo#due" && (i.sk as string).endsWith(`#${key}`)) await raw.send(new DeleteCommand({ TableName: T, Key: { pk: i.pk, sk: i.sk } }));
  const { pk: _a, sk: _b, ...cols } = row;
  void _a; void _b;
  for (const it of discordSchema.toItems({ discord_rejection_dm_outbox: [cols] }).main) await put(it);
}
const status = async (key: string) => (await get(outboxKey(key)))?.status;

/** The stored due index equals the one the stored rows imply (the checker N's job will generalise). */
async function expectIndexConsistent() {
  const items = await scan();
  const rows = discordSchema.fromItems({ main: items, ephemeral: [] }).discord_rejection_dm_outbox!;
  const want = discordSchema.toItems({ discord_rejection_dm_outbox: rows }).main.filter((i) => i.pk === "IX#dmo#due").map((i) => i.sk).sort();
  const have = items.filter((i) => i.pk === "IX#dmo#due").map((i) => i.sk).sort();
  expect(have).toEqual(want);
  const claims = items.filter((i) => (i.pk as string).startsWith("DMO#seq#") || (i.pk as string).startsWith("DMO#nonce#")).length;
  expect(claims).toBe(rows.length * 2);
}

describe("due and lease", () => {
  it("[LDB-DDB61] due lists pending rows past next_attempt_at and expired leases, by (next_attempt_at, event_seq)", async () => {
    await enqueue("P-late", { next_attempt_at: iso(-10) });
    await enqueue("P-early", { next_attempt_at: iso(-20) });
    await enqueue("P-tie", { next_attempt_at: iso(-10), event_seq: 5 });
    await enqueue("P-future", { next_attempt_at: iso(10) });
    await enqueue("P-now", { next_attempt_at: now });
    await enqueue("L-expired", { next_attempt_at: iso(-30) });
    await setRow("L-expired", { status: "leased", lease_token: "x", lease_until: iso(-1) });
    await enqueue("L-active", { next_attempt_at: iso(-30) });
    await setRow("L-active", { status: "leased", lease_token: "y", lease_until: iso(5) });
    await enqueue("SENT");
    await setRow("SENT", { status: "sent" });
    const due = await o.due(now, 10);
    expect(due.map((r) => r.delivery_key)).toEqual(["L-expired", "P-early", "P-tie", "P-late", "P-now"]);
    expect(due[0]).toMatchObject({ status: "leased", lease_token: "x", decision: "rejection", kind: "comment", review_version: 0, ambiguous_message_attempt_at: null });
    expect(Object.keys(due[0]!).sort()).toEqual(
      ["ambiguous_message_attempt_at", "attempts", "decision", "delivery_key", "event_seq", "kind", "layout_id", "lease_token", "lease_until", "next_attempt_at", "nonce", "recipient_id", "review_version", "status", "submission_id"],
    );
    expect((await o.due(now, 2)).map((r) => r.delivery_key)).toEqual(["L-expired", "P-early"]);
    await expectIndexConsistent();
  });

  it("[LDB-DDB61] lease takes a due row once, counts the attempt and moves the index; a later lease needs the first to expire", async () => {
    await enqueue("A", { next_attempt_at: iso(-5) });
    await enqueue("FUT", { next_attempt_at: iso(5) });
    expect(await o.lease("FUT", "t", iso(60), now)).toBe(false);
    expect(await o.lease("missing", "t", iso(60), now)).toBe(false);
    expect(await o.lease("A", "t1", iso(60), now)).toBe(true);
    expect(await o.lease("A", "t2", iso(120), iso(30))).toBe(false); // lease_until 60 still ahead
    expect(await get(outboxKey("A"))).toMatchObject({ status: "leased", lease_token: "t1", lease_until: iso(60), attempts: 1, updated_at: now });
    await expectIndexConsistent();
    expect(await o.lease("A", "t2", iso(180), iso(60))).toBe(true); // lease_until <= now
    expect(await get(outboxKey("A"))).toMatchObject({ lease_token: "t2", attempts: 2 });
    await expectIndexConsistent();
  });

  it("[LDB-DDB61] only one of many concurrent workers leases a row", async () => {
    await enqueue("RACE", { next_attempt_at: iso(-5) });
    const won = await Promise.all(Array.from({ length: 10 }, (_, i) => o.lease("RACE", `w${i}`, iso(60), now)));
    expect(won.filter(Boolean)).toHaveLength(1);
    expect((await get(outboxKey("RACE")))?.attempts).toBe(1);
    await expectIndexConsistent();
  });
});

describe("under a lease", () => {
  it("[LDB-DDB61] beginMessage needs a live lease and keeps the first ambiguous mark", async () => {
    await enqueue("B", { next_attempt_at: iso(-5) });
    expect(await o.beginMessage({ deliveryKey: "B", token: "t", at: now, channelId: "dm1" })).toBe(false); // not leased
    await o.lease("B", "t", iso(60), now);
    expect(await o.beginMessage({ deliveryKey: "B", token: "wrong", at: now, channelId: "dm1" })).toBe(false);
    expect(await o.beginMessage({ deliveryKey: "B", token: "t", at: iso(60), channelId: "dm1" })).toBe(false); // lease_until > at fails
    expect(await o.beginMessage({ deliveryKey: "B", token: "t", at: iso(10), channelId: "dm1" })).toBe(true);
    expect(await o.beginMessage({ deliveryKey: "B", token: "t", at: iso(20), channelId: "dm2" })).toBe(true);
    expect(await get(outboxKey("B"))).toMatchObject({ ambiguous_message_attempt_at: iso(10), dm_channel_id: "dm2", updated_at: iso(20) });
    await o.clearAmbiguous({ deliveryKey: "B", token: "other", at: iso(30) });
    expect((await get(outboxKey("B")))?.ambiguous_message_attempt_at).toBe(iso(10));
    await o.clearAmbiguous({ deliveryKey: "B", token: "t", at: iso(30) });
    expect(await get(outboxKey("B"))).toMatchObject({ ambiguous_message_attempt_at: null, updated_at: iso(30) });
    expect(await o.beginMessage({ deliveryKey: "B", token: "t", at: iso(40), channelId: "dm3" })).toBe(true);
    expect((await get(outboxKey("B")))?.ambiguous_message_attempt_at).toBe(iso(40));
  });

  it("[LDB-DDB61] markSent, retry and terminal act only for the lease holder, and the index follows", async () => {
    for (const k of ["S", "R", "T"]) {
      await enqueue(k, { next_attempt_at: iso(-5) });
      await o.lease(k, `tok-${k}`, iso(5000), now);
    }
    await o.markSent({ deliveryKey: "S", token: "stale", messageId: "dm-msg", at: iso(1) });
    expect(await status("S")).toBe("leased");
    await o.markSent({ deliveryKey: "S", token: "tok-S", messageId: "dm-msg", at: iso(1) });
    expect(await get(outboxKey("S"))).toMatchObject({ status: "sent", discord_message_id: "dm-msg", sent_at: iso(1), updated_at: iso(1), lease_token: null, lease_until: null });

    await o.retry({ deliveryKey: "R", token: "stale", at: iso(2), nextAttemptAt: iso(300), error: "http_500" });
    expect(await status("R")).toBe("leased");
    await o.retry({ deliveryKey: "R", token: "tok-R", at: iso(2), nextAttemptAt: iso(300), error: "http_500" });
    expect(await get(outboxKey("R"))).toMatchObject({ status: "pending", next_attempt_at: iso(300), last_error_class: "http_500", lease_token: null });
    expect((await o.due(now, 10)).map((r) => r.delivery_key)).toEqual([]);
    expect((await o.due(iso(300), 10)).map((r) => r.delivery_key)).toEqual(["R"]);

    await o.terminal({ deliveryKey: "T", token: "tok-T", at: iso(3), status: "blocked", error: "dm_closed" });
    expect(await get(outboxKey("T"))).toMatchObject({ status: "blocked", last_error_class: "dm_closed", lease_token: null, updated_at: iso(3) });
    await o.terminal({ deliveryKey: "T", token: "tok-T", at: iso(4), status: "failed", error: "again" }); // no longer leased: ignored
    expect((await get(outboxKey("T")))?.status).toBe("blocked");
    await expectIndexConsistent();
  });

  it("[LDB-DDB61] deferAllPending pushes pending rows to at least `until` and stamps them all, leaving leased rows alone", async () => {
    await enqueue("EARLY", { next_attempt_at: iso(-60) });
    await enqueue("LATER", { next_attempt_at: iso(900) });
    await enqueue("LEASED", { next_attempt_at: iso(-60) });
    await o.lease("LEASED", "t", iso(5000), now);
    await enqueue("DONE", { next_attempt_at: iso(-60) });
    await setRow("DONE", { status: "sent" });
    await o.deferAllPending(iso(600), iso(7));
    expect(await get(outboxKey("EARLY"))).toMatchObject({ next_attempt_at: iso(600), updated_at: iso(7) });
    expect(await get(outboxKey("LATER"))).toMatchObject({ next_attempt_at: iso(900), updated_at: iso(7) }); // MAX: never earlier
    expect(await get(outboxKey("LEASED"))).toMatchObject({ next_attempt_at: iso(-60), updated_at: now });
    expect(await get(outboxKey("DONE"))).toMatchObject({ next_attempt_at: iso(-60), updated_at: now });
    expect((await o.due(iso(500), 10)).map((r) => r.delivery_key)).toEqual([]);
    expect((await o.due(iso(700), 10)).map((r) => r.delivery_key)).toEqual(["EARLY"]);
    await expectIndexConsistent();
  });
});

describe("content", () => {
  const sub = (kind: "comment" | "link" | "wpm", id: string, over: Record<string, unknown>) =>
    put({ ...submissionKey(kind, id), id, layout_id: "LAY1", status: "rejected", reason: "because", decided_by: "mod", ...over });
  const row = (kind: "comment" | "link" | "wpm", id: string, over: Partial<RejectionOutboxRow> = {}) =>
    ({ decision: "rejection", delivery_key: `k-${id}`, event_seq: 1, review_version: 0, nonce: "n", kind, submission_id: id, layout_id: "LAY1", recipient_id: "u1", status: "leased", attempts: 1, next_attempt_at: now, lease_token: "t", lease_until: iso(60), ambiguous_message_attempt_at: null, ...over }) as RejectionOutboxRow;

  it("[LDB-DDB61] reads the submission and layout, and says whether the row's decision still stands", async () => {
    await put({ pk: "CAT", sk: "LAY1", id: "LAY1", name: "Layout One", owner: "o", deleted: 0 });
    await put({ pk: "CAT", sk: "LAY2", id: "LAY2", name: "Gone", owner: "o", deleted: 1 });
    await sub("comment", "C", { user_id: "u1", body: "text", review_version: 2 });
    await sub("comment", "CNB", { user_id: "u1", body: null, review_version: 2 });
    await sub("wpm", "W", { user_id: "u1", wpm: 88, proof: "https://p", review_version: 1 });
    await sub("link", "L", { submitted_by: "u1", url: "https://l", status: "approved" });
    await sub("wpm", "WD", { user_id: "u1", wpm: 70, proof: "https://p", review_version: 0, layout_id: "LAY2" });

    expect(await o.content(row("comment", "C", { review_version: 2 }))).toEqual({
      recipient_id: "u1", reason: "because", layout_name: "Layout One", deleted: 0, comment_body: "text", wpm: null, proof: null, link_url: null, eligible: 1,
    });
    expect(await o.content(row("comment", "C", { review_version: 1 }))).toMatchObject({ eligible: 0 }); // a newer cycle
    expect(await o.content(row("comment", "C", { review_version: 2, decision: "approval" }))).toMatchObject({ eligible: 0 }); // status is rejected
    expect(await o.content(row("comment", "CNB", { review_version: 2 }))).toMatchObject({ eligible: 0, comment_body: null }); // body erased
    expect(await o.content(row("wpm", "W", { review_version: 1 }))).toMatchObject({ wpm: 88, proof: "https://p", comment_body: null, eligible: 1 });
    expect(await o.content(row("link", "L", { decision: "approval" }))).toBeNull(); // link approvals are never DM'd
    expect(await o.content(row("link", "L", { review_version: 99 }))).toMatchObject({ link_url: "https://l", eligible: 0 }); // approved, not rejected; links ignore the version
    expect(await o.content(row("wpm", "WD", { layout_id: "LAY2" }))).toMatchObject({ deleted: 1, layout_name: "Gone" });
    expect(await o.content(row("wpm", "nope"))).toBeNull();
    expect(await o.content(row("wpm", "W", { layout_id: "OTHER" }))).toBeNull();
  });
});
