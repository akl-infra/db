import { env } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ulid } from "ulidx";
import type { Bindings } from "../../src/env";
import { drainDiscordActions, handleDiscordInteraction } from "../../src/core/discord-interactions";
import { fixedClock } from "../../src/core/time";

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
    expect(await response.json()).toEqual({ type: 5, data: { flags: 64 } });
    const queued = await db.prepare("SELECT interaction_id, actor_id, token, state FROM discord_pending_actions").first<{ interaction_id: string; actor_id: string; token: string; state: string }>();
    expect(queued).toMatchObject({ interaction_id: "900000000000000111", actor_id: MOD, token: TOKEN, state: "pending" });

    await db.prepare("DELETE FROM admins WHERE user_id = ?").bind(MOD).run();
    let callbackCount = 0;
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(null, { status: ++callbackCount === 1 ? 500 : 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await drainDiscordActions(db, env, clock);
    const submission = await db.prepare("SELECT status FROM link_submissions WHERE id = ?").bind(submissionId).first<{ status: string }>();
    expect(submission?.status).toBe("pending");
    expect(fetchMock).toHaveBeenCalledTimes(2); // initial callback edit + bounded durable retry
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain(`/webhooks/${APP}/${TOKEN}/messages/@original`);
    const completed = await db.prepare("SELECT state, token, result FROM discord_pending_actions").first<{ state: string; token: string; result: string }>();
    expect(completed).toMatchObject({ state: "complete", token: "", result: "You no longer have permission to moderate this queue." });
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
    expect(await response.json()).toEqual({ type: 5, data: { flags: 64 } });
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
