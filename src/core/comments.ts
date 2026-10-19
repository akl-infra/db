// Layout comments (docs/decisions/29-layout-comments.md): one plain-text
// comment per user per layout, every write moderated through the same queue
// pattern `core/wpm.ts` and `core/links.ts` use. `src/routes/comments.ts` is
// glue only (LDB-W1) -- every D1 statement for these verbs lives here. Rows
// are never deleted, but their text is: a delete or a removal sets `body` to
// NULL for good (LDB-CMT4), and `status` records what happened.
import { ulid } from "ulidx";
import type { Actor } from "../auth/actor";
import type { Bindings } from "../env";
import { invalidComment, notFound, ownComment } from "./errors";
import { appendInfo, appendModeration } from "./events";
import { byRef, type LayoutRow, type Source } from "./records";
import type { Clock } from "./time";

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

// [LDB-CMT9] The explicit column list (never `SELECT *`) keeps
// `notified_at` -- the mod-queue notifier's claim bookkeeping,
// `core/modqueue.ts` -- off every wire these rows reach.
const COMMENT_COLUMNS = "id, layout_id, user_id, body, via, submitted_at, status, decided_by, decided_at, reason";

async function loadComment(db: Bindings["DB"], id: string): Promise<CommentRow> {
  const row = await db.prepare(`SELECT ${COMMENT_COLUMNS} FROM layout_comments WHERE id = ?`).bind(id).first<CommentRow>();
  if (row === null) throw notFound(`no comment '${id}'`, id);
  return row;
}

// The layout every write route names: the usual ref resolution; a tombstone
// refuses (a deleted layout takes no new comments).
export async function resolveCommentLayout(db: Bindings["DB"], ref: string): Promise<LayoutRow> {
  const layout = await byRef(db, ref);
  if (layout === null || layout.deleted) throw notFound(`no layout '${ref}'`, ref);
  return layout;
}

function validated(rawBody: unknown): string {
  const v = validateComment(rawBody);
  if (!v.ok) throw invalidComment(v.message);
  return v.body;
}

// [LDB-CMT7] The one place `comment_approved` is written. The event names
// the submission, layout and user and NEVER the text: the public feed must
// not keep a comment that is later deleted or removed.
async function appendApproved(db: Bindings["DB"], now: Clock, actor: Actor, version: string | null, c: Pick<CommentRow, "id" | "layout_id" | "user_id">): Promise<void> {
  await appendModeration(db, now, {
    kind: "comment_approved",
    layoutId: c.layout_id,
    actor: actor.user_id,
    via: actor.via,
    source: sourceOf(actor, version),
    detail: { submission_id: c.id, layout_id: c.layout_id, user_id: c.user_id },
  });
}

// [LDB-CMT11] A slot's likes live exactly as long as the slot has an approved
// comment: cleared when the slot no longer has one (the author's delete, a
// mod's removal). Conditional on that, so a statement that follows a decision
// which did not happen (a lost race) clears nothing. A pending or rejected
// edit leaves them, and an approved edit replaces the row inside the slot.
function clearLikesOfEmptySlot(db: Bindings["DB"], layoutId: string, authorId: string): D1PreparedStatement {
  return db
    .prepare(
      `DELETE FROM comment_likes WHERE layout_id = ? AND author_id = ?
       AND NOT EXISTS (SELECT 1 FROM layout_comments WHERE layout_id = ? AND user_id = ? AND status = 'approved')`,
    )
    .bind(layoutId, authorId, layoutId, authorId);
}

// PUT /v1/layouts/:ref/comment. Everyone, an admin included: queued (`202`) --
// LDB-CMT2: a fresh pending row supersedes the same user's older pending one on
// this layout, no event for that. Nothing is approved at once; an admin
// approves it in the Inbox like any other.
export async function submitComment(
  db: Bindings["DB"],
  now: Clock,
  actor: Actor,
  version: string | null,
  layoutId: string,
  rawBody: unknown,
): Promise<CommentRow> {
  const body = validated(rawBody);
  const at = now();
  const id = ulid();
  const supersede = db
    .prepare("UPDATE layout_comments SET status = 'superseded', decided_by = ?, decided_at = ? WHERE layout_id = ? AND user_id = ? AND status = 'pending'")
    .bind(actor.user_id, at, layoutId, actor.user_id);

  await db.batch([
    supersede,
    db
      .prepare(
        `INSERT INTO layout_comments (id, layout_id, user_id, body, via, submitted_at, status, decided_by, decided_at, reason)
         VALUES (?, ?, ?, ?, ?, ?, 'pending', NULL, NULL, NULL)`,
      )
      .bind(id, layoutId, actor.user_id, body, actor.via, at),
  ]);

  // [LDB-CMT7] The feed is public and a pending comment is private to mods:
  // this event names the submission and nothing else -- no text.
  await appendInfo(db, now, {
    kind: "comment_submitted",
    layoutId,
    actor: actor.user_id,
    via: actor.via,
    source: sourceOf(actor, version),
    detail: { submission_id: id },
  });
  return { id, layout_id: layoutId, user_id: actor.user_id, body, via: actor.via, submitted_at: at, status: "pending", decided_by: null, decided_at: null, reason: null };
}

// DELETE /v1/layouts/:ref/comment: immediate, no review (LDB-CMT4). Every
// row of (layout, caller) that still has a text loses it; an approved or
// pending one becomes `deleted`, the rest (rejected, superseded) keep their
// status and just lose the text. `false` if none of the caller's rows there
// has a text left (nothing is written, no event); a lone rejected or
// superseded text is erased and counts.
export async function deleteOwnComment(db: Bindings["DB"], now: Clock, actor: Actor, version: string | null, layoutId: string): Promise<boolean> {
  const live = await db
    .prepare("SELECT 1 AS one FROM layout_comments WHERE layout_id = ? AND user_id = ? AND body IS NOT NULL LIMIT 1")
    .bind(layoutId, actor.user_id)
    .first();
  if (live === null) return false;

  const at = now();
  await db.batch([
    db
      .prepare(
        `UPDATE layout_comments
         SET body = NULL, status = 'deleted', decided_by = ?, decided_at = ?
         WHERE layout_id = ? AND user_id = ? AND status IN ('approved', 'pending')`,
      )
      .bind(actor.user_id, at, layoutId, actor.user_id),
    db.prepare("UPDATE layout_comments SET body = NULL WHERE layout_id = ? AND user_id = ? AND body IS NOT NULL").bind(layoutId, actor.user_id),
    clearLikesOfEmptySlot(db, layoutId, actor.user_id),
  ]);
  await appendInfo(db, now, {
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
export async function listCommentQueue(db: Bindings["DB"], status: CommentQueueStatus): Promise<CommentQueueRow[]> {
  const cols = COMMENT_COLUMNS.split(", ")
    .map((c) => `s.${c}`)
    .join(", ");
  const { results } = await db
    .prepare(
      `SELECT ${cols}, l.name AS layout_name, a.name AS user_name,
              (SELECT b.body FROM layout_comments b
               WHERE b.layout_id = s.layout_id AND b.user_id = s.user_id AND b.status = 'approved' AND b.id != s.id
               ORDER BY b.decided_at DESC, b.id ASC LIMIT 1) AS live_body
       FROM layout_comments s
       JOIN layouts l ON l.id = s.layout_id
       LEFT JOIN authors a ON a.user_id = s.user_id
       WHERE s.status = ? AND l.deleted = 0
       ORDER BY s.submitted_at ASC, s.id ASC`,
    )
    .bind(status)
    .all<CommentQueueRow>();
  return results;
}

// POST /v1/admin/comment-queue/:id/approve: `404 not_found` if the layout is
// a tombstone (restore first) or the submission doesn't exist / isn't
// pending. One atomic batch: the user's previous approved row becomes
// `replaced` (text erased) only if this row is still pending, and this row
// is claimed (`changes === 1` wins), so two admins deciding at once can
// never both succeed and a loser never retires the live text.
export async function approveComment(db: Bindings["DB"], now: Clock, actor: Actor, version: string | null, id: string): Promise<CommentRow> {
  const submission = await loadComment(db, id);
  if (submission.status !== "pending") throw notFound(`comment '${id}' is not pending`, id);
  const layout = await db.prepare("SELECT id FROM layouts WHERE id = ? AND deleted = 0").bind(submission.layout_id).first();
  if (layout === null) throw notFound(`no layout '${submission.layout_id}'`, submission.layout_id);

  const at = now();
  const [, claim] = await db.batch([
    db
      .prepare(
        `UPDATE layout_comments SET status = 'replaced', body = NULL, decided_by = ?, decided_at = ?
         WHERE layout_id = ? AND user_id = ? AND status = 'approved' AND id != ?
           AND EXISTS (SELECT 1 FROM layout_comments WHERE id = ? AND status = 'pending')`,
      )
      .bind(actor.user_id, at, submission.layout_id, submission.user_id, id, id),
    db
      .prepare("UPDATE layout_comments SET status = 'approved', decided_by = ?, decided_at = ?, reason = NULL WHERE id = ? AND status = 'pending'")
      .bind(actor.user_id, at, id),
  ]);
  if (claim!.meta.changes !== 1) throw notFound(`comment '${id}' is not pending`, id);

  const approved = await loadComment(db, id);
  await appendApproved(db, now, actor, version, approved);
  return approved;
}

// POST /v1/admin/comment-queue/:id/reject: marks the submission `rejected`
// (the text is KEPT so its author can read it back with the reason) and
// appends `comment_rejected`, which names the submission and nothing else.
export async function rejectComment(db: Bindings["DB"], now: Clock, actor: Actor, version: string | null, id: string, reason?: string): Promise<CommentRow> {
  const submission = await loadComment(db, id);
  if (submission.status !== "pending") throw notFound(`comment '${id}' is not pending`, id);

  const res = await db
    .prepare("UPDATE layout_comments SET status = 'rejected', decided_by = ?, decided_at = ?, reason = ? WHERE id = ? AND status = 'pending'")
    .bind(actor.user_id, now(), reason ?? null, id)
    .run();
  if (res.meta.changes !== 1) throw notFound(`comment '${id}' is not pending`, id);

  const rejected = await loadComment(db, id);
  await appendModeration(db, now, {
    kind: "comment_rejected",
    layoutId: rejected.layout_id,
    actor: actor.user_id,
    via: actor.via,
    source: sourceOf(actor, version),
    detail: { submission_id: rejected.id },
  });
  return rejected;
}

// POST /v1/admin/comments/:id/remove: a mod takes an approved comment down.
// `removed`: the text is KEPT, private to its author and mods exactly like a
// rejected one (so the author can edit and resend it); only the author's own
// delete erases it. `reason` kept for the author, the slot's likes cleared.
// `404` if the comment doesn't exist or isn't approved (so a removal can't be
// repeated).
export async function removeComment(db: Bindings["DB"], now: Clock, actor: Actor, version: string | null, id: string, reason?: string): Promise<CommentRow> {
  const comment = await loadComment(db, id);
  if (comment.status !== "approved") throw notFound(`comment '${id}' is not approved`, id);

  const [res] = await db.batch([
    db
      .prepare("UPDATE layout_comments SET status = 'removed', decided_by = ?, decided_at = ?, reason = ? WHERE id = ? AND status = 'approved'")
      .bind(actor.user_id, now(), reason ?? null, id),
    clearLikesOfEmptySlot(db, comment.layout_id, comment.user_id),
  ]);
  if (res!.meta.changes !== 1) throw notFound(`comment '${id}' is not approved`, id);

  const removed = await loadComment(db, id);
  await appendModeration(db, now, {
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

export async function listCommentCounts(db: Bindings["DB"]): Promise<PublicCommentCount[]> {
  const { results } = await db
    .prepare(
      `SELECT l.id AS layout_id, l.name AS layout_name, COUNT(*) AS count
       FROM layouts l
       JOIN layout_comments c ON c.layout_id = l.id
       WHERE l.deleted = 0 AND c.status = 'approved' AND c.body IS NOT NULL
       GROUP BY l.id, l.name
       ORDER BY l.name COLLATE NOCASE ASC, l.id ASC`,
    )
    .all<PublicCommentCount>();
  return results;
}

export async function listComments(db: Bindings["DB"], layout: LayoutRow, viewer?: string, sort: CommentSort = "likes"): Promise<PublicComment[]> {
  if (layout.deleted) return [];
  const { results } = await db
    .prepare(
      `SELECT c.id AS id, c.user_id AS user_id, a.name AS name, c.body AS body, c.decided_at AS approved_at,
              EXISTS (
                SELECT 1 FROM layout_comments r
                WHERE r.layout_id = c.layout_id AND r.user_id = c.user_id AND r.status = 'replaced'
                  AND r.decided_at > COALESCE(
                    (SELECT MAX(d.decided_at) FROM layout_comments d
                     WHERE d.layout_id = c.layout_id AND d.user_id = c.user_id AND d.status IN ('deleted', 'removed')),
                    '')
              ) AS edited,
              (SELECT COUNT(*) FROM comment_likes k WHERE k.layout_id = c.layout_id AND k.author_id = c.user_id) AS likes,
              EXISTS (SELECT 1 FROM comment_likes k WHERE k.layout_id = c.layout_id AND k.author_id = c.user_id AND k.user_id = ?) AS liked,
              (c.user_id = ?) AS is_author
       FROM layout_comments c
       LEFT JOIN authors a ON a.user_id = c.user_id
       WHERE c.layout_id = ? AND c.status = 'approved' AND c.body IS NOT NULL
       ORDER BY is_author DESC, ${sort === "newest" ? "" : "likes DESC, "}c.decided_at DESC, c.id ASC`,
    )
    .bind(viewer ?? "", layout.owner, layout.id)
    .all<Omit<PublicComment, "edited" | "liked" | "is_author"> & { edited: number; liked: number; is_author: number }>();
  return results.map(({ liked, edited, is_author, ...r }) => ({ ...r, edited: edited === 1, is_author: is_author === 1, ...(viewer === undefined ? {} : { liked: liked === 1 }) }));
}

// PUT /v1/layouts/:ref/comments/:author_id/like (LDB-CMT11): idempotent. The
// target is the author's comment slot, so `404` when the slot has no approved
// comment and `400 own_comment` for the author themselves. A like that was
// already there changes nothing and appends no event.
export async function likeComment(db: Bindings["DB"], now: Clock, actor: Actor, version: string | null, layoutId: string, authorId: string): Promise<void> {
  if (authorId === actor.user_id) throw ownComment();
  const res = await db
    .prepare(
      `INSERT INTO comment_likes (layout_id, author_id, user_id, via, created_at)
       SELECT ?, ?, ?, ?, ?
       WHERE EXISTS (SELECT 1 FROM layout_comments WHERE layout_id = ? AND user_id = ? AND status = 'approved' AND body IS NOT NULL)
       ON CONFLICT (layout_id, author_id, user_id) DO NOTHING`,
    )
    .bind(layoutId, authorId, actor.user_id, actor.via, now(), layoutId, authorId)
    .run();
  if (res.meta.changes === 1) {
    await appendInfo(db, now, {
      kind: "comment_liked",
      layoutId,
      actor: actor.user_id,
      via: actor.via,
      source: sourceOf(actor, version),
      detail: { layout_id: layoutId, author_id: authorId, user_id: actor.user_id },
    });
    return;
  }
  const slot = await db
    .prepare("SELECT 1 AS one FROM layout_comments WHERE layout_id = ? AND user_id = ? AND status = 'approved' AND body IS NOT NULL LIMIT 1")
    .bind(layoutId, authorId)
    .first();
  if (slot === null) throw notFound(`no comment by '${authorId}' on this layout`, authorId);
}

// DELETE the same path: idempotent; an unlike that removed nothing appends no event.
export async function unlikeComment(db: Bindings["DB"], now: Clock, actor: Actor, version: string | null, layoutId: string, authorId: string): Promise<void> {
  const res = await db.prepare("DELETE FROM comment_likes WHERE layout_id = ? AND author_id = ? AND user_id = ?").bind(layoutId, authorId, actor.user_id).run();
  if (res.meta.changes !== 1) return;
  await appendInfo(db, now, {
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
export async function readOwnComment(db: Bindings["DB"], layoutId: string, userId: string): Promise<OwnComment> {
  const { results } = await db
    .prepare(`SELECT ${COMMENT_COLUMNS} FROM layout_comments WHERE layout_id = ? AND user_id = ? ORDER BY submitted_at ASC, id ASC`)
    .bind(layoutId, userId)
    .all<CommentRow>();
  return deriveOwn(results);
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
export async function listMyComments(db: Bindings["DB"], userId: string): Promise<MyComment[]> {
  const cols = COMMENT_COLUMNS.split(", ").map((c) => `s.${c}`).join(", ");
  const { results } = await db
    .prepare(
      `SELECT ${cols}, l.name AS layout_name, l.owner AS layout_owner
       FROM layout_comments s
       JOIN layouts l ON l.id = s.layout_id AND l.deleted = 0
       WHERE s.user_id = ?
       ORDER BY s.layout_id ASC, s.submitted_at ASC, s.id ASC`,
    )
    .bind(userId)
    .all<CommentRow & { layout_name: string; layout_owner: string }>();
  const likeCounts = await db
    .prepare("SELECT layout_id, COUNT(*) AS n FROM comment_likes WHERE author_id = ? GROUP BY layout_id")
    .bind(userId)
    .all<{ layout_id: string; n: number }>();
  const likes = new Map(likeCounts.results.map((r) => [r.layout_id, r.n]));

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
