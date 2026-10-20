// WPM records (docs/decisions/28-wpm-records.md): a user's best typing
// speed on a layout, submitted with a proof link and moderated through the
// same queue pattern `core/links.ts` uses. `src/routes/wpm.ts` is glue
// only (LDB-W1) -- every D1 statement for these verbs lives here. Rows are
// never deleted: `status` is the only thing that moves, so a proof stays
// reviewable forever (LDB-WPM2).
import { ulid } from "ulidx";
import type { Actor } from "../auth/actor";
import type { Bindings } from "../env";
import { badRequest, invalidProof, invalidWpm, notFound, reviewConflict } from "./errors";
import { appendInfo, rejectionModerationStatement } from "./events";
import { reopenReview, reviewHistoryStatement, type ReviewExpectation } from "./moderation-review";
import { rejectionOutboxStatement } from "./rejection-dm";
import { byRef, type LayoutRow, type Source } from "./records";
import { verifyDiscordProofAuthor, type DiscordProofAccess } from "./modqueue-proof";
import type { Clock } from "./time";

// --- the pure validators (LDB-WPM1, table-tested) -----------------------

export const MIN_WPM = 1;
export const MAX_WPM = 1000;
export const MAX_PROOF_LENGTH = 512;

export type WpmValidation = { ok: true; wpm: number } | { ok: false; message: string };
export type ProofValidation = { ok: true; proof: string } | { ok: false; message: string };

// akldb is permissive about what a plausible speed is (clients and mods
// judge that); it only refuses what is not a speed at all.
export function validateWpm(raw: unknown): WpmValidation {
  if (typeof raw !== "number" || !Number.isInteger(raw)) return { ok: false, message: "'wpm' must be an integer" };
  if (raw < MIN_WPM || raw > MAX_WPM) return { ok: false, message: `'wpm' must be between ${MIN_WPM} and ${MAX_WPM}` };
  return { ok: true, wpm: raw };
}

// Any absolute http(s) URL with a host -- not restricted to Discord (a
// video, a monkeytype result page, ...). Trimmed first; the stored value is
// the trimmed string, byte for byte.
export function validateProof(raw: unknown): ProofValidation {
  if (typeof raw !== "string") return { ok: false, message: "'proof' must be a string" };
  const proof = raw.trim();
  if (proof.length === 0) return { ok: false, message: "'proof' must be a non-empty string" };
  if (proof.length > MAX_PROOF_LENGTH) return { ok: false, message: `'proof' must be at most ${MAX_PROOF_LENGTH} characters` };
  let parsed: URL;
  try {
    parsed = new URL(proof);
  } catch {
    return { ok: false, message: `'${proof}' is not a valid URL` };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return { ok: false, message: "'proof' must use http: or https:" };
  if (!/^https?:\/\//i.test(proof) || parsed.hostname === "") return { ok: false, message: "'proof' must be an absolute URL with a host" };
  return { ok: true, proof };
}

// A Discord user id: 17-20 digits. Checked only where an id is accepted
// without an `authors` row to prove it (the admin on-behalf entry).
const SNOWFLAKE = /^\d{17,20}$/;
export function validateUserId(raw: unknown, param: string): string {
  if (typeof raw !== "string" || !SNOWFLAKE.test(raw)) throw badRequest(`'${param}' must be a Discord user id (17-20 digits)`, param);
  return raw;
}

// --- rows ----------------------------------------------------------------

export type WpmStatus = "pending" | "approved" | "rejected" | "superseded";

export interface WpmSubmissionRow {
  id: string;
  layout_id: string;
  user_id: string;
  wpm: number;
  proof: string;
  submitted_by: string;
  via: string;
  submitted_at: string;
  status: WpmStatus;
  decided_by: string | null;
  decided_at: string | null;
  reason: string | null;
  review_version: number;
}

// `GET /v1/admin/wpm-queue` additionally names the layout and the user.
export interface WpmQueueRow extends WpmSubmissionRow {
  layout_name: string;
  user_name: string | null; // joined from authors; null if no author row
}

// `GET /v1/wpm`: one row per (layout, user), the user's best approved speed.
export interface WpmRecord {
  layout_id: string;
  layout_name: string;
  user_id: string;
  user_name: string | null;
  wpm: number;
  proof: string;
  approved_at: string;
  submission_id: string;
}

function sourceOf(actor: Actor, version: string | null): Source {
  return { client: actor.source_client, version };
}

// [LDB-WPM9] The explicit column list (never `SELECT *`) keeps
// `notified_at` -- the mod-queue notifier's claim bookkeeping,
// `core/modqueue.ts` -- off every wire these rows reach.
const SUBMISSION_COLUMNS = "id, layout_id, user_id, wpm, proof, submitted_by, via, submitted_at, status, decided_by, decided_at, reason, review_version";

async function loadSubmission(db: Bindings["DB"], id: string): Promise<WpmSubmissionRow> {
  const row = await db.prepare(`SELECT ${SUBMISSION_COLUMNS} FROM wpm_submissions WHERE id = ?`).bind(id).first<WpmSubmissionRow>();
  if (row === null) throw notFound(`no wpm submission '${id}'`, id);
  return row;
}

export type WpmSubmissionStatus = Pick<WpmSubmissionRow, "id" | "status" | "reason" | "review_version">;

// [LDB-WPM16] Clients can follow their own submissions without gaining
// access to the queue or exposing private decision reasons in the feed.
export async function readWpmSubmissionStatus(db: Bindings["DB"], actor: Actor, id: string): Promise<WpmSubmissionStatus> {
  const submission = await loadSubmission(db, id);
  if (!actor.admin && actor.user_id !== submission.user_id && actor.user_id !== submission.submitted_by) {
    throw notFound(`no wpm submission '${id}'`, id);
  }
  return { id: submission.id, status: submission.status, reason: submission.reason, review_version: submission.review_version };
}

// The layout every submission route names: the usual ref resolution; a
// tombstone refuses (a deleted layout takes no new records).
export async function resolveWpmLayout(db: Bindings["DB"], ref: string): Promise<LayoutRow> {
  const layout = await byRef(db, ref);
  if (layout === null || layout.deleted) throw notFound(`no layout '${ref}'`, ref);
  return layout;
}

function validated(rawWpm: unknown, rawProof: unknown): { wpm: number; proof: string } {
  const w = validateWpm(rawWpm);
  if (!w.ok) throw invalidWpm(w.message);
  const p = validateProof(rawProof);
  if (!p.ok) throw invalidProof(p.message);
  return { wpm: w.wpm, proof: p.proof };
}

// Inserts an already-approved row and appends its `wpm_approved` event: the
// admin's own speed through the user route, and the on-behalf entry.
async function insertApproved(
  db: Bindings["DB"],
  now: Clock,
  actor: Actor,
  version: string | null,
  layoutId: string,
  userId: string,
  wpm: number,
  proof: string,
): Promise<WpmSubmissionRow> {
  const at = now();
  const id = ulid();
  await db.batch([
    db.prepare(`INSERT INTO wpm_submissions (id, layout_id, user_id, wpm, proof, submitted_by, via, submitted_at, status, decided_by, decided_at, reason)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'approved', ?, ?, NULL)`)
      .bind(id, layoutId, userId, wpm, proof, actor.user_id, actor.via, at, actor.user_id, at),
    rejectionModerationStatement(db, at, { kind: "wpm_approved", layoutId, actor: actor.user_id,
      via: actor.via, source: sourceOf(actor, version), detail: { submission_id: id, user_id: userId, wpm, proof } }),
    reviewHistoryStatement(db, "wpm", id, "approved", actor.user_id, at, null, 0),
  ]);
  return { id, layout_id: layoutId, user_id: userId, wpm, proof, submitted_by: actor.user_id, via: actor.via, submitted_at: at, status: "approved", decided_by: actor.user_id, decided_at: at, reason: null, review_version: 0 };
}

// POST /v1/wpm. Everyone, an admin included: queued (`202`) -- LDB-WPM2: a
// fresh pending submission supersedes the same user's older pending one for
// this layout, no event for that. No short circuit for mods (saltorbit,
// API 1.23): an admin's OWN speed is approved in the Inbox like anyone's;
// only `POST /v1/admin/wpm` (an explicit entry for someone else) is approved
// at once.
export async function submitWpm(
  db: Bindings["DB"],
  now: Clock,
  actor: Actor,
  version: string | null,
  layoutId: string,
  rawWpm: unknown,
  rawProof: unknown,
  proofAccess: DiscordProofAccess,
): Promise<WpmSubmissionRow> {
  const { wpm, proof } = validated(rawWpm, rawProof);
  await verifyDiscordProofAuthor(proof, actor.user_id, proofAccess);

  const at = now();
  const id = ulid();
  await db.batch([
    db
      .prepare("UPDATE wpm_submissions SET status = 'superseded', decided_by = ?, decided_at = ? WHERE layout_id = ? AND user_id = ? AND status = 'pending'")
      .bind(actor.user_id, at, layoutId, actor.user_id),
    db
      .prepare(
        `INSERT INTO wpm_submissions (id, layout_id, user_id, wpm, proof, submitted_by, via, submitted_at, status, decided_by, decided_at, reason)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, NULL, NULL)`,
      )
      .bind(id, layoutId, actor.user_id, wpm, proof, actor.user_id, actor.via, at),
  ]);

  // [LDB-WPM7] The feed is public and pending submissions are private to
  // mods: this event names the submission and nothing else -- no speed, no
  // proof (the queue, an admin read, is where those live until approval).
  await appendInfo(db, now, {
    kind: "wpm_submitted",
    layoutId,
    actor: actor.user_id,
    via: actor.via,
    source: sourceOf(actor, version),
    detail: { submission_id: id },
  });

  return { id, layout_id: layoutId, user_id: actor.user_id, wpm, proof, submitted_by: actor.user_id, via: actor.via, submitted_at: at, status: "pending", decided_by: null, decided_at: null, reason: null, review_version: 0 };
}

// POST /v1/admin/wpm (admin): an entry on someone else's behalf, approved at
// once. The target need not have an `authors` row yet (LDB-WPM4).
export async function submitWpmOnBehalf(
  db: Bindings["DB"],
  now: Clock,
  actor: Actor,
  version: string | null,
  layoutId: string,
  rawUserId: unknown,
  rawWpm: unknown,
  rawProof: unknown,
  proofAccess: DiscordProofAccess,
): Promise<WpmSubmissionRow> {
  const userId = validateUserId(rawUserId, "user_id");
  const { wpm, proof } = validated(rawWpm, rawProof);
  await verifyDiscordProofAuthor(proof, userId, proofAccess);
  return insertApproved(db, now, actor, version, layoutId, userId, wpm, proof);
}

export type WpmQueueStatus = WpmStatus;

// GET /v1/admin/wpm-queue?status=... (default pending): hides a submission
// whose layout is currently a tombstone (nothing about delete touches
// submissions -- a pending one is simply hidden until restore).
export async function listWpmQueue(db: Bindings["DB"], status: WpmQueueStatus): Promise<WpmQueueRow[]> {
  const cols = SUBMISSION_COLUMNS.split(", ")
    .map((c) => `s.${c}`)
    .join(", ");
  const { results } = await db
    .prepare(
      `SELECT ${cols}, l.name AS layout_name, a.name AS user_name
       FROM wpm_submissions s
       JOIN layouts l ON l.id = s.layout_id
       LEFT JOIN authors a ON a.user_id = s.user_id
       WHERE s.status = ? AND l.deleted = 0
       ORDER BY s.submitted_at ASC, s.id ASC`,
    )
    .bind(status)
    .all<WpmQueueRow>();
  return results;
}

// POST /v1/admin/wpm-queue/:id/approve: `404 not_found` if the layout is a
// tombstone (restore first) or the submission doesn't exist / isn't pending.
export async function approveWpm(db: Bindings["DB"], now: Clock, actor: Actor, version: string | null, id: string, expectedReviewVersion = 0): Promise<WpmSubmissionRow> {
  const submission = await loadSubmission(db, id);
  if (submission.review_version !== expectedReviewVersion) throw reviewConflict(id);
  if (submission.status !== "pending") throw notFound(`wpm submission '${id}' is not pending`, id);
  const layout = await db.prepare("SELECT id FROM layouts WHERE id = ? AND deleted = 0").bind(submission.layout_id).first();
  if (layout === null) throw notFound(`no layout '${submission.layout_id}'`, submission.layout_id);
  const at = now();
  const results = await db.batch([
    db.prepare(`UPDATE wpm_submissions SET status = 'approved', decided_by = ?, decided_at = ?, reason = NULL
      WHERE id = ? AND status = 'pending' AND review_version = ?
        AND EXISTS (SELECT 1 FROM layouts WHERE id = wpm_submissions.layout_id AND deleted = 0)`)
      .bind(actor.user_id, at, id, expectedReviewVersion),
    rejectionModerationStatement(db, at, { kind: "wpm_approved", layoutId: submission.layout_id,
      actor: actor.user_id, via: actor.via, source: sourceOf(actor, version), detail: { submission_id: submission.id, user_id: submission.user_id, wpm: submission.wpm, proof: submission.proof } }),
    reviewHistoryStatement(db, "wpm", id, "approved", actor.user_id, at, null, expectedReviewVersion),
  ]);
  if (results[0]!.meta.changes !== 1) throw reviewConflict(id);
  return loadSubmission(db, id);
}

// POST /v1/admin/wpm-queue/:id/reject: marks the submission `rejected` and
// appends `wpm_rejected` (`admin: 1`). The event names the submission and
// nothing else -- a refused record's speed, proof and the moderator's reason
// are private to admins (the queue has them), like `link_rejected`.
export async function rejectWpm(db: Bindings["DB"], now: Clock, actor: Actor, version: string | null, id: string, reason?: string, options?: { notifySubmitter?: boolean; reviewVersion?: number }): Promise<WpmSubmissionRow> {
  const submission = await loadSubmission(db, id);
  const expectedReviewVersion = options?.reviewVersion ?? 0;
  if (submission.review_version !== expectedReviewVersion) throw reviewConflict(id);
  if (submission.status !== "pending") throw notFound(`wpm submission '${id}' is not pending`, id);
  if (await db.prepare("SELECT id FROM layouts WHERE id = ?").bind(submission.layout_id).first() === null) {
    throw notFound(`no layout '${submission.layout_id}'`, submission.layout_id);
  }
  const at = now();
  const [claim, event] = await db.batch([
    db.prepare(`UPDATE wpm_submissions SET status = 'rejected', decided_by = ?, decided_at = ?, reason = ?
      WHERE id = ? AND status = 'pending' AND review_version = ? `)
      .bind(actor.user_id, at, reason ?? null, id, expectedReviewVersion),
    rejectionModerationStatement(db, at, { kind: "wpm_rejected", layoutId: submission.layout_id,
      actor: actor.user_id, via: actor.via, source: sourceOf(actor, version), detail: { submission_id: submission.id } }),
    ...(options?.notifySubmitter === true ? [await rejectionOutboxStatement(db, {
      kind: "wpm", submissionId: id, layoutId: submission.layout_id,
      recipientId: submission.user_id, at, reviewVersion: expectedReviewVersion,
    })] : []),
    reviewHistoryStatement(db, "wpm", id, "rejected", actor.user_id, at, reason ?? null, expectedReviewVersion),
  ]);
  if (claim!.meta.changes !== 1 || event!.meta.changes !== 1) throw reviewConflict(id);
  return loadSubmission(db, id);
}

export async function reopenWpm(db: Bindings["DB"], now: Clock, actor: Actor, version: string | null, id: string, expected: ReviewExpectation): Promise<WpmSubmissionRow> {
  await reopenReview(db, now, actor, version, "wpm", id, expected);
  return loadSubmission(db, id);
}

// GET /v1/wpm?layout=&user= (public). One row per (layout, user): the
// approved row with the highest speed, a tie going to the earliest
// `decided_at` (then the lower id, so the pick is deterministic). Records on
// a deleted layout are hidden. Sorted wpm desc, then approved_at asc.
export async function listWpmRecords(db: Bindings["DB"], filter: { layoutId?: string; userId?: string }): Promise<WpmRecord[]> {
  const where: string[] = [];
  const params: string[] = [];
  if (filter.layoutId !== undefined) {
    where.push("AND s.layout_id = ?");
    params.push(filter.layoutId);
  }
  if (filter.userId !== undefined) {
    where.push("AND s.user_id = ?");
    params.push(filter.userId);
  }
  const { results } = await db
    .prepare(
      `SELECT s.layout_id AS layout_id, l.name AS layout_name, s.user_id AS user_id, a.name AS user_name,
              s.wpm AS wpm, s.proof AS proof, s.decided_at AS approved_at, s.id AS submission_id
       FROM wpm_submissions s
       JOIN layouts l ON l.id = s.layout_id AND l.deleted = 0
       LEFT JOIN authors a ON a.user_id = s.user_id
       WHERE s.status = 'approved' ${where.join(" ")}
         AND NOT EXISTS (
           SELECT 1 FROM wpm_submissions b
           WHERE b.layout_id = s.layout_id AND b.user_id = s.user_id AND b.status = 'approved'
             AND (b.wpm > s.wpm
                  OR (b.wpm = s.wpm AND (b.decided_at < s.decided_at OR (b.decided_at = s.decided_at AND b.id < s.id))))
         )
       ORDER BY s.wpm DESC, s.decided_at ASC, s.id ASC`,
    )
    .bind(...params)
    .all<WpmRecord>();
  return results;
}
