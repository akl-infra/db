// Pure Discord Components V2 rendering and status mutation for mod-queue
// messages. Stable component IDs preserve content while the controlled action
// row changes between pending decisions and version-bound reopening.
import type { QueueKind } from "./modqueue";
import type { ProofPreview } from "./modqueue-proof";

export interface LinkCardData {
  id: string;
  review_version?: number;
  layout_id: string;
  url: string;
  submitted_by: string;
  layout_name: string;
  submitter_name: string | null;
}

export interface WpmCardData {
  source_message_url?: string | null;
  id: string;
  review_version?: number;
  layout_id: string;
  user_id: string;
  wpm: number;
  proof: string;
  layout_name: string;
  user_name: string | null;
}

export interface CommentCardData {
  id: string;
  review_version?: number;
  layout_id: string;
  user_id: string;
  body: string;
  layout_name: string;
  layout_owner: string;
  user_name: string | null;
  live_body: string | null;
}

export interface QueueStatus {
  submitter_id?: string;
  source_message_url?: string | null;
  status: "pending" | "approved" | "rejected" | "superseded" | "replaced" | "deleted" | "removed";
  decider_name: string | null;
  review_version?: number;
  reason?: string | null;
}

export const COMPONENT_STATUS_ID = 41001;
const COMPONENT_TITLE_ID = 41002;
const COMPONENT_METADATA_ID = 41003;
const COMPONENT_BODY_ID = 41004;
const COMPONENT_SEPARATOR_ID = 41005;
const COMPONENT_ACTIONS_ID = 41006;
const COMPONENT_STATUS_SEPARATOR_ID = 41007;
const COMPONENT_BODY_SEPARATOR_ID = 41008;
const COMPONENT_FILE_ID = 41009;
const COMPONENT_PROOF_MEDIA_ID = 41010;
const COMPONENT_PROOF_NOTE_ID = 41011;
export const DISCORD_COMPONENTS_V2_FLAG = 32768;
const MAX_COMPONENT_TEXT_UNITS = 4000;
// A decision may add a moderator and a 500-character reason (up to twice
// that after Markdown escaping). Reserve it before deciding inline/file.
const DECISION_STATUS_RESERVE = 1200;

export interface TextFileAttachment { filename: string; content: string; description: string }
export interface MessageFileAttachment { filename: string; content: string | Uint8Array; description: string; contentType?: string }

function escapeMarkdown(value: string): string {
  return value.replace(/[\\`*_~|>#\[\]]/g, (ch) => `\\${ch}`);
}

function inlineText(value: string): string {
  return value.replace(/[\r\n\u0000-\u001f\u007f]/g, " ");
}

function quoteComment(value: string): string {
  return escapeMarkdown(value).replace(/\r\n?/g, "\n").split("\n").map((line) => `> ${line}`).join("\n");
}

function safeWrappedUrl(value: string): string {
  return `<${value.replace(/[<>\s]/g, (ch) => encodeURIComponent(ch))}>`;
}

function clipUtf16(value: string, maxUnits: number): string {
  if (value.length <= maxUnits) return value;
  let clipped = value.slice(0, Math.max(0, maxUnits - 1));
  // Do not leave an unpaired high surrogate at Discord's UTF-16 boundary.
  if (clipped.length > 0 && /[\uD800-\uDBFF]/.test(clipped.at(-1)!)) clipped = clipped.slice(0, -1);
  return `${clipped}…`;
}

/** Missing author profiles still resolve to a Discord display name, without
 * enabling notification pings. Stored names remain escaped plain text. */
export function queueUserName(name: string | null, userId: string, maxUnits = Infinity): string {
  if (!name?.trim() || name === userId) return `<@${userId}>`;
  return escapeMarkdown(clipUtf16(inlineText(name), maxUnits));
}

/** Repair only the generated author slot, never submitted text or proof.
 * The source row supplies the identity rather than trusting message content. */
export function repairQueueUser(content: string, kind: QueueKind, userId?: string): string {
  if (!userId || !/^\d{17,20}$/.test(userId)) return content;
  if (kind === "link" && content.startsWith(`Submitted by **${userId}** · Link ·`)) {
    return content.replace(`Submitted by **${userId}**`, `Submitted by **<@${userId}>**`);
  }
  const heading = kind === "wpm" ? "**WPM submission** on "
    : kind === "comment" ? /^\*\*(?:New|Edited) comment\*\* on / : null;
  if (heading && (typeof heading === "string" ? content.startsWith(heading) : heading.test(content))) {
    const suffix = ` by **${userId}**`;
    const newline = content.indexOf("\n");
    const firstLine = newline === -1 ? content : content.slice(0, newline);
    return firstLine.endsWith(suffix)
      ? `${firstLine.slice(0, -suffix.length)} by **<@${userId}>**${newline === -1 ? "" : content.slice(newline)}`
      : content;
  }
  const legacyHeading = kind === "comment" ? /^(?:New|Edited) comment on \*\*/
    : kind === "wpm" ? /^New WPM submission on \*\*/ : /^New link submission on \*\*/;
  if (!legacyHeading.test(content)) return content;
  const newline = content.indexOf("\n");
  const firstLine = newline === -1 ? content : content.slice(0, newline);
  const tail = newline === -1 ? "" : content.slice(newline);
  const marker = kind === "comment" ? `** by ${userId} (` : `** by ${userId}:`;
  let repaired = firstLine.replace(marker, marker.replace(userId, `<@${userId}>`));
  // A mention adds three characters. At the legacy message limit, remove
  // four generated bold delimiters rather than trimming submitted text.
  if (repaired !== firstLine && repaired.length + tail.length > 2000) {
    repaired = repaired.replace(" on **", " on ").replace(`** by <@${userId}>`, ` by <@${userId}>`);
  }
  return repaired + tail;
}

function layoutLink(layoutId: string, name: string): string {
  return `[${escapeMarkdown(name)}](<https://akldb.org/l/${layoutId}>)`;
}

function statusText(state: QueueStatus): string {
  if (state.status === "pending") return "**PENDING REVIEW**";
  const labels: Record<Exclude<QueueStatus["status"], "pending">, string> = {
    approved: "✅ APPROVED",
    rejected: "❌ DENIED",
    superseded: "↪️ SUPERSEDED",
    replaced: "↪️ REPLACED",
    deleted: "🗑️ DELETED",
    removed: "⚠️ REMOVED",
  };
  const label = labels[state.status];
  return clipUtf16(state.decider_name === null ? `**${label}**` : `**${label}** · by ${escapeMarkdown(state.decider_name)}`, 180);
}

function decisionStatusLabel(status: QueueStatus["status"]): string {
  return { pending: "⏳ Pending review", approved: "✅ Approved", rejected: "❌ Denied",
    superseded: "↪️ Superseded", replaced: "↪️ Replaced", deleted: "🗑️ Deleted", removed: "⚠️ Removed" }[status];
}

function decisionStatusText(state: QueueStatus): string {
  const actor = state.status === "pending" || state.decider_name === null ? ""
    : ` · by ${escapeMarkdown(clipUtf16(inlineText(state.decider_name), 60))}`;
  const reason = state.status === "rejected" && state.reason?.trim()
    ? `\n**Reason:** ${escapeMarkdown(clipUtf16(inlineText(state.reason.trim()), 500))}` : "";
  return `**${decisionStatusLabel(state.status)}**${actor}${reason}`;
}

function actionRow(kind: QueueKind, id: string, actionsEnabled: boolean, state: QueueStatus = { status: "pending", decider_name: null }): Record<string, unknown> {
  const version = state.review_version ?? 0;
  const customId = (action: string) => `aklmod2|${kind}|${action}|${id}|${version}`;
  const buttons = state.status === "pending" ? [
    { type: 2, style: 3, label: "✓ Approve", custom_id: customId("approve") },
    { type: 2, style: 4, label: "✕ Deny", custom_id: customId("deny") },
  ] : kind !== "link" && (state.status === "approved" || state.status === "rejected") ? [
    { type: 2, style: 2, label: "Reopen review", custom_id: customId(`reopen-${state.status}`) },
  ] : [];
  return { type: 1, id: COMPONENT_ACTIONS_ID, components: [
    ...(actionsEnabled ? buttons : []),
    ...(kind === "wpm" && state.source_message_url ? [{ type: 2, style: 5, label: "Original message", url: state.source_message_url }] : []),
    { type: 2, style: 5, label: "Open in akldb", url: "https://akldb.org/admin?tab=inbox" },
  ] };
}

/** Full escaped preview if it fits the card; otherwise a plain-text file with
 * the exact complete text. `maxInlineUnits` includes labels and markdown. */
export function formatCommentText(body: string, liveBody: string | null, maxInlineUnits: number, contentFirst = false): { inline: string; attachmentText?: string } {
  const inline = contentFirst
    ? `${quoteComment(body)}${liveBody === null ? "" : `\n\n-# Previous version\n${quoteComment(liveBody)}`}`
    : liveBody === null
    ? `**Comment**\n${escapeMarkdown(body)}`
    : `**Before**\n${escapeMarkdown(liveBody)}\n\n**After**\n${escapeMarkdown(body)}`;
  if (inline.length <= maxInlineUnits) return { inline };
  const attachmentText = liveBody === null
    ? `COMMENT\n\n${body}`
    : `BEFORE\n\n${liveBody}\n\nAFTER\n\n${body}`;
  return { inline: "Full comment text attached as a .txt file.", attachmentText };
}

function payload(kind: QueueKind, id: string, title: string, metadata: string, body: string, actionsEnabled: boolean, file?: TextFileAttachment, reviewVersion = 0, preview?: ProofPreview, sourceMessageUrl: string | null = null): Record<string, unknown> {
  title = clipUtf16(title, 600);
  metadata = clipUtf16(metadata, 500);
  const result: Record<string, unknown> = {
    flags: DISCORD_COMPONENTS_V2_FLAG,
    allowed_mentions: { parse: [] },
    components: [{
      type: 17,
      id: 41000,
      components: kind !== "link" ? [
        { type: 10, id: COMPONENT_METADATA_ID, content: metadata },
        { type: 10, id: COMPONENT_BODY_ID, content: body },
        ...(file === undefined ? [] : [{ type: 13, id: COMPONENT_FILE_ID, file: { url: `attachment://${file.filename}` } }]),
        ...(preview?.kind === "images" ? [{ type: 12, id: COMPONENT_PROOF_MEDIA_ID, items: preview.images.map((image) => ({
          media: { url: `attachment://${image.filename}` }, description: image.description, spoiler: image.spoiler,
        })) }] : []),
        ...(preview?.kind === "youtube" ? [
          ...(preview.thumbnailUrl ? [{ type: 12, id: COMPONENT_PROOF_MEDIA_ID, items: [{ media: { url: preview.thumbnailUrl }, description: "YouTube video thumbnail" }] }] : []),
          { type: 10, id: COMPONENT_PROOF_NOTE_ID, content: `[Watch on YouTube](<${preview.videoUrl}>)` },
        ] : []),
        ...(preview?.kind === "unavailable" || (preview?.kind === "images" && preview.incomplete)
          ? [{ type: 10, id: COMPONENT_PROOF_NOTE_ID, content: preview.kind === "unavailable"
            ? "Image preview unavailable. Open the original proof link."
            : "Some images could not be copied. Open the original proof link for the complete proof." }] : []),
        { type: 14, id: COMPONENT_SEPARATOR_ID, divider: true, spacing: 1 },
        actionRow(kind, id, actionsEnabled, { status: "pending", decider_name: null, review_version: reviewVersion, source_message_url: sourceMessageUrl }),
      ] : [
        { type: 10, id: COMPONENT_TITLE_ID, content: title },
        { type: 10, id: COMPONENT_METADATA_ID, content: metadata },
        { type: 14, id: COMPONENT_BODY_SEPARATOR_ID, divider: true, spacing: 1 },
        { type: 10, id: COMPONENT_BODY_ID, content: body },
        ...(file === undefined ? [] : [{ type: 13, id: COMPONENT_FILE_ID, file: { url: `attachment://${file.filename}` } }]),
        { type: 14, id: COMPONENT_SEPARATOR_ID, divider: true, spacing: 1 },
        actionRow(kind, id, actionsEnabled, { status: "pending", decider_name: null, review_version: reviewVersion, source_message_url: sourceMessageUrl }),
      ],
    }],
  };
  const files: MessageFileAttachment[] = [...(file ? [file] : []), ...(preview?.kind === "images" ? preview.images : [])];
  if (files.length) {
    result.attachments = files.map((item, index) => ({ id: String(index), filename: item.filename, description: item.description }));
    // Internal-only upload metadata. The transport strips this before sending
    // payload_json and uploads the exact bytes as multipart `files[n]`.
    result.__files = files;
  }
  return result;
}

export function buildV2Payload(kind: "link", candidate: LinkCardData, actionsEnabled?: boolean): Record<string, unknown>;
export function buildV2Payload(kind: "wpm", candidate: WpmCardData, actionsEnabled?: boolean, preview?: ProofPreview): Record<string, unknown>;
export function buildV2Payload(kind: "comment", candidate: CommentCardData, actionsEnabled?: boolean): Record<string, unknown>;
export function buildV2Payload(kind: QueueKind, candidate: LinkCardData | WpmCardData | CommentCardData, actionsEnabled = true, preview?: ProofPreview): Record<string, unknown> {
  if (kind === "link") {
    const c = candidate as LinkCardData;
    const who = queueUserName(c.submitter_name, c.submitted_by, 60);
    return payload(kind, c.id, `## Link submission on ${layoutLink(c.layout_id, c.layout_name)}`,
      `Submitted by **${who}** · Link · Submission \`${c.id}\``, `Submitted URL: ${safeWrappedUrl(c.url)}`, actionsEnabled, undefined, c.review_version ?? 0);
  }
  if (kind === "wpm") {
    const c = candidate as WpmCardData;
    const who = queueUserName(c.user_name, c.user_id, 60);
    const metadata = `**WPM submission** on **${layoutLink(c.layout_id, clipUtf16(inlineText(c.layout_name), 100))}** by **${who}**`;
    // Parentheses and backslashes can terminate or alter a Markdown link
    // target even inside its angle-bracket wrapper. Encode them as URL data.
    const proof = safeWrappedUrl(c.proof.replace(/[()\\]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`));
    const body = `**${c.wpm} WPM** · [View proof](${proof})`;
    const previewTextSize = preview?.kind === "youtube" ? preview.videoUrl.length + 30 : 100;
    const file = body.length + metadata.length + DECISION_STATUS_RESERVE + previewTextSize <= MAX_COMPONENT_TEXT_UNITS ? undefined : {
      filename: `wpm-proof-${c.id}.txt`, content: c.proof, description: "Complete WPM proof URL",
    };
    return payload(kind, c.id, "", metadata, file === undefined ? body : `**${c.wpm} WPM** · Full proof URL attached.`,
      actionsEnabled, file, c.review_version ?? 0, preview, c.source_message_url ?? null);
  }
  const c = candidate as CommentCardData;
  const who = queueUserName(c.user_name, c.user_id, 60);
  const authorLabel = c.user_id === c.layout_owner ? " (Layout Author)" : "";
  const metadata = `**${c.live_body === null ? "New" : "Edited"} comment** on **${layoutLink(c.layout_id, clipUtf16(inlineText(c.layout_name), 100))}** by **${who}**${authorLabel}`;
  // Keep headroom for a longer status label when a decision arrives.
  const formatted = formatCommentText(c.body, c.live_body, MAX_COMPONENT_TEXT_UNITS - DECISION_STATUS_RESERVE - metadata.length, true);
  const file = formatted.attachmentText === undefined ? undefined : {
    filename: `comment-${c.id}.txt`, content: formatted.attachmentText, description: "Complete comment text before and after the edit",
  };
  return payload(kind, c.id, "", metadata, formatted.inline, actionsEnabled, file, c.review_version ?? 0);
}

export function buildV2StatusPatch(current: unknown, kind: QueueKind, id: string, state: QueueStatus, actionsEnabled = true): Record<string, unknown> | null {
  if (current === null || typeof current !== "object" || !("components" in current) || !Array.isArray(current.components)) return null;
  // Older cards did not reserve room for a reason. Preserve their bounded
  // status layout; the new footer can safely use its reserved space.
  const richCard = kind !== "link" && current.components.some((container: { components?: { id?: number; content?: string }[] }) =>
    Array.isArray(container?.components) && container.components.some((row) => row?.id === COMPONENT_METADATA_ID &&
      typeof row.content === "string" && (kind === "comment"
        ? /^\*\*(?:New|Edited) comment\*\* on /.test(row.content)
        : /^\*\*WPM submission\*\* on /.test(row.content))));
  let foundStatus = false;
  const eraseCommentBody = kind === "comment" && (state.status === "deleted" || state.status === "replaced");
  const patch = (component: unknown): unknown => {
    if (Array.isArray(component)) return component.map(patch).filter((item) => item !== null);
    if (component === null || typeof component !== "object") return component;
    const row = { ...component } as Record<string, unknown>;
    if (row.type === 10 && row.id === COMPONENT_METADATA_ID && typeof row.content === "string") {
      row.content = repairQueueUser(row.content, kind, state.submitter_id);
    }
    if (row.type === 1 && row.id === COMPONENT_ACTIONS_ID) return actionRow(kind, id, actionsEnabled, state);
    // Earlier compact cards kept state in their context line. Preserve that
    // format while omitting its pending label when a review is reopened.
    if (kind === "comment" && row.type === 10 && row.id === COMPONENT_METADATA_ID &&
        typeof row.content === "string" && /^-# (?:\([^)]*\) )?(?:New|Edited) comment on /.test(row.content)) {
      foundStatus = true;
      const context = row.content.replace(/^-# (?:\([^)]*\) )?/, "");
      return { ...row, content: `-# ${state.status === "pending" ? "" : `(${decisionStatusLabel(state.status)}) `}${context}` };
    }
    if (row.type === 10 && row.id === COMPONENT_STATUS_ID) {
      foundStatus = true;
      if (kind !== "link" && state.status === "pending") return null;
      return { ...row, content: richCard ? decisionStatusText(state) : statusText(state) };
    }
    if (eraseCommentBody && row.type === 10 && row.id === COMPONENT_BODY_ID) {
      return { ...row, content: "**Comment preview removed**" };
    }
    if (eraseCommentBody && row.type === 13 && row.id === COMPONENT_FILE_ID) return null;
    if (Array.isArray(row.components)) return { ...row, components: row.components.map(patch).filter((item) => item !== null) };
    return { ...row };
  };
  const components = current.components.map(patch);
  if (richCard && !foundStatus) {
    const container = components.find((item): item is { components: Record<string, unknown>[] } =>
      item !== null && typeof item === "object" && "id" in item && item.id === 41000 &&
      "components" in item && Array.isArray(item.components));
    if (container) {
      const actionIndex = container.components.findIndex((row) => row.id === COMPONENT_ACTIONS_ID);
      if (actionIndex !== -1) {
        if (state.status !== "pending") container.components.splice(actionIndex, 0,
          { type: 10, id: COMPONENT_STATUS_ID, content: decisionStatusText(state) });
        foundStatus = true;
      }
    }
  }
  if (!foundStatus) {
    const container = components.find((component): component is Record<string, unknown> =>
      component !== null && typeof component === "object" &&
      "type" in component && component.type === 17 &&
      "id" in component && component.id === 41000 &&
      "components" in component && Array.isArray(component.components));
    if (container && Array.isArray(container.components)) {
      if (kind === "link" || state.status !== "pending") {
        container.components.unshift(
          { type: 10, id: COMPONENT_STATUS_ID, content: statusText(state) },
          { type: 14, id: COMPONENT_STATUS_SEPARATOR_ID, divider: true, spacing: 1 },
        );
      }
      foundStatus = true;
    }
  }
  if (!foundStatus) return null;
  const patchBody: Record<string, unknown> = { flags: DISCORD_COMPONENTS_V2_FLAG, components, allowed_mentions: { parse: [] } };
  if ("attachments" in current && Array.isArray(current.attachments)) {
    const attachments = [...current.attachments];
    // Discord may expose an inline attachment on its media component rather
    // than in the message's top-level attachments. An explicit PATCH list
    // must keep those IDs too, or approving the card would erase its proof.
    const retainMedia = (value: unknown): void => {
      if (Array.isArray(value)) { value.forEach(retainMedia); return; }
      if (!value || typeof value !== "object") return;
      const row = value as Record<string, unknown>;
      if (typeof row.attachment_id === "string" && /^\d{17,20}$/.test(row.attachment_id)
        && !attachments.some((a) => a?.id === row.attachment_id)) attachments.push({ id: row.attachment_id });
      Object.values(row).forEach(retainMedia);
    };
    retainMedia(components);
    patchBody.attachments = eraseCommentBody ? [] : attachments;
  }
  return patchBody;
}
