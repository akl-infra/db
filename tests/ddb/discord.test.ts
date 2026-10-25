// [LDB-DDB59..DDB63] The DynamoDB DiscordStore (lane K): the receipt claim across the four interaction tables, the action
// lifecycle and prunes, the atomic consume-and-queue pairs, and the lane's schema round trip.
import { DeleteCommand, GetCommand, PutCommand, ScanCommand } from "@aws-sdk/lib-dynamodb";
import { beforeEach, describe, expect, it } from "vitest";
import { DuplicateInteractionError, type ActionTable } from "../../src/store/port";
import { ddbHarness } from "../harness/ddb";
import { actionKey, denyModalKey, interactionClaimKey, mqnKey, reopenConfKey, submissionKey } from "../../src/store/ddb/keys-discord";
import { discordSchema, normalize } from "../../src/store/ddb/schema/discord";

const { raw, tables, store } = ddbHarness;
const T = tables.main;
const d = store.discord;
const t0 = "2026-10-25T00:00:00.000Z";
const t1 = "2026-10-25T01:00:00.000Z";
const t2 = "2026-10-25T02:00:00.000Z";
const PA: ActionTable = "discord_pending_actions";
const RA: ActionTable = "discord_reopen_actions";

const get = async (k: { pk: string; sk: string }) => (await raw.send(new GetCommand({ TableName: T, Key: k, ConsistentRead: true }))).Item;
const put = (item: Record<string, unknown>) => raw.send(new PutCommand({ TableName: T, Item: item }));

beforeEach(async () => {
  const all = (await raw.send(new ScanCommand({ TableName: T, ConsistentRead: true }))).Items ?? [];
  for (const i of all) await raw.send(new DeleteCommand({ TableName: T, Key: { pk: i.pk, sk: i.sk } }));
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const action = (id: string, over: Record<string, unknown> = {}): any => ({
  interaction_id: id, application_id: "app", token: `tok-${id}`, actor_id: "mod", actor_name: "Mod", kind: "link" as const, action: "approve" as const, submission_id: "S1",
  channel_id: "c", message_id: "m", guild_id: "g", created_at: t0, expires_at: t2, expected_review_version: 0, ...over,
});

describe("interaction receipts", () => {
  it("[LDB-DDB59] an interaction id is held once across all four tables", async () => {
    await d.insertAction(PA, action("I1"));
    expect(await d.hasReceipt("I1")).toBe(true);
    expect(await d.hasReceipt("I2")).toBe(false);
    await expect(d.insertAction(PA, action("I1"))).rejects.toBeInstanceOf(DuplicateInteractionError);
    await expect(d.insertAction(RA, action("I1", { action: "reopen", expected_status: "approved" }))).rejects.toBeInstanceOf(DuplicateInteractionError);
    await d.insertDenyModal({ modalId: "M1", initialInteractionId: "I3", actorId: "mod", kind: "link", submissionId: "S1", channelId: "c", messageId: "m", guildId: "g", createdAt: t0, expiresAt: t2, expectedReviewVersion: 0 });
    expect(await d.hasReceipt("I3")).toBe(true);
    await expect(d.insertDenyModal({ modalId: "M2", initialInteractionId: "I3", actorId: "mod", kind: "link", submissionId: "S1", channelId: "c", messageId: "m", guildId: "g", createdAt: t0, expiresAt: t2, expectedReviewVersion: 0 })).rejects.toBeInstanceOf(DuplicateInteractionError);
    await expect(d.insertDenyModal({ modalId: "M1", initialInteractionId: "I9", actorId: "mod", kind: "link", submissionId: "S1", channelId: "c", messageId: "m", guildId: "g", createdAt: t0, expiresAt: t2, expectedReviewVersion: 0 })).rejects.toBeInstanceOf(DuplicateInteractionError);
    expect(await d.hasReceipt("I9")).toBe(false); // the failed insert left no claim behind
    expect(await get(denyModalKey("M2"))).toBeUndefined();
  });

  it("[LDB-DDB59] the modal is consumed and the deny queued atomically; a replay or an id clash changes nothing", async () => {
    const modal = { modalId: "M", initialInteractionId: "I0", actorId: "mod", kind: "wpm" as const, submissionId: "S", channelId: "c", messageId: "m", guildId: "g", createdAt: t0, expiresAt: t2, expectedReviewVersion: 3 };
    await d.insertDenyModal(modal);
    expect(await d.denyModal("M")).toEqual({ actor_id: "mod", kind: "wpm", submission_id: "S", channel_id: "c", message_id: "m", guild_id: "g", expires_at: t2, consumed_at: null, expected_review_version: 3 });
    expect(await d.denyModal("none")).toBeNull();
    const deny = (id: string) => ({ ...action(id, { action: "deny", kind: "wpm", submission_id: "S", reason: "no", expected_review_version: 3 }) });
    // wrong actor / expired: nothing consumed, no action
    expect(await d.consumeModalAndQueueDeny({ modalId: "M", actorId: "other", at: t1, action: deny("I1") })).toBe(false);
    expect(await d.consumeModalAndQueueDeny({ modalId: "M", actorId: "mod", at: t2, action: deny("I1") })).toBe(false); // expires_at > at fails
    expect(await d.consumeModalAndQueueDeny({ modalId: "none", actorId: "mod", at: t1, action: deny("I1") })).toBe(false);
    expect(await get(actionKey(PA, "I1"))).toBeUndefined();
    // an id already taken: Duplicate, and the modal stays unconsumed
    await d.insertAction(PA, action("TAKEN"));
    await expect(d.consumeModalAndQueueDeny({ modalId: "M", actorId: "mod", at: t1, action: deny("TAKEN") })).rejects.toBeInstanceOf(DuplicateInteractionError);
    expect((await d.denyModal("M"))?.consumed_at).toBeNull();
    // the real thing
    expect(await d.consumeModalAndQueueDeny({ modalId: "M", actorId: "mod", at: t1, action: deny("I1") })).toBe(true);
    expect((await d.denyModal("M"))?.consumed_at).toBe(t1);
    expect(await get(actionKey(PA, "I1"))).toMatchObject({ action: "deny", reason: "no", response_mode: "update", state: "pending", expected_review_version: 3, attempts: 0 });
    expect(await d.hasReceipt("I1")).toBe(true);
    expect(await d.consumeModalAndQueueDeny({ modalId: "M", actorId: "mod", at: t1, action: deny("I2") })).toBe(false); // already submitted
    expect(await d.hasReceipt("I2")).toBe(false);
  });

  it("[LDB-DDB59] a reopen confirmation is consumed once, by cancel or by queueing the reopen", async () => {
    await put({ ...reopenConfKey("C1"), ...normalize("discord_reopen_confirmations", { confirmation_id: "C1", initial_interaction_id: "I0", actor_id: "mod", kind: "wpm", submission_id: "S", channel_id: "c", message_id: "m", guild_id: "g", expected_status: "approved", expected_review_version: 1, created_at: t0, expires_at: t1 }) });
    await put({ ...interactionClaimKey("I0"), tbl: "discord_reopen_confirmations" });
    expect((await d.reopenConfirmation("C1"))?.expected_review_version).toBe(1);
    expect(await d.reopenConfirmation("zzz")).toBeNull();
    const reopen = (id: string) => ({ ...action(id, { action: "reopen", kind: "wpm", submission_id: "S", expected_review_version: 1, expected_status: "approved" as const }) });
    const { reason: _r, ...noReason } = reopen("R1") as Record<string, unknown>;
    void _r;
    // expired confirmation: refused, no action queued
    expect(await d.consumeConfirmationAndQueueReopen({ confirmationId: "C1", at: t1, action: noReason as never })).toBe(false);
    expect(await get(actionKey(RA, "R1"))).toBeUndefined();
    expect(await d.consumeConfirmationAndQueueReopen({ confirmationId: "C1", at: "2026-10-25T00:30:00.000Z", action: noReason as never })).toBe(true);
    expect(await get(actionKey(RA, "R1"))).toMatchObject({ action: "reopen", expected_status: "approved", state: "pending", reason: null, response_mode: "reply" });
    expect((await d.reopenConfirmation("C1"))?.consumed_at).toBe("2026-10-25T00:30:00.000Z");
    expect(await d.consumeConfirmationAndQueueReopen({ confirmationId: "C1", at: "2026-10-25T00:31:00.000Z", action: { ...noReason, interaction_id: "R2" } as never })).toBe(false);
    expect(await d.hasReceipt("R2")).toBe(false);

    // cancel path: consume without an action; the cancel interaction is still a receipt
    await put({ ...reopenConfKey("C2"), ...normalize("discord_reopen_confirmations", { confirmation_id: "C2", initial_interaction_id: "J0", actor_id: "mod", kind: "comment", submission_id: "S", channel_id: "c", message_id: "m", guild_id: "g", expected_status: "approved", expected_review_version: 1, created_at: t0, expires_at: t1 }) });
    expect(await d.consumeConfirmation("C2", t0, "J1")).toBe(true);
    expect(await d.consumeConfirmation("C2", t0, "J2")).toBe(false);
    expect(await d.hasReceipt("J1")).toBe(true);
    expect(await d.hasReceipt("J2")).toBe(false);
    expect(await d.consumeConfirmation("none", t0, "J3")).toBe(false);
    expect(await d.hasReceipt("J3")).toBe(false);
  });
});

describe("actions", () => {
  it("[LDB-DDB60] claimAction takes the oldest claimable action under a lease CAS; the lifecycle follows D1", async () => {
    await d.insertAction(PA, action("B", { created_at: "2026-10-25T00:00:02.000Z" }));
    await d.insertAction(PA, action("A", { created_at: "2026-10-25T00:00:01.000Z" }));
    await d.insertAction(PA, action("EXP", { created_at: "2026-10-25T00:00:00.000Z", expires_at: t0 })); // expired already
    const claimed = await d.claimAction(PA, t0, t1, "L1");
    expect(claimed).toMatchObject({ interaction_id: "A", state: "working", lease_until: t1, lease_token: "L1" });
    expect((await get(actionKey(PA, "A")))?.attempts).toBe(1);
    expect((await d.claimAction(PA, t0, t1, "L2"))?.interaction_id).toBe("B");
    expect(await d.claimAction(PA, t0, t1, "L3")).toBeNull(); // A and B are leased, EXP expired
    expect((await d.claimAction(PA, "2026-10-25T01:00:00.001Z", t2, "L4"))?.interaction_id).toBe("A"); // A's lease ran out
    expect((await get(actionKey(PA, "A")))?.attempts).toBe(2);

    await d.releaseAction(PA, "A", "stale-token");
    expect((await get(actionKey(PA, "A")))?.state).toBe("working");
    await d.releaseAction(PA, "A", "L4");
    expect(await get(actionKey(PA, "A"))).toMatchObject({ state: "pending", lease_token: null, lease_until: null });
    await d.claimAction(PA, t0, t1, "L5");
    await d.completeAction(PA, "A", "wrong", "done", "cb-token");
    expect((await get(actionKey(PA, "A")))?.state).toBe("working");
    await d.completeAction(PA, "A", "L5", "done", "cb-token");
    expect(await get(actionKey(PA, "A"))).toMatchObject({ state: "complete", result: "done", token: "cb-token", lease_token: null });
    await d.expireLeasedAction(PA, "B", "wrong", "gone");
    expect((await get(actionKey(PA, "B")))?.state).toBe("working");
    await d.expireLeasedAction(PA, "B", "L2", "configuration changed");
    expect(await get(actionKey(PA, "B"))).toMatchObject({ state: "expired", token: "", result: "configuration changed", lease_token: null });
  });

  it("[LDB-DDB60] callbacks: pending ones are completed rows with a token, fewest attempts first, and survive until expiry", async () => {
    for (const [id, at] of [["X", "2026-10-25T00:00:03.000Z"], ["Y", "2026-10-25T00:00:01.000Z"], ["Z", "2026-10-25T00:00:02.000Z"]] as const) {
      await d.insertAction(PA, action(id, { created_at: at }));
      await d.claimAction(PA, t0, t1, `L${id}`);
      await d.completeAction(PA, id, `L${id}`, "ok", `cb-${id}`);
    }
    await d.bumpCallbackAttempts(PA, "Y", "cb-Y");
    await d.bumpCallbackAttempts(PA, "Y", "wrong"); // no effect
    expect((await d.pendingCallbacks(PA, t0, 10)).map((r) => r.interaction_id)).toEqual(["Z", "X", "Y"]);
    expect(await d.pendingCallbacks(PA, t0, 2)).toHaveLength(2);
    expect(await d.pendingCallbacks(PA, t2, 10)).toEqual([]); // expired
    await d.clearCallbackToken(PA, "Z", "wrong");
    await d.clearCallbackToken(PA, "Z", "cb-Z");
    expect((await d.pendingCallbacks(PA, t0, 10)).map((r) => r.interaction_id)).toEqual(["X", "Y"]);
  });

  it("[LDB-DDB60] expireActions removes every row past its expiry with its claim, and the expired modals; disableActions closes the open ones", async () => {
    await d.insertAction(PA, action("OLD1", { expires_at: t0 }));
    await d.insertAction(PA, action("OLD2", { expires_at: t0 }));
    await d.claimAction(PA, "2026-10-24T00:00:00.000Z", t1, "Lw"); // OLD1 is working
    await d.insertAction(PA, action("LIVE", { expires_at: t2 }));
    await d.insertAction(RA, action("RLIVE", { action: "reopen", expected_status: "rejected", expires_at: t2 }));
    await d.insertDenyModal({ modalId: "MOLD", initialInteractionId: "IMOLD", actorId: "mod", kind: "link", submissionId: "S", channelId: "c", messageId: "m", guildId: "g", createdAt: t0, expiresAt: t0, expectedReviewVersion: 0 });
    await d.insertDenyModal({ modalId: "MNEW", initialInteractionId: "IMNEW", actorId: "mod", kind: "link", submissionId: "S", channelId: "c", messageId: "m", guildId: "g", createdAt: t0, expiresAt: t2, expectedReviewVersion: 0 });
    await d.expireActions(PA, t1);
    expect(await get(actionKey(PA, "OLD1"))).toBeUndefined();
    expect(await get(actionKey(PA, "OLD2"))).toBeUndefined();
    expect(await d.hasReceipt("OLD1")).toBe(false);
    expect(await get(actionKey(PA, "LIVE"))).toBeDefined();
    expect(await get(actionKey(RA, "RLIVE"))).toBeDefined(); // the other table is untouched
    expect(await get(denyModalKey("MOLD"))).toBeUndefined();
    expect(await d.hasReceipt("IMOLD")).toBe(false);
    expect(await get(denyModalKey("MNEW"))).toBeDefined();

    await d.insertAction(PA, action("DONE", { expires_at: t2 }));
    await d.claimAction(PA, t0, t1, "Ld");
    await d.completeAction(PA, "LIVE", "nope", "x", "tok"); // not leased by us: ignored
    await d.disableActions(PA);
    expect(await get(actionKey(PA, "LIVE"))).toMatchObject({ state: "expired", token: "", result: "actions disabled", lease_token: null });
    expect((await get(actionKey(PA, "DONE")))?.state).toBe("expired");
    expect((await get(actionKey(RA, "RLIVE")))?.state).toBe("pending");
  });

  it("[LDB-DDB60] pruning an expired confirmation keeps the claim of the reopen action it queued", async () => {
    await put({ ...reopenConfKey("C"), ...normalize("discord_reopen_confirmations", { confirmation_id: "C", initial_interaction_id: "I0", actor_id: "mod", kind: "wpm", submission_id: "S", channel_id: "c", message_id: "m", guild_id: "g", expected_status: "approved", expected_review_version: 1, created_at: t0, expires_at: t1 }) });
    await put({ ...interactionClaimKey("I0"), tbl: "discord_reopen_confirmations" });
    const { reason: _r, ...rest } = action("R", { action: "reopen", kind: "wpm", expected_status: "approved", expected_review_version: 1 }) as Record<string, unknown>;
    void _r;
    expect(await d.consumeConfirmationAndQueueReopen({ confirmationId: "C", at: t0, action: rest as never })).toBe(true);
    await d.deleteExpiredConfirmations(t2);
    expect(await d.reopenConfirmation("C")).toBeNull();
    expect(await d.hasReceipt("I0")).toBe(false);
    expect(await d.hasReceipt("R")).toBe(true);
  });

  it("[LDB-DDB59] a tracked target is a bot card showing exactly that status and version on a submission that still has it", async () => {
    await store.modqueue.insertNotification({ kind: "wpm", id: "W", messageId: "m1", format: "components_v2", transport: "bot", channelId: "c1", reviewVersion: 2, sourceMessageUrl: null });
    await store.modqueue.leaseNotification("wpm", "W", "t", t2, t0);
    await store.modqueue.markShown({ kind: "wpm", id: "W", status: "approved", reviewVersion: 2, sourceMessageUrl: null, leaseToken: "t" });
    await put({ ...submissionKey("wpm", "W"), id: "W", status: "approved", review_version: 2 });
    const target = { kind: "wpm" as const, id: "W", status: "approved", reviewVersion: 2 };
    expect(await d.trackedTarget(target, "c1", "m1")).toBe(true);
    expect(await d.trackedTarget(target, "c2", "m1")).toBe(false);
    expect(await d.trackedTarget(target, "c1", "m2")).toBe(false);
    expect(await d.trackedTarget({ ...target, reviewVersion: 1 }, "c1", "m1")).toBe(false);
    await put({ ...submissionKey("wpm", "W"), id: "W", status: "approved", review_version: 3 });
    expect(await d.trackedTarget(target, "c1", "m1")).toBe(false);
    await store.modqueue.insertNotification({ kind: "link", id: "L", messageId: "m", format: "text", transport: "legacy_webhook", channelId: "c1", reviewVersion: 0, sourceMessageUrl: null });
    expect(await d.trackedTarget({ kind: "link", id: "L", status: "pending", reviewVersion: 0 }, "c1", "m")).toBe(false); // legacy transport
    expect(await get(mqnKey("link", "L"))).toBeDefined();
  });
});

describe("schema", () => {
  it("[LDB-DDB63] toItems/fromItems round trip every table of the lane, and every item belongs to a table", () => {
    const rows = {
      modqueue_notifications: [
        normalize("modqueue_notifications", { kind: "link", submission_id: "A", message_id: "m", shown_status: "pending", channel_id: "c", transport: "bot" }),
        normalize("modqueue_notifications", { kind: "wpm", submission_id: "B", message_id: "m2", shown_status: "approved", shown_review_version: 2, shown_source_message_url: "https://x", reconcile_lease_token: "t", reconcile_lease_until: t1 }),
      ],
      modqueue_delivery_gate: [{ id: 1, lease_token: "g", lease_until: 5, retry_at: 9 }],
      discord_pending_actions: [normalize("discord_pending_actions", { ...action("P1"), reason: "r", state: "complete", result: "ok", attempts: 2 })],
      discord_reopen_actions: [normalize("discord_reopen_actions", { ...action("R1", { action: "reopen" }), expected_status: "rejected", response_mode: "update" })],
      discord_deny_modals: [normalize("discord_deny_modals", { modal_id: "M", initial_interaction_id: "I", actor_id: "a", kind: "link", submission_id: "S", channel_id: "c", message_id: "m", guild_id: "g", created_at: t0, expires_at: t1, consumed_at: t0, consumed_interaction_id: "P1" })],
      discord_reopen_confirmations: [
        normalize("discord_reopen_confirmations", { confirmation_id: "C", initial_interaction_id: "I2", actor_id: "a", kind: "wpm", submission_id: "S", channel_id: "c", message_id: "m", guild_id: "g", expected_status: "approved", expected_review_version: 1, created_at: t0, expires_at: t1, consumed_at: t0, consumed_interaction_id: "R1" }),
        normalize("discord_reopen_confirmations", { confirmation_id: "C2", initial_interaction_id: "I3", actor_id: "a", kind: "comment", submission_id: "S", channel_id: "c", message_id: "m", guild_id: "g", expected_status: "approved", expected_review_version: 1, created_at: t0, expires_at: t1, consumed_at: t0, consumed_interaction_id: "CANCEL" }),
      ],
      discord_rejection_dm_outbox: [
        normalize("discord_rejection_dm_outbox", { delivery_key: "approval:wpm:S:1", event_seq: 8, kind: "wpm", submission_id: "S", layout_id: "L", recipient_id: "u", nonce: "n2", status: "sent", next_attempt_at: t0, created_at: t0, updated_at: t0, sent_at: t1, decision: "approval", review_version: 1 }),
        normalize("discord_rejection_dm_outbox", { delivery_key: "rejection:wpm:S", event_seq: 7, kind: "wpm", submission_id: "S", layout_id: "L", recipient_id: "u", nonce: "n1", next_attempt_at: t0, created_at: t0, updated_at: t0 }),
      ],
    };
    const items = discordSchema.toItems(rows);
    expect(items.ephemeral).toEqual([]);
    for (const it of items.main) expect(discordSchema.tableOf(it), JSON.stringify(it)).not.toBeNull();
    const back = discordSchema.fromItems(items);
    for (const t of discordSchema.tables) expect(back[t], t).toEqual(rows[t as keyof typeof rows]);
    // derived items: claims for every interaction id, the cancel id but not the action-held one; due index for pending/leased only
    const keys = new Set(items.main.map((i) => `${i.pk as string}|${i.sk as string}`));
    for (const id of ["P1", "R1", "I", "I2", "I3", "CANCEL"]) expect(keys.has(`DINT#${id}|CLAIM`), id).toBe(true);
    expect(items.main.filter((i) => i.pk === "DINT#R1")).toHaveLength(1);
    expect(keys.has("IX#dmo#due|pending#" + t0 + "#rejection:wpm:S")).toBe(true);
    expect(items.main.filter((i) => i.pk === "IX#dmo#due")).toHaveLength(1);
    expect(keys.has("DMO#seq#7|CLAIM") && keys.has("DMO#nonce#n2|CLAIM")).toBe(true);
    expect(keys.has("IX#mqn#dirty|link#A")).toBe(true);
  });

  it("[LDB-DDB63] a database without a gate row reads as the seeded row; defaults fill absent columns", () => {
    expect(discordSchema.fromItems({ main: [], ephemeral: [] }).modqueue_delivery_gate).toEqual([{ id: 1, lease_token: null, lease_until: 0, retry_at: 0 }]);
    const [n] = discordSchema.fromItems(discordSchema.toItems({ modqueue_notifications: [{ kind: "link", submission_id: "A", message_id: "m", shown_status: "pending" }] })).modqueue_notifications!;
    expect(n).toMatchObject({ failed_attempts: 0, message_format: "text", transport: "legacy_webhook", shown_review_version: 0, channel_id: null });
  });
});
