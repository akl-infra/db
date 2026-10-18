// The admin Inbox (`pages/admin/InboxTab.tsx`): link submissions, WPM
// submissions and layout comments in ONE list, newest first. Pure merge + one loader, so the
// ordering and the either-queue-failed behaviour are testable without
// mounting the page.
import { adminCommentQueue, adminLinkQueue, adminWpmQueue, type ApiResult } from "../api.ts";
import type { CommentQueueRow, LinkQueueRow, LinkSubmissionStatus, WpmQueueRow } from "./types.ts";

export type InboxItem =
  | { kind: "link"; id: string; submitted_at: string; status: LinkSubmissionStatus; row: LinkQueueRow }
  | { kind: "wpm"; id: string; submitted_at: string; status: LinkSubmissionStatus; row: WpmQueueRow }
  | { kind: "comment"; id: string; submitted_at: string; status: LinkSubmissionStatus; row: CommentQueueRow };

/** Newest `submitted_at` first; equal timestamps order by id descending
 * (ids are ULIDs, so that is newest-minted first) so the order is total. */
export function mergeInbox(links: LinkQueueRow[], wpms: WpmQueueRow[], comments: CommentQueueRow[] = []): InboxItem[] {
  const items: InboxItem[] = [
    ...links.map((row): InboxItem => ({ kind: "link", id: row.id, submitted_at: row.submitted_at, status: row.status, row })),
    ...wpms.map((row): InboxItem => ({ kind: "wpm", id: row.id, submitted_at: row.submitted_at, status: row.status, row })),
    // The Inbox only asks the comment queue for the four statuses its chips offer.
    ...comments.map((row): InboxItem => ({ kind: "comment", id: row.id, submitted_at: row.submitted_at, status: row.status as LinkSubmissionStatus, row })),
  ];
  return items.sort((a, b) => (a.submitted_at === b.submitted_at ? (a.id < b.id ? 1 : a.id > b.id ? -1 : 0) : a.submitted_at < b.submitted_at ? 1 : -1));
}

/** Loads all three queues for `status` and merges them. If ANY queue fails
 * the whole result is that failure (shown verbatim, `loadErrorMessage`):
 * half an inbox would read as "nothing else is waiting", which is the one
 * thing an inbox must never claim by accident. */
export async function loadInbox(status: LinkSubmissionStatus): Promise<ApiResult<InboxItem[]>> {
  const [links, wpms, comments] = await Promise.all([adminLinkQueue(status), adminWpmQueue(status), adminCommentQueue(status)]);
  if (!links.ok) return links;
  if (!wpms.ok) return wpms;
  if (!comments.ok) return comments;
  return { ok: true, data: mergeInbox(links.data.submissions, wpms.data.submissions, comments.data.submissions) };
}
