// Mod-queue Discord notify (saltorbit 2026-09-28, LDB-MD11/LDB-MD12): a
// pending link or WPM submission (docs/decisions/28-wpm-records.md,
// LDB-WPM8: one sweep per queue table, the same claim pattern each) is announced to a Discord channel via an
// incoming webhook, at most once ever. `MODQUEUE_DISCORD_WEBHOOK` unset or
// empty makes the whole thing a no-op (LDB-MD12) -- no fetch, no D1 write.
// Called from both the submit paths (`src/routes/links.ts` and
// `src/routes/wpm.ts`, right after a fresh `queued` submission) and the cron (`src/index.ts`'s `scheduled()`,
// every 5-minute tick): the CLAIM below (an `UPDATE ... WHERE notified_at
// IS NULL AND status = 'pending'`, `changes === 1` means THIS call won)
// is what keeps the two paths racing each other from ever
// double-announcing the same submission (LDB-MD11). A submission already
// `approved`/`rejected`/`superseded` by claim time never matches that
// WHERE clause, so it is never announced either. Both messages end in a link
// to the admin console's Inbox tab (`/admin?tab=inbox`), where the
// submission is approved or rejected. `notifyPending` never
// throws -- a candidate read failure, a claim failure, or a webhook
// failure is logged and the function returns (or moves to the next
// candidate); the cron's own `core/jobs.ts` `runJob` guard is a second,
// belt-and-suspenders layer, not the only one.
import type { Bindings } from "../env";
import type { Clock } from "./time";
import { deliver, DeliveryDeferred, discordJson } from "./modqueue-delivery";
import { buildV2Payload, buildV2StatusPatch, DISCORD_COMPONENTS_V2_FLAG, formatCommentText, queueUserName, repairQueueUser, type CommentCardData, type LinkCardData, type QueueStatus, type TextFileAttachment, type MessageFileAttachment, type WpmCardData } from "./modqueue-message";
import { resolveProofPreview, type ProofPreview } from "./modqueue-proof";
import { toStore, type StoreArg } from "../store/arg";
import type { Store } from "../store/port";

const WEBHOOK_TIMEOUT_MS = 5000;
const USER_AGENT = "akl-db/1.0";
const BATCH_LIMIT = 10; // one sweep never announces more than this many at once

export type QueueKind = "link" | "wpm" | "comment";
type DecidedStatus = "pending" | "approved" | "rejected" | "superseded" | "replaced" | "deleted" | "removed";
type MessageFormat = "text" | "components_v2";
type MessageTransport = "legacy_webhook" | "bot";
interface NotificationRow { message_id: string; shown_status: DecidedStatus; shown_review_version: number; shown_source_message_url: string | null; message_format: MessageFormat; transport: MessageTransport; channel_id: string | null }

const STATUS_TABLE: Record<QueueKind, string> = { link: "link_submissions", wpm: "wpm_submissions", comment: "layout_comments" };
const EDITABLE_STATUSES = new Set<DecidedStatus>(["pending", "approved", "rejected", "superseded", "replaced", "deleted", "removed"]);

function statusContent(state: QueueStatus, original: string, kind: QueueKind): string {
  const status = state.status;
  if (status === "pending") return original;
  const prefix: Record<Exclude<DecidedStatus, "pending">, string> = {
    approved: "✅ APPROVED", rejected: "❌ REJECTED", superseded: "↪️ SUPERSEDED",
    replaced: "↪️ REPLACED", deleted: "🗑️ DELETED", removed: "⚠️ REMOVED",
  };
  // User-deleted and replaced comments have erased bodies by design. Their
  // Discord previews are erased too when the message is reconciled.
  if (kind === "comment" && (status === "deleted" || status === "replaced")) return prefix[status];
  const maxOriginalLength = 2000 - prefix[status].length - 1;
  if (original.length > maxOriginalLength) {
    const chars = Array.from(original);
    const tailBudget = Math.min(128, Math.floor(maxOriginalLength / 4));
    let tailLength = 0;
    let tailStart = chars.length;
    while (tailStart > 0 && tailLength + chars[tailStart - 1]!.length <= tailBudget) tailLength += chars[--tailStart]!.length;
    let headLength = 0;
    let headEnd = 0;
    const headBudget = maxOriginalLength - tailLength - 1;
    while (headEnd < tailStart && headLength + chars[headEnd]!.length <= headBudget) headLength += chars[headEnd++]!.length;
    const bounded = `${chars.slice(0, headEnd).join("")}…${chars.slice(tailStart).join("")}`;
    return `${prefix[status]}\n${bounded}`;
  }
  return `${prefix[status]}\n${original}`;
}

function legacyContent(state: QueueStatus, original: string, kind: QueueKind): string {
  original = repairQueueUser(original, kind, state.submitter_id);
  if (kind !== "wpm" || !state.source_message_url) return statusContent(state, original, kind);
  const suffix = `\n[Original message](<${state.source_message_url}>)`;
  const content = statusContent(state, original.endsWith(suffix) ? original.slice(0, -suffix.length) : original, kind);
  const budget = 2000 - suffix.length;
  const bounded = content.length <= budget ? content : `${content.slice(0, budget - 1).replace(/[\uD800-\uDBFF]$/, "")}…`;
  return bounded + suffix;
}

function withoutStatusPrefix(content: string): string {
  return content.replace(/^(?:✅ APPROVED|❌ REJECTED|↪️ SUPERSEDED|↪️ REPLACED|🗑️ DELETED|⚠️ REMOVED)\n/, "");
}

function webhookUrl(webhook: string, messageId?: string, format: MessageFormat = "text"): string {
  const url = new URL(webhook);
  if (messageId === undefined) {
    url.searchParams.set("wait", "true");
    if (format === "components_v2") url.searchParams.set("with_components", "true");
  } else {
    url.pathname = `${url.pathname.replace(/\/$/, "")}/messages/${encodeURIComponent(messageId)}`;
    url.searchParams.delete("wait");
  }
  return url.toString();
}

function messageUrl(env: Bindings, transport: MessageTransport, channelId: string | null, messageId?: string, format: MessageFormat = "text"): string | null {
  if (transport === "legacy_webhook") {
    const webhook = env.MODQUEUE_DISCORD_WEBHOOK;
    return webhook === undefined || webhook === "" ? null : webhookUrl(webhook, messageId, format);
  }
  const channel = channelId ?? env.MODQUEUE_DISCORD_CHANNEL_ID;
  if (channel === undefined || channel === "") return null;
  return `${env.DISCORD_API_URL.replace(/\/$/, "")}/v10/channels/${encodeURIComponent(channel)}/messages${messageId === undefined ? "" : `/${encodeURIComponent(messageId)}`}`;
}

function requestHeaders(env: Bindings, transport: MessageTransport, jsonBody = false): HeadersInit | null {
  const headers: Record<string, string> = { "User-Agent": USER_AGENT };
  if (jsonBody) headers["Content-Type"] = "application/json";
  if (transport === "bot") {
    const token = env.MODQUEUE_DISCORD_BOT_TOKEN;
    if (token === undefined || token === "") return null;
    headers.Authorization = `Bot ${token}`;
  }
  return headers;
}

function discordPost(body: Record<string, unknown>, env: Bindings, transport: MessageTransport): { body: BodyInit; headers: HeadersInit } | null {
  const files = Array.isArray(body.__files) ? body.__files as MessageFileAttachment[] : [];
  const headers = requestHeaders(env, transport, files.length === 0);
  if (headers === null) return null;
  if (files.length === 0) return { body: JSON.stringify(body), headers };
  const payload: Record<string, unknown> = { ...body };
  delete payload.__files;
  const form = new FormData();
  form.append("payload_json", JSON.stringify(payload));
  for (const [index, file] of files.entries()) {
    form.append(`files[${index}]`, new Blob([file.content], { type: file.contentType ?? "text/plain;charset=utf-8" }), file.filename);
  }
  return { body: form, headers };
}

async function sourceStatus(store: Store, kind: QueueKind, id: string): Promise<QueueStatus | null> {
  const row = await store.modqueue.sourceStatus(kind, id);
  return row !== null && EDITABLE_STATUSES.has(row.status as DecidedStatus)
    ? { status: row.status as DecidedStatus, submitter_id: row.submitter_id, decider_name: row.decider_name, review_version: row.review_version, reason: row.reason, source_message_url: row.source_message_url }
    : null;
}

async function failedStatusEdit(store: Store, kind: QueueKind, id: string): Promise<void> {
  await store.modqueue.bumpFailedAttempts(kind, id);
}

async function reconcileOne(store: Store, env: Bindings, kind: QueueKind, id: string, fetchImpl: typeof fetch): Promise<void> {
  const leaseToken = crypto.randomUUID();
  const leaseUntil = new Date(Date.now() + 60_000).toISOString();
  if (!(await store.modqueue.leaseNotification(kind, id, leaseToken, leaseUntil, new Date().toISOString()))) return;
  try {
    const row = await store.modqueue.notification(kind, id) as NotificationRow | null;
    if (row === null) return; // Legacy messages have no known id and cannot be backfilled safely.
    let state = await sourceStatus(store, kind, id);
    if (state === null || (state.status === row.shown_status && state.review_version === row.shown_review_version && (state.source_message_url ?? null) === row.shown_source_message_url)) return;
    const url = messageUrl(env, row.transport, row.channel_id, row.message_id, row.message_format);
    const headers = requestHeaders(env, row.transport);
    if (url === null || headers === null) return;
    const get = await deliver(store, fetchImpl, url, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
    }, async (response) => ({ ok: response.ok, status: response.status, message: response.ok ? await discordJson(response) : null }));
    if (!get.ok) {
      console.error(`modqueue message read failed for ${kind} submission '${id}' with status ${get.status}`);
      if (get.status === 404) await store.modqueue.deleteNotification(kind, id);
      else await failedStatusEdit(store, kind, id);
      return;
    }
    let message: unknown = get.message;
    // Only one reconciler may edit a message at a time. Re-read source state
    // immediately before PATCH and once after it; if a decision/deletion
    // moved during the network call, loop and make the message converge to
    // the newest state before releasing the lease.
    for (let pass = 0; pass < 3; pass++) {
      state = await sourceStatus(store, kind, id);
      if (state === null || (state.status === row.shown_status && state.review_version === row.shown_review_version && (state.source_message_url ?? null) === row.shown_source_message_url)) return;
      let patchBody: Record<string, unknown>;
      if (row.message_format === "components_v2") {
        const componentsPatch = buildV2StatusPatch(message, kind, id, state, row.transport === "bot" && env.MODQUEUE_DISCORD_ACTIONS === "true");
        if (componentsPatch === null) {
          console.error(`modqueue component status target missing for ${kind} submission '${id}'`);
          await failedStatusEdit(store, kind, id);
          return;
        }
        patchBody = componentsPatch;
      } else {
        if (message === null || typeof message !== "object" || !("content" in message) || typeof message.content !== "string") {
          console.error(`modqueue message read omitted content for ${kind} submission '${id}'`);
          await failedStatusEdit(store, kind, id);
          return;
        }
        patchBody = { content: legacyContent(state, withoutStatusPrefix(message.content), kind), allowed_mentions: { parse: [] } };
        if ("attachments" in message && Array.isArray(message.attachments)) {
          patchBody.attachments = kind === "comment" && (state.status === "deleted" || state.status === "replaced") ? [] : message.attachments;
        }
      }
      const response = await deliver(store, fetchImpl, url, {
        method: "PATCH",
        headers: requestHeaders(env, row.transport, true)!,
        body: JSON.stringify(patchBody),
        signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
      }, async (response) => ({ ok: response.ok, status: response.status }));
      if (!response.ok) {
        console.error(`modqueue status edit failed for ${kind} submission '${id}' with status ${response.status}`);
        if (response.status === 404) await store.modqueue.deleteNotification(kind, id);
        else await failedStatusEdit(store, kind, id);
        return;
      }
      await store.modqueue.markShown({ kind, id, status: state.status, reviewVersion: state.review_version ?? 0, sourceMessageUrl: state.source_message_url ?? null, leaseToken });
      row.shown_status = state.status;
      row.shown_review_version = state.review_version ?? 0;
      row.shown_source_message_url = state.source_message_url ?? null;
      message = { ...(typeof message === "object" && message !== null ? message : {}), ...patchBody };
      const latest = await sourceStatus(store, kind, id);
      if (latest === null || (latest.status === state.status && latest.review_version === state.review_version && latest.source_message_url === state.source_message_url)) return;
      state = latest;
    }
    // A later cron sweep sees the still-different source/shown status.
    await failedStatusEdit(store, kind, id);
  } catch (error) {
    if (error instanceof DeliveryDeferred) return;
    console.error(`modqueue status reconciliation failed for ${kind} submission '${id}'`);
    try { await failedStatusEdit(store, kind, id); } catch { /* retain a safe no-throw boundary */ }
  } finally {
    try {
      await store.modqueue.releaseNotificationLease(kind, id, leaseToken);
    } catch { /* lease expires safely if cleanup cannot reach D1 */ }
  }
}

async function savePostedMessage(store: Store, env: Bindings, kind: QueueKind, id: string, format: MessageFormat, transport: MessageTransport, channelId: string | null, response: Response, fetchImpl: typeof fetch, reviewVersion = 0, sourceMessageUrl: string | null = null): Promise<void> {
  try {
    const payload: unknown = await response.json();
    if (payload === null || typeof payload !== "object" || !("id" in payload) || typeof payload.id !== "string") {
      console.error(`modqueue ${transport} response omitted message id for ${kind} submission '${id}'`);
      return;
    }
    await store.modqueue.insertNotification({ kind, id, messageId: payload.id, format, transport, channelId, reviewVersion, sourceMessageUrl });
    // A decision or receipt binding may have landed while POST was in flight; reconcile against
    // the queue row immediately after persisting the newly returned id.
    await reconcileOne(store, env, kind, id, fetchImpl);
  } catch {
    console.error(`modqueue message tracking failed for ${kind} submission '${id}'`);
  }
}

export async function updateQueueNotification(dbArg: StoreArg, env: Bindings, kind: QueueKind, id: string, fetchImpl: typeof fetch = fetch): Promise<void> {
  const store = toStore(dbArg);
  await reconcileOne(store, env, kind, id, fetchImpl);
}

async function retryStatusEdits(store: Store, env: Bindings, fetchImpl: typeof fetch): Promise<void> {
  const candidates = await store.modqueue.staleNotifications(BATCH_LIMIT);
  for (const row of candidates) await reconcileOne(store, env, row.kind, row.submission_id, fetchImpl);
}

interface LinkCandidate {
  id: string;
  layout_id: string;
  url: string;
  submitted_by: string;
  layout_name: string;
  submitter_name: string | null; // joined from authors; null if no author row
}

interface CommentCandidate {
  id: string;
  review_version?: number;
  layout_id: string;
  user_id: string;
  body: string;
  layout_name: string;
  layout_owner: string;
  user_name: string | null; // joined from authors; null if no author row
  has_live: number; // 1 if the user already has an approved comment here (an edit)
  live_body: string | null;
}

interface WpmCandidate {
  source_message_url?: string | null;
  id: string;
  review_version?: number;
  layout_id: string;
  user_id: string;
  wpm: number;
  proof: string;
  layout_name: string;
  user_name: string | null; // joined from authors; null if no author row
}

// Discord markdown control characters a user-sourced string (a layout
// name, a Discord display name) could carry, `[`/`]` included so a name
// can never form a masked link -- backslash-escaped so it
// renders as literal text instead of breaking out into formatting.
function escapeMarkdown(s: string): string {
  return s.replace(/[\\`*_~|>[\]]/g, (ch) => `\\${ch}`);
}

// A user-supplied URL is wrapped in `<>` (no embed); percent-encode the
// characters that could close that wrapper early or split the link, so a
// proof URL can never break out of it.
function embedSafeUrl(url: string): string {
  return url.replace(/[<>\s]/g, (ch) => encodeURIComponent(ch));
}

// Exported for the pure escaping cases in `tests/auth/modqueue.test.ts` -- no
// DB, no clock, table-tested like `core/links.ts`'s own `validateLinkUrl`.
// The layout name links to its akldb.org page (`/l/<layout_id>`, a ULID --
// what the site's router and `GET /v1/layouts/:ref` both accept) and the
// second line links straight to the admin console's Inbox tab
// (`/admin?tab=inbox`), where the submission is approved or rejected. Every
// URL is wrapped in `<>` so Discord never expands it into an embed.
// A stored display name is escaped; a missing name uses a Discord mention.
// Every transport disables allowed_mentions so it resolves without a ping.
export const SITE_ORIGIN = "https://akldb.org";
const INBOX_URL = `${SITE_ORIGIN}/admin?tab=inbox`;

export function buildMessageContent(c: LinkCandidate): string {
  const who = queueUserName(c.submitter_name, c.submitted_by);
  const layout = `[${escapeMarkdown(c.layout_name)}](<${SITE_ORIGIN}/l/${c.layout_id}>)`;
  return `New link submission on **${layout}** by ${who}: <${c.url}>\n[Open the mod queue](<${INBOX_URL}>) · submission \`${c.id}\``;
}

// [LDB-WPM8] The WPM sibling: names the layout, the user whose speed it is
// and the speed, with the proof embed-suppressed.
export function buildWpmMessageContent(c: WpmCandidate): string {
  const who = queueUserName(c.user_name, c.user_id);
  const layout = `[${escapeMarkdown(c.layout_name)}](<${SITE_ORIGIN}/l/${c.layout_id}>)`;
  return legacyContent({ status: "pending", decider_name: null, source_message_url: c.source_message_url }, `New WPM submission on **${layout}** by ${who}: **${c.wpm} wpm** <${embedSafeUrl(c.proof)}>\n[Open the inbox](<${INBOX_URL}>) · submission \`${c.id}\``, "wpm");
}

function buildCommentMessage(c: CommentCandidate): { content: string; attachment?: TextFileAttachment } {
  const who = queueUserName(c.user_name, c.user_id);
  const layout = `[${escapeMarkdown(c.layout_name)}](<${SITE_ORIGIN}/l/${c.layout_id}>)`;
  const link = `[Open the inbox](<${INBOX_URL}>) · submission \`${c.id}\``;
  const edited = c.has_live === 1;
  const authorLabel = c.user_id === c.layout_owner ? " (Layout Author)" : "";
  const headline = `${edited ? "Edited" : "New"} comment on **${layout}** by ${who}${authorLabel} (${c.body.length} chars)`;
  const full = formatCommentText(c.body, edited ? c.live_body : null, 2000 - headline.length - link.length - 2);
  return {
    content: `${headline}\n${full.inline}\n${link}`,
    ...(full.attachmentText !== undefined ? { attachment: {
      filename: `comment-${c.id}.txt`, content: full.attachmentText, description: "Complete comment text before and after the edit",
    } } : {}),
  };
}

export function buildCommentMessageContent(c: CommentCandidate): string {
  return buildCommentMessage(c).content;
}

// One queue table's notifier: its candidate scan and its message. The table
// name is a constant of this module, never caller input.
interface Queue<C extends { id: string }> {
  table: "link_submissions" | "wpm_submissions";
  candidates: (store: Store, limit: number) => Promise<C[]>;
  build: (c: C) => string;
}

const LINK_QUEUE: Queue<LinkCandidate> = {
  table: "link_submissions",
  candidates: (store, limit) => store.modqueue.linkCandidates(limit),
  build: buildMessageContent,
};

const WPM_QUEUE: Queue<WpmCandidate> = {
  table: "wpm_submissions",
  candidates: (store, limit) => store.modqueue.wpmCandidates(limit),
  build: buildWpmMessageContent,
};

async function claim(store: Store, table: Queue<never>["table"], at: string, id: string): Promise<boolean> {
  return store.modqueue.claimAnnounce(table === "link_submissions" ? "link" : "wpm", id, at);
}

async function release(store: Store, table: Queue<never>["table"], id: string, claimedAt: string): Promise<void> {
  await store.modqueue.releaseAnnounce(table === "link_submissions" ? "link" : "wpm", id, claimedAt);
}

async function sweep<C extends { id: string; review_version?: number; source_message_url?: string | null }>(store: Store, env: Bindings, format: MessageFormat, transport: MessageTransport, channelId: string | null, now: Clock, fetchImpl: typeof fetch, queue: Queue<C>): Promise<void> {
  // Enrichment adds at most six seconds to a sweep, even for a backlog of
  // inaccessible proofs. It never delays the submission HTTP response.
  let previewBudgetMs = 6000;
  let candidates: C[];
  try {
    candidates = await queue.candidates(store, BATCH_LIMIT);
  } catch {
    console.error(`notifyPending: candidate read failed (${queue.table})`);
    return;
  }

  const gatedFetch: typeof fetch = async (input, init) => deliver(store, fetchImpl, String(input), init ?? {}, async (response) => {
    if (!response.ok) return new Response(null, { status: response.status });
    return Response.json(await discordJson(response), { status: response.status });
  });

  for (const candidate of candidates) {
    const claimedAt = now();
    let won: boolean;
    try {
      won = await claim(store, queue.table, claimedAt, candidate.id);
    } catch {
      console.error(`notifyPending: claim failed for submission '${candidate.id}'`);
      continue;
    }
    if (!won) continue; // lost the race to a concurrent caller, or the submission was decided first

    try {
      const kind = queue.table === "link_submissions" ? "link" : "wpm";
      let body: Record<string, unknown>;
      let preview: ProofPreview | undefined;
      const actionsEnabled = transport === "bot" && env.MODQUEUE_DISCORD_ACTIONS === "true";
      if (format === "components_v2" && queue.table === "link_submissions") body = buildV2Payload("link", candidate as unknown as LinkCardData, actionsEnabled);
      else if (format === "components_v2") {
        const start = Date.now();
        const wpm = candidate as unknown as WpmCardData;
        preview = await resolveProofPreview(wpm.proof, env, fetchImpl, previewBudgetMs);
        previewBudgetMs -= Date.now() - start;
        body = buildV2Payload("wpm", wpm, actionsEnabled, preview);
      }
      else body = { content: queue.build(candidate), allowed_mentions: { parse: [] } };
      const url = messageUrl(env, transport, channelId, undefined, format);
      const request = discordPost(body, env, transport);
      if (url === null || request === null) { await release(store, queue.table, candidate.id, claimedAt); return; }
      let res = await gatedFetch(url, {
        method: "POST",
        headers: request.headers,
        body: request.body,
        signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
      });
      // Only a definitive rejected upload is retried without images. Never
      // make a second POST on an ambiguous timeout or a rate limit here.
      if ((preview?.kind === "images" || preview?.kind === "youtube") && [400, 403, 413].includes(res.status)) {
        await res.body?.cancel();
        const withoutImage: ProofPreview = preview.kind === "youtube" ? { kind: "youtube", videoUrl: preview.videoUrl } : { kind: "unavailable" };
        const fallback = discordPost(buildV2Payload("wpm", candidate as unknown as WpmCardData, actionsEnabled, withoutImage), env, transport)!;
        res = await gatedFetch(url, { method: "POST", headers: fallback.headers, body: fallback.body, signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS) });
      }
      // Definitive failures release the claim for the next cron sweep.
      if (!res.ok) {
        console.error(`notifyPending: ${transport} post for submission '${candidate.id}' failed with status ${res.status}`);
        await release(store, queue.table, candidate.id, claimedAt);
      } else {
        await savePostedMessage(store, env, kind, candidate.id, format, transport, channelId, res, fetchImpl, candidate.review_version ?? 0, candidate.source_message_url ?? null);
      }
    } catch (error) {
      await release(store, queue.table, candidate.id, claimedAt);
      if (error instanceof DeliveryDeferred) break; // shared gate: leave the rest unclaimed for cron
      console.error(`notifyPending: webhook post for submission '${candidate.id}' threw`);
    }
  }
}

export async function notifyPending(dbArg: StoreArg, env: Bindings, now: Clock, fetchImpl: typeof fetch = fetch): Promise<void> {
  const store = toStore(dbArg);
  const botCards = env.MODQUEUE_DISCORD_CARDS === "true" && env.MODQUEUE_DISCORD_BOT_TOKEN !== undefined && env.MODQUEUE_DISCORD_BOT_TOKEN !== "" && env.MODQUEUE_DISCORD_CHANNEL_ID !== undefined && env.MODQUEUE_DISCORD_CHANNEL_ID !== "";
  const webhookReady = env.MODQUEUE_DISCORD_WEBHOOK !== undefined && env.MODQUEUE_DISCORD_WEBHOOK !== "";
  if (!botCards && !webhookReady) return; // [LDB-MD12]
  const transport: MessageTransport = botCards ? "bot" : "legacy_webhook";
  const channelId = botCards ? env.MODQUEUE_DISCORD_CHANNEL_ID! : null;
  const format: MessageFormat = botCards || env.MODQUEUE_DISCORD_COMPONENTS === "true" ? "components_v2" : "text";

  // Links first, then WPM: each table is swept (and claimed) on its own, so
  // a failure in one never starves the other.
  await sweep(store, env, format, transport, channelId, now, fetchImpl, LINK_QUEUE);
  await sweep(store, env, format, transport, channelId, now, fetchImpl, WPM_QUEUE);
  try {
    await retryStatusEdits(store, env, fetchImpl);
  } catch {
    console.error("modqueue status retry scan failed");
  }
}

// [LDB-CMT8] A pending comment is announced once, best effort, from the submit
// path only (`routes/comments.ts`, via `waitUntil`): `layout_comments` has no
// `notified_at`, so it is never newly announced by the sweep above. The full
// comment (and full before/after edit) is shown inline where it fits, or
// uploaded as a plaintext attachment; failed posts make no D1 write. Unset or
// empty transport config is a complete no-op. Never throws. Only a row that
// is still `pending` is announced.
export async function announceComment(dbArg: StoreArg, env: Bindings, id: string, fetchImpl: typeof fetch = fetch): Promise<void> {
  const store = toStore(dbArg);
  const botCards = env.MODQUEUE_DISCORD_CARDS === "true" && env.MODQUEUE_DISCORD_BOT_TOKEN !== undefined && env.MODQUEUE_DISCORD_BOT_TOKEN !== "" && env.MODQUEUE_DISCORD_CHANNEL_ID !== undefined && env.MODQUEUE_DISCORD_CHANNEL_ID !== "";
  const transport: MessageTransport = botCards ? "bot" : "legacy_webhook";
  const channelId = botCards ? env.MODQUEUE_DISCORD_CHANNEL_ID! : null;
  const ready = botCards || (env.MODQUEUE_DISCORD_WEBHOOK !== undefined && env.MODQUEUE_DISCORD_WEBHOOK !== "");
  if (!ready) return; // [LDB-MD12]
  try {
    const c = await store.modqueue.commentCandidate(id);
    if (c === null) return;
    const format: MessageFormat = botCards || env.MODQUEUE_DISCORD_COMPONENTS === "true" ? "components_v2" : "text";
    const body = format === "components_v2"
      ? buildV2Payload("comment", c, transport === "bot" && env.MODQUEUE_DISCORD_ACTIONS === "true")
      : (() => {
        const built = buildCommentMessage(c);
        const body: Record<string, unknown> = { content: built.content, allowed_mentions: { parse: [] } };
        if (built.attachment !== undefined) {
          body.attachments = [{ id: "0", filename: built.attachment.filename, description: built.attachment.description }];
          body.__files = [built.attachment];
        }
        return body;
      })();
    const url = messageUrl(env, transport, channelId, undefined, format);
    const request = discordPost(body, env, transport);
    if (url === null || request === null) return;
    const res = await fetchImpl(url, {
      method: "POST",
      headers: request.headers,
      body: request.body,
      signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
    });
    if (!res.ok) console.error(`announceComment: ${transport} post for comment '${id}' failed with status ${res.status}`);
    else await savePostedMessage(store, env, "comment", id, format, transport, channelId, res, fetchImpl, c.review_version ?? 0);
  } catch {
    console.error(`announceComment: announcing comment '${id}' failed`);
  }
}
