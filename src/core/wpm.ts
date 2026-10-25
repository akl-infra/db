// WPM records (docs/decisions/28-wpm-records.md): a user's best typing
// speed on a layout, submitted with a proof link and moderated through the
// same queue pattern `core/links.ts` uses. `src/routes/wpm.ts` is glue
// only (LDB-W1) -- every D1 statement for these verbs lives here. Rows are
// never deleted: `status` is the only thing that moves, so a proof stays
// reviewable forever (LDB-WPM2).
import { ulid } from "ulidx";
import type { Actor } from "../auth/actor";
import { sourceMessageConflict, badRequest, invalidProof, invalidWpm, notFound, reviewConflict } from "./errors";
import { lookupDiscordUser, storeResolved, type DiscordLookup } from "./discord-users";
import { appendInfo } from "./events";
import { layoutPresent, reopenReview, type ReviewExpectation } from "./moderation-review";
import { outboxIntent } from "./outbox-intent";
import { byRef, type LayoutRow, type Source } from "./records";
import { verifyDiscordProofAuthor, type DiscordProofAccess } from "./modqueue-proof";
import type { Clock } from "./time";
import { toStore, type StoreArg } from "../store/arg";
import type { Store } from "../store/port";

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
  user_name: string | null; // authors.name, else discord_users (LDB-WPM18); null if neither
}

// `GET /v1/wpm`: one row per (layout, user), the user's best approved speed.
export interface WpmRecord {
  layout_id: string;
  layout_name: string;
  user_id: string;
  user_name: string | null; // authors.name, else discord_users (LDB-WPM18); null if neither
  wpm: number;
  proof: string;
  approved_at: string;
  submission_id: string;
}

function sourceOf(actor: Actor, version: string | null): Source {
  return { client: actor.source_client, version };
}

async function loadSubmission(store: Store, id: string): Promise<WpmSubmissionRow> {
  const row = await store.wpm.get(id);
  if (row === null) throw notFound(`no wpm submission '${id}'`, id);
  return row;
}

export type WpmSubmissionStatus = Pick<WpmSubmissionRow, "id" | "status" | "reason" | "review_version">;

// [LDB-WPM16] Clients can follow their own submissions without gaining
// access to the queue or exposing private decision reasons in the feed.
export async function readWpmSubmissionStatus(dbArg: StoreArg, actor: Actor, id: string): Promise<WpmSubmissionStatus> {
  const store = toStore(dbArg);
  const submission = await loadSubmission(store, id);
  if (!actor.admin && actor.user_id !== submission.user_id && actor.user_id !== submission.submitted_by) {
    throw notFound(`no wpm submission '${id}'`, id);
  }
  return { id: submission.id, status: submission.status, reason: submission.reason, review_version: submission.review_version };
}

// [LDB-WPM17] Receipt URLs are immutable private delivery metadata. The CAS
// authorizes in the write itself and makes two concurrent first binds safe.
export async function bindWpmDiscordMessage(dbArg: StoreArg, actor: Actor, id: string,
  message: { guild_id: string | null; channel_id: string; message_id: string }): Promise<string> {
  const store = toStore(dbArg);
  const url = `https://discord.com/channels/${message.guild_id ?? "@me"}/${message.channel_id}/${message.message_id}`;
  if (await store.wpm.bindSourceMessage({ id, url, actorId: actor.user_id, admin: actor.admin })) return url;
  const existing = await store.wpm.sourceMessage({ id, actorId: actor.user_id, admin: actor.admin });
  if (existing === null) throw notFound(`no wpm submission '${id}'`, id);
  if (existing.source_message_url === url) return url;
  throw sourceMessageConflict();
}

// The layout every submission route names: the usual ref resolution; a
// tombstone refuses (a deleted layout takes no new records).
export async function resolveWpmLayout(dbArg: StoreArg, ref: string): Promise<LayoutRow> {
  const store = toStore(dbArg);
  const layout = await byRef(store, ref);
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
  store: Store,
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
  await store.wpm.insertApproved({
    row: { id, layout_id: layoutId, user_id: userId, wpm, proof, submitted_by: actor.user_id, via: actor.via, submitted_at: at, decided_by: actor.user_id, decided_at: at },
    event: { kind: "wpm_approved", layoutId, actor: actor.user_id,
      via: actor.via, source: sourceOf(actor, version), detail: { submission_id: id, user_id: userId, wpm, proof } },
    history: { kind: "wpm", submissionId: id, action: "approved", actor: actor.user_id, at, reason: null, reviewVersion: 0 },
  });
  return { id, layout_id: layoutId, user_id: userId, wpm, proof, submitted_by: actor.user_id, via: actor.via, submitted_at: at, status: "approved", decided_by: actor.user_id, decided_at: at, reason: null, review_version: 0 };
}

// POST /v1/wpm. Everyone, an admin included: queued (`202`) -- LDB-WPM2: a
// fresh pending submission supersedes the same user's older pending one for
// this layout, no event for that. No short circuit for mods (saltorbit,
// API 1.23): an admin's OWN speed is approved in the Inbox like anyone's;
// only `POST /v1/admin/wpm` (an explicit entry for someone else) is approved
// at once.
export async function submitWpm(
  dbArg: StoreArg,
  now: Clock,
  actor: Actor,
  version: string | null,
  layoutId: string,
  rawWpm: unknown,
  rawProof: unknown,
  proofAccess: DiscordProofAccess,
): Promise<WpmSubmissionRow> {
  const store = toStore(dbArg);
  const { wpm, proof } = validated(rawWpm, rawProof);
  await verifyDiscordProofAuthor(proof, actor.user_id, proofAccess);

  const at = now();
  const id = ulid();
  await store.wpm.submit({
    by: actor.user_id,
    at,
    row: { id, layout_id: layoutId, user_id: actor.user_id, wpm, proof, submitted_by: actor.user_id, via: actor.via, submitted_at: at },
  });

  // [LDB-WPM7] The feed is public and pending submissions are private to
  // mods: this event names the submission and nothing else -- no speed, no
  // proof (the queue, an admin read, is where those live until approval).
  await appendInfo(store, now, {
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
  dbArg: StoreArg,
  now: Clock,
  actor: Actor,
  version: string | null,
  layoutId: string,
  rawUserId: unknown,
  rawWpm: unknown,
  rawProof: unknown,
  proofAccess: DiscordProofAccess,
  lookup?: DiscordLookup,
): Promise<WpmSubmissionRow> {
  const store = toStore(dbArg);
  const userId = validateUserId(rawUserId, "user_id");
  const { wpm, proof } = validated(rawWpm, rawProof);
  await verifyDiscordProofAuthor(proof, userId, proofAccess);
  // [LDB-WPM19] Resolve the typist's name with the akldb bot alongside the
  // save. The lookup never throws and is bounded by its own timeout, so the
  // entry is saved whatever Discord does.
  const names = lookupDiscordUser(proofAccess, userId, lookup);
  const row = await insertApproved(store, now, actor, version, layoutId, userId, wpm, proof);
  await storeResolved(store, now, userId, await names);
  return row;
}

export type WpmQueueStatus = WpmStatus;

// GET /v1/admin/wpm-queue?status=... (default pending): hides a submission
// whose layout is currently a tombstone (nothing about delete touches
// submissions -- a pending one is simply hidden until restore).
export async function listWpmQueue(dbArg: StoreArg, status: WpmQueueStatus): Promise<WpmQueueRow[]> {
  return toStore(dbArg).wpm.queue(status);
}

// POST /v1/admin/wpm-queue/:id/approve: `404 not_found` if the layout is a
// tombstone (restore first) or the submission doesn't exist / isn't pending.
export async function approveWpm(dbArg: StoreArg, now: Clock, actor: Actor, version: string | null, id: string, expectedReviewVersion = 0, notifySubmitter = false): Promise<WpmSubmissionRow> {
  const store = toStore(dbArg);
  const submission = await loadSubmission(store, id);
  if (submission.review_version !== expectedReviewVersion) throw reviewConflict(id);
  if (submission.status !== "pending") throw notFound(`wpm submission '${id}' is not pending`, id);
  if (!(await layoutPresent(store, submission.layout_id, true))) throw notFound(`no layout '${submission.layout_id}'`, submission.layout_id);
  const at = now();
  const outcome = await store.wpm.approve({
    id,
    by: actor.user_id,
    at,
    reviewVersion: expectedReviewVersion,
    event: { kind: "wpm_approved", layoutId: submission.layout_id,
      actor: actor.user_id, via: actor.via, source: sourceOf(actor, version), detail: { submission_id: submission.id, user_id: submission.user_id, wpm: submission.wpm, proof: submission.proof } },
    ...(notifySubmitter ? { outbox: await outboxIntent({ kind: "wpm", submissionId: id, layoutId: submission.layout_id, recipientId: submission.user_id, at, reviewVersion: expectedReviewVersion }, "approval") } : {}),
    history: { kind: "wpm", submissionId: id, action: "approved", actor: actor.user_id, at, reason: null, reviewVersion: expectedReviewVersion },
  });
  if (!outcome.claimed) throw reviewConflict(id);
  return loadSubmission(store, id);
}

// POST /v1/admin/wpm-queue/:id/reject: marks the submission `rejected` and
// appends `wpm_rejected` (`admin: 1`). The event names the submission and
// nothing else -- a refused record's speed, proof and the moderator's reason
// are private to admins (the queue has them), like `link_rejected`.
export async function rejectWpm(dbArg: StoreArg, now: Clock, actor: Actor, version: string | null, id: string, reason?: string, options?: { notifySubmitter?: boolean; reviewVersion?: number }): Promise<WpmSubmissionRow> {
  const store = toStore(dbArg);
  const submission = await loadSubmission(store, id);
  const expectedReviewVersion = options?.reviewVersion ?? 0;
  if (submission.review_version !== expectedReviewVersion) throw reviewConflict(id);
  if (submission.status !== "pending") throw notFound(`wpm submission '${id}' is not pending`, id);
  if (!(await layoutPresent(store, submission.layout_id, false))) {
    throw notFound(`no layout '${submission.layout_id}'`, submission.layout_id);
  }
  const at = now();
  const outcome = await store.wpm.reject({
    id,
    by: actor.user_id,
    at,
    reason: reason ?? null,
    reviewVersion: expectedReviewVersion,
    event: { kind: "wpm_rejected", layoutId: submission.layout_id,
      actor: actor.user_id, via: actor.via, source: sourceOf(actor, version), detail: { submission_id: submission.id } },
    ...(options?.notifySubmitter === true ? { outbox: await outboxIntent({ kind: "wpm", submissionId: id, layoutId: submission.layout_id, recipientId: submission.user_id, at, reviewVersion: expectedReviewVersion }, "rejection") } : {}),
    history: { kind: "wpm", submissionId: id, action: "rejected", actor: actor.user_id, at, reason: reason ?? null, reviewVersion: expectedReviewVersion },
  });
  if (!outcome.claimed || !outcome.eventAppended) throw reviewConflict(id);
  return loadSubmission(store, id);
}

export async function reopenWpm(dbArg: StoreArg, now: Clock, actor: Actor, version: string | null, id: string, expected: ReviewExpectation): Promise<WpmSubmissionRow> {
  const store = toStore(dbArg);
  await reopenReview(store, now, actor, version, "wpm", id, expected);
  return loadSubmission(store, id);
}

// GET /v1/wpm?layout=&user= (public). One row per (layout, user): the
// approved row with the highest speed, a tie going to the earliest
// `decided_at` (then the lower id, so the pick is deterministic). Records on
// a deleted layout are hidden. Sorted wpm desc, then approved_at asc.
export async function listWpmRecords(dbArg: StoreArg, filter: { layoutId?: string; userId?: string }): Promise<WpmRecord[]> {
  return toStore(dbArg).wpm.records(filter);
}
