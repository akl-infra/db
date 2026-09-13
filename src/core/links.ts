// L5 moderation (design/akldb-site/01-plan.md §4.4): a user-submitted
// `link`, queued for admin approval. `src/routes/links.ts` is glue only
// (LDB-W1) -- every D1 statement for these verbs lives here. `LDB-P1`'s
// onlywriter test allows this file to write `link_submissions` but NEVER
// `layouts` -- `layouts.link` is written only by `core/events.ts`'s
// `appendLinkChange` (the same boundary `like_count` already follows).
import { ulid } from "ulidx";
import type { Actor } from "../auth/actor";
import type { Bindings } from "../env";
import { invalidLink, notFound } from "./errors";
import { appendInfo, appendLinkChange, appendModeration } from "./events";
import type { Source } from "./records";
import type { Clock } from "./time";

// --- the pure validator (LDB-MD9, table-tested) -------------------------

const MAX_LINK_LENGTH = 2048;

export type LinkValidation = { ok: true; url: string } | { ok: false; message: string };

// §4.4: `new URL` parse, `https:` only, no embedded credentials, <= 2048
// chars. Pure -- no DB, no clock -- so the accept/refuse table in
// `tests/core/links.test.ts` enumerates it directly.
export function validateLinkUrl(raw: unknown): LinkValidation {
  if (typeof raw !== "string" || raw.length === 0) return { ok: false, message: "'url' must be a non-empty string" };
  if (raw.length > MAX_LINK_LENGTH) return { ok: false, message: `'url' must be at most ${MAX_LINK_LENGTH} characters` };
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return { ok: false, message: `'${raw}' is not a valid URL` };
  }
  if (parsed.protocol !== "https:") return { ok: false, message: "'url' must use https:" };
  if (parsed.username !== "" || parsed.password !== "") return { ok: false, message: "'url' must not carry embedded credentials" };
  return { ok: true, url: raw };
}

// --- the queue -----------------------------------------------------------

export interface LinkSubmissionRow {
  id: string;
  layout_id: string;
  url: string;
  submitted_by: string;
  submitted_at: string;
  status: "pending" | "approved" | "rejected" | "superseded";
  decided_by: string | null;
  decided_at: string | null;
  reason: string | null;
}

function sourceOf(actor: Actor, version: string | null): Source {
  return { client: actor.source_client, version };
}

async function pendingSubmission(db: Bindings["DB"], layoutId: string): Promise<LinkSubmissionRow | null> {
  return db
    .prepare("SELECT * FROM link_submissions WHERE layout_id = ? AND status = 'pending' ORDER BY submitted_at DESC LIMIT 1")
    .bind(layoutId)
    .first<LinkSubmissionRow>();
}

// GET /v1/layouts/:ref/link (owner|admin): the approved link plus any
// pending submission.
export async function getLink(db: Bindings["DB"], layoutId: string): Promise<{ link: string | null; pending: LinkSubmissionRow | null }> {
  const layout = await db.prepare("SELECT link FROM layouts WHERE id = ?").bind(layoutId).first<{ link: string | null }>();
  if (layout === null) throw notFound(`no layout '${layoutId}'`, layoutId);
  const pending = await pendingSubmission(db, layoutId);
  return { link: layout.link, pending };
}

// PUT /v1/layouts/:ref/link (owner|admin). Owner: queued (`202`, a new
// pending submission -- LDB-MD6: at most one pending per layout, so a
// fresh submit supersedes any existing pending one first, no event for
// that -- the submitter's own bookkeeping). Admin: approved at once (`200`)
// -- straight through `appendLinkChange`, no queue row at all.
export async function submitLink(
  db: Bindings["DB"],
  now: Clock,
  actor: Actor,
  version: string | null,
  layoutId: string,
  isAdminActor: boolean,
  rawUrl: unknown,
): Promise<{ kind: "queued"; submission: LinkSubmissionRow } | { kind: "approved"; link: string | null }> {
  const validated = validateLinkUrl(rawUrl);
  if (!validated.ok) throw invalidLink(validated.message);

  if (isAdminActor) {
    const { link } = await appendLinkChange(db, now, {
      layoutId,
      kind: "link_approved",
      link: validated.url,
      actor: actor.user_id,
      via: actor.via,
      admin: true,
      source: sourceOf(actor, version),
    });
    return { kind: "approved", link };
  }

  const at = now();
  const existing = await pendingSubmission(db, layoutId);
  if (existing !== null) {
    await db
      .prepare("UPDATE link_submissions SET status = 'superseded', decided_by = ?, decided_at = ? WHERE id = ?")
      .bind(actor.user_id, at, existing.id)
      .run();
  }

  const id = ulid();
  await db
    .prepare(
      `INSERT INTO link_submissions (id, layout_id, url, submitted_by, submitted_at, status, decided_by, decided_at, reason)
       VALUES (?, ?, ?, ?, ?, 'pending', NULL, NULL, NULL)`,
    )
    .bind(id, layoutId, validated.url, actor.user_id, at)
    .run();

  await appendInfo(db, now, {
    kind: "link_submitted",
    layoutId,
    actor: actor.user_id,
    via: actor.via,
    source: sourceOf(actor, version),
    detail: { submission_id: id, url: validated.url },
  });

  const submission: LinkSubmissionRow = { id, layout_id: layoutId, url: validated.url, submitted_by: actor.user_id, submitted_at: at, status: "pending", decided_by: null, decided_at: null, reason: null };
  return { kind: "queued", submission };
}

// DELETE /v1/layouts/:ref/link (owner|admin): clears the approved link
// (`link_cleared` event) -- `appendLinkChange`'s own sweep also supersedes
// any pending submission for this layout (§4.4).
export async function clearLink(db: Bindings["DB"], now: Clock, actor: Actor, version: string | null, layoutId: string, isAdminActor: boolean): Promise<{ link: null }> {
  await appendLinkChange(db, now, {
    layoutId,
    kind: "link_cleared",
    link: null,
    actor: actor.user_id,
    via: actor.via,
    admin: isAdminActor,
    source: sourceOf(actor, version),
  });
  return { link: null };
}

export type QueueStatus = "pending" | "approved" | "rejected" | "superseded";

// GET /v1/admin/link-queue?status=... (default pending): hides a
// submission whose layout is currently a tombstone (§4.4: delete does not
// touch submissions -- a pending one on a tombstone is simply hidden until
// restore).
export async function listQueue(db: Bindings["DB"], status: QueueStatus): Promise<LinkSubmissionRow[]> {
  const { results } = await db
    .prepare(
      `SELECT s.* FROM link_submissions s JOIN layouts l ON l.id = s.layout_id
       WHERE s.status = ? AND l.deleted = 0
       ORDER BY s.submitted_at ASC`,
    )
    .bind(status)
    .all<LinkSubmissionRow>();
  return results;
}

async function loadSubmission(db: Bindings["DB"], id: string): Promise<LinkSubmissionRow> {
  const row = await db.prepare("SELECT * FROM link_submissions WHERE id = ?").bind(id).first<LinkSubmissionRow>();
  if (row === null) throw notFound(`no link submission '${id}'`, id);
  return row;
}

// POST /v1/admin/link-queue/:id/approve: `404 not_found` if the layout is
// a tombstone (§4.4 -- restore first) or the submission itself doesn't
// exist; approving a non-pending submission is refused the same way
// (nothing left to decide).
export async function approveSubmission(db: Bindings["DB"], now: Clock, actor: Actor, version: string | null, id: string): Promise<{ link: string | null }> {
  const submission = await loadSubmission(db, id);
  if (submission.status !== "pending") throw notFound(`link submission '${id}' is not pending`, id);
  const layout = await db.prepare("SELECT id FROM layouts WHERE id = ? AND deleted = 0").bind(submission.layout_id).first();
  if (layout === null) throw notFound(`no layout '${submission.layout_id}'`, submission.layout_id);

  const { link } = await appendLinkChange(db, now, {
    layoutId: submission.layout_id,
    kind: "link_approved",
    link: submission.url,
    actor: actor.user_id,
    via: actor.via,
    admin: true,
    source: sourceOf(actor, version),
    submissionId: submission.id,
  });
  return { link };
}

// POST /v1/admin/link-queue/:id/reject: marks the submission `rejected`
// and appends `link_rejected` (`admin: 1`, `appendModeration`).
export async function rejectSubmission(db: Bindings["DB"], now: Clock, actor: Actor, version: string | null, id: string, reason?: string): Promise<LinkSubmissionRow> {
  const submission = await loadSubmission(db, id);
  if (submission.status !== "pending") throw notFound(`link submission '${id}' is not pending`, id);

  const at = now();
  await db
    .prepare("UPDATE link_submissions SET status = 'rejected', decided_by = ?, decided_at = ?, reason = ? WHERE id = ?")
    .bind(actor.user_id, at, reason ?? null, submission.id)
    .run();

  await appendModeration(db, now, {
    kind: "link_rejected",
    layoutId: submission.layout_id,
    actor: actor.user_id,
    via: actor.via,
    source: sourceOf(actor, version),
    detail: { submission_id: submission.id, reason: reason ?? null },
  });

  return { ...submission, status: "rejected", decided_by: actor.user_id, decided_at: at, reason: reason ?? null };
}
