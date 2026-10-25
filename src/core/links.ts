// L5 moderation (design/akldb-site/01-plan.md §4.4): a user-submitted
// `link`, queued for admin approval. `src/routes/links.ts` is glue only
// (LDB-W1) -- every D1 statement for these verbs lives here. `LDB-P1`'s
// onlywriter test allows this file to write `link_submissions` but NEVER
// `layouts` -- `layouts.link` is written only by `core/events.ts`'s
// `appendLinkChange` (the same boundary `like_count` already follows).
import { ulid } from "ulidx";
import type { Actor } from "../auth/actor";
import { checkDestructiveBudget } from "./clients";
import { clientIdFromVia } from "./destructive-budget";
import { invalidLink, notFound } from "./errors";
import { appendInfo, appendLinkChange } from "./events";
import { approvedLinkOf, layoutPresent } from "./moderation-review";
import { outboxIntent } from "./outbox-intent";
import type { Source } from "./records";
import type { Clock } from "./time";
import { toStore, type StoreArg } from "../store/arg";
import type { Store } from "../store/port";

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

// GET /v1/layouts/:ref/link (owner|admin): the approved link plus any
// pending submission.
export async function getLink(dbArg: StoreArg, layoutId: string): Promise<{ link: string | null; pending: LinkSubmissionRow | null }> {
  const store = toStore(dbArg);
  const layout = await approvedLinkOf(store, layoutId); // P1: agent A (layouts.approvedLink)
  if (layout === null) throw notFound(`no layout '${layoutId}'`, layoutId);
  const pending = await store.links.pending(layoutId);
  return { link: layout.link, pending };
}

// PUT /v1/layouts/:ref/link (owner|admin). Everyone, an admin included:
// queued (`202`, a new pending submission -- LDB-MD6: at most one pending
// per layout, so a fresh submit supersedes any existing pending one first,
// no event for that -- the submitter's own bookkeeping). No short circuit
// for mods (saltorbit, API 1.23): an admin's own link is approved in the
// Inbox like anyone's.
export async function submitLink(
  dbArg: StoreArg,
  now: Clock,
  actor: Actor,
  version: string | null,
  layoutId: string,
  rawUrl: unknown,
): Promise<LinkSubmissionRow> {
  const store = toStore(dbArg);
  const validated = validateLinkUrl(rawUrl);
  if (!validated.ok) throw invalidLink(validated.message);

  const at = now();
  const existing = await store.links.pending(layoutId);
  const id = ulid();
  await store.links.submit({
    supersedeId: existing !== null ? existing.id : null,
    by: actor.user_id,
    at,
    row: { id, layout_id: layoutId, url: validated.url, submitted_by: actor.user_id, submitted_at: at },
  });

  await appendInfo(store, now, {
    kind: "link_submitted",
    layoutId,
    actor: actor.user_id,
    via: actor.via,
    source: sourceOf(actor, version),
    detail: { submission_id: id, url: validated.url },
  });

  return { id, layout_id: layoutId, url: validated.url, submitted_by: actor.user_id, submitted_at: at, status: "pending", decided_by: null, decided_at: null, reason: null };
}

// DELETE /v1/layouts/:ref/link (owner|admin): clears the approved link
// (`link_cleared` event) -- `appendLinkChange`'s own sweep also supersedes
// any pending submission for this layout (§4.4).
export async function clearLink(dbArg: StoreArg, now: Clock, actor: Actor, version: string | null, layoutId: string, isAdminActor: boolean): Promise<{ link: null }> {
  const store = toStore(dbArg);
  // [LDB-A10] ("rogue trusted client" hardening): clearing an approved
  // link is destructive -- the owner's submission history stays queryable
  // (LDB-MD5) but the PUBLIC wire loses it outright until re-approved or
  // reverted.
  const clientId = clientIdFromVia(actor.via);
  const { budgetProbe } = await appendLinkChange(store, now, {
    layoutId,
    kind: "link_cleared",
    link: null,
    actor: actor.user_id,
    via: actor.via,
    admin: isAdminActor,
    source: sourceOf(actor, version),
    ...(clientId !== undefined ? { destructiveBudget: { clientId } } : {}),
  });
  if (budgetProbe !== undefined) await checkDestructiveBudget(store, now, budgetProbe);
  return { link: null };
}

// `GET /v1/admin/link-queue` additionally names the layout and the submitter
// (joined; `submitter_name` is null with no `authors` row), so a moderator
// reads a name rather than a bare id.
export interface LinkQueueRow extends LinkSubmissionRow {
  layout_name: string;
  submitter_name: string | null;
}

export type QueueStatus = "pending" | "approved" | "rejected" | "superseded";

// GET /v1/admin/link-queue?status=... (default pending): hides a
// submission whose layout is currently a tombstone (§4.4: delete does not
// touch submissions -- a pending one on a tombstone is simply hidden until
// restore).
export async function listQueue(dbArg: StoreArg, status: QueueStatus): Promise<LinkQueueRow[]> {
  return toStore(dbArg).links.queue(status);
}

async function loadSubmission(store: Store, id: string): Promise<LinkSubmissionRow> {
  const row = await store.links.get(id);
  if (row === null) throw notFound(`no link submission '${id}'`, id);
  return row;
}

// POST /v1/admin/link-queue/:id/approve: `404 not_found` if the layout is
// a tombstone (§4.4 -- restore first) or the submission itself doesn't
// exist; approving a non-pending submission is refused the same way
// (nothing left to decide).
export async function approveSubmission(dbArg: StoreArg, now: Clock, actor: Actor, version: string | null, id: string): Promise<{ link: string | null }> {
  const store = toStore(dbArg);
  const submission = await loadSubmission(store, id);
  if (submission.status !== "pending") throw notFound(`link submission '${id}' is not pending`, id);
  if (!(await layoutPresent(store, submission.layout_id, true))) throw notFound(`no layout '${submission.layout_id}'`, submission.layout_id);

  const { link } = await appendLinkChange(store, now, {
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
export async function rejectSubmission(dbArg: StoreArg, now: Clock, actor: Actor, version: string | null, id: string, reason?: string, options?: { notifySubmitter?: boolean }): Promise<LinkSubmissionRow> {
  const store = toStore(dbArg);
  const submission = await loadSubmission(store, id);
  if (submission.status !== "pending") throw notFound(`link submission '${id}' is not pending`, id);
  if (!(await layoutPresent(store, submission.layout_id, false))) {
    throw notFound(`no layout '${submission.layout_id}'`, submission.layout_id);
  }

  const at = now();
  const outcome = await store.links.reject({
    id: submission.id,
    by: actor.user_id,
    at,
    reason: reason ?? null,
    event: {
      kind: "link_rejected",
      layoutId: submission.layout_id,
      actor: actor.user_id,
      via: actor.via,
      source: sourceOf(actor, version),
      detail: { submission_id: submission.id, reason: reason ?? null },
    },
    ...(options?.notifySubmitter === true
      ? { outbox: await outboxIntent({ kind: "link", submissionId: submission.id, layoutId: submission.layout_id, recipientId: submission.submitted_by, at }, "rejection") }
      : {}),
  });
  if (!outcome.claimed || !outcome.eventAppended) throw notFound(`link submission '${id}' is not pending`, id);

  return { ...submission, status: "rejected", decided_by: actor.user_id, decided_at: at, reason: reason ?? null };
}
