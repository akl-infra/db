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
  // design/layout-db/23-geometry.md §4.6 (LDB-F28): `fromCmini` relabelled
  // a `TB` finger, or an `LT`/`RT` thumb whose column disagreed with the
  // `col < 5 => LT else RT` rule -- `import/apply.ts` records one of these
  // per id whose `describeImportChanges(...).relabeled` is non-empty,
  // naming every relabelled key/free position in `detail`.
  | "import_relabel"
  | "upstream_deleted"
  | "admin.added"
  | "admin.removed"
  | "admin.import_paused"
  | "admin.import_resumed"
  | "admin.client_registered"
  | "admin.client_revoked"
  | "admin.import_ticked"
  | "admin.diff_ticked"
  | "admin.nightly_ticked"
  // L5 moderation (design/akldb-site/01-plan.md §4): bans are actor-scoped
  // (`layout_id` NULL, `appendAdmin`) -- author-rename/link are
  // layout-scoped (`appendModeration`/`appendLinkChange`, `layout_id` set,
  // `rev` NULL). The like-count override's own kind (admin dot likes_set)
  // was retired H24 (2026-09-13) -- see `foldLayout`'s comment for the
  // historical-event fallback.
  | "admin.user_banned"
  | "admin.user_unbanned"
  | "admin.author_renamed"
  | "link_submitted"
  | "link_approved"
  | "link_rejected"
  | "link_cleared";

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
// L5 moderation (§4.4, LDB-MD3): the `after` of a `link_approved` /
// `link_cleared` event -- never a full `LayoutSnapshot` (these are
// `rev: NULL` info events, no scope's rev bumps), just the one folded field
// it carries. `foldLayout` reads these by `kind`, not by `rev !== null`
// (the layout/format branch above), so there is no overlap.
export interface LinkSnapshot {
  scope: "link";
  link: string | null;
}
export type EventSnapshot = LayoutSnapshot | FormatSnapshot | LinkSnapshot;

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

  // LDB-L8a: no separate name-clash pre-read. `layouts_name_live` (a
  // partial UNIQUE index on `name WHERE deleted = 0`, migrations/
  // 0001_init.sql/0009_formats.sql) is the ONLY enforcement point
  // (tests/events/races.test.ts's own header: "the concurrency guard lives
  // INSIDE the write batch, not in the pre-checks") -- a live layout-scope
  // write that would clash fails the batch below with `UNIQUE constraint
  // failed: layouts.name`, caught right after `db.batch()` and mapped to
  // the exact same `nameTaken()` this pre-check used to throw. Removing it
  // saves one D1 round trip on every create/rename/restore/transfer's
  // common (non-colliding) path, at no behavioral cost: the constraint
  // already had to hold for correctness (two concurrent writes can't both
  // pass a pre-check), so this pre-check was read-then-hope-nothing-races,
  // never the actual guard.
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
  // H24 (2026-09-13): `like_count` self-heals to `COUNT(DISTINCT user_id)
  // FROM likes` on every rev-bumping write, never the raw pre-read count --
  // `like_adjust` is a dead column (migrations/0015) that no code reads or
  // writes any more; a fresh create has no prior row to read, so its own
  // `VALUES` supplies the pre-read count directly. `link` is likewise never
  // touched by an ordinary write (only `appendLinkChange` may -- LDB-P1's
  // onlywriter test names both).
  stmts.push(
    db
      .prepare(
        `INSERT INTO layouts (id, name, owner, n, layout_rev, created_at, modified_at, deleted, like_count, link, upstream_source, upstream_id, upstream_state, source_client, source_version)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?)
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

  // M1: read `like_count`/`link` back in the SAME batch, after the
  // `layouts` upsert's own self-healing subquery has run, so the value
  // this call RETURNS to its own caller (the response body an ordinary
  // write's caller sees) is the same live truth the row now holds --
  // never `finalLikeCount`, which can be a stale pre-read for any write
  // that isn't itself about a like.
  const likeCountStmtIdx = stmts.length;
  stmts.push(db.prepare(`SELECT like_count, link FROM layouts WHERE id = ?`).bind(id));

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

  const selfHealed = results[likeCountStmtIdx]?.results?.[0] as { like_count: number; link: string | null } | undefined;
  const trueLikeCount = selfHealed?.like_count ?? finalLikeCount;

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
    link: selfHealed?.link ?? null,
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

// [LDB-MD7] `via`/`source` default to the pre-L5 hard-coded values so
// EVERY existing call site (admins.ts's add/remove/pause/resume/manual
// ticks) is byte-for-byte unchanged -- L5's own new callers (bans,
// author-rename) pass the actor's real lane explicitly (LDB-A5: every
// event carries the actor's own lane).
export async function appendAdmin(
  db: Bindings["DB"],
  now: Clock,
  a: { kind: InfoKind; actor: string; via?: string; source?: Source; detail?: object },
): Promise<{ seq: number }> {
  const result = await db
    .prepare(
      `INSERT INTO events (at, kind, layout_id, name, owner, format, rev, actor, via, admin, detail_json, before_json, after_json, source_client, source_version)
       VALUES (?, ?, NULL, NULL, NULL, NULL, NULL, ?, ?, 1, ?, NULL, NULL, ?, ?)`,
    )
    .bind(now(), a.kind, a.actor, a.via ?? "discord", a.detail === undefined ? null : canonical(a.detail), a.source?.client ?? null, a.source?.version ?? null)
    .run();

  const seq = result.meta.last_row_id;
  if (seq === undefined) throw new Error("appendAdmin: events insert returned no last_row_id");
  return { seq };
}

// [LDB-MD7] The layout-scoped sibling of `appendAdmin` (§4.4's reviewer
// note 6): an admin action against ONE layout that carries an `after`
// snapshot of its own. `rev` stays NULL (never rev-bumping); always
// `admin: 1` -- every caller of this function IS a moderation action by
// definition (`link_rejected` today).
export interface Moderation {
  kind: InfoKind;
  layoutId: string;
  actor: string;
  via: string;
  source: Source;
  detail?: object;
  after?: object;
}

export async function appendModeration(db: Bindings["DB"], now: Clock, m: Moderation): Promise<{ seq: number }> {
  const current = await readById(db, m.layoutId);
  if (current === null) throw new Error(`appendModeration: layoutId '${m.layoutId}' does not exist`);

  const result = await db
    .prepare(
      `INSERT INTO events (at, kind, layout_id, name, owner, format, rev, actor, via, admin, detail_json, before_json, after_json, source_client, source_version)
       VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, ?, 1, ?, NULL, ?, ?, ?)`,
    )
    .bind(
      now(),
      m.kind,
      m.layoutId,
      current.name,
      current.owner,
      m.actor,
      m.via,
      m.detail === undefined ? null : canonical(m.detail),
      m.after === undefined ? null : canonical(m.after),
      m.source.client,
      m.source.version,
    )
    .run();

  const seq = result.meta.last_row_id;
  if (seq === undefined) throw new Error("appendModeration: events insert returned no last_row_id");
  return { seq };
}

// [LDB-MD3] [LDB-MD5] [LDB-MD7] §4.4: the ONLY writer of `layouts.link`
// (LDB-P1, `tests/tools/onlywriter.test.ts`'s allow-list names this
// function's home file, never `core/links.ts`). One batch: the `layouts`
// UPDATE, the `link_approved`/`link_cleared` event (`after.link` so
// `foldLayout` replays exactly), and -- always, not just on approve -- a
// sweep that supersedes every OTHER still-pending submission for this
// layout (covers both "approving supersedes any other pending submission"
// and "clearing supersedes the pending submission it had", with no
// separate event for that bookkeeping, same as a fresh owner submission
// superseding an older pending one).
export interface LinkChange {
  layoutId: string;
  kind: "link_approved" | "link_cleared";
  link: string | null;
  actor: string;
  via: string;
  admin: boolean;
  source: Source;
  submissionId?: string; // the submission THIS approval decides, if any
}

export async function appendLinkChange(db: Bindings["DB"], now: Clock, l: LinkChange): Promise<{ seq: number; link: string | null }> {
  const current = await readById(db, l.layoutId);
  if (current === null) throw new Error(`appendLinkChange: layoutId '${l.layoutId}' does not exist`);

  const at = now();
  const stmts: D1PreparedStatement[] = [
    db.prepare("UPDATE layouts SET link = ? WHERE id = ?").bind(l.link, l.layoutId),
    db
      .prepare(
        `INSERT INTO events (at, kind, layout_id, name, owner, format, rev, actor, via, admin, detail_json, before_json, after_json, source_client, source_version)
         VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, NULL, NULL, ?, ?, ?)`,
      )
      .bind(at, l.kind, l.layoutId, current.name, current.owner, l.actor, l.via, l.admin ? 1 : 0, canonical({ scope: "link", link: l.link }), l.source.client, l.source.version),
  ];
  if (l.submissionId !== undefined) {
    stmts.push(
      db
        .prepare("UPDATE link_submissions SET status = 'approved', decided_by = ?, decided_at = ? WHERE id = ? AND status = 'pending'")
        .bind(l.actor, at, l.submissionId),
    );
  }
  stmts.push(
    db
      .prepare("UPDATE link_submissions SET status = 'superseded', decided_by = ?, decided_at = ? WHERE layout_id = ? AND status = 'pending' AND id != ?")
      .bind(l.actor, at, l.layoutId, l.submissionId ?? ""),
  );

  const results = await db.batch(stmts);
  const seq = results[1]?.meta.last_row_id;
  if (seq === undefined) throw new Error("appendLinkChange: events insert returned no last_row_id");
  return { seq, link: l.link };
}

export interface Like {
  kind: "liked" | "unliked";
  layoutId: string;
  userId: string;
  via: string;
  detail?: object;
  source: Source;
  // LDB-L8b: when the caller already has a fresh `LayoutRow` for
  // `layoutId` in hand (`core/likes.ts`'s `loadForLike` reads it anyway,
  // to check `deleted`/the qwerty refusal before calling this), pass it
  // here so this function doesn't re-read the same row a second time.
  // Omitted, this reads it itself (every existing caller: the tombstone
  // name-inheritance loop in `core/write.ts`, `import/apply.ts`, and every
  // direct test call) -- behavior-identical either way, since `current` is
  // used only for its `name`/`owner` (denormalized onto the event row) and
  // the `like_count` fallback below.
  current?: LayoutRow;
}

// D13 L1/L2 (saltorbit, 2026-09-11): a like/unlike needs no version (L3), but
// it is no longer a silent no-op on repeat -- a repeat like fails with
// `409 already_liked`, a redundant unlike with `409 not_liked`, and either
// way NOTHING is written (no event, `like_count` untouched). Layout-level,
// same as ever -- no format is involved.
//
// LDB-L8b (review/LEDGER.md L8): no pre-batch "am I already liked?" read
// any more -- straight to the guarded batch below, whose own EXISTS/
// NOT EXISTS conditions already decide the exact same already_liked/
// not_liked outcome at commit time (`results[0].meta.changes === 0`
// below), race or no race. This is not a behavior change (every caller
// already tolerated this outcome, since a CONCURRENT request could always
// reach the batch's guard first); it's one fewer D1 round trip on every
// like/unlike, not just the racing ones.
export async function appendLike(db: Bindings["DB"], now: Clock, l: Like): Promise<{ seq: number; like_count: number }> {
  const current = l.current ?? (await readById(db, l.layoutId));
  if (current === null) throw new Error(`appendLike: layoutId '${l.layoutId}' does not exist`);

  const wantsLike = l.kind === "liked";
  const at = now();

  // Coordinator review (HIGH): two concurrent unlikes from the same user
  // could both DELETE (the loser's own DELETE just removes 0 rows, no
  // error) and both append an `unliked` event -- the second caller
  // wrongly gets 200 (breaks L2) and the fold subtracts twice (breaks
  // MF-3). Fixed by making the EVENT insert itself conditional on the row
  // it's about to react to STILL being true AT BATCH-COMMIT TIME (D1
  // batches serialize like any other writer transaction, so a losing
  // batch re-evaluates this EXISTS/NOT EXISTS against the winner's
  // already-committed state) -- 0 rows inserted means this call's own
  // premise no longer holds, and the DELETE/likes-count recompute below
  // are then no-ops. The same EXISTS also folds in the LOW fix for a like
  // racing a delete: a layout that's gone `deleted` by batch-commit time
  // inserts nothing either, so a post-batch fresh read tells the two
  // cases apart.
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
      // H24 (2026-09-13): `like_count` is exactly `COUNT(*) FROM likes` --
      // no adjustment, no admin override.
      db
        .prepare("UPDATE layouts SET like_count = (SELECT COUNT(*) FROM likes WHERE layout_id = ?) WHERE id = ?")
        .bind(l.layoutId, l.layoutId),
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

// LDB-L8c (review/LEDGER.md L8): `core/write.ts`'s `createLayout`, when a
// tombstoned name it's reclaiming (LDB-P9) had likes, used to copy them
// one `appendLike` call at a time -- a read, a pre-check and a batch EACH,
// so reclaiming a well-liked name cost 3x its liker count in D1 round
// trips. This is the same outcome (one `liked` event per former liker,
// `via`/`detail` shared, plus a real `likes` row copied for each) in ONE
// batch, however many likers -- `userIds` must be non-empty (callers
// already only reach this when it is, LDB-P9's own "nothing to inherit"
// case never calls it at all).
export async function appendInheritedLikes(
  db: Bindings["DB"],
  now: Clock,
  a: { layoutId: string; name: string; owner: string; userIds: string[]; via: string; detail: object; source: Source },
): Promise<{ like_count: number }> {
  const at = now();
  const detailJson = canonical(a.detail);

  // One `liked` event per former liker -- same shape `appendLike`'s own
  // event insert would have written (LDB-P9's feed/changes readers see no
  // difference), same live-layout guard, and ALSO guarded against a real,
  // direct like from this exact user landing in the tiny window between
  // the create's own commit and this batch (rare, but the guard costs
  // nothing and keeps `likes`' PK from ever seeing a duplicate attempt).
  const eventStmts = a.userIds.map((userId) =>
    db
      .prepare(
        `INSERT INTO events (at, kind, layout_id, name, owner, format, rev, actor, via, admin, detail_json, before_json, after_json, source_client, source_version)
         SELECT ?, 'liked', ?, ?, ?, NULL, NULL, ?, ?, 0, ?, NULL, NULL, ?, ?
         WHERE EXISTS (SELECT 1 FROM layouts WHERE id = ? AND deleted = 0)
           AND NOT EXISTS (SELECT 1 FROM likes WHERE layout_id = ? AND user_id = ?)`,
      )
      .bind(at, a.layoutId, a.name, a.owner, userId, a.via, detailJson, a.source.client, a.source.version, a.layoutId, a.layoutId, userId),
  );

  // The `likes` rows themselves, copied one INSERT per liker (same guard)
  // -- kept per-user, not one bulk `INSERT ... SELECT FROM likes WHERE
  // layout_id = tombstone`, so a like that lands mid-batch-window for ONE
  // specific user is skipped for that user alone rather than silently
  // deciding the whole copy atomically one way or the other.
  const likeStmts = a.userIds.map((userId) =>
    db
      .prepare(
        `INSERT INTO likes (layout_id, user_id, at, via)
         SELECT ?, ?, ?, ?
         WHERE EXISTS (SELECT 1 FROM layouts WHERE id = ? AND deleted = 0)
           AND NOT EXISTS (SELECT 1 FROM likes WHERE layout_id = ? AND user_id = ?)`,
      )
      .bind(a.layoutId, userId, at, a.via, a.layoutId, a.layoutId, userId),
  );

  const results = await db.batch([
    ...eventStmts,
    ...likeStmts,
    db.prepare("UPDATE layouts SET like_count = (SELECT COUNT(*) FROM likes WHERE layout_id = ?) WHERE id = ?").bind(a.layoutId, a.layoutId),
    db.prepare("SELECT like_count FROM layouts WHERE id = ?").bind(a.layoutId),
  ]);

  const last = results[results.length - 1];
  const counted = (last?.results?.[0] as { like_count: number } | undefined)?.like_count;
  return { like_count: counted ?? 0 };
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
  // [LDB-MD3] §4.4: `link` is a fold of the latest `link_approved` /
  // `link_cleared` event's `after` -- tracked the same way `likeCount` is,
  // independent of `layout`, and attached to the fold's output once at
  // the end.
  let link: string | null = null;

  for (const e of events) {
    if (e.rev !== null) {
      if (e.after === null) throw new Error(`foldLayout: rev-bumping event (seq ${e.seq}) has no 'after'`);
      if (e.after.scope === "layout") {
        layout = e.after;
      } else if (e.after.scope === "format") {
        const after = e.after;
        formats.set(after.lineage, after);
        if (after.upstream !== undefined && layout !== null) {
          layout = withUpstream(layout, after.upstream);
        }
      } else {
        throw new Error(`foldLayout: rev-bumping event (seq ${e.seq}) has an unexpected 'after' scope`);
      }
    } else if (e.kind === "liked" || e.kind === "unliked") {
      if (layout === null) throw new Error(`foldLayout: like event (seq ${e.seq}) precedes any write`);
      likeCount += e.kind === "liked" ? 1 : -1;
    } else if (e.kind === "admin.likes_set") {
      // Retired (H24, 2026-09-13): the admin like-count override is gone,
      // but a pre-existing event log (or a dump taken before this change)
      // may still carry this kind -- ignore it rather than throw.
    } else if (e.kind === "link_approved" || e.kind === "link_cleared") {
      if (e.after === null || e.after.scope !== "link") throw new Error(`foldLayout: ${e.kind} event (seq ${e.seq}) has no link 'after'`);
      link = e.after.link;
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
  return {
    layout: { ...layoutRow, like_count: Math.max(0, likeCount), link },
    formats: formatRows,
  };
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
