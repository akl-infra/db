import { createExecutionContext, env, store, testStore, waitOnExecutionContext } from "../harness";
import { pick } from "./store-support";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ulid } from "ulidx";
import type { Bindings } from "../../src/env";
import { drainDiscordActions, handleDiscordInteraction } from "../../src/core/discord-interactions";
import { buildV2Payload } from "../../src/core/modqueue-message";
import { reopenComment, rejectComment } from "../../src/core/comments";
import { fixedClock } from "../../src/core/time";
import { app } from "../../src/index";

const bindings = env as unknown as Bindings;
const clock = fixedClock("2026-10-18T12:00:00.000Z");
const APP = "900000000000000101";
const GUILD = "900000000000000102";
const CHANNEL = "900000000000000103";
const MOD = "900000000000000104";
const TOKEN = "interaction-token-for-test-only-123456789";
let pair: CryptoKeyPair;
let publicHex: string;

function envWith(): Bindings {
  return {
    ...bindings,
    MODQUEUE_DISCORD_ACTIONS: "true",
    MODQUEUE_DISCORD_APPLICATION_ID: APP,
    MODQUEUE_DISCORD_PUBLIC_KEY: publicHex,
    MODQUEUE_DISCORD_GUILD_ID: GUILD,
    MODQUEUE_DISCORD_CHANNEL_ID: CHANNEL,
    MODQUEUE_DISCORD_BOT_TOKEN: "fake-token-not-a-secret",
  };
}

function toHex(value: Uint8Array): string {
  return [...value].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function signedRequest(body: Record<string, unknown>, opts: { timestamp?: string; signedBody?: string } = {}): Promise<Request> {
  const raw = JSON.stringify(body);
  const timestamp = opts.timestamp ?? String(Math.floor(Date.parse(clock()) / 1000));
  const signatureData = new TextEncoder().encode(timestamp + (opts.signedBody ?? raw));
  const signature = new Uint8Array(await crypto.subtle.sign("Ed25519", pair.privateKey, signatureData));
  return new Request("https://example.test/discord/interactions", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Signature-Timestamp": timestamp, "X-Signature-Ed25519": toHex(signature) },
    body: raw,
  });
}

function interaction(type: number, id: string, data: Record<string, unknown>, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id, application_id: APP, type, token: TOKEN, guild_id: GUILD, channel_id: CHANNEL,
    member: { user: { id: MOD, username: "mod" } }, data,
    ...overrides,
  };
}

let submissionId: string;
let messageId: string;

beforeAll(async () => {
  pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]) as CryptoKeyPair;
  publicHex = toHex(new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey) as ArrayBuffer));
});

beforeEach(async () => {
  await testStore.remove("discord_pending_actions", {});
  await testStore.remove("discord_reopen_actions", {});
  await testStore.remove("discord_reopen_confirmations", {});
  await testStore.remove("discord_deny_modals", {});
  await testStore.remove("modqueue_notifications", {});
  await testStore.remove("link_submissions", {});
  await testStore.remove("admins", {});
  await testStore.remove("bans", {});
  await testStore.remove("authors", {});
  submissionId = ulid();
  messageId = "900000000000000105";
  await testStore.insert("link_submissions", { id: submissionId, layout_id: ulid(), url: "https://example.org/", submitted_by: MOD, submitted_at: clock(), status: "pending" });
  await testStore.insert("modqueue_notifications", { kind: "link", submission_id: submissionId, message_id: messageId, shown_status: "pending", message_format: "components_v2", transport: "bot", channel_id: CHANNEL });
});

afterEach(() => vi.unstubAllGlobals());

describe("[LDB-MD16] Discord HTTP interaction adapter", () => {
  it("[LDB-MD16] expires private callback tokens and modal bindings even when actions are disabled", async () => {
    await testStore.insert("discord_pending_actions", { interaction_id: "900000000000000199", application_id: APP, token: "expired-callback-token", actor_id: MOD, actor_name: "mod", kind: "link", action: "approve", submission_id: submissionId, channel_id: CHANNEL, message_id: messageId, guild_id: GUILD, created_at: "2026-10-18T11:00:00.000Z", expires_at: "2026-10-18T11:14:00.000Z" });
    await testStore.insert("discord_deny_modals", { modal_id: "expired-modal", initial_interaction_id: "900000000000000198", actor_id: MOD, kind: "link", submission_id: submissionId, channel_id: CHANNEL, message_id: messageId, guild_id: GUILD, created_at: "2026-10-18T11:00:00.000Z", expires_at: "2026-10-18T11:14:00.000Z" });
    await drainDiscordActions(store, { ...envWith(), MODQUEUE_DISCORD_ACTIONS: "false" }, clock);
    expect(pick(await testStore.row("discord_pending_actions", { interaction_id: "900000000000000199" }), "1")).toBeNull();
    expect(pick(await testStore.row("discord_deny_modals", { modal_id: "expired-modal" }), "1")).toBeNull();
  });

  it("[LDB-MD16] verifies exact raw bytes and freshness before answering signed PING", async () => {
    const ping = { id: "900000000000000106", application_id: APP, type: 1 };
    const response = await handleDiscordInteraction(await signedRequest(ping), envWith(), clock);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ type: 1 });
    const actionsOff = await handleDiscordInteraction(await signedRequest(ping), { ...envWith(), MODQUEUE_DISCORD_ACTIONS: "false" }, clock);
    expect(await actionsOff.json()).toEqual({ type: 1 });

    const altered = await signedRequest(ping, { signedBody: "{}" });
    expect((await handleDiscordInteraction(altered, envWith(), clock)).status).toBe(401);
    const stale = await signedRequest(ping, { timestamp: "1700000000" });
    expect((await handleDiscordInteraction(stale, envWith(), clock)).status).toBe(401);
    const wrongApp = await handleDiscordInteraction(await signedRequest(ping), { ...envWith(), MODQUEUE_DISCORD_APPLICATION_ID: "900000000000000107" }, clock);
    expect((await wrongApp.json() as { type: number }).type).toBe(4);
  });

  it("[LDB-MD16] accepts long opaque tokens for approve, deny, and modal submit but rejects missing or non-string tokens", async () => {
    const env = envWith();
    const longToken = "opaque.discord.continuation-token_0123456789.".repeat(7);
    expect(longToken.length).toBeGreaterThan(200);

    const missing = interaction(3, "900000000000000116", {
      custom_id: `aklmod1|link|approve|${submissionId}`,
    }, { message: { id: messageId } });
    delete missing.token;
    const missingResponse = await handleDiscordInteraction(await signedRequest(missing), env, clock);
    expect(((await missingResponse.json()) as { data: { content: string } }).data.content).toContain("malformed");
    const wrongType = interaction(3, "900000000000000117", {
      custom_id: `aklmod1|link|approve|${submissionId}`,
    }, { message: { id: messageId }, token: 42 });
    const wrongTypeResponse = await handleDiscordInteraction(await signedRequest(wrongType), env, clock);
    expect(((await wrongTypeResponse.json()) as { data: { content: string } }).data.content).toContain("malformed");

    await testStore.insert("admins", { user_id: MOD, added_at: clock() });
    const approve = interaction(3, "900000000000000118", {
      custom_id: `aklmod1|link|approve|${submissionId}`,
    }, { message: { id: messageId }, token: longToken });
    const approveAck = await handleDiscordInteraction(await signedRequest(approve), env, clock);
    expect(await approveAck.json()).toEqual({ type: 6 });
    const approvedAction = pick<{ token: string }>(await testStore.row("discord_pending_actions", { interaction_id: "900000000000000118" }), "token");
    expect(approvedAction?.token).toBe(longToken);
    await testStore.remove("discord_pending_actions", {});

    const deny = interaction(3, "900000000000000119", {
      custom_id: `aklmod1|link|deny|${submissionId}`,
    }, { message: { id: messageId }, token: longToken });
    const modalResponse = await handleDiscordInteraction(await signedRequest(deny), env, clock);
    const modal = await modalResponse.json() as { type: number; data: { custom_id: string } };
    expect(modal.type).toBe(9);
    const submit = interaction(5, "900000000000000120", {
      custom_id: modal.data.custom_id,
      components: [{ type: 18, component: { type: 4, custom_id: "reason", value: "Long-token modal reason." } }],
    }, { token: longToken });
    const submitAck = await handleDiscordInteraction(await signedRequest(submit), env, clock);
    expect(await submitAck.json()).toEqual({ type: 6 });
    const deniedAction = pick<{ token: string; action: string }>(await testStore.row("discord_pending_actions", { interaction_id: "900000000000000120" }), "token", "action");
    expect(deniedAction).toEqual({ token: longToken, action: "deny" });
  });

  it("[LDB-MD16] rejects untracked messages, wrong guild/channel and non-admin actors without queuing", async () => {
    const env = envWith();
    const button = (overrides: Record<string, unknown> = {}) => interaction(3, "900000000000000108", {
      custom_id: `aklmod1|link|approve|${submissionId}`,
    }, { message: { id: messageId }, ...overrides });
    const untracked = await handleDiscordInteraction(await signedRequest(button({ message: { id: "900000000000000109" } })), env, clock);
    expect(((await untracked.json()) as { data: { content: string } }).data.content).toContain("stale");
    const wrongChannel = await handleDiscordInteraction(await signedRequest(button({ channel_id: "900000000000000110" })), env, clock);
    expect(((await wrongChannel.json()) as { data: { content: string } }).data.content).toContain("not allowed");
    const denied = await handleDiscordInteraction(await signedRequest(button()), env, clock);
    expect(((await denied.json()) as { data: { content: string } }).data.content).toContain("permission");
    expect(await testStore.row("discord_pending_actions", {})).toBeNull();
  });

  it("[LDB-MD16] defers a button action only after persistence, then rechecks current admin role in the continuation", async () => {
    const env = envWith();
    await testStore.insert("admins", { user_id: MOD, added_at: clock() });
    const request = await signedRequest(interaction(3, "900000000000000111", {
      custom_id: `aklmod1|link|approve|${submissionId}`,
    }, { message: { id: messageId } }));
    const response = await handleDiscordInteraction(request, env, clock);
    expect(await response.json()).toEqual({ type: 6 });
    const queued = pick<{ interaction_id: string; actor_id: string; token: string; state: string }>((await testStore.rows("discord_pending_actions"))[0] ?? null, "interaction_id", "actor_id", "token", "state");
    expect(queued).toMatchObject({ interaction_id: "900000000000000111", actor_id: MOD, token: TOKEN, state: "pending" });

    await testStore.remove("admins", { user_id: MOD });
    let callbackCount = 0;
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(null, { status: ++callbackCount === 1 ? 500 : 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await drainDiscordActions(store, env, clock);
    const submission = pick<{ status: string }>(await testStore.row("link_submissions", { id: submissionId }), "status");
    expect(submission?.status).toBe("pending");
    expect(fetchMock).toHaveBeenCalledTimes(2); // private error followup + bounded durable retry
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(`https://discord.com/api/v10/webhooks/${APP}/${TOKEN}`);
    expect(fetchMock.mock.calls[0]?.[1]?.method).toBe("POST");
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({ flags: 64, allowed_mentions: { parse: [] } });
    const completed = pick<{ state: string; token: string; result: string }>((await testStore.rows("discord_pending_actions"))[0] ?? null, "state", "token", "result");
    expect(completed).toMatchObject({ state: "complete", token: "", result: "You no longer have permission to moderate this queue." });
  });

  it("[LDB-MD16] cleans up a legacy completed success reply without replaying the decision", async () => {
    await testStore.insert("discord_pending_actions", { interaction_id: "900000000000000180", application_id: APP, token: TOKEN, actor_id: MOD, actor_name: "mod", kind: "link", action: "approve", submission_id: submissionId, channel_id: CHANNEL, message_id: messageId, guild_id: GUILD, created_at: clock(), expires_at: "2026-10-18T12:14:00.000Z", state: "complete", result: "Submission approved." });
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    await drainDiscordActions(store, envWith(), clock);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(`https://discord.com/api/v10/webhooks/${APP}/${TOKEN}/messages/@original`);
    expect(fetchMock.mock.calls[0]?.[1]?.method).toBe("DELETE");
    expect(pick(await testStore.row("link_submissions", { id: submissionId }), "status")).toEqual({ status: "pending" });
    expect(pick(await testStore.row("discord_pending_actions", { interaction_id: "900000000000000180" }), "token")).toEqual({ token: "" });
  });

  it("[LDB-MD16] opens a deny modal, binds it to its original actor/card, stores bounded reason and rejects replay", async () => {
    const env = envWith();
    await testStore.insert("admins", { user_id: MOD, added_at: clock() });
    const click = interaction(3, "900000000000000112", {
      custom_id: `aklmod1|link|deny|${submissionId}`,
    }, { message: { id: messageId } });
    const opened = await handleDiscordInteraction(await signedRequest(click), env, clock);
    const modalResponse = await opened.json() as { type: number; data: { custom_id: string; components: { type: number }[] } };
    expect(modalResponse.type).toBe(9);
    expect(modalResponse.data.components[0]?.type).toBe(18);
    const modalId = modalResponse.data.custom_id.split("|")[2]!;
    const submitted = interaction(5, "900000000000000113", {
      custom_id: modalResponse.data.custom_id,
      components: [{ type: 18, component: { type: 4, custom_id: "reason", value: "Please include a clearer source." } }],
    });
    const response = await handleDiscordInteraction(await signedRequest(submitted), env, clock);
    expect(await response.json()).toEqual({ type: 6 });
    const queued = pick<{ action: string; reason: string; actor_id: string }>((await testStore.rows("discord_pending_actions"))[0] ?? null, "action", "reason", "actor_id");
    expect(queued).toEqual({ action: "deny", reason: "Please include a clearer source.", actor_id: MOD });
    const modal = pick<{ consumed_interaction_id: string }>(await testStore.row("discord_deny_modals", { modal_id: modalId }), "consumed_interaction_id");
    expect(modal?.consumed_interaction_id).toBe("900000000000000113");
    const replay = await handleDiscordInteraction(await signedRequest(submitted), env, clock);
    expect(((await replay.json()) as { data: { content: string } }).data.content).toContain("already received");
  });

  it("[LDB-MD19] opts a Discord denial into the private rejection DM outbox only when enabled", async () => {
    const layoutId = ulid();
    await testStore.insert("layouts", { id: layoutId, name: `discord-dm-${layoutId.toLowerCase()}`, owner: MOD, n: 1, layout_rev: 1, created_at: clock(), modified_at: clock() });
    await testStore.patch("link_submissions", { id: submissionId }, { layout_id: layoutId });
    await testStore.insert("admins", { user_id: MOD, added_at: clock() });
    const env = { ...envWith(), MODQUEUE_DISCORD_DMS: "true" };
    const click = interaction(3, "900000000000000114", {
      custom_id: `aklmod1|link|deny|${submissionId}`,
    }, { message: { id: messageId } });
    const opened = await handleDiscordInteraction(await signedRequest(click), env, clock);
    const modal = await opened.json() as { data: { custom_id: string } };
    const submitted = interaction(5, "900000000000000115", {
      custom_id: modal.data.custom_id,
      components: [{ type: 18, component: { type: 4, custom_id: "reason", value: "Please revise." } }],
    });
    expect((await handleDiscordInteraction(await signedRequest(submitted), env, clock)).status).toBe(200);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 404 })));
    await drainDiscordActions(store, env, clock);
    const queued = pick<{ kind: string; submission_id: string; recipient_id: string }>(await testStore.row("discord_rejection_dm_outbox", { submission_id: submissionId }), "kind", "submission_id", "recipient_id");
    expect(queued).toEqual({ kind: "link", submission_id: submissionId, recipient_id: MOD });
  });
});

describe("[LDB-MD21] Discord reopening", () => {
  async function seedReview(status: "approved" | "rejected" | "pending" = "rejected", kind: "comment" | "wpm" = "comment") {
    const layout = ulid();
    const id = ulid();
    await testStore.insert("layouts", { id: layout, name: `discord-reopen-${layout.toLowerCase()}`, owner: MOD, n: 1, layout_rev: 1, created_at: clock(), modified_at: clock() });
    if (kind === "comment") await testStore.insert("layout_comments", { id, layout_id: layout, user_id: MOD, body: "normal comment", via: "discord", submitted_at: clock(), status, decided_by: status === "pending" ? null : MOD, decided_at: status === "pending" ? null : clock() });
    else await testStore.insert("wpm_submissions", { id, layout_id: layout, user_id: MOD, wpm: 150, proof: "https://example.org/proof", submitted_by: MOD, via: "discord", submitted_at: clock(), status, decided_by: status === "pending" ? null : MOD, decided_at: status === "pending" ? null : clock() });
    await testStore.insert("modqueue_notifications", { kind, submission_id: id, message_id: messageId, shown_status: status, message_format: "components_v2", transport: "bot", channel_id: CHANNEL });
    if ((await testStore.count("admins", { user_id: MOD })) === 0) await testStore.insert("admins", { user_id: MOD, added_at: clock() });
    const initial = kind === "comment" ? buildV2Payload("comment", { id, layout_id: layout, body: "normal comment", live_body: null, user_id: MOD, user_name: "mod", layout_name: "test", layout_owner: MOD })
      : buildV2Payload("wpm", { id, layout_id: layout, wpm: 150, proof: "https://example.org/proof", user_id: MOD, user_name: "mod", layout_name: "test" });
    const patches: Record<string, unknown>[] = [];
    const requests: { url: string; method: string; body: Record<string, unknown> }[] = [];
    vi.stubGlobal("fetch", async (_url: string, init?: RequestInit) => {
      requests.push({ url: String(_url), method: init?.method ?? "GET", body: JSON.parse(String(init?.body ?? "{}")) });
      if (init?.method === "GET") return Response.json(initial);
      patches.push(JSON.parse(String(init?.body ?? "{}")));
      return Response.json({ id: messageId });
    });
    return { id, layout, patches, requests };
  }
  async function click(id: string, interactionId: string, action: string, version = 0, overrides: Record<string, unknown> = {}, kind = "comment") {
    const response = await handleDiscordInteraction(await signedRequest(interaction(3, interactionId, {
      custom_id: `aklmod2|${kind}|${action}|${id}|${version}`,
    }, { message: { id: messageId }, ...overrides })), envWith(), clock);
    return await response.json() as { type: number; data?: { flags?: number; content?: string; custom_id?: string; components?: { components: { custom_id: string }[] }[] } };
  }
  async function confirm(customId: string, initialId: string, interactionId: string, overrides: Record<string, unknown> = {}) {
    const response = await handleDiscordInteraction(await signedRequest(interaction(3, interactionId, { custom_id: customId }, {
      message: { id: "900000000000000888", interaction_metadata: { id: initialId } }, ...overrides,
    })), envWith(), clock);
    return await response.json() as { type: number; data?: { content?: string } };
  }

  it.each(["comment", "wpm"] as const)("[LDB-MD21] HTTP route silently reopens approved %s in one click without waiting for cron", async (kind) => {
    const { id, patches, requests } = await seedReview("approved", kind);
    const initialId = "900000000000000560";
    async function deliver(body: Record<string, unknown>) {
      const context = createExecutionContext();
      const request = await signedRequest(body, { timestamp: String(Math.floor(Date.now() / 1000)) });
      const response = await app.fetch(request, envWith(), context);
      await waitOnExecutionContext(context);
      expect(response.status).toBe(200);
      return await response.json() as { type: number; data?: { components: { components: { custom_id: string }[] }[] } };
    }
    const opened = await deliver(interaction(3, initialId, {
      custom_id: `aklmod2|${kind}|reopen-approved|${id}|0`,
    }, { message: { id: messageId } }));
    expect(opened).toEqual({ type: 6 });
    expect(await testStore.row("discord_reopen_confirmations", {})).toBeNull();
    // Exercise the production HTTP continuation, never call drainDiscordActions
    // directly: otherwise a missing waitUntil dispatch is invisible to this test.
    const table = kind === "comment" ? "layout_comments" : "wpm_submissions";
    expect(pick(await testStore.row(table, { id }), "status", "review_version"))
      .toEqual({ status: "pending", review_version: 1 });
    expect(pick(await testStore.row("discord_reopen_actions", { interaction_id: initialId }), "state", "token"))
      .toEqual({ state: "complete", token: "" });
    expect(patches.some((patch) => JSON.stringify(patch).includes(`aklmod2|${kind}|approve|${id}|1`))).toBe(true);
    expect(requests.every((request) => !request.url.includes("/webhooks/"))).toBe(true);
  });

  it.each(["comment", "wpm"] as const)("[LDB-MD21] directly reopens denied %s once, restores controls and rejects replay", async (kind) => {
    const { id, patches } = await seedReview("rejected", kind);
    const first = await click(id, "900000000000000501", "reopen-rejected", 0, {}, kind);
    expect(first.type).toBe(6);
    expect((await click(id, "900000000000000501", "reopen-rejected", 0, {}, kind)).data?.content).toContain("already received");
    await drainDiscordActions(store, envWith(), clock);
    const table = kind === "comment" ? "layout_comments" : "wpm_submissions";
    expect(pick(await testStore.row(table, { id }), "status", "review_version"))
      .toEqual({ status: "pending", review_version: 1 });
    expect(patches.some((patch) => JSON.stringify(patch).includes(`aklmod2|${kind}|approve|${id}|1`))).toBe(true);
    await drainDiscordActions(store, envWith(), clock);
    expect(await testStore.rows("moderation_review_history", { submission_id: id, action: "reopened" })).toHaveLength(1);
    expect((await click(id, "900000000000000502", "reopen-rejected", 0, {}, kind)).data?.content).toContain("stale");
  });

  async function legacyConfirmation(id: string, initialId: string) {
    const confirmationId = crypto.randomUUID();
    await testStore.insert("discord_reopen_confirmations", { confirmation_id: confirmationId, initial_interaction_id: initialId, actor_id: MOD, kind: "comment", submission_id: id, channel_id: CHANNEL, message_id: messageId, guild_id: GUILD, expected_status: "approved", expected_review_version: 0, created_at: clock(), expires_at: "2026-10-18T12:14:00.000Z" });
    return `aklmod2|confirm|${confirmationId}`;
  }

  it("[LDB-MD21] safely completes an already-issued private confirmation by deleting only its private prompt", async () => {
    const { id, requests } = await seedReview("approved");
    const customId = await legacyConfirmation(id, "900000000000000510");
    expect((await confirm(customId, "900000000000000999", "900000000000000511")).data?.content).toContain("another moderator or message");
    expect((await confirm(customId, "900000000000000510", "900000000000000512", { member: { user: { id: "900000000000000777", username: "other" } } })).data?.content).toContain("another moderator");
    expect((await confirm(customId, "900000000000000510", "900000000000000516")).type).toBe(6);
    await drainDiscordActions(store, envWith(), clock);
    expect(pick(await testStore.row("layout_comments", { id }), "status", "review_version")).toEqual({ status: "pending", review_version: 1 });
    expect(requests.filter((request) => request.url.includes("/webhooks/")))
      .toEqual([{ url: `https://discord.com/api/v10/webhooks/${APP}/${TOKEN}/messages/@original`, method: "DELETE", body: {} }]);
  });

  it("[LDB-MD21] rejects wrong guild/channel, removed permissions and changed bindings before direct reopening", async () => {
    const { id } = await seedReview("approved");
    expect((await click(id, "900000000000000521", "reopen-approved", 0, { guild_id: "900000000000000999" })).data?.content).toContain("not allowed");
    expect((await click(id, "900000000000000522", "reopen-approved", 0, { channel_id: "900000000000000999" })).data?.content).toContain("not allowed");
    await testStore.remove("admins", { user_id: MOD });
    expect((await click(id, "900000000000000523", "reopen-approved")).data?.content).toContain("permission");
    await testStore.insert("admins", { user_id: MOD, added_at: clock() });
    await testStore.patch("modqueue_notifications", { submission_id: id }, { message_id: "900000000000000999" });
    expect((await click(id, "900000000000000524", "reopen-approved")).data?.content).toContain("stale");
    expect(await testStore.row("discord_reopen_actions", {})).toBeNull();
  });

  it.each(["comment", "wpm"] as const)("[LDB-MD21] silently approves and denies %s through the HTTP continuation", async (kind) => {
    const { id, requests, patches } = await seedReview("pending", kind);
    async function deliver(body: Record<string, unknown>) {
      const context = createExecutionContext();
      const response = await app.fetch(await signedRequest(body, { timestamp: String(Math.floor(Date.now() / 1000)) }), envWith(), context);
      await waitOnExecutionContext(context);
      expect(response.status).toBe(200);
      return response.json() as Promise<{ type: number; data?: { custom_id: string } }>;
    }
    expect(await deliver(interaction(3, "900000000000000570", { custom_id: `aklmod2|${kind}|approve|${id}|0` }, { message: { id: messageId } }))).toEqual({ type: 6 });
    const table = kind === "comment" ? "layout_comments" : "wpm_submissions";
    expect(pick(await testStore.row(table, { id }), "status")).toEqual({ status: "approved" });
    expect(await deliver(interaction(3, "900000000000000571", { custom_id: `aklmod2|${kind}|reopen-approved|${id}|0` }, { message: { id: messageId } }))).toEqual({ type: 6 });
    const modal = await deliver(interaction(3, "900000000000000572", { custom_id: `aklmod2|${kind}|deny|${id}|1` }, { message: { id: messageId } }));
    expect(modal.type).toBe(9);
    expect(await deliver(interaction(5, "900000000000000573", {
      custom_id: modal.data!.custom_id, components: [{ type: 18, component: { type: 4, custom_id: "reason", value: "Proof missing" } }],
    }, { message: { id: messageId } }))).toEqual({ type: 6 });
    expect(pick(await testStore.row(table, { id }), "status", "reason")).toEqual({ status: "rejected", reason: "Proof missing" });
    expect(patches.some((patch) => JSON.stringify(patch).includes(`reopen-rejected|${id}|1`))).toBe(true);
    expect(requests.every((request) => !request.url.includes("/webhooks/"))).toBe(true);
  });

  it.each(["comment", "wpm"] as const)("[LDB-MD23] Discord approval of %s enqueues and immediately dispatches its DM", async (kind) => {
    const { id, requests } = await seedReview("pending", kind);
    const context = createExecutionContext();
    const enabled = { ...envWith(), MODQUEUE_DISCORD_DMS: "true" };
    const request = await signedRequest(interaction(3, "900000000000000576", {
      custom_id: `aklmod2|${kind}|approve|${id}|0`,
    }, { message: { id: messageId } }), { timestamp: String(Math.floor(Date.now() / 1000)) });
    expect((await app.fetch(request, enabled, context)).status).toBe(200);
    await waitOnExecutionContext(context);
    const row = pick<{ decision: string; status: string; discord_message_id: string }>(await testStore.row("discord_rejection_dm_outbox", { submission_id: id }), "decision", "status", "discord_message_id");
    expect(row).toEqual({ decision: "approval", status: "sent", discord_message_id: messageId });
    expect(requests.some((entry) => entry.url.endsWith("/users/@me/channels"))).toBe(true);
    expect(requests.some((entry) => entry.url.endsWith(`/channels/${messageId}/messages`))).toBe(true);
  });

  it("[LDB-MD21] stale pending buttons, denial modal and queued decisions cannot cross a reopened cycle", async () => {
    const { id } = await seedReview("pending");
    const modal = await click(id, "900000000000000530", "deny");
    expect(modal.type).toBe(9);
    expect((await click(id, "900000000000000531", "approve")).type).toBe(6);
    await testStore.patch("layout_comments", { id }, { review_version: 1 });
    await testStore.patch("modqueue_notifications", { submission_id: id }, { shown_review_version: 1 });
    for (const customId of [`aklmod1|comment|approve|${id}`, `aklmod2|comment|approve|${id}|0`]) {
      const response = await handleDiscordInteraction(await signedRequest(interaction(3, "900000000000000532", { custom_id: customId }, { message: { id: messageId } })), envWith(), clock);
      expect((await response.json() as { data: { content: string } }).data.content).toContain("stale");
    }
    const submit = await handleDiscordInteraction(await signedRequest(interaction(5, "900000000000000533", {
      custom_id: modal.data!.custom_id, components: [{ type: 18, component: { type: 4, custom_id: "reason", value: "stale reason" } }],
    })), envWith(), clock);
    expect((await submit.json() as { data: { content: string } }).data.content).toContain("changed");
    await drainDiscordActions(store, envWith(), clock);
    expect(pick(await testStore.row("layout_comments", { id }), "status", "review_version")).toEqual({ status: "pending", review_version: 1 });
    expect(pick(await testStore.row("discord_pending_actions", { submission_id: id }), "result")).toEqual({ result: "This review changed. Refresh the card before deciding." });
  });

  it("[LDB-MD21] queued reopen cannot undo a later redecision; another moderator's reopen is not claimed as ours", async () => {
    const { id } = await seedReview("rejected");
    await click(id, "900000000000000540", "reopen-rejected");
    const actor = { user_id: "900000000000000777", name: "other", admin: true, banned: false, via: "discord" as const, source_client: "test" };
    await reopenComment(store, clock, actor, null, id, { status: "rejected", review_version: 0 });
    await rejectComment(store, clock, actor, null, id, "new decision", { reviewVersion: 1 });
    await drainDiscordActions(store, envWith(), clock);
    expect(pick(await testStore.row("layout_comments", { id }), "status", "review_version")).toEqual({ status: "rejected", review_version: 1 });
    expect(pick(await testStore.row("discord_reopen_actions", { submission_id: id }), "result")).toEqual({ result: "This card is stale. Refresh it before reopening." });
    expect((await click(id, "900000000000000541", "reopen-rejected")).data?.content).toContain("stale");
  });

  it("[LDB-MD21] recovers a committed reopen after the worker lease expires without emitting another event", async () => {
    const { id } = await seedReview("rejected");
    await click(id, "900000000000000550", "reopen-rejected");
    const actor = { user_id: MOD, name: "mod", admin: true, banned: false, via: "discord" as const, source_client: "test" };
    await reopenComment(store, clock, actor, null, id, { status: "rejected", review_version: 0 });
    await testStore.patch("discord_reopen_actions", {}, { state: "working", lease_until: "2026-10-18T11:59:00.000Z" });
    await drainDiscordActions(store, envWith(), clock);
    expect(pick(await testStore.row("discord_reopen_actions", { submission_id: id }), "result", "state", "token")).toEqual({ result: null, state: "complete", token: "" });
    expect(await testStore.rows("moderation_review_history", { submission_id: id, action: "reopened" })).toHaveLength(1);
  });
});
