// Layout comments (docs/decisions/29-layout-comments.md): one plain-text
// comment per user per layout, every write moderated through the same queue
// pattern `core/wpm.ts` and `core/links.ts` use. `src/routes/comments.ts` is
// glue only (LDB-W1) -- every D1 statement for these verbs lives here. Rows
// are never deleted, but their text is: a delete or a removal sets `body` to
// NULL for good (LDB-CMT4), and `status` records what happened.
import { ulid } from "ulidx";
import type { Actor } from "../auth/actor";
import { invalidComment, notFound, ownComment, reviewConflict } from "./errors";
import { appendInfo, appendModeration } from "./events";
import { layoutPresent, reopenReview, type ReviewExpectation } from "./moderation-review";
import { outboxIntent } from "./outbox-intent";
import { byRef, type LayoutRow, type Source } from "./records";
import type { Clock } from "./time";
import { toStore, type StoreArg } from "../store/arg";
import type { Store } from "../store/port";

// --- the pure validator (LDB-CMT1, table-tested) --------------------------

export const MAX_COMMENT_LENGTH = 2000;

export type CommentValidation = { ok: true; body: string } | { ok: false; message: string };

// akldb is permissive: the only refusals are "not text", "nothing there" and
// "too long". Line endings are normalized to `\n` (CRLF and a lone CR), then
// the text is trimmed; the stored value is that string, byte for byte. Length
// counts Unicode code points, not UTF-16 units, so an emoji is one character.
export function validateComment(raw: unknown): CommentValidation {
  if (typeof raw !== "string") return { ok: false, message: "'body' must be a string" };
  const body = raw.replace(/\r\n?/g, "\n").trim();
  const length = [...body].length;
  if (length === 0) return { ok: false, message: "'body' must be a non-empty string" };
  if (length > MAX_COMMENT_LENGTH) return { ok: false, message: `'body' must be at most ${MAX_COMMENT_LENGTH} characters` };
  return { ok: true, body };
}

// --- rows ------------------------------------------------------------------

export type CommentStatus = "pending" | "approved" | "rejected" | "superseded" | "replaced" | "deleted" | "removed";

export interface CommentRow {
  id: string;
  layout_id: string;
  user_id: string;
  body: string | null;
  via: string;
  submitted_at: string;
  status: CommentStatus;
  decided_by: string | null;
  decided_at: string | null;
  reason: string | null;
  review_version: number;
}

// `GET /v1/admin/comment-queue` additionally names the layout and the user,
// and carries the user's current approved text so an edit can be diffed.
export interface CommentQueueRow extends CommentRow {
  layout_name: string;
  user_name: string | null; // joined from authors; null if no author row
  live_body: string | null; // the user's approved text on this layout, if any
}

// `GET /v1/layouts/:ref/comments`: one row per user, their approved comment.
export interface PublicComment {
  id: string;
  user_id: string;
  name: string | null;
  body: string;
  approved_at: string;
  edited: boolean;
  likes: number;
  liked?: boolean; // only when the caller is authenticated
  is_author: boolean; // the commenter is the layout's current owner
}

// `GET /v1/layouts/:ref/comment`: the caller's own view.
export interface OwnComment {
  live: { id: string; body: string; approved_at: string } | null;
  pending: { id: string; body: string; submitted_at: string } | null;
  // `body` is the text that was refused or taken down, kept private to the
  // author (and mods) so a client can prefill an editor to resend it.
  decision: { status: "rejected" | "removed"; reason: string | null; decided_at: string; body: string } | null;
}

function sourceOf(actor: Actor, version: string | null): Source {
  return { client: actor.source_client, version };
}

async function loadComment(store: Store, id: string): Promise<CommentRow> {
  const row = await store.comments.get(id);
  if (row === null) throw notFound(`no comment '${id}'`, id);
  return row;
}

// The layout every write route names: the usual ref resolution; a tombstone
// refuses (a deleted layout takes no new comments).
export async function resolveCommentLayout(dbArg: StoreArg, ref: string): Promise<LayoutRow> {
  const store = toStore(dbArg);
  const layout = await byRef(store, ref);
  if (layout === null || layout.deleted) throw notFound(`no layout '${ref}'`, ref);
  return layout;
}

function validated(rawBody: unknown): string {
  const v = validateComment(rawBody);
  if (!v.ok) throw invalidComment(v.message);
  return v.body;
}

// PUT /v1/layouts/:ref/comment. Everyone, an admin included: queued (`202`) --
// LDB-CMT2: a fresh pending row supersedes the same user's older pending one on
// this layout, no event for that. Nothing is approved at once; an admin
// approves it in the Inbox like any other.
export async function submitComment(
  dbArg: StoreArg,
  now: Clock,
  actor: Actor,
  version: string | null,
  layoutId: string,
  rawBody: unknown,
): Promise<CommentRow> {
  const store = toStore(dbArg);
  const body = validated(rawBody);
  const at = now();
  const id = ulid();
  await store.comments.submit({
    by: actor.user_id,
    at,
    row: { id, layout_id: layoutId, user_id: actor.user_id, body, via: actor.via, submitted_at: at },
  });

  // [LDB-CMT7] The feed is public and a pending comment is private to mods:
  // this event names the submission and nothing else -- no text.
  await appendInfo(store, now, {
    kind: "comment_submitted",
    layoutId,
    actor: actor.user_id,
    via: actor.via,
    source: sourceOf(actor, version),
    detail: { submission_id: id },
  });
  return { id, layout_id: layoutId, user_id: actor.user_id, body, via: actor.via, submitted_at: at, status: "pending", decided_by: null, decided_at: null, reason: null, review_version: 0 };
}

// DELETE /v1/layouts/:ref/comment: immediate, no review (LDB-CMT4). Every
// row of (layout, caller) that still has a text loses it; an approved or
// pending one becomes `deleted`, the rest (rejected, superseded) keep their
// status and just lose the text. `false` if none of the caller's rows there
// has a text left (nothing is written, no event); a lone rejected or
// superseded text is erased and counts.
export async function deleteOwnComment(dbArg: StoreArg, now: Clock, actor: Actor, version: string | null, layoutId: string): Promise<boolean> {
  const store = toStore(dbArg);
  if (!(await store.comments.hasBody(layoutId, actor.user_id))) return false;

  const at = now();
  await store.comments.deleteOwn({ layoutId, userId: actor.user_id, at });
  await appendInfo(store, now, {
    kind: "comment_deleted",
    layoutId,
    actor: actor.user_id,
    via: actor.via,
    source: sourceOf(actor, version),
    detail: { layout_id: layoutId, user_id: actor.user_id },
  });
  return true;
}

export type CommentQueueStatus = CommentStatus;

// GET /v1/admin/comment-queue?status=... (default pending): hides a row whose
// layout is currently a tombstone (nothing about delete touches comments --
// a pending one is simply hidden until restore).
export async function listCommentQueue(dbArg: StoreArg, status: CommentQueueStatus): Promise<CommentQueueRow[]> {
  return toStore(dbArg).comments.queue(status);
}

// POST /v1/admin/comment-queue/:id/approve: `404 not_found` if the layout is
// a tombstone (restore first) or the submission doesn't exist / isn't
// pending. One atomic batch: the user's previous approved row becomes
// `replaced` (text erased) only if this row is still pending, and this row
// is claimed (`changes === 1` wins), so two admins deciding at once can
// never both succeed and a loser never retires the live text.
export async function approveComment(dbArg: StoreArg, now: Clock, actor: Actor, version: string | null, id: string, expectedReviewVersion = 0, notifySubmitter = false): Promise<CommentRow> {
  const store = toStore(dbArg);
  const submission = await loadComment(store, id);
  if (submission.review_version !== expectedReviewVersion) throw reviewConflict(id);
  if (submission.status !== "pending") throw notFound(`comment submission '${id}' is not pending`, id);
  if (!(await layoutPresent(store, submission.layout_id, true))) throw notFound(`no layout '${submission.layout_id}'`, submission.layout_id);
  const at = now();
  const outcome = await store.comments.approve({
    id,
    layoutId: submission.layout_id,
    userId: submission.user_id,
    by: actor.user_id,
    at,
    reviewVersion: expectedReviewVersion,
    event: { kind: "comment_approved", layoutId: submission.layout_id,
      actor: actor.user_id, via: actor.via, source: sourceOf(actor, version), detail: { submission_id: submission.id, layout_id: submission.layout_id, user_id: submission.user_id } },
    ...(notifySubmitter ? { outbox: await outboxIntent({ kind: "comment", submissionId: id, layoutId: submission.layout_id, recipientId: submission.user_id, at, reviewVersion: expectedReviewVersion }, "approval") } : {}),
    history: { kind: "comment", submissionId: id, action: "approved", actor: actor.user_id, at, reason: null, reviewVersion: expectedReviewVersion },
  });
  if (!outcome.claimed) throw reviewConflict(id);
  return loadComment(store, id);
}

// POST /v1/admin/comment-queue/:id/reject: marks the submission `rejected`
// (the text is KEPT so its author can read it back with the reason) and
// appends `comment_rejected`, which names the submission and nothing else.
export async function rejectComment(dbArg: StoreArg, now: Clock, actor: Actor, version: string | null, id: string, reason?: string, options?: { notifySubmitter?: boolean; reviewVersion?: number }): Promise<CommentRow> {
  const store = toStore(dbArg);
  const submission = await loadComment(store, id);
  const expectedReviewVersion = options?.reviewVersion ?? 0;
  if (submission.review_version !== expectedReviewVersion) throw reviewConflict(id);
  if (submission.status !== "pending") throw notFound(`comment submission '${id}' is not pending`, id);
  if (!(await layoutPresent(store, submission.layout_id, false))) {
    throw notFound(`no layout '${submission.layout_id}'`, submission.layout_id);
  }
  const at = now();
  const outcome = await store.comments.reject({
    id,
    by: actor.user_id,
    at,
    reason: reason ?? null,
    reviewVersion: expectedReviewVersion,
    event: { kind: "comment_rejected", layoutId: submission.layout_id,
      actor: actor.user_id, via: actor.via, source: sourceOf(actor, version), detail: { submission_id: submission.id } },
    ...(options?.notifySubmitter === true ? { outbox: await outboxIntent({ kind: "comment", submissionId: id, layoutId: submission.layout_id, recipientId: submission.user_id, at, reviewVersion: expectedReviewVersion }, "rejection") } : {}),
    history: { kind: "comment", submissionId: id, action: "rejected", actor: actor.user_id, at, reason: reason ?? null, reviewVersion: expectedReviewVersion },
  });
  if (!outcome.claimed || !outcome.eventAppended) throw reviewConflict(id);
  return loadComment(store, id);
}

export async function reopenComment(dbArg: StoreArg, now: Clock, actor: Actor, version: string | null, id: string, expected: ReviewExpectation): Promise<CommentRow> {
  const store = toStore(dbArg);
  await reopenReview(store, now, actor, version, "comment", id, expected);
  return loadComment(store, id);
}

// POST /v1/admin/comments/:id/remove: a mod takes an approved comment down.
// `removed`: the text is KEPT, private to its author and mods exactly like a
// rejected one (so the author can edit and resend it); only the author's own
// delete erases it. `reason` kept for the author, the slot's likes cleared.
// `404` if the comment doesn't exist or isn't approved (so a removal can't be
// repeated).
export async function removeComment(dbArg: StoreArg, now: Clock, actor: Actor, version: string | null, id: string, reason?: string): Promise<CommentRow> {
  const store = toStore(dbArg);
  const comment = await loadComment(store, id);
  if (comment.status !== "approved") throw notFound(`comment '${id}' is not approved`, id);

  const res = await store.comments.remove({ id, layoutId: comment.layout_id, userId: comment.user_id, by: actor.user_id, at: now(), reason: reason ?? null, reviewVersion: comment.review_version });
  if (!res.claimed) throw notFound(`comment '${id}' is not approved`, id);

  const removed = await loadComment(store, id);
  await appendModeration(store, now, {
    kind: "comment_removed",
    layoutId: removed.layout_id,
    actor: actor.user_id,
    via: actor.via,
    source: sourceOf(actor, version),
    detail: { submission_id: removed.id, layout_id: removed.layout_id, user_id: removed.user_id },
  });
  return removed;
}

// GET /v1/layouts/:ref/comments (public). The one approved row per user
// (LDB-CMT3: the approve path keeps it at most one), most liked first (`likes`
// counts the slot's likers, LDB-CMT11; `sort=newest` leaves that out), with the
// layout's current owner's comment (`is_author`) pinned first under either sort, then
// newest approval, then id; `liked`
// (did `viewer` like it) is present only when a viewer is given. `edited` is true when that user has an earlier `replaced` row on
// this layout since their last delete or removal: a replaced row's
// `decided_at` is when it was retired, so "since" compares the retirement to
// the last time the user's thread was cut. A deleted layout lists nothing.
export type CommentSort = "likes" | "newest";
export const COMMENT_SORTS: readonly CommentSort[] = ["likes", "newest"];

// `GET /v1/comment-counts`: sparse public aggregate, with the same eligibility
// as `listComments` and no comment text or author data.
export interface PublicCommentCount {
  layout_id: string;
  layout_name: string;
  count: number;
}

export async function listCommentCounts(dbArg: StoreArg): Promise<PublicCommentCount[]> {
  return toStore(dbArg).comments.counts();
}

export async function listComments(dbArg: StoreArg, layout: LayoutRow, viewer?: string, sort: CommentSort = "likes"): Promise<PublicComment[]> {
  const store = toStore(dbArg);
  if (layout.deleted) return [];
  const results = await store.comments.list({ layoutId: layout.id, owner: layout.owner, viewer: viewer ?? "", sort });
  return results.map(({ liked, edited, is_author, ...r }) => ({ ...r, edited: edited === 1, is_author: is_author === 1, ...(viewer === undefined ? {} : { liked: liked === 1 }) }));
}

// PUT /v1/layouts/:ref/comments/:author_id/like (LDB-CMT11): idempotent. The
// target is the author's comment slot, so `404` when the slot has no approved
// comment and `400 own_comment` for the author themselves. A like that was
// already there changes nothing and appends no event.
export async function likeComment(dbArg: StoreArg, now: Clock, actor: Actor, version: string | null, layoutId: string, authorId: string): Promise<void> {
  const store = toStore(dbArg);
  if (authorId === actor.user_id) throw ownComment();
  const liked = await store.comments.like({ layoutId, authorId, userId: actor.user_id, via: actor.via, at: now() });
  if (liked) {
    await appendInfo(store, now, {
      kind: "comment_liked",
      layoutId,
      actor: actor.user_id,
      via: actor.via,
      source: sourceOf(actor, version),
      detail: { layout_id: layoutId, author_id: authorId, user_id: actor.user_id },
    });
    return;
  }
  if (!(await store.comments.approvedSlotExists(layoutId, authorId))) throw notFound(`no comment by '${authorId}' on this layout`, authorId);
}

// DELETE the same path: idempotent; an unlike that removed nothing appends no event.
export async function unlikeComment(dbArg: StoreArg, now: Clock, actor: Actor, version: string | null, layoutId: string, authorId: string): Promise<void> {
  const store = toStore(dbArg);
  if (!(await store.comments.unlike(layoutId, authorId, actor.user_id))) return;
  await appendInfo(store, now, {
    kind: "comment_unliked",
    layoutId,
    actor: actor.user_id,
    via: actor.via,
    source: sourceOf(actor, version),
    detail: { layout_id: layoutId, author_id: authorId, user_id: actor.user_id },
  });
}

// GET /v1/layouts/:ref/comment (the caller's own). `decision` is the
// caller's newest rejection or removal, shown only when it is newer than
// both their live and pending rows -- and than their last delete; a rejected
// row whose text the author erased is no verdict either, so a comment they
// erased themselves doesn't keep announcing an old rejection. `decision.body`
// is the refused or removed text itself.
export async function readOwnComment(dbArg: StoreArg, layoutId: string, userId: string): Promise<OwnComment> {
  return deriveOwn(await toStore(dbArg).comments.pairRows(layoutId, userId));
}

// The rules of the own read over one slot's rows (oldest first), shared by the
// per-layout read and `GET /v1/me/comments`.
function deriveOwn(results: CommentRow[]): OwnComment {
  const approved = results.filter((r) => r.status === "approved" && r.body !== null).at(-1);
  const pending = results.filter((r) => r.status === "pending" && r.body !== null).at(-1);
  const live = approved === undefined ? null : { id: approved.id, body: approved.body!, approved_at: approved.decided_at! };
  const pend = pending === undefined ? null : { id: pending.id, body: pending.body!, submitted_at: pending.submitted_at };

  const lastDelete = results.filter((r) => r.status === "deleted").reduce<string>((m, r) => (r.decided_at !== null && r.decided_at > m ? r.decided_at : m), "");
  const verdict = results
    .filter((r) => (r.status === "rejected" || r.status === "removed") && r.body !== null && r.decided_at !== null)
    .reduce<CommentRow | undefined>((best, r) => (best === undefined || r.decided_at! > best.decided_at! ? r : best), undefined);
  let decision: OwnComment["decision"] = null;
  if (verdict !== undefined) {
    const at = verdict.decided_at!;
    if (at > lastDelete && (live === null || at > live.approved_at) && (pend === null || at > pend.submitted_at)) {
      decision = { status: verdict.status as "rejected" | "removed", reason: verdict.reason, decided_at: at, body: verdict.body! };
    }
  }
  return { live, pending: pend, decision };
}

// `GET /v1/me/comments`: one row per layout where the caller has a live,
// pending or kept (rejected/removed) text.
export interface MyComment {
  layout_id: string;
  layout_name: string;
  is_author: boolean; // the caller is the layout's current owner (same rule as the list's `is_author`)
  live: (NonNullable<OwnComment["live"]> & { likes: number }) | null;
  pending: OwnComment["pending"];
  decision: OwnComment["decision"];
}

// Capped, not paginated (there is no /v1/me list precedent): the 500 most
// recently active slots.
export const MY_COMMENTS_LIMIT = 500;

// Every slot the caller has with text on a layout that is not a tombstone, most
// recent activity first (the latest of `approved_at`, `submitted_at` of the
// pending text and `decided_at` of the decision), then `layout_id`. The same
// rules as `readOwnComment` decide what each slot shows; a slot with nothing
// to show (erased, superseded, replaced only) is absent. Private to the caller.
export async function listMyComments(dbArg: StoreArg, userId: string): Promise<MyComment[]> {
  const { rows: results, likeCounts: likes } = await toStore(dbArg).comments.mine(userId);

  const byLayout = new Map<string, (CommentRow & { layout_name: string; layout_owner: string })[]>();
  for (const r of results) {
    const list = byLayout.get(r.layout_id);
    if (list === undefined) byLayout.set(r.layout_id, [r]);
    else list.push(r);
  }
  const out: { row: MyComment; at: string }[] = [];
  for (const [layoutId, rows] of byLayout) {
    const own = deriveOwn(rows);
    if (own.live === null && own.pending === null && own.decision === null) continue;
    const at = [own.live?.approved_at, own.pending?.submitted_at, own.decision?.decided_at].filter((x): x is string => x !== undefined).reduce((m, x) => (x > m ? x : m), "");
    out.push({
      at,
      row: { layout_id: layoutId, layout_name: rows[0]!.layout_name, is_author: rows[0]!.layout_owner === userId, live: own.live === null ? null : { ...own.live, likes: likes.get(layoutId) ?? 0 }, pending: own.pending, decision: own.decision },
    });
  }
  out.sort((a, b) => (a.at === b.at ? (a.row.layout_id < b.row.layout_id ? -1 : 1) : a.at < b.at ? 1 : -1));
  return out.slice(0, MY_COMMENTS_LIMIT).map((x) => x.row);
}
