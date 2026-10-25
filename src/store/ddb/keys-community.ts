// Key builders for lane J's areas (links, WPM, comments, review history;
// design/aws-port.md §2.3). Every partition below names the D1 index or query
// it replaces. Lane K builds against `subKey` (the submission rows) and the
// outbox/MQN shapes at the bottom; lane G's link approve/clear uses the link
// helpers in ./links.ts. Numbers in sort keys follow ./keys.ts.
import { padOrdinal, type Key } from "./keys";

export type SubmissionKind = "link" | "wpm" | "comment";

/** One submission row: `link_submissions`, `wpm_submissions` or `layout_comments`, all D1 columns flat (nulls kept). */
export function subKey(kind: SubmissionKind, id: string): Key {
  return { pk: `SUB#${kind}#${id}`, sk: "ROW" };
}

// ---- links ---------------------------------------------------------------

/** Replaces `link_submissions_status`: the queue by status, oldest first. */
export function linkStatusKey(status: string, submittedAt: string, id: string): Key {
  return { pk: `IX#link#st#${status}`, sk: `${submittedAt}#${id}` };
}

/** Replaces `link_submissions_layout`: a layout's submissions by status (the newest pending one is the last `pending#` item). */
export function linkLayoutKey(layoutId: string, status: string, submittedAt: string, id: string): Key {
  return { pk: `IX#link#lay#${layoutId}`, sk: `${status}#${submittedAt}#${id}` };
}

// ---- WPM -----------------------------------------------------------------

/** Replaces `wpm_submissions_status`. */
export function wpmStatusKey(status: string, submittedAt: string, id: string): Key {
  return { pk: `IX#wpm#st#${status}`, sk: `${submittedAt}#${id}` };
}

/** Replaces the supersede lookup of `wpm_submissions_user` / `_best`: one (layout, user) pair's rows by status. */
export function wpmPairKey(layoutId: string, userId: string, status: string, id: string): Key {
  return { pk: `IX#wpm#pair#${layoutId}#${userId}`, sk: `${status}#${id}` };
}

/** Replaces `wpm_submissions_best` (GET /v1/wpm): the approved rows, projected with wpm/proof/decided_at. */
export function wpmOkKey(layoutId: string, userId: string, id: string): Key {
  return { pk: "IX#wpm#ok", sk: `${layoutId}#${userId}#${id}` };
}

// ---- comments ------------------------------------------------------------

/** Replaces `layout_comments_status`. */
export function commentStatusKey(status: string, submittedAt: string, id: string): Key {
  return { pk: `IX#cmt#st#${status}`, sk: `${submittedAt}#${id}` };
}

/** Replaces `layout_comments_user`: every row of one (layout, user), submitted_at then id, projected with status/decided_at/has_body. */
export function commentPairKey(layoutId: string, userId: string, submittedAt: string, id: string): Key {
  return { pk: `IX#cmt#pair#${layoutId}#${userId}`, sk: `${submittedAt}#${id}` };
}

/** Replaces `layout_comments_approved`: a layout's approved rows with text, by decided_at. */
export function commentOkKey(layoutId: string, decidedAt: string, id: string): Key {
  return { pk: `IX#cmt#ok#${layoutId}`, sk: `${decidedAt}#${id}` };
}

/** Everything one user wrote (`mine`), by layout then submitted_at. */
export function commentUserKey(userId: string, layoutId: string, submittedAt: string, id: string): Key {
  return { pk: `IX#cmt#user#${userId}`, sk: `${layoutId}#${submittedAt}#${id}` };
}

/** Counter (R4) replacing `COUNT(*) ... GROUP BY layout` of GET /v1/comment-counts: `count` of approved rows with text; exists for every layout with a comment row. */
export function commentCountKey(layoutId: string): Key {
  return { pk: "CC", sk: layoutId };
}

/** `comment_likes` primary: all likes of a layout in one partition (list = one Query), sk `<author>#<liker>`. */
export function commentLikeKey(layoutId: string, authorId: string, userId: string): Key {
  return { pk: `CL#${layoutId}`, sk: `${authorId}#${userId}` };
}

export function commentLikesOfSlotPrefix(layoutId: string, authorId: string): Key {
  return { pk: `CL#${layoutId}`, sk: `${authorId}#` };
}

/** Replaces `comment_likes_user`'s per-author use: likes received by an author, `<layout>#<liker>` (the `mine` like counts). */
export function commentLikeByAuthorKey(authorId: string, layoutId: string, userId: string): Key {
  return { pk: `CLA#${authorId}`, sk: `${layoutId}#${userId}` };
}

// ---- guards (R5) ---------------------------------------------------------

/** Set-version guard of a layout's link submissions: `ver` = number of rows. */
export function linkGuardKey(layoutId: string): Key {
  return { pk: `L#${layoutId}`, sk: "SET#link" };
}

/** Guard of one WPM pair: `ver` = rows + sum of review_version. */
export function wpmGuardKey(layoutId: string, userId: string): Key {
  return { pk: `L#${layoutId}`, sk: `SET#wpm#${userId}` };
}

/** Guard of one comment pair: `ver` = rows + sum of review_version. */
export function commentGuardKey(layoutId: string, userId: string): Key {
  return { pk: `L#${layoutId}`, sk: `SET#cmt#${userId}` };
}

/** Guard of one comment slot's likes: `ver` = number of likes; absent when there are none. */
export function commentLikeGuardKey(layoutId: string, authorId: string): Key {
  return { pk: `L#${layoutId}`, sk: `SET#cl#${authorId}` };
}

// ---- review history ------------------------------------------------------

/** `moderation_review_history`: the n-th entry of one submission (n replaces the global AUTOINCREMENT, which only ordered within a submission). */
export function historyKey(kind: "comment" | "wpm", submissionId: string, n: number): Key {
  return { pk: `SUB#${kind}#${submissionId}`, sk: `H#${padOrdinal(n)}` };
}

export function historyPrefix(kind: "comment" | "wpm", submissionId: string): Key {
  return { pk: `SUB#${kind}#${submissionId}`, sk: "H#" };
}

/** The UNIQUE (kind, submission_id, review_version, action) claim (R3). */
export function historyClaimKey(kind: "comment" | "wpm", submissionId: string, reviewVersion: number, action: string): Key {
  return { pk: `SUB#${kind}#${submissionId}`, sk: `HK#${reviewVersion}#${action}` };
}

// ---- lane K's shapes that lane J writes inside decisions (pinned, see keys-discord.ts once it lands) ----

export function outboxRowKey(deliveryKey: string): Key {
  return { pk: `DMO#${deliveryKey}`, sk: "ROW" };
}
export function outboxSeqClaimKey(eventSeq: number): Key {
  return { pk: `DMO#seq#${eventSeq}`, sk: "CLAIM" };
}
export function outboxNonceClaimKey(nonce: string): Key {
  return { pk: `DMO#nonce#${nonce}`, sk: "CLAIM" };
}
/** Due index: pending/leased rows, `<status>#<next_attempt_at>#<delivery_key>`. */
export function outboxDueKey(status: string, nextAttemptAt: string, deliveryKey: string): Key {
  return { pk: "IX#dmo#due", sk: `${status}#${nextAttemptAt}#${deliveryKey}` };
}
/** Mod-queue notification dirty mark: every submission state change puts one. */
export function mqnDirtyKey(kind: SubmissionKind, submissionId: string): Key {
  return { pk: "IX#mqn#dirty", sk: `${kind}#${submissionId}` };
}
