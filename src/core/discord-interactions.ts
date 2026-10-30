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
import { toStore, type StoreArg } from "../store/arg";
import { type ActionTable, type Store } from "../store/port";

const MAX_BODY_BYTES = 64 * 1024;
const SIGNATURE_MAX_AGE_SECONDS = 5 * 60;
const TOKEN_LIFETIME_SECONDS = 14 * 60;
const LEASE_SECONDS = 30;
const BATCH_LIMIT = 10;
const USER_AGENT = "akldb-discord/1.0";
const EPHEMERAL = 64;

type Action = "approve" | "deny" | "reopen";
interface QueueTarget { kind: QueueKind; id: string; review_version: number; status: string; }
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
  expected_review_version: number;
  expected_status?: "approved" | "rejected";
  channel_id: string;
  message_id: string;
  guild_id: string;
  created_at: string;
  expires_at: string;
  state: string;
  lease_until: string | null;
  lease_token: string | null;
  result?: string | null;
  response_mode: "reply" | "update";
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
  if (typeof customId !== "string" || customId.length > 100) return null;
  const parts = customId.split("|");
  const legacy = parts[0] === "aklmod1" && parts.length === 4;
  if (!legacy && !(parts[0] === "aklmod2" && parts.length === 5 && /^(0|[1-9][0-9]*)$/.test(parts[4]!))) return null;
  if (!["link", "wpm", "comment"].includes(parts[1]!) || !/^[0-9A-HJKMNP-TV-Z]{26}$/.test(parts[3]!)) return null;
  const version = legacy ? 0 : Number(parts[4]);
  if (!Number.isSafeInteger(version)) return null;
  const action = parts[2]!;
  if (["approve", "deny"].includes(action)) return { kind: parts[1] as QueueKind, action: action as Action, id: parts[3]!, review_version: version, status: "pending" };
  if (!legacy && parts[1] !== "link" && ["reopen-approved", "reopen-rejected"].includes(action)) {
    return { kind: parts[1] as QueueKind, action: "reopen", id: parts[3]!, review_version: version, status: action.slice(7) };
  }
  return null;
}

function userOf(interaction: Record<string, unknown>): Record<string, unknown> | null {
  const member = record(interaction.member) ? interaction.member : null;
  const user = member && record(member.user) ? member.user : record(interaction.user) ? interaction.user : null;
  return user;
}

async function trackedTarget(store: Store, target: QueueTarget, channelId: string, messageId: string): Promise<boolean> {
  return store.discord.trackedTarget({ kind: target.kind, id: target.id, status: target.status, reviewVersion: target.review_version }, channelId, messageId);
}

async function hasReceipt(store: Store, interactionId: string): Promise<boolean> {
  return store.discord.hasReceipt(interactionId);
}

async function insertFailureResponse(store: Store, interactionId: string): Promise<Response> {
  try {
    if (await hasReceipt(store, interactionId)) return ephemeral("This interaction was already received.");
  } catch { /* distinguish storage trouble from a confirmed replay without leaking details */ }
  return ephemeral("We could not safely queue this action. Please refresh the card and try again.");
}

// ACK a component (or its denial modal) without creating a private reply.
function deferUpdate(): Response {
  return json({ type: 6 });
}

function denyModal(modalId: string): Response {
  return json({ type: 9, data: {
    custom_id: `aklmod1|deny|${modalId}`,
    title: "Deny submission",
    components: [{ type: 18, label: "Reason (optional)", description: "Let the submitter know what to change", component: { type: 4, custom_id: "reason", style: 2, required: false, max_length: 500, placeholder: "Optional" } }],
  } });
}

// The one Discord base: DISCORD_API_URL, which wrangler.toml pins to production's value, so production's URL is unchanged.
function discordUrl(env: Bindings, appId: string, token: string): string {
  return `${env.DISCORD_API_URL.replace(/\/$/, "")}/v10/webhooks/${encodeURIComponent(appId)}/${encodeURIComponent(token)}/messages/@original`;
}

async function finishInteraction(action: PendingAction, content: string | null, env: Bindings): Promise<"sent" | "retry" | "expired"> {
  // A deferred update's @original is the shared queue card. Never PATCH or
  // DELETE it to deliver a private outcome. Successful updates need no reply.
  // Old completed jobs may still carry these success strings while retrying
  // their pre-deploy reply. New jobs persist null on success.
  const success = content === null || [
    "Submission approved.", "Submission denied.", "Already approved.", "Already rejected.",
    "Review reopened.", "Review reopened. The submission is pending again.",
  ].includes(content);
  if (action.response_mode === "update" && success) return "sent";
  if (action.token === "" || env.MODQUEUE_DISCORD_BOT_TOKEN === undefined || env.MODQUEUE_DISCORD_BOT_TOKEN === "") return "expired";
  try {
    const original = discordUrl(env, action.application_id, action.token);
    const response = await fetch(action.response_mode === "update" ? original.replace(/\/messages\/@original$/, "") : original, {
      method: action.response_mode === "update" ? "POST" : success ? "DELETE" : "PATCH",
      headers: { "Content-Type": "application/json", "User-Agent": USER_AGENT },
      body: success ? undefined : JSON.stringify({ content, components: [], allowed_mentions: { parse: [] }, ...(action.response_mode === "update" ? { flags: EPHEMERAL } : {}) }),
      signal: AbortSignal.timeout(5000),
    });
    if (response.ok) return "sent";
    console.error(`discord interaction callback failed with status ${response.status}`);
    if (response.status === 401 || response.status === 404) return "expired";
    return "retry";
  } catch {
    // The callback token expires; decisions/status reconciliation remain durable.
    return "retry";
  }
}

async function submissionDecision(store: Store, action: PendingAction): Promise<{ status: string; decided_by: string | null; review_version: number } | null> {
  return store.review.submissionDecision(action.kind, action.submission_id);
}

async function performDecision(store: Store, env: Bindings, now: Clock, action: PendingAction): Promise<string | null> {
  const roles = await roleOf(store, action.actor_id); // fresh on each attempt
  if (!roles.admin || roles.banned) return "You no longer have permission to moderate this queue.";
  const authorName = await store.auth.authorName(action.actor_id);
  const actor: Actor = {
    user_id: action.actor_id, name: authorName ?? action.actor_name, via: "discord",
    ...roles, source_client: `discord-app:${action.application_id}`,
  };
  const before = await submissionDecision(store, action);
  if (action.action === "reopen") {
    if (before === null) return "This submission no longer exists.";
    // A recovered job may have committed already. Never reapply it to a later cycle.
    const ownReopen = before.review_version === action.expected_review_version + 1 && await store.review.reopenRecorded({ kind: action.kind, id: action.submission_id, reviewVersion: before.review_version, actor: action.actor_id });
    if (ownReopen) {
      await updateQueueNotification(store, env, action.kind, action.submission_id);
      return null;
    }
    if (before.review_version !== action.expected_review_version || before.status !== action.expected_status) return "This card is stale. Refresh it before reopening.";
    try {
      const expected = { status: action.expected_status!, review_version: action.expected_review_version };
      if (action.kind === "comment") await comments.reopenComment(store, now, actor, null, action.submission_id, expected);
      else if (action.kind === "wpm") await wpm.reopenWpm(store, now, actor, null, action.submission_id, expected);
      else return "Links cannot be reopened.";
    } catch (error) {
      if (!(error instanceof ApiError) || error.status >= 500) throw error;
      return "This submission is no longer available to reopen.";
    }
    await updateQueueNotification(store, env, action.kind, action.submission_id);
    return null;
  }
  if (before !== null && before.review_version !== action.expected_review_version) return "This review changed. Refresh the card before deciding.";
  const desired = action.action === "approve" ? "approved" : "rejected";
  if (before === null) return "This submission no longer exists.";
  if (before.status !== "pending") {
    if (before.status === desired && before.decided_by === action.actor_id) {
      await updateQueueNotification(store, env, action.kind, action.submission_id);
      return null;
    }
    return "This submission was already decided by someone else.";
  }
  try {
    if (action.kind === "link") {
      if (action.action === "approve") await links.approveSubmission(store, now, actor, null, action.submission_id);
      else await links.rejectSubmission(store, now, actor, null, action.submission_id, action.reason ?? undefined, { notifySubmitter: env.MODQUEUE_DISCORD_DMS === "true" });
    } else if (action.kind === "wpm") {
      if (action.action === "approve") await wpm.approveWpm(store, now, actor, null, action.submission_id, action.expected_review_version, env.MODQUEUE_DISCORD_DMS === "true");
      else await wpm.rejectWpm(store, now, actor, null, action.submission_id, action.reason ?? undefined, { notifySubmitter: env.MODQUEUE_DISCORD_DMS === "true", reviewVersion: action.expected_review_version });
    } else {
      if (action.action === "approve") await comments.approveComment(store, now, actor, null, action.submission_id, action.expected_review_version, env.MODQUEUE_DISCORD_DMS === "true");
      else await comments.rejectComment(store, now, actor, null, action.submission_id, action.reason ?? undefined, { notifySubmitter: env.MODQUEUE_DISCORD_DMS === "true", reviewVersion: action.expected_review_version });
    }
  } catch (error) {
    // Recover a crash after the domain write but before marking this job done.
    const after = await submissionDecision(store, action);
    if (after?.review_version !== action.expected_review_version) return "This review changed. Refresh the card before deciding.";
    if (after?.status === desired && after.decided_by === action.actor_id) {
      // The winning decision committed before a prior attempt failed.
    } else if (after?.status !== "pending") return "This submission was already decided by someone else.";
    else if (!(error instanceof ApiError) || error.status >= 500) throw error;
    else return "This submission is no longer available for that decision.";
  }
  await updateQueueNotification(store, env, action.kind, action.submission_id);
  return null;
}

async function claimAction(store: Store, now: Clock, table: ActionTable): Promise<PendingAction | null> {
  const at = now();
  const until = new Date(Date.parse(at) + LEASE_SECONDS * 1000).toISOString();
  const leaseToken = crypto.randomUUID();
  return store.discord.claimAction(table, at, until, leaseToken);
}

async function drainActionTable(store: Store, env: Bindings, now: Clock, table: ActionTable): Promise<void> {
  await store.discord.expireActions(table, now());
  if (env.MODQUEUE_DISCORD_ACTIONS !== "true" || env.MODQUEUE_DISCORD_BOT_TOKEN === undefined || env.MODQUEUE_DISCORD_BOT_TOKEN === "") {
    await store.discord.disableActions(table);
    return;
  }
  for (let i = 0; i < BATCH_LIMIT; i++) {
    const action = await claimAction(store, now, table);
    if (action === null) break;
    if (action.application_id !== env.MODQUEUE_DISCORD_APPLICATION_ID || action.guild_id !== env.MODQUEUE_DISCORD_GUILD_ID || action.channel_id !== env.MODQUEUE_DISCORD_CHANNEL_ID) {
      await store.discord.expireLeasedAction(table, action.interaction_id, action.lease_token!, "configuration changed");
      continue;
    }
    let result: string | null;
    try { result = await performDecision(store, env, now, action); }
    catch {
      await store.discord.releaseAction(table, action.interaction_id, action.lease_token!);
      break; // do not spin on a transient DB/Discord failure in the same tick
    }
    const callback = await finishInteraction(action, result, env);
    await store.discord.completeAction(table, action.interaction_id, action.lease_token!, result?.slice(0, 200) ?? null, callback === "retry" ? action.token : "");
  }
  const callbacks = await store.discord.pendingCallbacks(table, now(), BATCH_LIMIT);
  for (const action of callbacks) {
    const callback = await finishInteraction(action, action.result ?? null, env);
    if (callback !== "retry") {
      await store.discord.clearCallbackToken(table, action.interaction_id, action.token);
    } else {
      await store.discord.bumpCallbackAttempts(table, action.interaction_id, action.token);
    }
  }
}

export async function drainDiscordActions(dbArg: StoreArg, env: Bindings, now: Clock): Promise<void> {
  const store = toStore(dbArg);
  await store.discord.deleteExpiredConfirmations(now());
  await drainActionTable(store, env, now, "discord_pending_actions");
  await drainActionTable(store, env, now, "discord_reopen_actions");
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

async function handleReopenConfirmation(store: Store, interaction: Record<string, unknown>, env: Bindings, now: Clock,
  user: Record<string, unknown>, interactionId: string, token: string): Promise<Response | null> {
  const customId = record(interaction.data) ? interaction.data.custom_id : null;
  if (typeof customId !== "string") return null;
  const match = /^aklmod2\|(confirm|cancel)\|([0-9a-f-]{36})$/.exec(customId);
  if (match === null) return null;
  const row = await store.discord.reopenConfirmation(match[2]!);
  const metadata = record(interaction.message) && record(interaction.message.interaction_metadata) ? interaction.message.interaction_metadata : null;
  if (row === null || row.actor_id !== user.id || row.channel_id !== interaction.channel_id || row.guild_id !== interaction.guild_id ||
      row.expires_at <= now() || row.consumed_at !== null || metadata?.id !== row.initial_interaction_id) {
    return ephemeral("This confirmation expired or belongs to another moderator or message.");
  }
  const roles = await roleOf(store, row.actor_id);
  if (!roles.admin || roles.banned) return ephemeral("You no longer have permission to moderate this queue.");
  const nowIso = now();
  if (match[1] === "cancel") {
    const consumed = await store.discord.consumeConfirmation(row.confirmation_id, nowIso, interactionId);
    return consumed ? json({ type: 7, data: { content: "Review left unchanged.", components: [], allowed_mentions: { parse: [] } } })
      : ephemeral("This confirmation was already used.");
  }
  if (!await trackedTarget(store, { kind: row.kind, id: row.submission_id, status: row.expected_status, review_version: row.expected_review_version }, row.channel_id, row.message_id)) {
    return ephemeral("This review changed since the confirmation opened.");
  }
  const expiresAt = new Date(Date.parse(nowIso) + TOKEN_LIFETIME_SECONDS * 1000).toISOString();
  try {
    const queued = await store.discord.consumeConfirmationAndQueueReopen({
      confirmationId: row.confirmation_id,
      at: nowIso,
      action: {
        kind: row.kind, submission_id: row.submission_id, interaction_id: interactionId, application_id: env.MODQUEUE_DISCORD_APPLICATION_ID!,
        token, actor_id: row.actor_id, actor_name: user.username as string, action: "reopen", expected_review_version: row.expected_review_version,
        expected_status: row.expected_status, channel_id: row.channel_id, message_id: row.message_id, guild_id: row.guild_id,
        created_at: nowIso, expires_at: expiresAt,
      },
    });
    if (!queued) return ephemeral("This confirmation was already used.");
  } catch { return await insertFailureResponse(store, interactionId); }
  // Compatibility for confirmations already issued before silent reopening: the
  // default reply mode deletes this private prompt after success.
  return json({ type: 6 });
}

export async function handleDiscordInteraction(request: Request, env: Bindings, now: Clock): Promise<Response> {
  if (!configured(env)) return new Response("Not found", { status: 404 });
  const store = toStore(env.DB);
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
  // Discord defines this as an opaque string with no fixed length. The signed
  // request body is already bounded above; do not reject valid long tokens.
  if (!/^\d{17,20}$/.test(interactionId) || token.length === 0 || user === null || typeof user.id !== "string" || !/^\d{17,20}$/.test(user.id) || typeof user.username !== "string") return ephemeral("This interaction is malformed.");
  if (await hasReceipt(store, interactionId)) return ephemeral("This interaction was already received.");

  if (interaction.type === 3) {
    if (!actionsConfigured(env) || !record(interaction.message)) return ephemeral("Moderation actions are unavailable.");
    const confirmation = await handleReopenConfirmation(store, interaction, env, now, user, interactionId, token);
    if (confirmation !== null) return confirmation;
    const target = targetFromCustomId(record(interaction.data) ? interaction.data.custom_id : undefined);
    const messageId = typeof interaction.message.id === "string" ? interaction.message.id : "";
    if (target === null || !/^\d{17,20}$/.test(messageId) || !await trackedTarget(store, target, env.MODQUEUE_DISCORD_CHANNEL_ID!, messageId)) return ephemeral("This card is stale or unrecognized.");
    const roles = await roleOf(store, user.id);
    if (!roles.admin || roles.banned) return ephemeral("You do not have permission to moderate this queue.");
    const nowIso = now();
    if (target.action === "deny") {
      const modalId = crypto.randomUUID();
      const expiresAt = new Date(Date.parse(nowIso) + TOKEN_LIFETIME_SECONDS * 1000).toISOString();
      try {
        await store.discord.insertDenyModal({
          modalId, initialInteractionId: interactionId, actorId: user.id, kind: target.kind, submissionId: target.id,
          channelId: env.MODQUEUE_DISCORD_CHANNEL_ID!, messageId, guildId: env.MODQUEUE_DISCORD_GUILD_ID!,
          createdAt: nowIso, expiresAt, expectedReviewVersion: target.review_version,
        });
      } catch { return await insertFailureResponse(store, interactionId); }
      return denyModal(modalId);
    }
    const expiresAt = new Date(Date.parse(nowIso) + TOKEN_LIFETIME_SECONDS * 1000).toISOString();
    const table: ActionTable = target.action === "reopen" ? "discord_reopen_actions" : "discord_pending_actions";
    try {
      await store.discord.insertAction(table, {
        kind: target.kind, submission_id: target.id, interaction_id: interactionId, application_id: env.MODQUEUE_DISCORD_APPLICATION_ID!,
        token, actor_id: user.id, actor_name: user.username, action: target.action, expected_review_version: target.review_version,
        ...(target.action === "reopen" ? { expected_status: target.status as "approved" | "rejected" } : {}),
        channel_id: env.MODQUEUE_DISCORD_CHANNEL_ID!, message_id: messageId, guild_id: env.MODQUEUE_DISCORD_GUILD_ID!,
        created_at: nowIso, expires_at: expiresAt,
      });
    } catch { return await insertFailureResponse(store, interactionId); }
    return deferUpdate();
  }

  if (interaction.type === 5) {
    if (!actionsConfigured(env) || !record(interaction.data) || typeof interaction.data.custom_id !== "string") return ephemeral("This modal is no longer available.");
    const match = /^aklmod1\|deny\|([0-9a-f-]{36})$/.exec(interaction.data.custom_id);
    if (match === null) return ephemeral("This modal is invalid.");
    const modalId = match[1]!;
    let reason: string | null;
    try { reason = await parseReason(interaction); } catch { return ephemeral("The reason is too long."); }
    const modal = await store.discord.denyModal(modalId);
    if (modal === null || modal.actor_id !== user.id || modal.channel_id !== env.MODQUEUE_DISCORD_CHANNEL_ID || modal.guild_id !== env.MODQUEUE_DISCORD_GUILD_ID || modal.expires_at <= now() || modal.consumed_at !== null) return ephemeral("This modal expired or belongs to another moderator.");
    const roles = await roleOf(store, user.id);
    if (!roles.admin || roles.banned) return ephemeral("You no longer have permission to moderate this queue.");
    if (!await trackedTarget(store, { kind: modal.kind, id: modal.submission_id, status: "pending", review_version: modal.expected_review_version }, modal.channel_id, modal.message_id)) return ephemeral("This submission changed since the modal opened.");
    const nowIso = now();
    const expiresAt = new Date(Date.parse(nowIso) + TOKEN_LIFETIME_SECONDS * 1000).toISOString();
    try {
      const queued = await store.discord.consumeModalAndQueueDeny({
        modalId, actorId: user.id, at: nowIso,
        action: {
          kind: modal.kind, submission_id: modal.submission_id, interaction_id: interactionId, application_id: env.MODQUEUE_DISCORD_APPLICATION_ID!,
          token, actor_id: user.id, actor_name: user.username, action: "deny", reason, expected_review_version: modal.expected_review_version,
          channel_id: modal.channel_id, message_id: modal.message_id, guild_id: modal.guild_id,
          created_at: nowIso, expires_at: expiresAt,
        },
      });
      if (!queued) return ephemeral("This modal was already submitted.");
    } catch { return await insertFailureResponse(store, interactionId); }
    return deferUpdate();
  }
  return ephemeral("Unsupported interaction.");
}
