// Bulk revert (saltorbit 2026-09-13, "rogue trusted client" hardening --
// db/README.md's "Rogue trusted client" runbook): `POST
// /v1/admin/clients/:id/revert {since, dry_run?}` walks a client's own
// destructive events since a timestamp, newest -> oldest, and reverts
// each one from its own history -- never rewriting history (every revert
// is a NEW rev, `layout_revs` keeps every payload forever), never
// touching a record the client didn't write, and never overriding a
// later write some OTHER actor made on the same scope ([LDB-A13]).
//
// The "was this scope's current state produced by someone else" check
// reads straight off the CURRENT `layouts`/`layout_formats` row's own
// `source.client` (LDB-P15: the latest write's own source, already
// tracked on every scope) rather than re-scanning event history -- an
// event immediately following E from a DIFFERENT client/actor means E is
// no longer the live state and must not be clobbered; one from the SAME
// client (still queued for its own revert in this same newest-to-oldest
// walk) or from a previous REVERT (`system:revert`) is fine to build on.
// The one exception is a link change (`appendLinkChange` never folds a
// source onto `layouts`), handled via the link event history directly.
import type { Bindings } from "../env";
import { canonical } from "./canonical";
import { get as getFormat } from "../formats/registry";
import { appendLinkChange, commitWrite, RevConflictError, type CommitInput, type FormatSnapshot, type LayoutSnapshot } from "./events";
import { byRefWithFormats, readById } from "./records";
import type { Clock } from "./time";
import { nextUpstream } from "./upstream";

export const REVERT_ACTOR = "system:revert";
export const REVERT_VIA = "system:revert";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

const DESTRUCTIVE_LAYOUT_KINDS = new Set(["deleted", "renamed", "transferred"]);
const DESTRUCTIVE_FORMAT_KINDS = new Set(["updated", "fingermap"]);

export type RevertOutcome = "reverted" | "would_revert" | "skipped_no_op" | "skipped_newer_write_by_other" | "skipped_unsupported" | "skipped_conflict";

export interface RevertItem {
  seq: number;
  layout_id: string;
  scope: string; // "layout" or a lineage, e.g. "spark", or "link"
  kind: string;
  outcome: RevertOutcome;
  detail?: Record<string, unknown>;
}

export interface RevertResult {
  client_id: string;
  since: string;
  dry_run: boolean;
  scanned: number;
  items: RevertItem[];
  next: number | null; // pass back as `cursor` to continue below this seq
}

interface CandidateRow {
  seq: number;
  at: string;
  kind: string;
  layout_id: string;
  format: string | null; // full format id, e.g. "spark/1", as stored on the event row
  rev: number | null;
  before_json: string | null;
  after_json: string | null;
}

function lineageOf(format: string): string {
  const i = format.lastIndexOf("/");
  return i === -1 ? format : format.slice(0, i);
}

export async function revertClientWrites(
  db: Bindings["DB"],
  now: Clock,
  adminActorId: string,
  clientId: string,
  since: string,
  opts: { dryRun: boolean; cursor?: number; limit?: number },
): Promise<RevertResult> {
  const limit = Math.max(1, Math.min(opts.limit ?? DEFAULT_LIMIT, MAX_LIMIT));
  const sourceClient = `client:${clientId}`;
  const cursorSeq = opts.cursor ?? Number.MAX_SAFE_INTEGER;

  const { results } = await db
    .prepare(
      `SELECT seq, at, kind, layout_id, format, rev, before_json, after_json FROM events
       WHERE source_client = ? AND at >= ? AND seq < ?
         AND ((rev IS NOT NULL AND (
                (format IS NULL AND kind IN ('deleted','renamed','transferred'))
             OR (format IS NOT NULL AND kind IN ('updated','fingermap'))
           )) OR kind = 'link_cleared')
       ORDER BY seq DESC
       LIMIT ?`,
    )
    .bind(sourceClient, since, cursorSeq, limit)
    .all<CandidateRow>();

  const items: RevertItem[] = [];
  for (const row of results) {
    const item = await revertOne(db, now, adminActorId, sourceClient, row, opts.dryRun);
    items.push(item);
  }

  const next = results.length === limit ? results[results.length - 1]!.seq : null;
  return { client_id: clientId, since, dry_run: opts.dryRun, scanned: results.length, items, next };
}

async function revertOne(db: Bindings["DB"], now: Clock, adminActorId: string, sourceClient: string, row: CandidateRow, dryRun: boolean): Promise<RevertItem> {
  const base = { seq: row.seq, layout_id: row.layout_id, kind: row.kind };
  try {
    if (row.kind === "link_cleared") {
      return await revertLinkCleared(db, now, adminActorId, sourceClient, row, dryRun);
    }
    if (row.format === null) {
      return await revertLayoutScope(db, now, adminActorId, sourceClient, row, dryRun);
    }
    return await revertFormatScope(db, now, adminActorId, sourceClient, row, dryRun);
  } catch (e) {
    if (e instanceof RevConflictError) {
      return { ...base, scope: row.format === null ? "layout" : lineageOf(row.format), outcome: "skipped_conflict", detail: { message: e.message } };
    }
    throw e;
  }
}

// Allowed to have produced the CURRENT state of a scope this revert is
// about to touch: the client being reverted, or an earlier call of this
// same revert tool. Anything else is someone else's later, legitimate
// write -- must not be clobbered ([LDB-A13]).
function sourceIsSafe(client: string | null | undefined, sourceClient: string): boolean {
  return client === sourceClient || client === REVERT_VIA;
}

async function revertLayoutScope(db: Bindings["DB"], now: Clock, adminActorId: string, sourceClient: string, row: CandidateRow, dryRun: boolean): Promise<RevertItem> {
  const before = row.before_json === null ? null : (JSON.parse(row.before_json) as LayoutSnapshot);
  if (before === null) {
    return { seq: row.seq, layout_id: row.layout_id, scope: "layout", kind: row.kind, outcome: "skipped_unsupported", detail: { reason: "no before-snapshot (this was the layout's own creation)" } };
  }
  const current = await readById(db, row.layout_id);
  if (current === null) {
    return { seq: row.seq, layout_id: row.layout_id, scope: "layout", kind: row.kind, outcome: "skipped_unsupported", detail: { reason: "layout no longer exists" } };
  }

  let alreadyMatches = false;
  let target: { deleted: boolean; name: string; owner: string; kind: "restored" | "renamed" | "transferred" };
  if (row.kind === "deleted") {
    alreadyMatches = current.deleted === false;
    target = { deleted: false, name: current.name, owner: current.owner, kind: "restored" };
  } else if (row.kind === "renamed") {
    if (current.deleted) return { seq: row.seq, layout_id: row.layout_id, scope: "layout", kind: row.kind, outcome: "skipped_unsupported", detail: { reason: "layout is currently a tombstone" } };
    alreadyMatches = current.name === before.name;
    target = { deleted: current.deleted, name: before.name, owner: current.owner, kind: "renamed" };
  } else {
    // transferred
    if (current.deleted) return { seq: row.seq, layout_id: row.layout_id, scope: "layout", kind: row.kind, outcome: "skipped_unsupported", detail: { reason: "layout is currently a tombstone" } };
    alreadyMatches = current.owner === before.owner;
    target = { deleted: current.deleted, name: current.name, owner: before.owner, kind: "transferred" };
  }

  if (alreadyMatches) return { seq: row.seq, layout_id: row.layout_id, scope: "layout", kind: row.kind, outcome: "skipped_no_op" };
  if (!sourceIsSafe(current.source?.client, sourceClient)) {
    return { seq: row.seq, layout_id: row.layout_id, scope: "layout", kind: row.kind, outcome: "skipped_newer_write_by_other", detail: { current_source_client: current.source?.client ?? null } };
  }
  if (dryRun) return { seq: row.seq, layout_id: row.layout_id, scope: "layout", kind: row.kind, outcome: "would_revert", detail: { target } };

  const lwf = await byRefWithFormats(db, row.layout_id);
  if (lwf === null) return { seq: row.seq, layout_id: row.layout_id, scope: "layout", kind: row.kind, outcome: "skipped_unsupported", detail: { reason: "layout vanished mid-revert" } };
  const input: CommitInput = {
    layoutId: lwf.layout.id,
    creating: false,
    currentN: lwf.layout.n,
    currentLayout: lwf.layout,
    currentFormats: lwf.formats,
    layout: {
      kind: target.kind,
      name: target.name,
      owner: target.owner,
      created_at: lwf.layout.created_at,
      deleted: target.deleted,
      detail: { revert_of_seq: row.seq, admin: adminActorId, reverted_client: sourceClient },
    },
    modified_at: now(),
    actor: REVERT_ACTOR,
    via: REVERT_VIA,
    admin: true,
    source: { client: REVERT_ACTOR, version: null },
    upstream: nextUpstream(lwf.layout.upstream, REVERT_VIA, true),
  };
  const result = await commitWrite(db, now, input);
  return { seq: row.seq, layout_id: row.layout_id, scope: "layout", kind: row.kind, outcome: "reverted", detail: { new_rev: result.layout.layout_rev } };
}

async function revertFormatScope(db: Bindings["DB"], now: Clock, adminActorId: string, sourceClient: string, row: CandidateRow, dryRun: boolean): Promise<RevertItem> {
  const lineage = lineageOf(row.format!);
  const before = row.before_json === null ? null : (JSON.parse(row.before_json) as FormatSnapshot);
  if (before === null) {
    return { seq: row.seq, layout_id: row.layout_id, scope: lineage, kind: row.kind, outcome: "skipped_unsupported", detail: { reason: "no before-snapshot (this format's own addition)" } };
  }

  const lwf = await byRefWithFormats(db, row.layout_id);
  if (lwf === null) return { seq: row.seq, layout_id: row.layout_id, scope: lineage, kind: row.kind, outcome: "skipped_unsupported", detail: { reason: "layout no longer exists" } };
  const current = lwf.formats.get(lineage);
  if (current === undefined) return { seq: row.seq, layout_id: row.layout_id, scope: lineage, kind: row.kind, outcome: "skipped_unsupported", detail: { reason: "layout no longer has this format" } };

  const prevRevRow = await db
    .prepare("SELECT format, payload_json FROM layout_revs WHERE layout_id = ? AND lineage = ? AND rev = ?")
    .bind(row.layout_id, lineage, before.rev)
    .first<{ format: string; payload_json: string }>();
  if (prevRevRow === null) {
    return { seq: row.seq, layout_id: row.layout_id, scope: lineage, kind: row.kind, outcome: "skipped_unsupported", detail: { reason: `no layout_revs row for rev ${before.rev}` } };
  }
  const targetPayload: unknown = JSON.parse(prevRevRow.payload_json);

  if (canonical(current.payload) === canonical(targetPayload) && current.format === prevRevRow.format) {
    return { seq: row.seq, layout_id: row.layout_id, scope: lineage, kind: row.kind, outcome: "skipped_no_op" };
  }
  if (!sourceIsSafe(current.source?.client, sourceClient)) {
    return { seq: row.seq, layout_id: row.layout_id, scope: lineage, kind: row.kind, outcome: "skipped_newer_write_by_other", detail: { current_source_client: current.source?.client ?? null } };
  }
  if (dryRun) return { seq: row.seq, layout_id: row.layout_id, scope: lineage, kind: row.kind, outcome: "would_revert", detail: { restored_rev: before.rev } };

  const module = getFormat(prevRevRow.format);
  if (module === undefined) return { seq: row.seq, layout_id: row.layout_id, scope: lineage, kind: row.kind, outcome: "skipped_unsupported", detail: { reason: `format '${prevRevRow.format}' is no longer registered` } };

  const touches = lineage === "spark";
  const input: CommitInput = {
    layoutId: lwf.layout.id,
    creating: false,
    currentN: lwf.layout.n,
    currentLayout: lwf.layout,
    currentFormats: lwf.formats,
    format: {
      kind: "updated",
      lineage,
      format: prevRevRow.format,
      payload: targetPayload,
      hasMagic: module.hasMagic(targetPayload),
      detail: { revert_of_seq: row.seq, admin: adminActorId, reverted_client: sourceClient, restored_rev: before.rev },
    },
    modified_at: now(),
    actor: REVERT_ACTOR,
    via: REVERT_VIA,
    admin: true,
    source: { client: REVERT_ACTOR, version: null },
    upstream: nextUpstream(lwf.layout.upstream, REVERT_VIA, touches),
  };
  const result = await commitWrite(db, now, input);
  const written = result.formats.get(lineage)!;
  return { seq: row.seq, layout_id: row.layout_id, scope: lineage, kind: row.kind, outcome: "reverted", detail: { new_rev: written.rev, restored_rev: before.rev } };
}

interface LinkEventRow {
  seq: number;
  after_json: string | null;
  source_client: string | null;
}

async function revertLinkCleared(db: Bindings["DB"], now: Clock, adminActorId: string, sourceClient: string, row: CandidateRow, dryRun: boolean): Promise<RevertItem> {
  const current = await readById(db, row.layout_id);
  if (current === null) return { seq: row.seq, layout_id: row.layout_id, scope: "link", kind: row.kind, outcome: "skipped_unsupported", detail: { reason: "layout no longer exists" } };

  // `appendLinkChange` never folds a source onto `layouts` (only
  // layout-scope/format-scope writes do, LDB-P15) -- read the link
  // history directly instead: the PREVIOUS link event (what `link` held
  // just before this clear) is what we restore, and the LATEST link
  // event's own source is what tells us whether someone else has since
  // approved/cleared a different value.
  const [{ results: beforeRows }, { results: latestRows }] = await Promise.all([
    db
      .prepare("SELECT seq, after_json, source_client FROM events WHERE layout_id = ? AND kind IN ('link_approved','link_cleared') AND seq < ? ORDER BY seq DESC LIMIT 1")
      .bind(row.layout_id, row.seq)
      .all<LinkEventRow>(),
    db
      .prepare("SELECT seq, after_json, source_client FROM events WHERE layout_id = ? AND kind IN ('link_approved','link_cleared') ORDER BY seq DESC LIMIT 1")
      .bind(row.layout_id)
      .all<LinkEventRow>(),
  ]);
  const beforeLink: string | null = beforeRows[0]?.after_json !== undefined && beforeRows[0]?.after_json !== null ? (JSON.parse(beforeRows[0].after_json) as { link: string | null }).link : null;
  const latestSourceClient = latestRows[0]?.source_client ?? null;

  if (current.link === beforeLink) return { seq: row.seq, layout_id: row.layout_id, scope: "link", kind: row.kind, outcome: "skipped_no_op" };
  if (!sourceIsSafe(latestSourceClient, sourceClient)) {
    return { seq: row.seq, layout_id: row.layout_id, scope: "link", kind: row.kind, outcome: "skipped_newer_write_by_other", detail: { current_source_client: latestSourceClient } };
  }
  if (dryRun) return { seq: row.seq, layout_id: row.layout_id, scope: "link", kind: row.kind, outcome: "would_revert", detail: { restored_link: beforeLink } };

  await appendLinkChange(db, now, {
    layoutId: row.layout_id,
    kind: beforeLink === null ? "link_cleared" : "link_approved",
    link: beforeLink,
    actor: REVERT_ACTOR,
    via: REVERT_VIA,
    admin: true,
    source: { client: REVERT_ACTOR, version: null },
    detail: { revert_of_seq: row.seq, admin: adminActorId, reverted_client: sourceClient },
  });
  return { seq: row.seq, layout_id: row.layout_id, scope: "link", kind: row.kind, outcome: "reverted", detail: { restored_link: beforeLink } };
}

// Exported for `tests/tools/invariants.test.ts`-style structural checks
// and for `routes/admin.ts` to enumerate what a client-lane "destructive"
// write means without re-deriving the list.
export const REVERTIBLE_KINDS = { layout: DESTRUCTIVE_LAYOUT_KINDS, format: DESTRUCTIVE_FORMAT_KINDS, link: new Set(["link_cleared"]) };
