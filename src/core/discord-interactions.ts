// Dedicated akldb Discord HTTP interaction adapter. It uses the signed HTTP
// delivery path only; no Gateway client, Spark dependency, or user bearer token.
import type { Bindings } from "../env";
import type { Actor } from "../auth/actor";
import { roleOf } from "../auth/roles";
import { ApiError } from "./errors";
import * as comments from "./comments";
import * as links from "./links";
import * as wpm from "./wpm";
import { updateQueueNotification, type QueueKind } from "./modqueue";
import type { Clock } from "./time";

const MAX_BODY_BYTES = 64 * 1024;
const SIGNATURE_MAX_AGE_SECONDS = 5 * 60;
const TOKEN_LIFETIME_SECONDS = 14 * 60;
const LEASE_SECONDS = 30;
const BATCH_LIMIT = 10;
const API = "https://discord.com/api/v10";
const USER_AGENT = "akldb-discord/1.0";
const EPHEMERAL = 64;

type Action = "approve" | "deny";
interface QueueTarget { kind: QueueKind; id: string; }
interface PendingAction {
  kind: QueueKind;
  submission_id: string;
  interaction_id: string;
  application_id: string;
  token: string;
  actor_id: string;
  actor_name: string;
  action: Action;
  reason: string | null;
  channel_id: string;
  message_id: string;
  guild_id: string;
  created_at: string;
  expires_at: string;
  state: string;
  lease_until: string | null;
  lease_token: string | null;
  result?: string | null;
}

function configured(env: Bindings): boolean {
  return env.MODQUEUE_DISCORD_APPLICATION_ID !== undefined && env.MODQUEUE_DISCORD_APPLICATION_ID !== "" &&
    env.MODQUEUE_DISCORD_PUBLIC_KEY !== undefined && env.MODQUEUE_DISCORD_PUBLIC_KEY !== "";
}

function actionsConfigured(env: Bindings): boolean {
  return env.MODQUEUE_DISCORD_ACTIONS === "true" && env.MODQUEUE_DISCORD_BOT_TOKEN !== undefined && env.MODQUEUE_DISCORD_BOT_TOKEN !== "" &&
    env.MODQUEUE_DISCORD_GUILD_ID !== undefined && env.MODQUEUE_DISCORD_GUILD_ID !== "" &&
    env.MODQUEUE_DISCORD_CHANNEL_ID !== undefined && env.MODQUEUE_DISCORD_CHANNEL_ID !== "";
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function ephemeral(content: string): Response {
  return json({ type: 4, data: { content, flags: EPHEMERAL, allowed_mentions: { parse: [] } } });
}

function hexBytes(value: string): Uint8Array | null {
  if (!/^(?:[0-9a-fA-F]{2})+$/.test(value)) return null;
  const out = new Uint8Array(value.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(value.slice(i * 2, i * 2 + 2), 16);
  return out;
}

async function readBoundedBody(request: Request): Promise<Uint8Array | null> {
  const length = Number(request.headers.get("Content-Length"));
  if (Number.isFinite(length) && length > MAX_BODY_BYTES) return null;
  if (request.body === null) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
  return result;
}

async function verifyRequest(request: Request, body: Uint8Array, env: Bindings, now: Clock): Promise<boolean> {
  const timestamp = request.headers.get("X-Signature-Timestamp");
  const signature = hexBytes(request.headers.get("X-Signature-Ed25519") ?? "");
  const publicKey = hexBytes(env.MODQUEUE_DISCORD_PUBLIC_KEY ?? "");
  if (timestamp === null || !/^\d{10,13}$/.test(timestamp) || signature?.length !== 64 || publicKey?.length !== 32) return false;
  const seconds = timestamp.length === 13 ? Math.floor(Number(timestamp) / 1000) : Number(timestamp);
  if (!Number.isSafeInteger(seconds) || Math.abs(Math.floor(Date.parse(now()) / 1000) - seconds) > SIGNATURE_MAX_AGE_SECONDS) return false;
  try {
    const key = await crypto.subtle.importKey("raw", publicKey, { name: "Ed25519" }, false, ["verify"]);
    const signed = new Uint8Array(new TextEncoder().encode(timestamp).length + body.length);
    signed.set(new TextEncoder().encode(timestamp));
    signed.set(body, new TextEncoder().encode(timestamp).length);
    return await crypto.subtle.verify("Ed25519", key, signature, signed);
  } catch {
    return false;
  }
}

function record(body: unknown): body is Record<string, unknown> {
  return body !== null && typeof body === "object" && !Array.isArray(body);
}

function targetFromCustomId(customId: unknown): (QueueTarget & { action: Action }) | null {
  if (typeof customId !== "string") return null;
  const parts = customId.split("|");
  if (parts.length !== 4 || parts[0] !== "aklmod1" || !["link", "wpm", "comment"].includes(parts[1]!) || !["approve", "deny"].includes(parts[2]!)) return null;
  if (!/^[0-9A-HJKMNP-TV-Z]{26}$/.test(parts[3]!)) return null;
  return { kind: parts[1] as QueueKind, action: parts[2] as Action, id: parts[3]! };
}

function userOf(interaction: Record<string, unknown>): Record<string, unknown> | null {
  const member = record(interaction.member) ? interaction.member : null;
  const user = member && record(member.user) ? member.user : record(interaction.user) ? interaction.user : null;
  return user;
}

async function trackedTarget(db: Bindings["DB"], target: QueueTarget, channelId: string, messageId: string): Promise<boolean> {
  const row = await db.prepare(`SELECT 1 FROM modqueue_notifications
    WHERE kind = ? AND submission_id = ? AND transport = 'bot' AND channel_id = ?
      AND message_id = ? AND shown_status = 'pending' LIMIT 1`)
    .bind(target.kind, target.id, channelId, messageId).first();
  if (row === null) return false;
  const table = target.kind === "link" ? "link_submissions" : target.kind === "wpm" ? "wpm_submissions" : "layout_comments";
  return await db.prepare(`SELECT 1 FROM ${table} WHERE id = ? AND status = 'pending'`).bind(target.id).first() !== null;
}

async function hasReceipt(db: Bindings["DB"], interactionId: string): Promise<boolean> {
  return await db.prepare("SELECT 1 FROM discord_pending_actions WHERE interaction_id = ? UNION ALL SELECT 1 FROM discord_deny_modals WHERE initial_interaction_id = ? LIMIT 1")
    .bind(interactionId, interactionId).first() !== null;
}

async function insertFailureResponse(db: Bindings["DB"], interactionId: string): Promise<Response> {
  try {
    if (await hasReceipt(db, interactionId)) return ephemeral("This interaction was already received.");
  } catch { /* distinguish storage trouble from a confirmed replay without leaking details */ }
  return ephemeral("We could not safely queue this action. Please refresh the card and try again.");
}

function deferEphemeral(): Response {
  return json({ type: 5, data: { flags: EPHEMERAL } });
}

function denyModal(modalId: string): Response {
  return json({ type: 9, data: {
    custom_id: `aklmod1|deny|${modalId}`,
    title: "Deny submission",
    components: [{ type: 18, label: "Reason (optional)", description: "Let the submitter know what to change", component: { type: 4, custom_id: "reason", style: 2, required: false, max_length: 500, placeholder: "Optional" } }],
  } });
}

function discordUrl(appId: string, token: string): string {
  return `${API}/webhooks/${encodeURIComponent(appId)}/${encodeURIComponent(token)}/messages/@original`;
}

async function editDeferredResponse(action: PendingAction, content: string, env: Bindings): Promise<"sent" | "retry" | "expired"> {
  if (action.token === "" || env.MODQUEUE_DISCORD_BOT_TOKEN === undefined || env.MODQUEUE_DISCORD_BOT_TOKEN === "") return "expired";
  try {
    const response = await fetch(discordUrl(action.application_id, action.token), {
      method: "PATCH",
      headers: { "Content-Type": "application/json", "User-Agent": USER_AGENT },
      body: JSON.stringify({ content, allowed_mentions: { parse: [] } }),
      signal: AbortSignal.timeout(5000),
    });
    if (response.ok) return "sent";
    console.error(`discord interaction callback edit failed with status ${response.status}`);
    if (response.status === 401 || response.status === 404) return "expired";
    return "retry";
  } catch {
    // The callback token expires; decisions/status reconciliation remain durable.
    return "retry";
  }
}

async function submissionDecision(db: Bindings["DB"], action: PendingAction): Promise<{ status: string; decided_by: string | null } | null> {
  const table = action.kind === "link" ? "link_submissions" : action.kind === "wpm" ? "wpm_submissions" : "layout_comments";
  return db.prepare(`SELECT status, decided_by FROM ${table} WHERE id = ?`).bind(action.submission_id)
    .first<{ status: string; decided_by: string | null }>();
}

async function performDecision(db: Bindings["DB"], env: Bindings, now: Clock, action: PendingAction): Promise<string> {
  const roles = await roleOf(db, action.actor_id); // fresh on each attempt
  if (!roles.admin || roles.banned) return "You no longer have permission to moderate this queue.";
  const author = await db.prepare("SELECT name FROM authors WHERE user_id = ?").bind(action.actor_id).first<{ name: string }>();
  const actor: Actor = {
    user_id: action.actor_id, name: author?.name ?? action.actor_name, via: "discord",
    ...roles, source_client: `discord-app:${action.application_id}`,
  };
  const before = await submissionDecision(db, action);
  const desired = action.action === "approve" ? "approved" : "rejected";
  if (before === null) return "This submission no longer exists.";
  if (before.status !== "pending") {
    if (before.status === desired && before.decided_by === action.actor_id) {
      await updateQueueNotification(db, env, action.kind, action.submission_id);
      return `Already ${desired}.`;
    }
    return "This submission was already decided by someone else.";
  }
  try {
    if (action.kind === "link") {
      if (action.action === "approve") await links.approveSubmission(db, now, actor, null, action.submission_id);
      else await links.rejectSubmission(db, now, actor, null, action.submission_id, action.reason ?? undefined);
    } else if (action.kind === "wpm") {
      if (action.action === "approve") await wpm.approveWpm(db, now, actor, null, action.submission_id);
      else await wpm.rejectWpm(db, now, actor, null, action.submission_id, action.reason ?? undefined);
    } else {
      if (action.action === "approve") await comments.approveComment(db, now, actor, null, action.submission_id);
      else await comments.rejectComment(db, now, actor, null, action.submission_id, action.reason ?? undefined);
    }
  } catch (error) {
    // Recover a crash after the domain write but before marking this job done.
    const after = await submissionDecision(db, action);
    if (after?.status === desired && after.decided_by === action.actor_id) {
      // The winning decision committed before a prior attempt failed.
    } else if (after?.status !== "pending") return "This submission was already decided by someone else.";
    else if (!(error instanceof ApiError) || error.status >= 500) throw error;
    else return "This submission is no longer available for that decision.";
  }
  await updateQueueNotification(db, env, action.kind, action.submission_id);
  return action.action === "approve" ? "Submission approved." : "Submission denied.";
}

async function claimAction(db: Bindings["DB"], now: Clock): Promise<PendingAction | null> {
  const at = now();
  const until = new Date(Date.parse(at) + LEASE_SECONDS * 1000).toISOString();
  const leaseToken = crypto.randomUUID();
  const row = await db.prepare(`SELECT * FROM discord_pending_actions WHERE expires_at > ? AND
    (state = 'pending' OR (state = 'working' AND lease_until < ?)) ORDER BY created_at ASC LIMIT 1`).bind(at, at).first<PendingAction>();
  if (row === null) return null;
  const changed = await db.prepare(`UPDATE discord_pending_actions SET state = 'working', lease_until = ?, lease_token = ?, attempts = attempts + 1
    WHERE interaction_id = ? AND (state = 'pending' OR (state = 'working' AND lease_until < ?))`).bind(until, leaseToken, row.interaction_id, at).run();
  return changed.meta.changes === 1 ? { ...row, state: "working", lease_until: until, lease_token: leaseToken } : null;
}

export async function drainDiscordActions(db: Bindings["DB"], env: Bindings, now: Clock): Promise<void> {
  await db.prepare("UPDATE discord_pending_actions SET state = 'expired', token = '', result = 'expired', lease_until = NULL, lease_token = NULL WHERE expires_at <= ? AND state IN ('pending', 'working')").bind(now()).run();
  await db.prepare("DELETE FROM discord_deny_modals WHERE expires_at <= ?").bind(now()).run();
  await db.prepare("DELETE FROM discord_pending_actions WHERE expires_at <= ? AND state IN ('complete', 'expired')").bind(now()).run();
  if (env.MODQUEUE_DISCORD_ACTIONS !== "true" || env.MODQUEUE_DISCORD_BOT_TOKEN === undefined || env.MODQUEUE_DISCORD_BOT_TOKEN === "") {
    await db.prepare("UPDATE discord_pending_actions SET state = 'expired', token = '', result = 'actions disabled', lease_until = NULL, lease_token = NULL WHERE state IN ('pending', 'working')").run();
    await db.prepare("UPDATE discord_pending_actions SET token = '' WHERE state = 'complete'").run();
    return;
  }
  for (let i = 0; i < BATCH_LIMIT; i++) {
    const action = await claimAction(db, now);
    if (action === null) break;
    if (action.application_id !== env.MODQUEUE_DISCORD_APPLICATION_ID || action.guild_id !== env.MODQUEUE_DISCORD_GUILD_ID || action.channel_id !== env.MODQUEUE_DISCORD_CHANNEL_ID) {
      await db.prepare("UPDATE discord_pending_actions SET state = 'expired', token = '', result = 'configuration changed', lease_until = NULL, lease_token = NULL WHERE interaction_id = ? AND lease_token = ?")
        .bind(action.interaction_id, action.lease_token).run();
      continue;
    }
    let result: string;
    try { result = await performDecision(db, env, now, action); }
    catch {
      await db.prepare("UPDATE discord_pending_actions SET state = 'pending', lease_until = NULL, lease_token = NULL WHERE interaction_id = ? AND state = 'working' AND lease_token = ?")
        .bind(action.interaction_id, action.lease_token).run();
      break; // do not spin on a transient DB/Discord failure in the same tick
    }
    const callback = await editDeferredResponse(action, result, env);
    await db.prepare("UPDATE discord_pending_actions SET state = 'complete', result = ?, token = ?, lease_until = NULL, lease_token = NULL WHERE interaction_id = ? AND state = 'working' AND lease_token = ?")
      .bind(result.slice(0, 200), callback === "retry" ? action.token : "", action.interaction_id, action.lease_token).run();
  }
  const callbacks = await db.prepare(`SELECT * FROM discord_pending_actions WHERE state = 'complete' AND token != '' AND expires_at > ?
    ORDER BY attempts ASC, created_at ASC LIMIT ?`).bind(now(), BATCH_LIMIT).all<PendingAction>();
  for (const action of callbacks.results) {
    const callback = await editDeferredResponse(action, action.result ?? "Action complete.", env);
    if (callback !== "retry") {
      await db.prepare("UPDATE discord_pending_actions SET token = '' WHERE interaction_id = ? AND state = 'complete' AND token = ?")
        .bind(action.interaction_id, action.token).run();
    } else {
      await db.prepare("UPDATE discord_pending_actions SET attempts = attempts + 1 WHERE interaction_id = ? AND state = 'complete' AND token = ?")
        .bind(action.interaction_id, action.token).run();
    }
  }
}

async function parseReason(interaction: Record<string, unknown>): Promise<string | null> {
  if (!record(interaction.data)) return null;
  const rows = interaction.data.components;
  if (!Array.isArray(rows)) return null;
  for (const row of rows) {
    if (!record(row)) continue;
    const components = Array.isArray(row.components) ? row.components : [row.component];
    for (const component of components) {
      if (record(component) && component.custom_id === "reason" && typeof component.value === "string") {
        const reason = component.value;
        if (reason.length > 500) throw new Error("invalid reason");
        return reason.length === 0 ? null : reason;
      }
    }
  }
  return null;
}

export async function handleDiscordInteraction(request: Request, env: Bindings, now: Clock): Promise<Response> {
  if (!configured(env)) return new Response("Not found", { status: 404 });
  let raw: Uint8Array | null;
  try { raw = await readBoundedBody(request); } catch { return new Response("Bad request", { status: 400 }); }
  if (raw === null) return new Response("Payload too large", { status: 413 });
  if (!await verifyRequest(request, raw, env, now)) return new Response("Invalid signature", { status: 401 });
  let interaction: unknown;
  try { interaction = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(raw)); } catch { return new Response("Bad request", { status: 400 }); }
  if (!record(interaction)) return new Response("Bad request", { status: 400 });
  if (interaction.application_id !== env.MODQUEUE_DISCORD_APPLICATION_ID) return ephemeral("This interaction is not for akldb.");
  if (interaction.type === 1) return json({ type: 1 });
  if (interaction.guild_id !== env.MODQUEUE_DISCORD_GUILD_ID || interaction.channel_id !== env.MODQUEUE_DISCORD_CHANNEL_ID) return ephemeral("This action is not allowed here.");
  const interactionId = typeof interaction.id === "string" ? interaction.id : "";
  const token = typeof interaction.token === "string" ? interaction.token : "";
  const user = userOf(interaction);
  if (!/^\d{17,20}$/.test(interactionId) || token.length < 20 || token.length > 200 || user === null || typeof user.id !== "string" || !/^\d{17,20}$/.test(user.id) || typeof user.username !== "string") return ephemeral("This interaction is malformed.");
  if (await hasReceipt(env.DB, interactionId)) return ephemeral("This interaction was already received.");

  if (interaction.type === 3) {
    if (!actionsConfigured(env) || !record(interaction.message)) return ephemeral("Moderation actions are unavailable.");
    const target = targetFromCustomId(record(interaction.data) ? interaction.data.custom_id : undefined);
    const messageId = typeof interaction.message.id === "string" ? interaction.message.id : "";
    if (target === null || !/^\d{17,20}$/.test(messageId) || !await trackedTarget(env.DB, target, env.MODQUEUE_DISCORD_CHANNEL_ID!, messageId)) return ephemeral("This card is stale or unrecognized.");
    const roles = await roleOf(env.DB, user.id);
    if (!roles.admin || roles.banned) return ephemeral("You do not have permission to moderate this queue.");
    const nowIso = now();
    if (target.action === "deny") {
      const modalId = crypto.randomUUID();
      const expiresAt = new Date(Date.parse(nowIso) + TOKEN_LIFETIME_SECONDS * 1000).toISOString();
      try {
        await env.DB.prepare(`INSERT INTO discord_deny_modals (modal_id, initial_interaction_id, actor_id, kind, submission_id, channel_id, message_id, guild_id, created_at, expires_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .bind(modalId, interactionId, user.id, target.kind, target.id, env.MODQUEUE_DISCORD_CHANNEL_ID, messageId, env.MODQUEUE_DISCORD_GUILD_ID, nowIso, expiresAt).run();
      } catch { return await insertFailureResponse(env.DB, interactionId); }
      return denyModal(modalId);
    }
    const expiresAt = new Date(Date.parse(nowIso) + TOKEN_LIFETIME_SECONDS * 1000).toISOString();
    try {
      await env.DB.prepare(`INSERT INTO discord_pending_actions (interaction_id, application_id, token, actor_id, actor_name, kind, action, submission_id, reason, channel_id, message_id, guild_id, created_at, expires_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?)`)
        .bind(interactionId, env.MODQUEUE_DISCORD_APPLICATION_ID, token, user.id, user.username, target.kind, target.action, target.id, env.MODQUEUE_DISCORD_CHANNEL_ID, messageId, env.MODQUEUE_DISCORD_GUILD_ID, nowIso, expiresAt).run();
    } catch { return await insertFailureResponse(env.DB, interactionId); }
    return deferEphemeral();
  }

  if (interaction.type === 5) {
    if (!actionsConfigured(env) || !record(interaction.data) || typeof interaction.data.custom_id !== "string") return ephemeral("This modal is no longer available.");
    const match = /^aklmod1\|deny\|([0-9a-f-]{36})$/.exec(interaction.data.custom_id);
    if (match === null) return ephemeral("This modal is invalid.");
    const modalId = match[1]!;
    let reason: string | null;
    try { reason = await parseReason(interaction); } catch { return ephemeral("The reason is too long."); }
    const modal = await env.DB.prepare(`SELECT actor_id, kind, submission_id, channel_id, message_id, guild_id, expires_at, consumed_at
      FROM discord_deny_modals WHERE modal_id = ?`).bind(modalId).first<{ actor_id: string; kind: QueueKind; submission_id: string; channel_id: string; message_id: string; guild_id: string; expires_at: string; consumed_at: string | null }>();
    if (modal === null || modal.actor_id !== user.id || modal.channel_id !== env.MODQUEUE_DISCORD_CHANNEL_ID || modal.guild_id !== env.MODQUEUE_DISCORD_GUILD_ID || modal.expires_at <= now() || modal.consumed_at !== null) return ephemeral("This modal expired or belongs to another moderator.");
    const roles = await roleOf(env.DB, user.id);
    if (!roles.admin || roles.banned) return ephemeral("You no longer have permission to moderate this queue.");
    if (!await trackedTarget(env.DB, { kind: modal.kind, id: modal.submission_id }, modal.channel_id, modal.message_id)) return ephemeral("This submission is no longer pending.");
    const nowIso = now();
    const expiresAt = new Date(Date.parse(nowIso) + TOKEN_LIFETIME_SECONDS * 1000).toISOString();
    try {
      const result = await env.DB.batch([
        env.DB.prepare("UPDATE discord_deny_modals SET consumed_at = ?, consumed_interaction_id = ? WHERE modal_id = ? AND actor_id = ? AND expires_at > ? AND consumed_at IS NULL")
          .bind(nowIso, interactionId, modalId, user.id, nowIso),
        env.DB.prepare(`INSERT INTO discord_pending_actions (interaction_id, application_id, token, actor_id, actor_name, kind, action, submission_id, reason, channel_id, message_id, guild_id, created_at, expires_at)
          SELECT ?, ?, ?, ?, ?, ?, 'deny', ?, ?, ?, ?, ?, ?, ? WHERE EXISTS
            (SELECT 1 FROM discord_deny_modals WHERE modal_id = ? AND consumed_interaction_id = ? AND actor_id = ?)`)
          .bind(interactionId, env.MODQUEUE_DISCORD_APPLICATION_ID, token, user.id, user.username, modal.kind, modal.submission_id, reason, modal.channel_id, modal.message_id, modal.guild_id, nowIso, expiresAt, modalId, interactionId, user.id),
      ]);
      if (result[0]?.meta.changes !== 1 || result[1]?.meta.changes !== 1) return ephemeral("This modal was already submitted.");
    } catch { return await insertFailureResponse(env.DB, interactionId); }
    return deferEphemeral();
  }
  return ephemeral("Unsupported interaction.");
}
