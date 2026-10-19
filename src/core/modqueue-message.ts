// Pure Discord Components V2 rendering and status mutation for mod-queue
// messages. Keep component IDs stable: status edits target one TextDisplay,
// and disable only this message's approve/deny controls.
import type { QueueKind } from "./modqueue";

export interface LinkCardData {
  id: string;
  layout_id: string;
  url: string;
  submitted_by: string;
  layout_name: string;
  submitter_name: string | null;
}

export interface WpmCardData {
  id: string;
  layout_id: string;
  user_id: string;
  wpm: number;
  proof: string;
  layout_name: string;
  user_name: string | null;
}

export interface CommentCardData {
  id: string;
  layout_id: string;
  user_id: string;
  body: string;
  layout_name: string;
  user_name: string | null;
  live_body: string | null;
}

export interface QueueStatus {
  status: "pending" | "approved" | "rejected" | "superseded" | "replaced" | "deleted" | "removed";
  decider_name: string | null;
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
export const DISCORD_COMPONENTS_V2_FLAG = 32768;
const MAX_COMPONENT_TEXT_UNITS = 4000;
const STATUS_TEXT_RESERVE = 180;

export interface TextFileAttachment { filename: string; content: string; description: string }

function escapeMarkdown(value: string): string {
  return value.replace(/[\\`*_~|>\[\]]/g, (ch) => `\\${ch}`);
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

function actionRow(kind: QueueKind, id: string, actionsEnabled: boolean): Record<string, unknown> {
  return {
    type: 1,
    id: COMPONENT_ACTIONS_ID,
    components: [
      ...(actionsEnabled ? [
        { type: 2, style: 3, label: "✓ Approve", custom_id: `aklmod1|${kind}|approve|${id}` },
        { type: 2, style: 4, label: "✕ Deny", custom_id: `aklmod1|${kind}|deny|${id}` },
      ] : []),
      { type: 2, style: 5, label: "Open in akldb", url: "https://akldb.org/admin?tab=inbox" },
    ],
  };
}

/** Full escaped preview if it fits the card; otherwise a plain-text file with
 * the exact complete text. `maxInlineUnits` includes labels and markdown. */
export function formatCommentText(body: string, liveBody: string | null, maxInlineUnits: number): { inline: string; attachmentText?: string } {
  const inline = liveBody === null
    ? `**Comment**\n${escapeMarkdown(body)}`
    : `**Before**\n${escapeMarkdown(liveBody)}\n\n**After**\n${escapeMarkdown(body)}`;
  if (inline.length <= maxInlineUnits) return { inline };
  const attachmentText = liveBody === null
    ? `COMMENT\n\n${body}`
    : `BEFORE\n\n${liveBody}\n\nAFTER\n\n${body}`;
  return { inline: "Full comment text attached as a .txt file.", attachmentText };
}

function payload(kind: QueueKind, id: string, title: string, metadata: string, body: string, actionsEnabled: boolean, file?: TextFileAttachment): Record<string, unknown> {
  title = clipUtf16(title, 600);
  metadata = clipUtf16(metadata, 500);
  const result: Record<string, unknown> = {
    flags: DISCORD_COMPONENTS_V2_FLAG,
    allowed_mentions: { parse: [] },
    components: [{
      type: 17,
      id: 41000,
      components: [
        { type: 10, id: COMPONENT_TITLE_ID, content: title },
        { type: 10, id: COMPONENT_METADATA_ID, content: metadata },
        { type: 14, id: COMPONENT_BODY_SEPARATOR_ID, divider: true, spacing: 1 },
        { type: 10, id: COMPONENT_BODY_ID, content: body },
        ...(file === undefined ? [] : [{ type: 13, id: COMPONENT_FILE_ID, file: { url: `attachment://${file.filename}` } }]),
        { type: 14, id: COMPONENT_SEPARATOR_ID, divider: true, spacing: 1 },
        actionRow(kind, id, actionsEnabled),
      ],
    }],
  };
  if (file !== undefined) {
    result.attachments = [{ id: "0", filename: file.filename, description: file.description }];
    // Internal-only upload metadata. The transport strips this before sending
    // payload_json and uploads the exact text as multipart `files[0]`.
    result.__files = [file];
  }
  return result;
}

export function buildV2Payload(kind: "link", candidate: LinkCardData, actionsEnabled?: boolean): Record<string, unknown>;
export function buildV2Payload(kind: "wpm", candidate: WpmCardData, actionsEnabled?: boolean): Record<string, unknown>;
export function buildV2Payload(kind: "comment", candidate: CommentCardData, actionsEnabled?: boolean): Record<string, unknown>;
export function buildV2Payload(kind: QueueKind, candidate: LinkCardData | WpmCardData | CommentCardData, actionsEnabled = true): Record<string, unknown> {
  if (kind === "link") {
    const c = candidate as LinkCardData;
    const who = clipUtf16(escapeMarkdown(c.submitter_name ?? c.submitted_by), 120);
    return payload(kind, c.id, `## Link submission on ${layoutLink(c.layout_id, c.layout_name)}`,
      `Submitted by **${who}** · Link · Submission \`${c.id}\``, `Submitted URL: ${safeWrappedUrl(c.url)}`, actionsEnabled);
  }
  if (kind === "wpm") {
    const c = candidate as WpmCardData;
    const who = clipUtf16(escapeMarkdown(c.user_name ?? c.user_id), 120);
    return payload(kind, c.id, `## WPM submission on ${layoutLink(c.layout_id, c.layout_name)}`,
      `Submitted by **${who}** · Words per minute · Submission \`${c.id}\``, `**${c.wpm} WPM**\nProof: ${safeWrappedUrl(c.proof)}`, actionsEnabled);
  }
  const c = candidate as CommentCardData;
  const who = clipUtf16(escapeMarkdown(c.user_name ?? c.user_id), 120);
  const title = `## Comment on ${layoutLink(c.layout_id, c.layout_name)}`;
  const metadata = `Submitted by **${who}** · Comment · Submission \`${c.id}\``;
  // Keep headroom for the status TextDisplay added when a decision arrives.
  const formatted = formatCommentText(c.body, c.live_body, MAX_COMPONENT_TEXT_UNITS - STATUS_TEXT_RESERVE - title.length - metadata.length);
  const file = formatted.attachmentText === undefined ? undefined : {
    filename: `comment-${c.id}.txt`, content: formatted.attachmentText, description: "Complete comment text before and after the edit",
  };
  return payload(kind, c.id, title, metadata, formatted.inline, actionsEnabled, file);
}

export function buildV2StatusPatch(current: unknown, kind: QueueKind, id: string, state: QueueStatus): Record<string, unknown> | null {
  if (current === null || typeof current !== "object" || !("components" in current) || !Array.isArray(current.components)) return null;
  let foundStatus = false;
  const moderationPrefix = `aklmod1|${kind}|`;
  const eraseCommentBody = kind === "comment" && (state.status === "deleted" || state.status === "replaced");
  const patch = (component: unknown): unknown => {
    if (Array.isArray(component)) return component.map(patch).filter((item) => item !== null);
    if (component === null || typeof component !== "object") return component;
    const row = component as Record<string, unknown>;
    if (row.type === 10 && row.id === COMPONENT_STATUS_ID) {
      foundStatus = true;
      return { ...row, content: statusText(state) };
    }
    if (eraseCommentBody && row.type === 10 && row.id === COMPONENT_BODY_ID) {
      return { ...row, content: "**Comment preview removed**" };
    }
    if (eraseCommentBody && row.type === 13 && row.id === COMPONENT_FILE_ID) return null;
    if (row.type === 2 && typeof row.custom_id === "string" && row.custom_id.startsWith(moderationPrefix) && row.custom_id.endsWith(`|${id}`)) {
      return { ...row, disabled: true };
    }
    if (Array.isArray(row.components)) return { ...row, components: row.components.map(patch).filter((item) => item !== null) };
    return { ...row };
  };
  const components = current.components.map(patch);
  if (!foundStatus && state.status !== "pending") {
    const container = components.find((component): component is Record<string, unknown> =>
      component !== null && typeof component === "object" &&
      "type" in component && component.type === 17 &&
      "id" in component && component.id === 41000 &&
      "components" in component && Array.isArray(component.components));
    if (container && Array.isArray(container.components)) {
      container.components.unshift(
        { type: 10, id: COMPONENT_STATUS_ID, content: statusText(state) },
        { type: 14, id: COMPONENT_STATUS_SEPARATOR_ID, divider: true, spacing: 1 },
      );
      foundStatus = true;
    }
  }
  if (!foundStatus) return null;
  const patchBody: Record<string, unknown> = { flags: DISCORD_COMPONENTS_V2_FLAG, components, allowed_mentions: { parse: [] } };
  if ("attachments" in current && Array.isArray(current.attachments)) {
    patchBody.attachments = eraseCommentBody ? [] : current.attachments;
  }
  return patchBody;
}
