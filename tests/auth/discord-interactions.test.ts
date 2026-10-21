import { createExecutionContext, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ulid } from "ulidx";
import type { Bindings } from "../../src/env";
import { drainDiscordActions, handleDiscordInteraction } from "../../src/core/discord-interactions";
import { buildV2Payload } from "../../src/core/modqueue-message";
import { reopenComment, rejectComment } from "../../src/core/comments";
import { fixedClock } from "../../src/core/time";
import { app } from "../../src/index";

const bindings = env as unknown as Bindings;
const db = bindings.DB;
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
  await db.batch([
    db.prepare("DELETE FROM discord_pending_actions"),
    db.prepare("DELETE FROM discord_reopen_actions"),
    db.prepare("DELETE FROM discord_reopen_confirmations"),
    db.prepare("DELETE FROM discord_deny_modals"),
    db.prepare("DELETE FROM modqueue_notifications"),
    db.prepare("DELETE FROM link_submissions"),
    db.prepare("DELETE FROM admins"),
    db.prepare("DELETE FROM bans"),
    db.prepare("DELETE FROM authors"),
  ]);
  submissionId = ulid();
  messageId = "900000000000000105";
  await db.prepare(`INSERT INTO link_submissions (id, layout_id, url, submitted_by, submitted_at, status)
    VALUES (?, ?, ?, ?, ?, 'pending')`).bind(submissionId, ulid(), "https://example.org/", MOD, clock()).run();
  await db.prepare(`INSERT INTO modqueue_notifications (kind, submission_id, message_id, shown_status, message_format, transport, channel_id)
    VALUES ('link', ?, ?, 'pending', 'components_v2', 'bot', ?)`).bind(submissionId, messageId, CHANNEL).run();
});

afterEach(() => vi.unstubAllGlobals());

describe("[LDB-MD16] Discord HTTP interaction adapter", () => {
  it("[LDB-MD16] expires private callback tokens and modal bindings even when actions are disabled", async () => {
    await db.prepare(`INSERT INTO discord_pending_actions (interaction_id, application_id, token, actor_id, actor_name, kind, action, submission_id, channel_id, message_id, guild_id, created_at, expires_at)
      VALUES ('900000000000000199', ?, 'expired-callback-token', ?, 'mod', 'link', 'approve', ?, ?, ?, ?, ?, ?)`)
      .bind(APP, MOD, submissionId, CHANNEL, messageId, GUILD, "2026-10-18T11:00:00.000Z", "2026-10-18T11:14:00.000Z").run();
    await db.prepare(`INSERT INTO discord_deny_modals (modal_id, initial_interaction_id, actor_id, kind, submission_id, channel_id, message_id, guild_id, created_at, expires_at)
      VALUES ('expired-modal', '900000000000000198', ?, 'link', ?, ?, ?, ?, ?, ?)`)
      .bind(MOD, submissionId, CHANNEL, messageId, GUILD, "2026-10-18T11:00:00.000Z", "2026-10-18T11:14:00.000Z").run();
    await drainDiscordActions(db, { ...envWith(), MODQUEUE_DISCORD_ACTIONS: "false" }, clock);
    expect(await db.prepare("SELECT 1 FROM discord_pending_actions WHERE interaction_id = '900000000000000199'").first()).toBeNull();
    expect(await db.prepare("SELECT 1 FROM discord_deny_modals WHERE modal_id = 'expired-modal'").first()).toBeNull();
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

    await db.prepare("INSERT INTO admins (user_id, added_at) VALUES (?, ?)").bind(MOD, clock()).run();
    const approve = interaction(3, "900000000000000118", {
      custom_id: `aklmod1|link|approve|${submissionId}`,
    }, { message: { id: messageId }, token: longToken });
    const approveAck = await handleDiscordInteraction(await signedRequest(approve), env, clock);
    expect(await approveAck.json()).toEqual({ type: 6 });
    const approvedAction = await db.prepare("SELECT token FROM discord_pending_actions WHERE interaction_id = ?")
      .bind("900000000000000118").first<{ token: string }>();
    expect(approvedAction?.token).toBe(longToken);
    await db.prepare("DELETE FROM discord_pending_actions").run();

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
    const deniedAction = await db.prepare("SELECT token, action FROM discord_pending_actions WHERE interaction_id = ?")
      .bind("900000000000000120").first<{ token: string; action: string }>();
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
    expect(await db.prepare("SELECT 1 FROM discord_pending_actions").first()).toBeNull();
  });

  it("[LDB-MD16] defers a button action only after persistence, then rechecks current admin role in the continuation", async () => {
    const env = envWith();
    await db.prepare("INSERT INTO admins (user_id, added_at) VALUES (?, ?)").bind(MOD, clock()).run();
    const request = await signedRequest(interaction(3, "900000000000000111", {
      custom_id: `aklmod1|link|approve|${submissionId}`,
    }, { message: { id: messageId } }));
    const response = await handleDiscordInteraction(request, env, clock);
    expect(await response.json()).toEqual({ type: 6 });
    const queued = await db.prepare("SELECT interaction_id, actor_id, token, state FROM discord_pending_actions").first<{ interaction_id: string; actor_id: string; token: string; state: string }>();
    expect(queued).toMatchObject({ interaction_id: "900000000000000111", actor_id: MOD, token: TOKEN, state: "pending" });

    await db.prepare("DELETE FROM admins WHERE user_id = ?").bind(MOD).run();
    let callbackCount = 0;
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(null, { status: ++callbackCount === 1 ? 500 : 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await drainDiscordActions(db, env, clock);
    const submission = await db.prepare("SELECT status FROM link_submissions WHERE id = ?").bind(submissionId).first<{ status: string }>();
    expect(submission?.status).toBe("pending");
    expect(fetchMock).toHaveBeenCalledTimes(2); // private error followup + bounded durable retry
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(`https://discord.com/api/v10/webhooks/${APP}/${TOKEN}`);
    expect(fetchMock.mock.calls[0]?.[1]?.method).toBe("POST");
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({ flags: 64, allowed_mentions: { parse: [] } });
    const completed = await db.prepare("SELECT state, token, result FROM discord_pending_actions").first<{ state: string; token: string; result: string }>();
    expect(completed).toMatchObject({ state: "complete", token: "", result: "You no longer have permission to moderate this queue." });
  });

  it("[LDB-MD16] cleans up a legacy completed success reply without replaying the decision", async () => {
    await db.prepare(`INSERT INTO discord_pending_actions
      (interaction_id, application_id, token, actor_id, actor_name, kind, action, submission_id, channel_id, message_id, guild_id, created_at, expires_at, state, result)
      VALUES ('900000000000000180', ?, ?, ?, 'mod', 'link', 'approve', ?, ?, ?, ?, ?, '2026-10-18T12:14:00.000Z', 'complete', 'Submission approved.')`)
      .bind(APP, TOKEN, MOD, submissionId, CHANNEL, messageId, GUILD, clock()).run();
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    await drainDiscordActions(db, envWith(), clock);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(`https://discord.com/api/v10/webhooks/${APP}/${TOKEN}/messages/@original`);
    expect(fetchMock.mock.calls[0]?.[1]?.method).toBe("DELETE");
    expect(await db.prepare("SELECT status FROM link_submissions WHERE id = ?").bind(submissionId).first()).toEqual({ status: "pending" });
    expect(await db.prepare("SELECT token FROM discord_pending_actions WHERE interaction_id = '900000000000000180'").first()).toEqual({ token: "" });
  });

  it("[LDB-MD16] opens a deny modal, binds it to its original actor/card, stores bounded reason and rejects replay", async () => {
    const env = envWith();
    await db.prepare("INSERT INTO admins (user_id, added_at) VALUES (?, ?)").bind(MOD, clock()).run();
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
    const queued = await db.prepare("SELECT action, reason, actor_id FROM discord_pending_actions").first<{ action: string; reason: string; actor_id: string }>();
    expect(queued).toEqual({ action: "deny", reason: "Please include a clearer source.", actor_id: MOD });
    const modal = await db.prepare("SELECT consumed_interaction_id FROM discord_deny_modals WHERE modal_id = ?").bind(modalId).first<{ consumed_interaction_id: string }>();
    expect(modal?.consumed_interaction_id).toBe("900000000000000113");
    const replay = await handleDiscordInteraction(await signedRequest(submitted), env, clock);
    expect(((await replay.json()) as { data: { content: string } }).data.content).toContain("already received");
  });

  it("[LDB-MD19] opts a Discord denial into the private rejection DM outbox only when enabled", async () => {
    const layoutId = ulid();
    await db.prepare(`INSERT INTO layouts (id, name, owner, n, layout_rev, created_at, modified_at)
      VALUES (?, ?, ?, 1, 1, ?, ?)`).bind(layoutId, `discord-dm-${layoutId.toLowerCase()}`, MOD, clock(), clock()).run();
    await db.prepare("UPDATE link_submissions SET layout_id = ? WHERE id = ?").bind(layoutId, submissionId).run();
    await db.prepare("INSERT INTO admins (user_id, added_at) VALUES (?, ?)").bind(MOD, clock()).run();
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
    await drainDiscordActions(db, env, clock);
    const queued = await db.prepare("SELECT kind, submission_id, recipient_id FROM discord_rejection_dm_outbox WHERE submission_id = ?")
      .bind(submissionId).first<{ kind: string; submission_id: string; recipient_id: string }>();
    expect(queued).toEqual({ kind: "link", submission_id: submissionId, recipient_id: MOD });
  });
});

describe("[LDB-MD21] Discord reopening", () => {
  async function seedReview(status: "approved" | "rejected" | "pending" = "rejected", kind: "comment" | "wpm" = "comment") {
    const layout = ulid();
    const id = ulid();
    await db.prepare(`INSERT INTO layouts (id, name, owner, n, layout_rev, created_at, modified_at)
      VALUES (?, ?, ?, 1, 1, ?, ?)`).bind(layout, `discord-reopen-${layout.toLowerCase()}`, MOD, clock(), clock()).run();
    if (kind === "comment") await db.prepare(`INSERT INTO layout_comments (id, layout_id, user_id, body, via, submitted_at, status, decided_by, decided_at)
      VALUES (?, ?, ?, 'normal comment', 'discord', ?, ?, ?, ?)`)
      .bind(id, layout, MOD, clock(), status, status === "pending" ? null : MOD, status === "pending" ? null : clock()).run();
    else await db.prepare(`INSERT INTO wpm_submissions (id, layout_id, user_id, wpm, proof, submitted_by, via, submitted_at, status, decided_by, decided_at)
      VALUES (?, ?, ?, 150, 'https://example.org/proof', ?, 'discord', ?, ?, ?, ?)`)
      .bind(id, layout, MOD, MOD, clock(), status, status === "pending" ? null : MOD, status === "pending" ? null : clock()).run();
    await db.prepare(`INSERT INTO modqueue_notifications (kind, submission_id, message_id, shown_status, message_format, transport, channel_id)
      VALUES (?, ?, ?, ?, 'components_v2', 'bot', ?)`).bind(kind, id, messageId, status, CHANNEL).run();
    await db.prepare("INSERT OR IGNORE INTO admins (user_id, added_at) VALUES (?, ?)").bind(MOD, clock()).run();
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
    expect(await db.prepare("SELECT 1 FROM discord_reopen_confirmations").first()).toBeNull();
    // Exercise the production HTTP continuation, never call drainDiscordActions
    // directly: otherwise a missing waitUntil dispatch is invisible to this test.
    const table = kind === "comment" ? "layout_comments" : "wpm_submissions";
    expect(await db.prepare(`SELECT status, review_version FROM ${table} WHERE id = ?`).bind(id).first())
      .toEqual({ status: "pending", review_version: 1 });
    expect(await db.prepare("SELECT state, token FROM discord_reopen_actions WHERE interaction_id = ?").bind(initialId).first())
      .toEqual({ state: "complete", token: "" });
    expect(patches.some((patch) => JSON.stringify(patch).includes(`aklmod2|${kind}|approve|${id}|1`))).toBe(true);
    expect(requests.every((request) => !request.url.includes("/webhooks/"))).toBe(true);
  });

  it.each(["comment", "wpm"] as const)("[LDB-MD21] directly reopens denied %s once, restores controls and rejects replay", async (kind) => {
    const { id, patches } = await seedReview("rejected", kind);
    const first = await click(id, "900000000000000501", "reopen-rejected", 0, {}, kind);
    expect(first.type).toBe(6);
    expect((await click(id, "900000000000000501", "reopen-rejected", 0, {}, kind)).data?.content).toContain("already received");
    await drainDiscordActions(db, envWith(), clock);
    const table = kind === "comment" ? "layout_comments" : "wpm_submissions";
    expect(await db.prepare(`SELECT status, review_version FROM ${table} WHERE id = ?`).bind(id).first())
      .toEqual({ status: "pending", review_version: 1 });
    expect(patches.some((patch) => JSON.stringify(patch).includes(`aklmod2|${kind}|approve|${id}|1`))).toBe(true);
    await drainDiscordActions(db, envWith(), clock);
    expect((await db.prepare("SELECT id FROM moderation_review_history WHERE submission_id = ? AND action = 'reopened'").bind(id).all()).results).toHaveLength(1);
    expect((await click(id, "900000000000000502", "reopen-rejected", 0, {}, kind)).data?.content).toContain("stale");
  });

  async function legacyConfirmation(id: string, initialId: string) {
    const confirmationId = crypto.randomUUID();
    await db.prepare(`INSERT INTO discord_reopen_confirmations
      (confirmation_id, initial_interaction_id, actor_id, kind, submission_id, channel_id, message_id, guild_id, expected_status, expected_review_version, created_at, expires_at)
      VALUES (?, ?, ?, 'comment', ?, ?, ?, ?, 'approved', 0, ?, '2026-10-18T12:14:00.000Z')`)
      .bind(confirmationId, initialId, MOD, id, CHANNEL, messageId, GUILD, clock()).run();
    return `aklmod2|confirm|${confirmationId}`;
  }

  it("[LDB-MD21] safely completes an already-issued private confirmation by deleting only its private prompt", async () => {
    const { id, requests } = await seedReview("approved");
    const customId = await legacyConfirmation(id, "900000000000000510");
    expect((await confirm(customId, "900000000000000999", "900000000000000511")).data?.content).toContain("another moderator or message");
    expect((await confirm(customId, "900000000000000510", "900000000000000512", { member: { user: { id: "900000000000000777", username: "other" } } })).data?.content).toContain("another moderator");
    expect((await confirm(customId, "900000000000000510", "900000000000000516")).type).toBe(6);
    await drainDiscordActions(db, envWith(), clock);
    expect(await db.prepare("SELECT status, review_version FROM layout_comments WHERE id = ?").bind(id).first()).toEqual({ status: "pending", review_version: 1 });
    expect(requests.filter((request) => request.url.includes("/webhooks/")))
      .toEqual([{ url: `https://discord.com/api/v10/webhooks/${APP}/${TOKEN}/messages/@original`, method: "DELETE", body: {} }]);
  });

  it("[LDB-MD21] rejects wrong guild/channel, removed permissions and changed bindings before direct reopening", async () => {
    const { id } = await seedReview("approved");
    expect((await click(id, "900000000000000521", "reopen-approved", 0, { guild_id: "900000000000000999" })).data?.content).toContain("not allowed");
    expect((await click(id, "900000000000000522", "reopen-approved", 0, { channel_id: "900000000000000999" })).data?.content).toContain("not allowed");
    await db.prepare("DELETE FROM admins WHERE user_id = ?").bind(MOD).run();
    expect((await click(id, "900000000000000523", "reopen-approved")).data?.content).toContain("permission");
    await db.prepare("INSERT INTO admins (user_id, added_at) VALUES (?, ?)").bind(MOD, clock()).run();
    await db.prepare("UPDATE modqueue_notifications SET message_id = '900000000000000999' WHERE submission_id = ?").bind(id).run();
    expect((await click(id, "900000000000000524", "reopen-approved")).data?.content).toContain("stale");
    expect(await db.prepare("SELECT 1 FROM discord_reopen_actions").first()).toBeNull();
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
    expect(await db.prepare(`SELECT status FROM ${table} WHERE id = ?`).bind(id).first()).toEqual({ status: "approved" });
    expect(await deliver(interaction(3, "900000000000000571", { custom_id: `aklmod2|${kind}|reopen-approved|${id}|0` }, { message: { id: messageId } }))).toEqual({ type: 6 });
    const modal = await deliver(interaction(3, "900000000000000572", { custom_id: `aklmod2|${kind}|deny|${id}|1` }, { message: { id: messageId } }));
    expect(modal.type).toBe(9);
    expect(await deliver(interaction(5, "900000000000000573", {
      custom_id: modal.data!.custom_id, components: [{ type: 18, component: { type: 4, custom_id: "reason", value: "Proof missing" } }],
    }, { message: { id: messageId } }))).toEqual({ type: 6 });
    expect(await db.prepare(`SELECT status, reason FROM ${table} WHERE id = ?`).bind(id).first()).toEqual({ status: "rejected", reason: "Proof missing" });
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
    const row = await db.prepare("SELECT decision, status, discord_message_id FROM discord_rejection_dm_outbox WHERE submission_id = ?")
      .bind(id).first<{ decision: string; status: string; discord_message_id: string }>();
    expect(row).toEqual({ decision: "approval", status: "sent", discord_message_id: messageId });
    expect(requests.some((entry) => entry.url.endsWith("/users/@me/channels"))).toBe(true);
    expect(requests.some((entry) => entry.url.endsWith(`/channels/${messageId}/messages`))).toBe(true);
  });

  it("[LDB-MD21] stale pending buttons, denial modal and queued decisions cannot cross a reopened cycle", async () => {
    const { id } = await seedReview("pending");
    const modal = await click(id, "900000000000000530", "deny");
    expect(modal.type).toBe(9);
    expect((await click(id, "900000000000000531", "approve")).type).toBe(6);
    await db.prepare("UPDATE layout_comments SET review_version = 1 WHERE id = ?").bind(id).run();
    await db.prepare("UPDATE modqueue_notifications SET shown_review_version = 1 WHERE submission_id = ?").bind(id).run();
    for (const customId of [`aklmod1|comment|approve|${id}`, `aklmod2|comment|approve|${id}|0`]) {
      const response = await handleDiscordInteraction(await signedRequest(interaction(3, "900000000000000532", { custom_id: customId }, { message: { id: messageId } })), envWith(), clock);
      expect((await response.json() as { data: { content: string } }).data.content).toContain("stale");
    }
    const submit = await handleDiscordInteraction(await signedRequest(interaction(5, "900000000000000533", {
      custom_id: modal.data!.custom_id, components: [{ type: 18, component: { type: 4, custom_id: "reason", value: "stale reason" } }],
    })), envWith(), clock);
    expect((await submit.json() as { data: { content: string } }).data.content).toContain("changed");
    await drainDiscordActions(db, envWith(), clock);
    expect(await db.prepare("SELECT status, review_version FROM layout_comments WHERE id = ?").bind(id).first()).toEqual({ status: "pending", review_version: 1 });
    expect(await db.prepare("SELECT result FROM discord_pending_actions WHERE submission_id = ?").bind(id).first()).toEqual({ result: "This review changed. Refresh the card before deciding." });
  });

  it("[LDB-MD21] queued reopen cannot undo a later redecision; another moderator's reopen is not claimed as ours", async () => {
    const { id } = await seedReview("rejected");
    await click(id, "900000000000000540", "reopen-rejected");
    const actor = { user_id: "900000000000000777", name: "other", admin: true, banned: false, via: "discord" as const, source_client: "test" };
    await reopenComment(db, clock, actor, null, id, { status: "rejected", review_version: 0 });
    await rejectComment(db, clock, actor, null, id, "new decision", { reviewVersion: 1 });
    await drainDiscordActions(db, envWith(), clock);
    expect(await db.prepare("SELECT status, review_version FROM layout_comments WHERE id = ?").bind(id).first()).toEqual({ status: "rejected", review_version: 1 });
    expect(await db.prepare("SELECT result FROM discord_reopen_actions WHERE submission_id = ?").bind(id).first()).toEqual({ result: "This card is stale. Refresh it before reopening." });
    expect((await click(id, "900000000000000541", "reopen-rejected")).data?.content).toContain("stale");
  });

  it("[LDB-MD21] recovers a committed reopen after the worker lease expires without emitting another event", async () => {
    const { id } = await seedReview("rejected");
    await click(id, "900000000000000550", "reopen-rejected");
    const actor = { user_id: MOD, name: "mod", admin: true, banned: false, via: "discord" as const, source_client: "test" };
    await reopenComment(db, clock, actor, null, id, { status: "rejected", review_version: 0 });
    await db.prepare("UPDATE discord_reopen_actions SET state = 'working', lease_until = '2026-10-18T11:59:00.000Z'").run();
    await drainDiscordActions(db, envWith(), clock);
    expect(await db.prepare("SELECT result, state, token FROM discord_reopen_actions WHERE submission_id = ?").bind(id).first()).toEqual({ result: null, state: "complete", token: "" });
    expect((await db.prepare("SELECT id FROM moderation_review_history WHERE submission_id = ? AND action = 'reopened'").bind(id).all()).results).toHaveLength(1);
  });
});
