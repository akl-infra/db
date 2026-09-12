// Records + events, the fold (21-formats.md §2.1/§2.2). `commitWrite` is the
// only code under `src/` that writes `layouts`/`layout_formats` (checked by
// tests/tools/onlywriter.test.ts); `records.ts` only reads. Every
// rev-bumping event has exactly one SCOPE (`format === null` = the layout;
// otherwise a lineage) and bumps exactly that scope's rev (MF-2); a write
// that changes both scopes (a create, some imports) appends one event per
// scope, in the same D1 batch, serialized by ONE shared per-layout counter
// `n` (`layout_revs`' PK `(layout_id, n)`, migrations/0009_formats.sql).
import type { Bindings } from "../env";
import { canonical } from "./canonical";
import { alreadyLiked as alreadyLikedError, nameTaken, notFound, notLiked as notLikedError } from "./errors";
import { type FormatRow, type LayoutRow, type Source, type Upstream, readById } from "./records";
import { ulid } from "ulidx";
import type { Clock } from "./time";

// A write lost the rev race: another write to the SAME layout (either
// scope) committed the next `n` first (the `layout_revs` PK refused the
// loser's batch). The write pipeline (`core/write.ts`) turns this into a
// retry (own scope unchanged) or `409 stale` (own scope moved).
export class RevConflictError extends Error {
  constructor(readonly layoutId: string) {
    super(`layout '${layoutId}' was written concurrently`);
  }
}

export type WriteKind =
  | "created"
  | "format_added"
  | "updated"
  | "renamed"
  | "fingermap"
  | "transferred"
  | "deleted"
  | "restored"
  | "imported"
  | "upstream_deleted";

// "upstream_deleted" is deliberately in both WriteKind and InfoKind: a
// following layout's tombstoning is rev-bumping (layout scope), a
// non-following layout's is informational.
export type InfoKind =
  | "upstream_changed"
  | "import_conflict"
  // LDB-B5 (design/layout-db/review/audit-db.md B5): a non-conflict error
  // from one id's apply, recorded so the tick can keep going instead of
  // aborting -- `import/apply.ts`'s `recordImportError`.
  | "import_error"
  | "upstream_deleted"
  | "admin.added"
  | "admin.removed"
  | "admin.import_paused"
  | "admin.import_resumed"
  | "admin.client_registered"
  | "admin.client_revoked"
  | "admin.import_ticked"
  | "admin.diff_ticked"
  | "admin.nightly_ticked";

// 21-formats.md §2.2: what a rev-bumping event's `after` (and `before`)
// carry -- never a payload (that's `layout_revs`' job). A layout-scope
// event's snapshot is the layout's own fields; a format-scope event's is
// that format's row, PLUS `upstream` when THIS write forked/kept it (only
// ever true for lineage `spark` or a layout-scope write -- MF-12). Folding
// a layout's events in seq order, with payloads from `layout_revs`,
// reproduces both tables exactly (MF-3).
// Coordinator review (LOW, third batch): `like_count` is deliberately NOT
// part of a layout-scope event's own snapshot. A rev-bumping write's own
// `like_count` is whatever it read (or self-healed to, M1) at ITS commit
// time, which a feed/webhook reader taking straight off the event would
// see as a wrong, frozen count the moment a like/unlike lands after --
// likes are their own source of truth for counts (`liked`/`unliked`
// events), never a layout-scope event's `after`.
export interface LayoutSnapshot {
  scope: "layout";
  id: string;
  name: string;
  owner: string;
  layout_rev: number;
  created_at: string;
  modified_at: string;
  deleted: boolean;
  upstream: Upstream | null;
  source: Source | null;
}
export interface FormatSnapshot {
  scope: "format";
  layout_id: string;
  lineage: string;
  format: string;
  rev: number;
  created_at: string;
  modified_at: string;
  has_magic: boolean;
  source: Source | null;
  upstream?: Upstream | null;
}
export type EventSnapshot = LayoutSnapshot | FormatSnapshot;

// One scope-write, fully specified by the caller (`core/write.ts`'s verb
// functions each build this from a fresh read plus their own checks) --
// this module never defaults an "omitted" field from a prior read, so
// there is exactly one place (the verb function) that decides what a write
// keeps vs. changes.
export interface LayoutPart {
  kind: WriteKind;
  name: string;
  owner: string;
  created_at: string;
  deleted: boolean;
  detail?: object;
}
export interface FormatPart {
  kind: WriteKind;
  lineage: string;
  format: string; // full id, e.g. 'spark/1'
  payload: unknown;
  hasMagic: boolean;
  detail?: object;
}

export interface CommitInput {
  layoutId: string; // minted by the caller (ulid()) when creating
  creating: boolean;
  currentN: number; // 0 when creating
  currentLayout: LayoutRow | null; // null when creating
  currentFormats: Map<string, FormatRow>; // every format the layout currently has (empty when creating)
  layout?: LayoutPart;
  format?: FormatPart;
  modified_at: string;
  actor: string;
  via: string;
  admin?: boolean;
  source: Source;
  // The FINAL upstream value this write leaves (already computed by the
  // caller via `core/upstream.ts`'s `nextUpstream`, from the SAME fresh
  // read `currentLayout` came from -- MF-12).
  upstream: Upstream | null;
  like_count?: number; // present only when a caller needs to seed a non-zero count at create (LDB-P9's tombstone-name inheritance runs a separate appendLike pass instead, so this is always omitted/0 in practice; kept for symmetry)
}

export interface CommitResult {
  layout: LayoutRow;
  formats: Map<string, FormatRow>;
  seqs: number[];
}

function layoutSnapshot(l: {
  id: string;
  name: string;
  owner: string;
  layout_rev: number;
  created_at: string;
  modified_at: string;
  deleted: boolean;
  upstream: Upstream | null;
  source: Source | null;
}): LayoutSnapshot {
  return { scope: "layout", ...l };
}

function formatSnapshot(f: {
  layout_id: string;
  lineage: string;
  format: string;
  rev: number;
  created_at: string;
  modified_at: string;
  has_magic: boolean;
  source: Source | null;
  upstream?: Upstream | null;
}): FormatSnapshot {
  return { scope: "format", ...f };
}

// One batch, one shared per-layout counter `n`: events (layout-scope first
// when both are present, then format-scope) -> layout_revs (event_seq =
// last_insert_rowid(), same connection) -> ONE `layouts` upsert reflecting
// every part's effect -> an optional `layout_formats` upsert. `n`'s PK on
// `layout_revs` is the concurrency guard for BOTH scopes at once (21-
// formats.md §2.1: "restores today's serialization while clients still see
// two revs") -- a loser's whole batch rolls back (events included, so
// `seq` stays gapless) and surfaces as `RevConflictError`.
export async function commitWrite(db: Bindings["DB"], now: Clock, input: CommitInput): Promise<CommitResult> {
  if (input.layout === undefined && input.format === undefined) {
    throw new Error("commitWrite: at least one of layout/format must be given");
  }
  const at = now();
  const id = input.layoutId;
  const partsCount = (input.layout !== undefined ? 1 : 0) + (input.format !== undefined ? 1 : 0);

  // Name-clash pre-check (mirrors 07 §4's original reasoning): only a LIVE
  // layout-scope write that leaves the layout live needs it -- a deleted
  // write, or a pure format-scope write, never claims a name.
  if (input.layout !== undefined && !input.layout.deleted) {
    const clash = await db
      .prepare("SELECT 1 FROM layouts WHERE deleted = 0 AND name = ? AND id != ? LIMIT 1")
      .bind(input.layout.name, id)
      .first();
    if (clash !== null) throw nameTaken(input.layout.name);
  }

  const finalLayoutRev = input.layout !== undefined ? (input.creating ? 1 : input.currentLayout!.layout_rev + 1) : (input.currentLayout?.layout_rev ?? 0);
  const finalLikeCount = input.like_count ?? input.currentLayout?.like_count ?? 0;
  const finalName = input.layout?.name ?? input.currentLayout!.name;
  const finalOwner = input.layout?.owner ?? input.currentLayout!.owner;
  const finalCreatedAt = input.layout?.created_at ?? input.currentLayout!.created_at;
  const finalDeleted = input.layout?.deleted ?? input.currentLayout!.deleted;
  const finalModifiedAt = input.layout !== undefined ? input.modified_at : (input.currentLayout?.modified_at ?? input.modified_at);
  const finalLayoutSource: Source | null = input.layout !== undefined ? input.source : (input.currentLayout?.source ?? null);

  const existingFormat = input.format !== undefined ? input.currentFormats.get(input.format.lineage) ?? null : null;
  const finalFormatRev = input.format !== undefined ? (existingFormat?.rev ?? 0) + 1 : 0;
  const finalFormatCreatedAt = input.format !== undefined ? (existingFormat?.created_at ?? input.modified_at) : "";

  const beforeLayout: LayoutSnapshot | null = input.currentLayout === null ? null : layoutSnapshot(input.currentLayout);
  const beforeFormat: FormatSnapshot | null = existingFormat === null ? null : formatSnapshot(existingFormat);

  const afterLayout: LayoutSnapshot = layoutSnapshot({
    id,
    name: finalName,
    owner: finalOwner,
    layout_rev: finalLayoutRev,
    created_at: finalCreatedAt,
    modified_at: finalModifiedAt,
    deleted: finalDeleted,
    upstream: input.upstream,
    source: finalLayoutSource,
  });

  // The format-scope event's snapshot carries `upstream` too (MF-3, MF-12)
  // iff this format IS lineage `spark` -- the one lineage a format-scope
  // write is allowed to fork/carry upstream through. When a layout part is
  // ALSO present in the same batch, the layout event already carries the
  // same value; this is harmless, idempotent overlap for the fold.
  const formatTouchesUpstream = input.format !== undefined && input.format.lineage === "spark";
  const afterFormat: FormatSnapshot | undefined =
    input.format === undefined
      ? undefined
      : formatSnapshot({
          layout_id: id,
          lineage: input.format.lineage,
          format: input.format.format,
          rev: finalFormatRev,
          created_at: finalFormatCreatedAt,
          modified_at: input.modified_at,
          has_magic: input.format.hasMagic,
          source: input.source,
          ...(formatTouchesUpstream ? { upstream: input.upstream } : {}),
        });

  const stmts: D1PreparedStatement[] = [];
  const seqSlots: number[] = [];
  let nCursor = input.currentN;

  function pushEvent(kind: WriteKind, format: string | null, rev: number, before: EventSnapshot | null, after: EventSnapshot, detail: object | undefined) {
    stmts.push(
      db
        .prepare(
          `INSERT INTO events (at, kind, layout_id, name, owner, format, rev, actor, via, admin, detail_json, before_json, after_json, source_client, source_version)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          at,
          kind,
          id,
          finalName,
          finalOwner,
          format,
          rev,
          input.actor,
          input.via,
          input.admin === true ? 1 : 0,
          detail === undefined ? null : canonical(detail),
          before === null ? null : canonical(before),
          canonical(after),
          input.source.client,
          input.source.version,
        ),
    );
    seqSlots.push(stmts.length - 1);
    nCursor += 1;
    stmts.push(
      db
        .prepare(
          `INSERT INTO layout_revs (layout_id, n, lineage, rev, event_seq, format, payload_json)
           VALUES (?, ?, ?, ?, last_insert_rowid(), ?, ?)`,
        )
        .bind(id, nCursor, format === null ? null : lineageOf(format), rev, format, format === null ? null : canonical(input.format!.payload)),
    );
  }

  function lineageOf(format: string): string {
    const i = format.lastIndexOf("/");
    return i === -1 ? format : format.slice(0, i);
  }

  if (input.layout !== undefined) {
    pushEvent(input.layout.kind, null, finalLayoutRev, beforeLayout, afterLayout, input.layout.detail);
  }
  if (input.format !== undefined) {
    pushEvent(input.format.kind, input.format.format, finalFormatRev, beforeFormat, afterFormat!, input.format.detail);
  }

  // ONE `layouts` upsert reflecting the final state after every part in
  // this batch (n bumped once per part, whatever else changed).
  stmts.push(
    db
      .prepare(
        `INSERT INTO layouts (id, name, owner, n, layout_rev, created_at, modified_at, deleted, like_count, upstream_source, upstream_id, upstream_state, source_client, source_version)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name, owner = excluded.owner, n = excluded.n, layout_rev = excluded.layout_rev,
           created_at = excluded.created_at, modified_at = excluded.modified_at, deleted = excluded.deleted,
           like_count = (SELECT COUNT(*) FROM likes WHERE layout_id = excluded.id),
           upstream_source = excluded.upstream_source, upstream_id = excluded.upstream_id, upstream_state = excluded.upstream_state,
           source_client = excluded.source_client, source_version = excluded.source_version`,
      )
      .bind(
        id,
        finalName,
        finalOwner,
        nCursor,
        finalLayoutRev,
        finalCreatedAt,
        finalModifiedAt,
        finalDeleted ? 1 : 0,
        finalLikeCount,
        input.upstream?.source ?? null,
        input.upstream?.id ?? null,
        input.upstream?.state ?? null,
        finalLayoutSource?.client ?? null,
        finalLayoutSource?.version ?? null,
      ),
  );

  if (input.format !== undefined) {
    stmts.push(
      db
        .prepare(
          `INSERT INTO layout_formats (layout_id, lineage, format, rev, created_at, modified_at, payload_json, has_magic, source_client, source_version)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(layout_id, lineage) DO UPDATE SET
             format = excluded.format, rev = excluded.rev, created_at = excluded.created_at, modified_at = excluded.modified_at,
             payload_json = excluded.payload_json, has_magic = excluded.has_magic,
             source_client = excluded.source_client, source_version = excluded.source_version`,
        )
        .bind(
          id,
          input.format.lineage,
          input.format.format,
          finalFormatRev,
          finalFormatCreatedAt,
          input.modified_at,
          canonical(input.format.payload),
          input.format.hasMagic ? 1 : 0,
          input.source.client,
          input.source.version,
        ),
    );
  }

  // M1: read `like_count` back in the SAME batch, after the `layouts`
  // upsert's own self-healing subquery has run, so the value this call
  // RETURNS to its own caller (the response body an ordinary write's
  // caller sees) is the same live truth the row now holds -- never
  // `finalLikeCount`, which can be a stale pre-read for any write that
  // isn't itself about a like.
  const likeCountStmtIdx = stmts.length;
  stmts.push(db.prepare(`SELECT COUNT(*) as cnt FROM likes WHERE layout_id = ?`).bind(id));

  let results;
  try {
    results = await db.batch(stmts);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/UNIQUE constraint failed: layouts\.name/.test(msg)) throw nameTaken(finalName);
    if (/UNIQUE constraint failed: layout_revs\./.test(msg)) throw new RevConflictError(id);
    throw e;
  }

  const seqs = seqSlots.map((i) => {
    const seq = results[i]?.meta.last_row_id;
    if (seq === undefined) throw new Error("commitWrite: events insert returned no last_row_id");
    return seq;
  });

  const trueLikeCount = (results[likeCountStmtIdx]?.results?.[0] as { cnt: number } | undefined)?.cnt ?? finalLikeCount;

  const layout: LayoutRow = {
    id,
    name: finalName,
    owner: finalOwner,
    n: nCursor,
    layout_rev: finalLayoutRev,
    created_at: finalCreatedAt,
    modified_at: finalModifiedAt,
    deleted: finalDeleted,
    like_count: trueLikeCount,
    upstream: input.upstream,
    source: finalLayoutSource,
  };
  const formats = new Map(input.currentFormats);
  if (input.format !== undefined) {
    formats.set(input.format.lineage, {
      layout_id: id,
      lineage: input.format.lineage,
      format: input.format.format,
      rev: finalFormatRev,
      created_at: finalFormatCreatedAt,
      modified_at: input.modified_at,
      payload: input.format.payload,
      has_magic: input.format.hasMagic,
      source: input.source,
    });
  }

  return { layout, formats, seqs };
}

// Informational: `rev`/`format` NULL, `layouts`/`layout_formats` untouched.
export interface Info {
  kind: InfoKind;
  layoutId: string;
  actor: string;
  via: string;
  detail?: object;
  source: Source;
}

export async function appendInfo(db: Bindings["DB"], now: Clock, i: Info): Promise<{ seq: number }> {
  const current = await readById(db, i.layoutId);
  if (current === null) throw new Error(`appendInfo: layoutId '${i.layoutId}' does not exist`);

  const result = await db
    .prepare(
      `INSERT INTO events (at, kind, layout_id, name, owner, format, rev, actor, via, admin, detail_json, before_json, after_json, source_client, source_version)
       VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, ?, 0, ?, NULL, NULL, ?, ?)`,
    )
    .bind(now(), i.kind, i.layoutId, current.name, current.owner, i.actor, i.via, i.detail === undefined ? null : canonical(i.detail), i.source.client, i.source.version)
    .run();

  const seq = result.meta.last_row_id;
  return { seq };
}

export async function appendAdmin(db: Bindings["DB"], now: Clock, a: { kind: InfoKind; actor: string; detail?: object }): Promise<{ seq: number }> {
  const result = await db
    .prepare(
      `INSERT INTO events (at, kind, layout_id, name, owner, format, rev, actor, via, admin, detail_json, before_json, after_json)
       VALUES (?, ?, NULL, NULL, NULL, NULL, NULL, ?, 'discord', 1, ?, NULL, NULL)`,
    )
    .bind(now(), a.kind, a.actor, a.detail === undefined ? null : canonical(a.detail))
    .run();

  const seq = result.meta.last_row_id;
  if (seq === undefined) throw new Error("appendAdmin: events insert returned no last_row_id");
  return { seq };
}

export interface Like {
  kind: "liked" | "unliked";
  layoutId: string;
  userId: string;
  via: string;
  detail?: object;
  source: Source;
}

// D13 L1/L2 (saltorbit, 2026-09-11): a like/unlike needs no version (L3), but
// it is no longer a silent no-op on repeat -- a repeat like fails with
// `409 already_liked`, a redundant unlike with `409 not_liked`, and either
// way NOTHING is written (no event, `like_count` untouched). Layout-level,
// same as ever -- no format is involved.
export async function appendLike(db: Bindings["DB"], now: Clock, l: Like): Promise<{ seq: number; like_count: number }> {
  const current = await readById(db, l.layoutId);
  if (current === null) throw new Error(`appendLike: layoutId '${l.layoutId}' does not exist`);

  const existing = await db.prepare("SELECT 1 FROM likes WHERE layout_id = ? AND user_id = ?").bind(l.layoutId, l.userId).first();
  const isAlreadyLiked = existing !== null;
  const wantsLike = l.kind === "liked";

  if (wantsLike === isAlreadyLiked) {
    throw wantsLike ? alreadyLikedError() : notLikedError();
  }

  const at = now();

  // Coordinator review (HIGH): the check above is a read BEFORE the
  // batch -- for a LIKE, the `likes` table's own PK still makes the
  // actual race atomic (caught below); for an UNLIKE there is no such
  // constraint, so two concurrent unlikes from the same user could both
  // pass the pre-batch check, both DELETE (the loser's own DELETE just
  // removes 0 rows, no error), and both append an `unliked` event --
  // the second caller wrongly gets 200 (breaks L2) and the fold subtracts
  // twice (breaks MF-3). Fixed by making the EVENT insert itself
  // conditional on the row it's about to react to STILL being true AT
  // BATCH-COMMIT TIME (D1 batches serialize like any other writer
  // transaction, so a losing batch re-evaluates this EXISTS/NOT EXISTS
  // against the winner's already-committed state, not the stale pre-batch
  // read) -- 0 rows inserted means this call's own premise no longer
  // holds, and the DELETE/likes-count recompute below are then no-ops.
  // The same EXISTS also folds in the LOW fix for a like racing a delete:
  // a layout that's gone `deleted` by batch-commit time inserts nothing
  // either, so a post-batch fresh read tells the two cases apart.
  const eventInsertSql = `INSERT INTO events (at, kind, layout_id, name, owner, format, rev, actor, via, admin, detail_json, before_json, after_json, source_client, source_version)
    SELECT ?, ?, ?, ?, ?, NULL, NULL, ?, ?, 0, ?, NULL, NULL, ?, ?
    WHERE EXISTS (SELECT 1 FROM layouts WHERE id = ? AND deleted = 0)
      AND ${wantsLike ? "NOT EXISTS" : "EXISTS"} (SELECT 1 FROM likes WHERE layout_id = ? AND user_id = ?)`;

  let results;
  try {
    results = await db.batch([
      db
        .prepare(eventInsertSql)
        .bind(
          at,
          l.kind,
          l.layoutId,
          current.name,
          current.owner,
          l.userId,
          l.via,
          l.detail === undefined ? null : canonical(l.detail),
          l.source.client,
          l.source.version,
          l.layoutId,
          l.layoutId,
          l.userId,
        ),
      // Coordinator review (follow-up on the HIGH fix, 3e52dc5b9): the
      // event insert was gated on `layouts.deleted = 0`, but these two
      // statements were NOT -- a like racing a delete could still INSERT
      // a likes row (and have it counted) on a tombstone with no event
      // (row != fold, MF-3; the stray like is then inherited by the next
      // layout of that name, LDB-P9); an unlike racing a delete could
      // still DELETE a real like row with no event. Gated on the SAME
      // live condition, re-evaluated at batch-commit time like the event
      // insert's own -- the whole batch is one transaction, so every
      // statement in it sees the same answer.
      wantsLike
        ? db
            // LDB-B1 (design/layout-db/review/audit-db.md B1): `via` records
            // where THIS like came from -- the same vocabulary every other
            // write already uses (`discord`, `client:<id>`, `import:cmini`
            // for a union-add the cmini importer makes) -- so a later
            // reconciliation can tell a real user's like from an imported
            // one without guessing from `events`.
            .prepare("INSERT INTO likes (layout_id, user_id, at, via) SELECT ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM layouts WHERE id = ? AND deleted = 0)")
            .bind(l.layoutId, l.userId, at, l.via, l.layoutId)
        : db
            .prepare("DELETE FROM likes WHERE layout_id = ? AND user_id = ? AND EXISTS (SELECT 1 FROM layouts WHERE id = ? AND deleted = 0)")
            .bind(l.layoutId, l.userId, l.layoutId),
      db.prepare("UPDATE layouts SET like_count = (SELECT COUNT(*) FROM likes WHERE layout_id = ?) WHERE id = ?").bind(l.layoutId, l.layoutId),
      db.prepare("SELECT like_count FROM layouts WHERE id = ?").bind(l.layoutId),
    ]);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // L1 (E2's own rule, applied to likes): of two concurrent likes from
    // the SAME user, exactly one succeeds -- the `likes` table's own
    // (layout_id, user_id) PK is what makes that atomic; the loser gets
    // the same `already_liked` a sequential repeat would.
    if (/UNIQUE constraint failed: likes\./.test(msg)) throw alreadyLikedError();
    throw e;
  }

  if (results[0]?.meta.changes === 0) {
    // The event insert's own WHERE clause didn't hold at batch-commit
    // time -- find out which of its two conditions failed (a fresh read
    // costs nothing extra on this rare, race-only path).
    const fresh = await readById(db, l.layoutId);
    if (fresh === null || fresh.deleted) throw notFound(`no layout '${current.name}'`, current.name);
    throw wantsLike ? alreadyLikedError() : notLikedError();
  }

  const seq = results[0]?.meta.last_row_id;
  if (seq === undefined) throw new Error("appendLike: events insert returned no last_row_id");
  const counted = (results[3]?.results?.[0] as { like_count: number } | undefined)?.like_count;
  return { seq, like_count: counted ?? current.like_count };
}

// A parsed `events` row (D1's 0/1 and JSON-string columns converted).
export interface Event {
  seq: number;
  at: string;
  kind: string;
  layout_id: string | null;
  name: string | null;
  owner: string | null;
  format: string | null;
  rev: number | null;
  actor: string;
  via: string;
  admin: boolean;
  detail: unknown;
  before: EventSnapshot | null;
  after: EventSnapshot | null;
  source: Source;
}

export interface EventDbRow {
  seq: number;
  at: string;
  kind: string;
  layout_id: string | null;
  name: string | null;
  owner: string | null;
  format: string | null;
  rev: number | null;
  actor: string;
  via: string;
  admin: number;
  detail_json: string | null;
  before_json: string | null;
  after_json: string | null;
  source_client: string | null;
  source_version: string | null;
}

export function sourceOfEvent(row: { source_client: string | null; source_version: string | null; via: string }): Source {
  if (row.source_client === null) return { client: `legacy:${row.via}`, version: null };
  return { client: row.source_client, version: row.source_version };
}

export function rowToEvent(row: EventDbRow): Event {
  return {
    seq: row.seq,
    at: row.at,
    kind: row.kind,
    layout_id: row.layout_id,
    name: row.name,
    owner: row.owner,
    format: row.format,
    rev: row.rev,
    actor: row.actor,
    via: row.via,
    admin: row.admin !== 0,
    detail: row.detail_json === null ? null : JSON.parse(row.detail_json),
    before: row.before_json === null ? null : (JSON.parse(row.before_json) as EventSnapshot),
    after: row.after_json === null ? null : (JSON.parse(row.after_json) as EventSnapshot),
    source: sourceOfEvent(row),
  };
}

// MF-3: folds one layout's events (seq order) plus its `layout_revs`
// payloads into its `layouts` row and every `layout_formats` row. `revs`
// keys on `(lineage-or-null, rev)`: null lineage for the layout scope.
// `n` (the internal write counter) is never carried on an event snapshot
// (§2.2's "after" is deliberately payload-and-`n`-free), so a fold can
// reconstruct every OTHER `layouts` column but not `n` itself -- callers
// that need `n` already have it from the row they read to get the events
// in the first place.
export interface FoldedLayout {
  layout: Omit<LayoutRow, "n">;
  formats: Map<string, FormatRow>;
}

// Function boundaries here (rather than inlining the spread in the loop)
// sidestep a TS control-flow-analysis quirk: narrowing a `let` through its
// own reassignment inside a loop resolves the spread's operand to `never`
// at the call site (`core/events.ts`'s `bumpLikeCount` hit the same thing
// before this rewrite).
function withUpstream(l: LayoutSnapshot, upstream: Upstream | null): LayoutSnapshot {
  return { ...l, upstream };
}

function revKey(lineage: string | null, rev: number): string {
  return `${lineage ?? ""} ${rev}`;
}

export function foldLayout(events: Event[], revs: Map<string, { format: string | null; payload: unknown }>): FoldedLayout | null {
  let layout: LayoutSnapshot | null = null;
  const formats = new Map<string, FormatSnapshot>();
  // Coordinator review (LOW, third batch): `like_count` no longer lives
  // on any event's own `after` snapshot at all (see LayoutSnapshot's own
  // comment) -- likes are their own source of truth for counts, so this
  // tracks the running tally independently of `layout`, purely from every
  // `liked`/`unliked` event actually replayed, and attaches it to the
  // fold's OUTPUT once at the end, never to an intermediate snapshot.
  let likeCount = 0;

  for (const e of events) {
    if (e.rev !== null) {
      if (e.after === null) throw new Error(`foldLayout: rev-bumping event (seq ${e.seq}) has no 'after'`);
      if (e.after.scope === "layout") {
        layout = e.after;
      } else {
        const after = e.after;
        formats.set(after.lineage, after);
        if (after.upstream !== undefined && layout !== null) {
          layout = withUpstream(layout, after.upstream);
        }
      }
    } else if (e.kind === "liked" || e.kind === "unliked") {
      if (layout === null) throw new Error(`foldLayout: like event (seq ${e.seq}) precedes any write`);
      likeCount += e.kind === "liked" ? 1 : -1;
    }
  }

  if (layout === null) return null;
  const { scope: _s, ...layoutRow } = layout;
  const formatRows = new Map<string, FormatRow>();
  for (const [lin, snap] of formats) {
    const rev = revs.get(revKey(lin, snap.rev));
    if (rev === undefined) throw new Error(`foldLayout: no layout_revs entry for lineage '${lin}' rev ${snap.rev}`);
    const { scope: _s2, upstream: _u, ...rest } = snap;
    formatRows.set(lin, { ...rest, payload: rev.payload });
  }
  return { layout: { ...layoutRow, like_count: likeCount }, formats: formatRows };
}

export interface FeedFilter {
  layoutId?: string;
  actor?: string;
  format?: string; // 21-formats.md §2.4: `/history`'s optional filter -- absent means all, not a default
}

export async function feed(db: Bindings["DB"], since: number, limit: number, kinds?: string[], filter?: FeedFilter): Promise<{ next: number; items: Event[] }> {
  const cappedLimit = Math.min(limit, 1000);
  const params: unknown[] = [since];
  let sql = "SELECT * FROM events WHERE seq > ?";
  if (kinds !== undefined && kinds.length > 0) {
    sql += ` AND kind IN (${kinds.map(() => "?").join(",")})`;
    params.push(...kinds);
  }
  if (filter?.layoutId !== undefined) {
    sql += " AND layout_id = ?";
    params.push(filter.layoutId);
  }
  if (filter?.actor !== undefined) {
    sql += " AND actor = ?";
    params.push(filter.actor);
  }
  if (filter?.format !== undefined) {
    sql += " AND format = ?";
    params.push(filter.format);
  }
  sql += " ORDER BY seq ASC LIMIT ?";
  params.push(cappedLimit);

  const { results } = await db.prepare(sql).bind(...params).all<EventDbRow>();
  const items = results.map(rowToEvent);
  const next = items.length > 0 ? items[items.length - 1]!.seq : since;
  return { next, items };
}
