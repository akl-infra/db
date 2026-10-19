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
import { buildV2Payload, buildV2StatusPatch, DISCORD_COMPONENTS_V2_FLAG, formatCommentText, type CommentCardData, type LinkCardData, type QueueStatus, type TextFileAttachment, type WpmCardData } from "./modqueue-message";

const WEBHOOK_TIMEOUT_MS = 5000;
const USER_AGENT = "akl-db/1.0";
const BATCH_LIMIT = 10; // one sweep never announces more than this many at once

export type QueueKind = "link" | "wpm" | "comment";
type DecidedStatus = "pending" | "approved" | "rejected" | "superseded" | "replaced" | "deleted" | "removed";
type MessageFormat = "text" | "components_v2";
type MessageTransport = "legacy_webhook" | "bot";
interface NotificationRow { message_id: string; shown_status: DecidedStatus; message_format: MessageFormat; transport: MessageTransport; channel_id: string | null }

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
  const files = Array.isArray(body.__files) ? body.__files as TextFileAttachment[] : [];
  const headers = requestHeaders(env, transport, files.length === 0);
  if (headers === null) return null;
  if (files.length === 0) return { body: JSON.stringify(body), headers };
  const payload: Record<string, unknown> = { ...body };
  delete payload.__files;
  const form = new FormData();
  form.append("payload_json", JSON.stringify(payload));
  for (const [index, file] of files.entries()) {
    form.append(`files[${index}]`, new Blob([file.content], { type: "text/plain;charset=utf-8" }), file.filename);
  }
  return { body: form, headers };
}

async function sourceStatus(db: Bindings["DB"], kind: QueueKind, id: string): Promise<QueueStatus | null> {
  const row = await db.prepare(`SELECT s.status, a.name AS decider_name FROM ${STATUS_TABLE[kind]} s
    LEFT JOIN authors a ON a.user_id = s.decided_by WHERE s.id = ?`).bind(id)
    .first<{ status: string; decider_name: string | null }>();
  return row !== null && EDITABLE_STATUSES.has(row.status as DecidedStatus)
    ? { status: row.status as DecidedStatus, decider_name: row.decider_name }
    : null;
}

async function failedStatusEdit(db: Bindings["DB"], kind: QueueKind, id: string): Promise<void> {
  await db.prepare("UPDATE modqueue_notifications SET failed_attempts = failed_attempts + 1 WHERE kind = ? AND submission_id = ?")
    .bind(kind, id).run();
}

async function reconcileOne(db: Bindings["DB"], env: Bindings, kind: QueueKind, id: string, fetchImpl: typeof fetch): Promise<void> {
  const leaseToken = crypto.randomUUID();
  const leaseUntil = new Date(Date.now() + 60_000).toISOString();
  const lease = await db.prepare(`UPDATE modqueue_notifications SET reconcile_lease_token = ?, reconcile_lease_until = ?
    WHERE kind = ? AND submission_id = ? AND (reconcile_lease_token IS NULL OR reconcile_lease_until < ?)`)
    .bind(leaseToken, leaseUntil, kind, id, new Date().toISOString()).run();
  if ((lease.meta.changes ?? 0) !== 1) return;
  try {
    const row = await db.prepare("SELECT message_id, shown_status, message_format, transport, channel_id FROM modqueue_notifications WHERE kind = ? AND submission_id = ?")
      .bind(kind, id).first<NotificationRow>();
    if (row === null) return; // Legacy messages have no known id and cannot be backfilled safely.
    let state = await sourceStatus(db, kind, id);
    if (state === null || state.status === row.shown_status) return;
    const url = messageUrl(env, row.transport, row.channel_id, row.message_id, row.message_format);
    const headers = requestHeaders(env, row.transport);
    if (url === null || headers === null) return;
    const get = await fetchImpl(url, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
    });
    if (!get.ok) {
      console.error(`modqueue message read failed for ${kind} submission '${id}' with status ${get.status}`);
      if (get.status === 404) await db.prepare("DELETE FROM modqueue_notifications WHERE kind = ? AND submission_id = ?").bind(kind, id).run();
      else await failedStatusEdit(db, kind, id);
      return;
    }
    const message: unknown = await get.json();
    // Only one reconciler may edit a message at a time. Re-read source state
    // immediately before PATCH and once after it; if a decision/deletion
    // moved during the network call, loop and make the message converge to
    // the newest state before releasing the lease.
    for (let pass = 0; pass < 3; pass++) {
      state = await sourceStatus(db, kind, id);
      if (state === null || state.status === row.shown_status) return;
      let patchBody: Record<string, unknown>;
      if (row.message_format === "components_v2") {
        const componentsPatch = buildV2StatusPatch(message, kind, id, state);
        if (componentsPatch === null) {
          console.error(`modqueue component status target missing for ${kind} submission '${id}'`);
          await failedStatusEdit(db, kind, id);
          return;
        }
        patchBody = componentsPatch;
      } else {
        if (message === null || typeof message !== "object" || !("content" in message) || typeof message.content !== "string") {
          console.error(`modqueue message read omitted content for ${kind} submission '${id}'`);
          await failedStatusEdit(db, kind, id);
          return;
        }
        patchBody = { content: statusContent(state, withoutStatusPrefix(message.content), kind), allowed_mentions: { parse: [] } };
        if ("attachments" in message && Array.isArray(message.attachments)) {
          patchBody.attachments = kind === "comment" && (state.status === "deleted" || state.status === "replaced") ? [] : message.attachments;
        }
      }
      const response = await fetchImpl(url, {
        method: "PATCH",
        headers: requestHeaders(env, row.transport, true)!,
        body: JSON.stringify(patchBody),
        signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
      });
      if (!response.ok) {
        console.error(`modqueue status edit failed for ${kind} submission '${id}' with status ${response.status}`);
        if (response.status === 404) await db.prepare("DELETE FROM modqueue_notifications WHERE kind = ? AND submission_id = ?").bind(kind, id).run();
        else await failedStatusEdit(db, kind, id);
        return;
      }
      await db.prepare("UPDATE modqueue_notifications SET shown_status = ?, failed_attempts = 0 WHERE kind = ? AND submission_id = ? AND reconcile_lease_token = ?")
        .bind(state.status, kind, id, leaseToken).run();
      const latest = await sourceStatus(db, kind, id);
      if (latest === null || latest.status === state.status) return;
      state = latest;
    }
    // A later cron sweep sees the still-different source/shown status.
    await failedStatusEdit(db, kind, id);
  } catch {
    console.error(`modqueue status reconciliation failed for ${kind} submission '${id}'`);
    try { await failedStatusEdit(db, kind, id); } catch { /* retain a safe no-throw boundary */ }
  } finally {
    try {
      await db.prepare("UPDATE modqueue_notifications SET reconcile_lease_token = NULL, reconcile_lease_until = NULL WHERE kind = ? AND submission_id = ? AND reconcile_lease_token = ?")
        .bind(kind, id, leaseToken).run();
    } catch { /* lease expires safely if cleanup cannot reach D1 */ }
  }
}

async function savePostedMessage(db: Bindings["DB"], env: Bindings, kind: QueueKind, id: string, format: MessageFormat, transport: MessageTransport, channelId: string | null, response: Response, fetchImpl: typeof fetch): Promise<void> {
  try {
    const payload: unknown = await response.json();
    if (payload === null || typeof payload !== "object" || !("id" in payload) || typeof payload.id !== "string") {
      console.error(`modqueue ${transport} response omitted message id for ${kind} submission '${id}'`);
      return;
    }
    await db.prepare(`INSERT INTO modqueue_notifications (kind, submission_id, message_id, shown_status, message_format, transport, channel_id)
      VALUES (?, ?, ?, 'pending', ?, ?, ?) ON CONFLICT(kind, submission_id) DO NOTHING`)
      .bind(kind, id, payload.id, format, transport, channelId).run();
    // A decision may have landed while POST was in flight; reconcile against
    // the queue row immediately after persisting the newly returned id.
    await reconcileOne(db, env, kind, id, fetchImpl);
  } catch {
    console.error(`modqueue message tracking failed for ${kind} submission '${id}'`);
  }
}

export async function updateQueueNotification(db: Bindings["DB"], env: Bindings, kind: QueueKind, id: string, fetchImpl: typeof fetch = fetch): Promise<void> {
  await reconcileOne(db, env, kind, id, fetchImpl);
}

async function retryStatusEdits(db: Bindings["DB"], env: Bindings, fetchImpl: typeof fetch): Promise<void> {
  const candidates = await db.prepare(`SELECT n.kind, n.submission_id, n.failed_attempts FROM modqueue_notifications n
    JOIN link_submissions s ON n.kind = 'link' AND s.id = n.submission_id WHERE n.shown_status != s.status
    UNION ALL SELECT n.kind, n.submission_id, n.failed_attempts FROM modqueue_notifications n
    JOIN wpm_submissions s ON n.kind = 'wpm' AND s.id = n.submission_id WHERE n.shown_status != s.status
    UNION ALL SELECT n.kind, n.submission_id, n.failed_attempts FROM modqueue_notifications n
    JOIN layout_comments s ON n.kind = 'comment' AND s.id = n.submission_id WHERE n.shown_status != s.status
    ORDER BY failed_attempts ASC LIMIT ?`).bind(BATCH_LIMIT).all<{ kind: QueueKind; submission_id: string }>();
  for (const row of candidates.results) await reconcileOne(db, env, row.kind, row.submission_id, fetchImpl);
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
  layout_id: string;
  user_id: string;
  body: string;
  layout_name: string;
  user_name: string | null; // joined from authors; null if no author row
  has_live: number; // 1 if the user already has an approved comment here (an edit)
  live_body: string | null;
}

interface WpmCandidate {
  id: string;
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
// URL is wrapped in `<>` so Discord never expands it into an embed; the
// submitter's Discord display name (when known) is escaped, the user id
// (the fallback) never needs it -- it's a numeric snowflake, never free text.
export const SITE_ORIGIN = "https://akldb.org";
const INBOX_URL = `${SITE_ORIGIN}/admin?tab=inbox`;

export function buildMessageContent(c: LinkCandidate): string {
  const who = c.submitter_name !== null ? escapeMarkdown(c.submitter_name) : c.submitted_by;
  const layout = `[${escapeMarkdown(c.layout_name)}](<${SITE_ORIGIN}/l/${c.layout_id}>)`;
  return `New link submission on **${layout}** by ${who}: <${c.url}>\n[Open the mod queue](<${INBOX_URL}>) · submission \`${c.id}\``;
}

// [LDB-WPM8] The WPM sibling: names the layout, the user whose speed it is
// and the speed, with the proof embed-suppressed.
export function buildWpmMessageContent(c: WpmCandidate): string {
  const who = c.user_name !== null ? escapeMarkdown(c.user_name) : c.user_id;
  const layout = `[${escapeMarkdown(c.layout_name)}](<${SITE_ORIGIN}/l/${c.layout_id}>)`;
  return `New WPM submission on **${layout}** by ${who}: **${c.wpm} wpm** <${embedSafeUrl(c.proof)}>\n[Open the inbox](<${INBOX_URL}>) · submission \`${c.id}\``;
}

function buildCommentMessage(c: CommentCandidate): { content: string; attachment?: TextFileAttachment } {
  const who = c.user_name !== null ? escapeMarkdown(c.user_name) : c.user_id;
  const layout = `[${escapeMarkdown(c.layout_name)}](<${SITE_ORIGIN}/l/${c.layout_id}>)`;
  const link = `[Open the inbox](<${INBOX_URL}>) · submission \`${c.id}\``;
  const edited = c.has_live === 1;
  const headline = `${edited ? "Edited" : "New"} comment on **${layout}** by ${who} (${c.body.length} chars)`;
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
  candidateSql: string;
  build: (c: C) => string;
}

const LINK_QUEUE: Queue<LinkCandidate> = {
  table: "link_submissions",
  candidateSql: `SELECT s.id AS id, s.layout_id AS layout_id, s.url AS url, s.submitted_by AS submitted_by,
                l.name AS layout_name, a.name AS submitter_name
         FROM link_submissions s
         JOIN layouts l ON l.id = s.layout_id
         LEFT JOIN authors a ON a.user_id = s.submitted_by
         WHERE s.status = 'pending' AND s.notified_at IS NULL
         ORDER BY s.submitted_at ASC
         LIMIT ?`,
  build: buildMessageContent,
};

const WPM_QUEUE: Queue<WpmCandidate> = {
  table: "wpm_submissions",
  candidateSql: `SELECT s.id AS id, s.layout_id AS layout_id, s.user_id AS user_id, s.wpm AS wpm, s.proof AS proof,
                l.name AS layout_name, a.name AS user_name
         FROM wpm_submissions s
         JOIN layouts l ON l.id = s.layout_id
         LEFT JOIN authors a ON a.user_id = s.user_id
         WHERE s.status = 'pending' AND s.notified_at IS NULL
         ORDER BY s.submitted_at ASC
         LIMIT ?`,
  build: buildWpmMessageContent,
};

async function claim(db: Bindings["DB"], table: Queue<never>["table"], at: string, id: string): Promise<boolean> {
  const res = await db
    .prepare(`UPDATE ${table} SET notified_at = ? WHERE id = ? AND notified_at IS NULL AND status = 'pending'`)
    .bind(at, id)
    .run();
  return res.meta.changes === 1;
}

async function release(db: Bindings["DB"], table: Queue<never>["table"], id: string, claimedAt: string): Promise<void> {
  await db.prepare(`UPDATE ${table} SET notified_at = NULL WHERE id = ? AND notified_at = ?`).bind(id, claimedAt).run();
}

async function sweep<C extends { id: string }>(db: Bindings["DB"], env: Bindings, format: MessageFormat, transport: MessageTransport, channelId: string | null, now: Clock, fetchImpl: typeof fetch, queue: Queue<C>): Promise<void> {
  let candidates: C[];
  try {
    const { results } = await db.prepare(queue.candidateSql).bind(BATCH_LIMIT).all<C>();
    candidates = results;
  } catch {
    console.error(`notifyPending: candidate read failed (${queue.table})`);
    return;
  }

  for (const candidate of candidates) {
    const claimedAt = now();
    let won: boolean;
    try {
      won = await claim(db, queue.table, claimedAt, candidate.id);
    } catch {
      console.error(`notifyPending: claim failed for submission '${candidate.id}'`);
      continue;
    }
    if (!won) continue; // lost the race to a concurrent caller, or the submission was decided first

    try {
      const kind = queue.table === "link_submissions" ? "link" : "wpm";
      let body: Record<string, unknown>;
      const actionsEnabled = transport === "bot" && env.MODQUEUE_DISCORD_ACTIONS === "true";
      if (format === "components_v2" && queue.table === "link_submissions") body = buildV2Payload("link", candidate as unknown as LinkCardData, actionsEnabled);
      else if (format === "components_v2") body = buildV2Payload("wpm", candidate as unknown as WpmCardData, actionsEnabled);
      else body = { content: queue.build(candidate), allowed_mentions: { parse: [] } };
      const url = messageUrl(env, transport, channelId, undefined, format);
      const request = discordPost(body, env, transport);
      if (url === null || request === null) { await release(db, queue.table, candidate.id, claimedAt); return; }
      const res = await fetchImpl(url, {
        method: "POST",
        headers: request.headers,
        body: request.body,
        signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
      });
      // A Discord 429 is just another non-2xx here (no `Retry-After`
      // parsing) -- releasing the claim is enough: the cron's next
      // 5-minute tick simply tries again, same as any other failure.
      if (!res.ok) {
        console.error(`notifyPending: ${transport} post for submission '${candidate.id}' failed with status ${res.status}`);
        await release(db, queue.table, candidate.id, claimedAt);
      } else {
        await savePostedMessage(db, env, kind, candidate.id, format, transport, channelId, res, fetchImpl);
      }
    } catch {
      console.error(`notifyPending: webhook post for submission '${candidate.id}' threw`);
      await release(db, queue.table, candidate.id, claimedAt);
    }
  }
}

export async function notifyPending(db: Bindings["DB"], env: Bindings, now: Clock, fetchImpl: typeof fetch = fetch): Promise<void> {
  const botCards = env.MODQUEUE_DISCORD_CARDS === "true" && env.MODQUEUE_DISCORD_BOT_TOKEN !== undefined && env.MODQUEUE_DISCORD_BOT_TOKEN !== "" && env.MODQUEUE_DISCORD_CHANNEL_ID !== undefined && env.MODQUEUE_DISCORD_CHANNEL_ID !== "";
  const webhookReady = env.MODQUEUE_DISCORD_WEBHOOK !== undefined && env.MODQUEUE_DISCORD_WEBHOOK !== "";
  if (!botCards && !webhookReady) return; // [LDB-MD12]
  const transport: MessageTransport = botCards ? "bot" : "legacy_webhook";
  const channelId = botCards ? env.MODQUEUE_DISCORD_CHANNEL_ID! : null;
  const format: MessageFormat = botCards || env.MODQUEUE_DISCORD_COMPONENTS === "true" ? "components_v2" : "text";

  // Links first, then WPM: each table is swept (and claimed) on its own, so
  // a failure in one never starves the other.
  await sweep(db, env, format, transport, channelId, now, fetchImpl, LINK_QUEUE);
  await sweep(db, env, format, transport, channelId, now, fetchImpl, WPM_QUEUE);
  try {
    await retryStatusEdits(db, env, fetchImpl);
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
export async function announceComment(db: Bindings["DB"], env: Bindings, id: string, fetchImpl: typeof fetch = fetch): Promise<void> {
  const botCards = env.MODQUEUE_DISCORD_CARDS === "true" && env.MODQUEUE_DISCORD_BOT_TOKEN !== undefined && env.MODQUEUE_DISCORD_BOT_TOKEN !== "" && env.MODQUEUE_DISCORD_CHANNEL_ID !== undefined && env.MODQUEUE_DISCORD_CHANNEL_ID !== "";
  const transport: MessageTransport = botCards ? "bot" : "legacy_webhook";
  const channelId = botCards ? env.MODQUEUE_DISCORD_CHANNEL_ID! : null;
  const ready = botCards || (env.MODQUEUE_DISCORD_WEBHOOK !== undefined && env.MODQUEUE_DISCORD_WEBHOOK !== "");
  if (!ready) return; // [LDB-MD12]
  try {
    const c = await db
      .prepare(
        `SELECT s.id AS id, s.layout_id AS layout_id, s.user_id AS user_id, s.body AS body,
                l.name AS layout_name, a.name AS user_name,
                EXISTS (SELECT 1 FROM layout_comments b WHERE b.layout_id = s.layout_id AND b.user_id = s.user_id AND b.status = 'approved') AS has_live
                , (SELECT b.body FROM layout_comments b WHERE b.layout_id = s.layout_id AND b.user_id = s.user_id AND b.status = 'approved' AND b.body IS NOT NULL ORDER BY b.decided_at DESC LIMIT 1) AS live_body
         FROM layout_comments s
         JOIN layouts l ON l.id = s.layout_id
         LEFT JOIN authors a ON a.user_id = s.user_id
         WHERE s.id = ? AND s.status = 'pending' AND s.body IS NOT NULL`,
      )
      .bind(id)
      .first<CommentCandidate>();
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
    else await savePostedMessage(db, env, "comment", id, format, transport, channelId, res, fetchImpl);
  } catch {
    console.error(`announceComment: announcing comment '${id}' failed`);
  }
}
