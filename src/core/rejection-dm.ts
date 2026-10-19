// Private submitter-DM delivery for future moderation rejections. The
// outbox stores routing identifiers only; content is rebuilt from the current
// submission when a lease is delivered, so erased/replaced data is not kept.
import type { Bindings } from "../env";
import type { Clock } from "./time";

export type RejectionKind = "comment" | "link" | "wpm";

export interface RejectionDelivery {
  kind: RejectionKind;
  submissionId: string;
  layoutId: string;
  recipientId: string;
  at: string;
  reviewVersion?: number;
}

export interface RejectionOutboxRow {
  delivery_key: string;
  event_seq: number;
  review_version: number;
  nonce: string;
  kind: RejectionKind;
  submission_id: string;
  layout_id: string;
  recipient_id: string;
  status: "pending" | "leased" | "sent" | "blocked" | "uncertain" | "failed" | "expired";
  attempts: number;
  next_attempt_at: string;
  lease_token: string | null;
  lease_until: string | null;
  ambiguous_message_attempt_at: string | null;
}

interface DeliveryContent {
  recipient_id: string;
  layout_name: string;
  layout_id: string;
  reason: string | null;
  context: string;
  comment_body: string | null;
  eligible: number;
}

export type RejectionDmMessagePayload = {
  payload: {
    content?: string;
    flags?: number;
    components?: Array<Record<string, unknown>>;
    attachments?: Array<{ id: number; filename: string }>;
    allowed_mentions: { parse: string[] };
    nonce?: string;
    enforce_nonce?: boolean;
  };
  attachmentText?: string;
}

// Discord accepts at most 25 nonce characters. A truncated digest is stable
// across retries and opaque (no user or submission identifiers in the nonce).
export async function discordNonceFor(deliveryKey: string): Promise<string> {
  const bytes = new TextEncoder().encode(deliveryKey);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(digest.slice(0, 12), (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function makeRejectionDelivery(input: RejectionDelivery): Promise<{
  deliveryKey: string;
  nonce: string;
}> {
  const cycle = input.reviewVersion ?? 0;
  const deliveryKey = `rejection:${input.kind}:${input.submissionId}${cycle === 0 ? "" : `:${cycle}`}`;
  return { deliveryKey, nonce: await discordNonceFor(deliveryKey) };
}

// This is the third statement in the rejection transaction, immediately
// after the conditional event INSERT. SQLite's changes() is therefore the
// event insert's count, while last_insert_rowid() is its actual event seq.
export async function rejectionOutboxStatement(db: Bindings["DB"], input: RejectionDelivery): Promise<D1PreparedStatement> {
  const { deliveryKey, nonce } = await makeRejectionDelivery(input);
  return db
    .prepare(
      `INSERT INTO discord_rejection_dm_outbox
        (delivery_key, event_seq, kind, submission_id, layout_id, recipient_id, nonce, status,
         attempts, next_attempt_at, created_at, updated_at, review_version)
       SELECT ?, last_insert_rowid(), ?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?, ?
       WHERE changes() = 1`,
    )
    .bind(deliveryKey, input.kind, input.submissionId, input.layoutId, input.recipientId, nonce, input.at, input.at, input.at, input.reviewVersion ?? 0);
}

// Render all current decision context at send time. Comments are never
// truncated: safe Markdown chunks are used up to 4,000 aggregate characters,
// then the complete raw body is attached as a plaintext file.
export function buildRejectionDmMessage(input: {
  kind: RejectionKind;
  layoutName: string;
  layoutUrl: string;
  reason: string | null;
  context: string;
  commentBody?: string | null;
}): RejectionDmMessagePayload {
  const label = input.kind === "comment" ? "comment" : input.kind === "link" ? "link" : "WPM record";
  const name = safeText(input.layoutName, 100);
  const context = safeText(input.context, 500);
  const reason = input.reason === null || input.reason.trim() === "" ? "No reason was provided." : safeText(input.reason, 500);
  const url = safeUrl(input.layoutUrl);
  const summary = input.kind === "comment"
    ? `**Reason:** ${reason}\n${url}`
    : `Your ${label} submission for ${name} was not approved.\n${context}\nReason: ${reason}\nLayout: ${url}`;
  if (input.kind !== "comment") return { payload: { content: summary, allowed_mentions: { parse: [] } } };

  if (typeof input.commentBody !== "string") throw new Error("eligible rejected comment body is unavailable");
  const intro = { type: 10, content: `Your comment submission for **${name}** was not approved.` };
  const components = [intro, ...quotedTextDisplays(input.commentBody), { type: 10, content: summary }];
  // Count the actual payload, including quote prefixes on continued lines and
  // split components. Escaping and astral Unicode can expand otherwise short text.
  if (components.reduce((length, component) => length + countCharacters(component.content), 0) <= 4000) {
    return {
      payload: {
        flags: 1 << 15,
        components,
        allowed_mentions: { parse: [] },
      },
    };
  }
  return {
    payload: {
      flags: 1 << 15,
      components: [
        intro,
        { type: 13, file: { url: "attachment://rejected-comment.txt" } },
        { type: 10, content: summary },
      ],
      attachments: [{ id: 0, filename: "rejected-comment.txt" }],
      allowed_mentions: { parse: [] },
    },
    attachmentText: input.commentBody,
  };
}

function safeText(value: string, max: number): string {
  return value.replace(/[\r\n\u0000-\u001f\u007f]/g, " ").replace(/@/g, "＠").replace(/:/g, "：").replace(/[\[\](){}<>\\`*_~|>]/g, "").trim().slice(0, max) || "(not available)";
}

const ESCAPED_MARKDOWN = new Set(["\\", "*", "_", "~", "|", "`", ">", "#", "[", "]", "(", ")", "<", ">"]);

export function escapeDiscordMarkdown(value: string): string {
  return escapedMarkdownTokens(value).join("");
}

function escapedMarkdownTokens(value: string): string[] {
  return Array.from(value, (character) => ESCAPED_MARKDOWN.has(character) ? `\\${character}` : character);
}

function countCharacters(value: string): number {
  // Discord's payload limits are measured in UTF-16 code units. `String.length`
  // matches that accounting, including for astral emoji.
  return value.length;
}

function quotedTextDisplays(body: string): Array<{ type: 10; content: string }> {
  const components: Array<{ type: 10; content: string }> = [];
  let chunk = "> ";
  for (const bodyToken of escapedMarkdownTokens(body)) {
    const token = bodyToken === "\n" ? "\n> " : bodyToken;
    const size = countCharacters(token);
    if (countCharacters(chunk) + size > 1800) {
      components.push({ type: 10, content: chunk });
      chunk = "> ";
    }
    chunk += token;
  }
  components.push({ type: 10, content: chunk });
  return components;
}

function safeUrl(value: string): string {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") return "https://akldb.org";
    return url.toString().slice(0, 300);
  } catch {
    return "https://akldb.org";
  }
}

export interface RejectionDmBindings extends Pick<Bindings, "DB"> {
  MODQUEUE_DISCORD_DMS?: string;
  MODQUEUE_DISCORD_BOT_TOKEN?: string;
  DISCORD_API_URL?: string;
}

// Bounded lease-fenced queue drain. Claims are durable before network calls;
// every mutation after claim checks the lease token, so an expired worker
// cannot overwrite a newer worker's state.
export async function dispatchRejectionDms(
  db: Bindings["DB"],
  bindings: RejectionDmBindings,
  now: Clock,
  fetchImpl: typeof fetch = fetch,
): Promise<{ sent: number; retried: number; terminal: number }> {
  if (bindings.MODQUEUE_DISCORD_DMS !== "true" || !bindings.MODQUEUE_DISCORD_BOT_TOKEN) return { sent: 0, retried: 0, terminal: 0 };
  const api = (bindings.DISCORD_API_URL ?? "https://discord.com/api").replace(/\/$/, "") + "/v10";
  const token = bindings.MODQUEUE_DISCORD_BOT_TOKEN;
  const summary = { sent: 0, retried: 0, terminal: 0 };
  const candidates = await db.prepare(
    `SELECT delivery_key, event_seq, review_version, kind, submission_id, layout_id, recipient_id, nonce,
            status, attempts, next_attempt_at, lease_token, lease_until, ambiguous_message_attempt_at
       FROM discord_rejection_dm_outbox
      WHERE (status = 'pending' AND next_attempt_at <= ?)
         OR (status = 'leased' AND lease_until <= ?)
      ORDER BY next_attempt_at, event_seq LIMIT 10`,
  ).bind(now(), now()).all<RejectionOutboxRow>();

  for (const candidate of candidates.results ?? []) {
    const tokenId = crypto.randomUUID();
    const at = now();
    const leaseUntil = addSeconds(at, 120);
    const claim = await db.prepare(
      `UPDATE discord_rejection_dm_outbox
          SET status = 'leased', lease_token = ?, lease_until = ?, attempts = attempts + 1, updated_at = ?
        WHERE delivery_key = ? AND ((status = 'pending' AND next_attempt_at <= ?) OR (status = 'leased' AND lease_until <= ?))`,
    ).bind(tokenId, leaseUntil, at, candidate.delivery_key, at, at).run();
    if (claim.meta.changes !== 1) continue;

    const row = { ...candidate, lease_token: tokenId, attempts: candidate.attempts + 1 };
    const content = await readEligibleContent(db, row);
    if (content === null || content.eligible !== 1) {
      await terminal(db, row, now(), "expired", "no_longer_eligible");
      summary.terminal++;
      continue;
    }

    const authHeaders = { Authorization: `Bot ${token}`, "Content-Type": "application/json", "User-Agent": "akldb/1.0" };
    let channelId: string;
    try {
      const channelResponse = await fetchImpl(`${api}/users/@me/channels`, {
        method: "POST", headers: authHeaders, body: JSON.stringify({ recipient_id: content.recipient_id }),
        signal: AbortSignal.timeout(8_000),
      });
      if (!channelResponse.ok) {
        await handleFailure(db, row, channelResponse, now(), false);
        if (channelResponse.status === 429 || channelResponse.status >= 500) summary.retried++;
        else summary.terminal++;
        continue;
      }
      const channel = await channelResponse.json() as { id?: string };
      if (typeof channel.id !== "string" || !/^\d{17,20}$/.test(channel.id)) {
        await terminal(db, row, now(), "failed", "invalid_dm_channel_response");
        summary.terminal++;
        continue;
      }
      channelId = channel.id;
    } catch {
      await retry(db, row, now(), "network_error", 0);
      summary.retried++;
      continue;
    }

    // Re-check just before the message POST: a comment may have been erased
    // while the DM channel request was in flight.
    const currentContent = await readEligibleContent(db, row);
    if (currentContent === null || currentContent.eligible !== 1) {
      await terminal(db, row, now(), "expired", "no_longer_eligible");
      summary.terminal++;
      continue;
    }

    const beforeMessage = now();
    const previousAttempt = row.ambiguous_message_attempt_at;
    if (previousAttempt !== null && new Date(beforeMessage).getTime() - new Date(previousAttempt).getTime() > 120_000) {
      await terminal(db, row, beforeMessage, "uncertain", "nonce_window_expired");
      summary.terminal++;
      continue;
    }
    const begin = await db.prepare(
      `UPDATE discord_rejection_dm_outbox
          SET ambiguous_message_attempt_at = COALESCE(ambiguous_message_attempt_at, ?), dm_channel_id = ?, updated_at = ?
        WHERE delivery_key = ? AND status = 'leased' AND lease_token = ? AND lease_until > ?`,
    ).bind(beforeMessage, channelId, beforeMessage, row.delivery_key, tokenId, beforeMessage).run();
    if (begin.meta.changes !== 1) continue;
    const messageRow = { ...row, ambiguous_message_attempt_at: previousAttempt ?? beforeMessage };

    const dmMessage = buildRejectionDmMessage({
      kind: row.kind,
      layoutName: currentContent.layout_name,
      layoutUrl: `https://akldb.org/l/${encodeURIComponent(content.layout_id)}`,
      reason: currentContent.reason,
      context: currentContent.context,
      commentBody: currentContent.comment_body,
    });
    try {
      const messageHeaders: Record<string, string> = {
        Authorization: `Bot ${token}`,
        "User-Agent": "akldb/1.0",
      };
      dmMessage.payload.nonce = row.nonce;
      dmMessage.payload.enforce_nonce = true;
      let messageBody: BodyInit;
      if (dmMessage.attachmentText !== undefined) {
        const form = new FormData();
        form.set("payload_json", JSON.stringify(dmMessage.payload));
        form.set("files[0]", new Blob([dmMessage.attachmentText], { type: "text/plain;charset=utf-8" }), "rejected-comment.txt");
        messageBody = form;
      } else {
        messageHeaders["Content-Type"] = "application/json";
        messageBody = JSON.stringify(dmMessage.payload);
      }
      const response = await fetchImpl(`${api}/channels/${channelId}/messages`, {
        method: "POST", headers: messageHeaders,
        body: messageBody,
        signal: AbortSignal.timeout(8_000),
      });
      if (!response.ok) {
        await handleFailure(db, messageRow, response, now(), true, previousAttempt !== null);
        if (response.status === 429 || response.status >= 500) summary.retried++;
        else summary.terminal++;
        continue;
      }
      const sent = await response.json() as { id?: string };
      if (typeof sent.id !== "string" || !/^\d{17,20}$/.test(sent.id)) {
        await terminal(db, row, now(), "uncertain", "invalid_message_response");
        summary.terminal++;
        continue;
      }
      await db.prepare(
        `UPDATE discord_rejection_dm_outbox
            SET status = 'sent', discord_message_id = ?, sent_at = ?, updated_at = ?, lease_token = NULL, lease_until = NULL
          WHERE delivery_key = ? AND status = 'leased' AND lease_token = ?`,
      ).bind(sent.id, now(), now(), row.delivery_key, tokenId).run();
      summary.sent++;
    } catch {
      await retry(db, messageRow, now(), "network_error", 0, true);
      summary.retried++;
    }
  }
  return summary;
}

async function readEligibleContent(db: Bindings["DB"], row: RejectionOutboxRow): Promise<DeliveryContent | null> {
  const source = row.kind === "comment" ? "layout_comments" : row.kind === "link" ? "link_submissions" : "wpm_submissions";
  const recipient = row.kind === "link" ? "submitted_by" : "user_id";
  const cycleEligibility = row.kind === "link" ? "" : " AND s.review_version = ?";
  const bodyEligibility = row.kind === "comment" ? " AND s.body IS NOT NULL" : "";
  const rowData = await db.prepare(
    `SELECT s.${recipient} AS recipient_id, s.reason, l.name AS layout_name, l.deleted,
            ${row.kind === "comment" ? "s.body" : "NULL"} AS comment_body,
            s.status = 'rejected'${bodyEligibility}${cycleEligibility} AS eligible
       FROM ${source} s JOIN layouts l ON l.id = s.layout_id
      WHERE s.id = ? AND s.layout_id = ?`,
  ).bind(...(row.kind === "link" ? [] : [row.review_version]), row.submission_id, row.layout_id).first<Omit<DeliveryContent, "context"> & { deleted: number }>();
  if (rowData === null) return null;
  return {
    recipient_id: rowData.recipient_id,
    layout_id: row.layout_id,
    layout_name: rowData.layout_name,
    reason: rowData.reason,
    comment_body: rowData.comment_body,
    context: row.kind === "comment" ? "Comment submission" : row.kind === "link" ? "Link submission" : "WPM submission",
    eligible: rowData.eligible && rowData.deleted === 0 && rowData.recipient_id === row.recipient_id ? 1 : 0,
  };
}

async function handleFailure(db: Bindings["DB"], row: RejectionOutboxRow, response: Response, at: string, messagePost: boolean, priorAmbiguous = false): Promise<void> {
  if (response.status === 429) {
    const retryAfter = await retryAfterSeconds(response);
    // A definitive 429 means this particular message was not accepted. If
    // no earlier POST had an ambiguous outcome, clear its pre-send marker so
    // a long server retry delay does not become a false uncertain terminal.
    if (messagePost && !priorAmbiguous) {
      await db.prepare(`UPDATE discord_rejection_dm_outbox SET ambiguous_message_attempt_at = NULL, updated_at = ?
        WHERE delivery_key = ? AND status = 'leased' AND lease_token = ?`).bind(at, row.delivery_key, row.lease_token).run();
    }
    await retry(db, row, at, "rate_limited", retryAfter, false);
    return;
  }
  if (response.status >= 500) {
    const age = row.ambiguous_message_attempt_at === null ? 0 : new Date(at).getTime() - new Date(row.ambiguous_message_attempt_at).getTime();
    if (messagePost && age > 120_000) await terminal(db, row, at, "uncertain", "ambiguous_result_outside_nonce_window");
    else await retry(db, row, at, `http_${response.status}`, 0, messagePost);
    return;
  }
  let code: number | null = null;
  try { code = (await response.clone().json() as { code?: number }).code ?? null; } catch { /* response body is not trusted */ }
  await terminal(db, row, at, code === 50007 ? "blocked" : "failed", code === 50007 ? "recipient_blocks_dms" : `http_${response.status}`);
}

async function retryAfterSeconds(response: Response): Promise<number> {
  const headerValue = response.headers.get("Retry-After");
  const header = headerValue === null ? Number.NaN : Number(headerValue);
  if (Number.isFinite(header) && header >= 0) return header;
  try {
    const body = await response.clone().json() as { retry_after?: number };
    if (typeof body.retry_after === "number" && Number.isFinite(body.retry_after) && body.retry_after >= 0) return body.retry_after;
  } catch { /* use exponential fallback */ }
  return 0;
}

async function retry(db: Bindings["DB"], row: RejectionOutboxRow, at: string, error: string, retryAfter: number, ambiguous = false): Promise<void> {
  const attemptAt = row.ambiguous_message_attempt_at;
  if (ambiguous && attemptAt !== null && new Date(at).getTime() - new Date(attemptAt).getTime() > 120_000) {
    await terminal(db, row, at, "uncertain", "nonce_window_expired");
    return;
  }
  const exponential = Math.min(60 * 60, 30 * 2 ** Math.min(Math.max(row.attempts - 1, 0), 7));
  const seconds = retryAfter > 0 ? retryAfter : exponential + deterministicJitter(row.delivery_key, row.attempts, exponential);
  await db.prepare(
    `UPDATE discord_rejection_dm_outbox
        SET status = 'pending', next_attempt_at = ?, updated_at = ?, lease_token = NULL, lease_until = NULL, last_error_class = ?
      WHERE delivery_key = ? AND status = 'leased' AND lease_token = ?`,
  ).bind(addSeconds(at, seconds), at, error, row.delivery_key, row.lease_token).run();
  // Treat any 429 as a queue-wide pause. Discord may identify it as global
  // only in response headers/body, and delaying other pending DMs briefly is
  // preferable to accidentally continuing through a global limit.
  if (error === "rate_limited") {
    await db.prepare("UPDATE discord_rejection_dm_outbox SET next_attempt_at = MAX(next_attempt_at, ?), updated_at = ? WHERE status = 'pending'")
      .bind(addSeconds(at, seconds), at).run();
  }
}

async function terminal(db: Bindings["DB"], row: RejectionOutboxRow, at: string, status: "blocked" | "uncertain" | "failed" | "expired", error: string): Promise<void> {
  await db.prepare(
    `UPDATE discord_rejection_dm_outbox
        SET status = ?, updated_at = ?, lease_token = NULL, lease_until = NULL, last_error_class = ?
      WHERE delivery_key = ? AND status = 'leased' AND lease_token = ?`,
  ).bind(status, at, error, row.delivery_key, row.lease_token).run();
}

function addSeconds(iso: string, seconds: number): string {
  return new Date(new Date(iso).getTime() + seconds * 1000).toISOString();
}

function deterministicJitter(key: string, attempt: number, baseSeconds: number): number {
  let hash = 2166136261 ^ attempt;
  for (const character of key) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
  return (hash >>> 0) % (Math.floor(baseSeconds / 5) + 1);
}
