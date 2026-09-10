// The write pipeline (09 §2.6): one function per verb, all sharing the same
// spine -- resolve -> authorize -> check -> `appendWrite`. `src/routes/
// write.ts` is glue only (parse the request, call one of these, `c.json`
// the result) so LDB-W1 holds: no file under `src/routes/` prepares a D1
// statement. This module DOES prepare statements (the name-clash re-read,
// the `authors` existence check for transfer, the `last_write` lookup for a
// `stale` body) -- LDB-W1 is a routes/-only boundary, `appendWrite`/
// `appendLike` in `core/events.ts` stay the only code that writes `layouts`
// (LDB-P1, tests/tools/onlywriter.test.ts).
import type { Actor } from "../auth/actor";
import type { Bindings } from "../env";
import { get as getFormat, list as listFormats } from "../formats/registry";
import { resolveFormat, storedAsSpark } from "../../formats/registry.ts";
import { requireIfMatch, type IfMatch } from "./ifmatch";
import {
  ApiError,
  badRequest,
  formatNotWritable,
  internal,
  invalidName,
  nameTaken,
  notFound,
  notOwner,
  stale,
  unknownFormat,
  unsupportedForFormat,
  type ErrBody,
  type LastWrite,
} from "./errors";
import { appendLike, appendWrite, RevConflictError, rowToEvent, type EventDbRow, type Write } from "./events";
import { checkName } from "./names";
import { byRef, readById, readByName, toWire, type RecordRow } from "./records";
import type { Clock } from "./time";
import type { EditResult, FormatModule } from "../formats/registry";

const TRANSFER_USER_ID_RE = /^\d{17,20}$/;

// Every write that carries an EXISTING record's payload forward (delete,
// restore, transfer, the PATCH normalization below) stores it through
// spark, never verbatim (20-spark.md S2, LDB-F16/F21): a legacy-stored
// (`akl/1`/`cmini/1`) record is converted, and `has_magic` is recomputed
// from the converted payload -- `record.has_magic` itself may be stale
// (LDB-I10/I11-era rows) or simply wrong for a format the carry-forward
// changed. `spark/1` is always registered (LDB-T1's own bar), so this
// never actually throws -- the check only satisfies the type checker.
function sparkHasMagic(payload: unknown): boolean {
  const module = getFormat("spark/1");
  if (module === undefined) throw internal();
  return module.hasMagic(payload);
}

// byRef; a tombstone is reachable only by id and only when `allowDeleted`
// (restore -- a tombstone has no live name, so byRef's own name lookup
// already excludes it; this only matters for the id path). `admin: true`
// iff the ownership check passed ONLY because the actor is an admin -- this
// is exactly what a caller stamps onto the `Write`'s `admin` field (09
// §2.6: "on the event only when the actor is not the owner").
export async function loadForWrite(
  db: Bindings["DB"],
  ref: string,
  actor: Actor,
  opts: { allowDeleted: boolean },
): Promise<{ record: RecordRow; admin: boolean }> {
  const record = await byRef(db, ref);
  if (record === null || (record.deleted && !opts.allowDeleted)) {
    throw notFound(`no layout '${ref}'`, ref);
  }
  if (record.owner === actor.user_id) return { record, admin: false };
  if (actor.admin) return { record, admin: true };
  throw notOwner(record.name, record.owner);
}

async function latestRevBumpingEvent(db: Bindings["DB"], layoutId: string): Promise<LastWrite> {
  const row = await db
    .prepare("SELECT * FROM events WHERE layout_id = ? AND rev IS NOT NULL ORDER BY seq DESC LIMIT 1")
    .bind(layoutId)
    .first<EventDbRow>();
  // Unreachable in practice: every record reaching this point was created
  // by a rev-bumping write, so at least one such event always exists.
  if (row === null) throw internal();
  const e = rowToEvent(row);
  return { seq: e.seq, at: e.at, actor: e.actor, via: e.via, kind: e.kind, admin: e.admin };
}

// The `If-Match` pre-check (09 §2.3 point 1): the record is already in
// hand (from `loadForWrite`), so only `last_write` needs a read.
export async function requireRev(db: Bindings["DB"], record: RecordRow, ifMatch: IfMatch): Promise<void> {
  if (ifMatch.kind !== "rev" || ifMatch.rev === record.rev) return;
  const lastWrite = await latestRevBumpingEvent(db, record.id);
  throw stale(toWire(record) as Record<string, unknown> & { rev: number }, lastWrite);
}

// 20-spark.md S2 (LDB-F16): every write resolves `format` through the
// registry's alias table first -- `spark/1` (or `akl/1`, its alias)
// resolves to spark/1's module and stores natively (`module.id`, never
// the caller's own literal, so an `akl/1` write stores `spark/1` byte-
// identical); `mana2/1` resolves but its `role` is `"output"` -> `400
// format_not_writable`; `cmini/1` and anything unregistered don't resolve
// at all -> `400 unknown_format`, `known` listing registered ids only.
export function validatePayload(format: string, payload: unknown): { module: FormatModule; hasMagic: boolean } {
  const resolved = resolveFormat(format);
  if (resolved === undefined) {
    throw unknownFormat(
      format,
      listFormats().map((f) => f.id),
    );
  }
  if (resolved.module.role === "output") {
    throw formatNotWritable(format);
  }
  const result = resolved.module.validate(payload);
  if (!result.ok) throw new ApiError(400, result.error);
  return { module: resolved.module, hasMagic: resolved.module.hasMagic(payload) };
}

// Maps the two D1-constraint outcomes `appendWrite` surfaces (09 §2.3) onto
// the route-facing errors: a lost rev race -> re-read the winner, 409
// `stale`; a lost name race -> re-read the holder, 409 `name_taken` with
// `holder` (the bare `nameTaken` `appendWrite` itself throws doesn't know
// who holds the name, only that something does).
async function commitWrite(db: Bindings["DB"], now: Clock, write: Write): Promise<{ record: RecordRow; seq: number }> {
  try {
    return await appendWrite(db, now, write);
  } catch (e) {
    if (e instanceof RevConflictError) {
      const current = await readById(db, e.layoutId);
      if (current !== null) {
        const lastWrite = await latestRevBumpingEvent(db, e.layoutId);
        throw stale(toWire(current) as Record<string, unknown> & { rev: number }, lastWrite);
      }
    }
    if (e instanceof ApiError && e.body.error === "name_taken" && e.body.holder === undefined) {
      const holderRec = await readByName(db, write.name);
      if (holderRec !== null) {
        throw nameTaken(write.name, { id: holderRec.id, owner: holderRec.owner });
      }
    }
    throw e;
  }
}

export interface CreateBody {
  name: string;
  format: string;
  payload: unknown;
}

// LDB-P9 (design/layout-db/18-command-decisions.md §2 D1; saltorbit,
// 2026-09-10: "tombstoned name carries likes for whoever takes it. it's a
// quirk people like"): the name column has no per-status uniqueness
// constraint beyond `layouts_name_live` (live rows only, migrations/
// 0001_init.sql), so more than one tombstone can hold the same literal
// name (case-insensitively -- the column's own COLLATE) over a record's
// history. "The" tombstone a re-add inherits from is the most recently
// modified one -- ties broken by `rev` (impossible in practice: two rows
// can't share both `name` and `modified_at` unless one wrote the other,
// which only rev can order).
async function latestTombstoneIdByName(db: Bindings["DB"], name: string): Promise<string | null> {
  const row = await db
    .prepare("SELECT id FROM layouts WHERE name = ? AND deleted = 1 ORDER BY modified_at DESC, rev DESC LIMIT 1")
    .bind(name)
    .first<{ id: string }>();
  return row?.id ?? null;
}

async function likeUserIds(db: Bindings["DB"], layoutId: string): Promise<string[]> {
  const { results } = await db
    .prepare("SELECT user_id FROM likes WHERE layout_id = ? ORDER BY user_id ASC")
    .bind(layoutId)
    .all<{ user_id: string }>();
  return results.map((r) => r.user_id);
}

// POST /v1/layouts: any actor; check_name -> validate -> create (09 §3 T2).
// LDB-P9: a name currently held by a tombstone (ANY owner, not just the
// same actor -- Q3 in `18-command-decisions.md` §3 confirmed the
// different-actor half) has its likes copied onto the new record as
// `liked` events `via: "name_inherited"`, `detail: {from: <tombstone id>}`
// -- read BEFORE the create's own write so a concurrent restore of that
// SAME tombstone (LDB-P8, 30-day owner window or any-time admin) racing
// this POST is decided by which one's D1 statement actually lands first,
// same as any other race in this file; the tombstone itself keeps its own
// likes and history untouched (appendLike never removes a like from its
// SOURCE record) and stays restorable, which would then leave both records
// carrying the same users' likes -- accepted, documented in `18`.
export async function createLayout(
  env: Bindings,
  now: Clock,
  actor: Actor,
  body: CreateBody,
): Promise<{ record: RecordRow; seq: number }> {
  const nameCheck = checkName(body.name);
  if (!nameCheck.ok) throw invalidName(body.name, nameCheck.message);
  const { hasMagic, module } = validatePayload(body.format, body.payload);

  const tombstoneId = await latestTombstoneIdByName(env.DB, body.name);

  const result = await commitWrite(env.DB, now, {
    kind: "created",
    name: body.name,
    owner: actor.user_id,
    modified_at: now(),
    format: module.id, // native id: an `akl/1` write stores `spark/1` (LDB-F16/F20)
    payload: body.payload,
    actor: actor.user_id,
    via: actor.via,
    hasMagic,
  });

  if (tombstoneId === null) return result;

  // `record.like_count` was captured at rev 1 (always 0 for a fresh
  // create) BEFORE these likes landed -- carried forward from the last
  // `appendLike`'s own return (the same derived-from-`likes` count
  // `appendLike` always answers, LDB-L1) so the response this returns
  // reflects the inherited likes instead of silently under-reporting them
  // until the next read.
  let likeCount = result.record.like_count;
  for (const userId of await likeUserIds(env.DB, tombstoneId)) {
    ({ like_count: likeCount } = await appendLike(env.DB, now, {
      kind: "liked",
      layoutId: result.record.id,
      userId,
      via: "name_inherited",
      detail: { from: tombstoneId },
    }));
  }
  return { record: { ...result.record, like_count: likeCount }, seq: result.seq };
}

export interface ReplaceBody {
  format: string;
  payload: unknown;
}

// PUT /v1/layouts/{ref}: owner or admin; whole payload replaced, name/
// owner/created_at kept, format may change.
//
// 20-spark.md S2 (saltorbit's decision 6 + the lead's answer to §8 Q1): magic
// edits fork like any user write now -- `isMagicOnlyReplace` and its
// `detail.magic_only` marker are gone, so `modified_at` bumps here
// unconditionally, same as every other PUT. `core/follows.ts`'s
// `legacyFollows`/`followsUpstream` keeps reading the marker off
// HISTORICAL events (LDB-I12, narrowed not deleted) -- nothing new ever
// writes it again.
export async function replaceLayout(
  env: Bindings,
  now: Clock,
  actor: Actor,
  ref: string,
  body: ReplaceBody,
  ifMatch: IfMatch,
): Promise<{ record: RecordRow; seq: number }> {
  const db = env.DB;
  requireIfMatch(ifMatch);
  const { record, admin } = await loadForWrite(db, ref, actor, { allowDeleted: false });
  await requireRev(db, record, ifMatch);
  const { hasMagic, module } = validatePayload(body.format, body.payload);

  return commitWrite(db, now, {
    kind: "updated",
    layoutId: record.id,
    name: record.name,
    owner: record.owner,
    modified_at: now(),
    format: module.id,
    payload: body.payload,
    actor: actor.user_id,
    via: actor.via,
    admin,
    hasMagic,
  });
}

// DELETE /v1/layouts/{ref}: owner or admin; tombstones (payload/format/name
// kept, `deleted: true`); frees the name.
//
// 20-spark.md S2 (LDB-F16/F21, §8 R-H2): carries the record's payload
// forward through `storedAsSpark`, not `record.format`/`record.payload`
// verbatim -- otherwise deleting an unmigrated legacy-stored record would
// re-store its old format, breaking "every accepted write stores
// spark/<latest>". `has_magic` is recomputed from the converted payload
// (`record.has_magic` may disagree once the payload's shape changed).
export async function deleteLayout(
  env: Bindings,
  now: Clock,
  actor: Actor,
  ref: string,
  ifMatch: IfMatch,
): Promise<{ record: RecordRow; seq: number }> {
  const db = env.DB;
  requireIfMatch(ifMatch);
  const { record, admin } = await loadForWrite(db, ref, actor, { allowDeleted: false });
  await requireRev(db, record, ifMatch);
  const stored = storedAsSpark(record.format, record.payload);

  return commitWrite(db, now, {
    kind: "deleted",
    layoutId: record.id,
    name: record.name,
    owner: record.owner,
    modified_at: now(),
    format: stored.format,
    payload: stored.payload,
    actor: actor.user_id,
    via: actor.via,
    admin,
    deleted: true,
    hasMagic: sparkHasMagic(stored.payload),
  });
}

export interface RestoreBody {
  name?: string;
}

// POST /v1/layouts/{ref}/restore: `{ref}` must be the id (a tombstone has
// no live name, so byRef's name path never finds one anyway); owner or
// admin, no time limit (20-spark.md §1 decision 8 -- the 30-day owner
// window is gone: tombstones were never pruned, so there is no storage
// pressure the window was protecting against). No `If-Match` -- a
// tombstone has one possible next state.
//
// Decision 9 (refined in review, §8 R-L1): the body is optional (absent,
// `{}`, or `{name}`; the route's `parseRestoreBody` refuses anything else
// with `400 bad_request`, LDB-A7). Without `name`, restoring under the
// tombstone's own (possibly reclaimed) name answers `409 name_taken` with
// `holder` exactly as any other name clash does (`commitWrite`'s own
// catch). With a DIFFERENT `name`, it goes through `check_name` (LDB-N1
// amended) and the event is `restored` with `detail: {renamed_from}`
// (LDB-P8 amended) -- both records keep their own likes; a restore frees
// no name (LDB-P4 untouched).
//
// LDB-F16/F21/§8 R-H2: the payload is carried forward through
// `storedAsSpark`, not verbatim, and `has_magic` is recomputed -- same
// reasoning as `deleteLayout`.
export async function restoreLayout(
  env: Bindings,
  now: Clock,
  actor: Actor,
  ref: string,
  body: RestoreBody = {},
): Promise<{ record: RecordRow; seq: number }> {
  const db = env.DB;
  const { record, admin } = await loadForWrite(db, ref, actor, { allowDeleted: true });

  if (!record.deleted) {
    throw badRequest(`'${record.name}' is not deleted`, "/ref");
  }

  let name = record.name;
  let renamedFrom: string | undefined;
  if (body.name !== undefined && body.name !== record.name) {
    const nameCheck = checkName(body.name);
    if (!nameCheck.ok) throw invalidName(body.name, nameCheck.message);
    name = body.name;
    renamedFrom = record.name;
  }

  const stored = storedAsSpark(record.format, record.payload);

  return commitWrite(db, now, {
    kind: "restored",
    layoutId: record.id,
    name,
    owner: record.owner,
    modified_at: now(),
    format: stored.format,
    payload: stored.payload,
    actor: actor.user_id,
    via: actor.via, // stops a follow of upstream (LDB-I2a): this becomes the latest rev-bumping event
    admin,
    deleted: false,
    hasMagic: sparkHasMagic(stored.payload),
    ...(renamedFrom !== undefined ? { detail: { renamed_from: renamedFrom } } : {}),
  });
}

export interface TransferBody {
  to: string;
}

// POST /v1/layouts/{ref}/transfer: owner or admin; `to` must name a known
// user (an `authors` row -- an author, or anyone who has signed in once)
// and differ from the current owner. `If-Match` is required (saltorbit's rule,
// 2026-09-09: the client must name the version it saw) but its VALUE is
// never checked against `record.rev` -- ownership has no draft to be
// stale, so `requireIfMatch` (presence only) is all that runs here, not
// `requireRev`.
//
// LDB-F16/F21/§8 R-H2: carries the payload forward through `storedAsSpark`
// and recomputes `has_magic`, same reasoning as `deleteLayout`.
export async function transferLayout(
  env: Bindings,
  now: Clock,
  actor: Actor,
  ref: string,
  body: TransferBody,
  ifMatch: IfMatch,
): Promise<{ record: RecordRow; seq: number }> {
  const db = env.DB;
  requireIfMatch(ifMatch);
  const { record, admin } = await loadForWrite(db, ref, actor, { allowDeleted: false });

  if (body.to === record.owner) throw badRequest("already the owner", "/to");
  if (!TRANSFER_USER_ID_RE.test(body.to)) throw badRequest(`unknown user '${body.to}'`, "/to");
  const author = await db.prepare("SELECT 1 FROM authors WHERE user_id = ?").bind(body.to).first();
  if (author === null) throw badRequest(`unknown user '${body.to}'`, "/to");

  const stored = storedAsSpark(record.format, record.payload);

  return commitWrite(db, now, {
    kind: "transferred",
    layoutId: record.id,
    name: record.name,
    owner: body.to,
    modified_at: now(),
    format: stored.format,
    payload: stored.payload,
    actor: actor.user_id,
    via: actor.via,
    admin,
    hasMagic: sparkHasMagic(stored.payload),
  });
}

export interface PatchBody {
  name?: string;
  fingermap?: Record<string, string>;
  board?: unknown;
  magic?: unknown;
}

const PATCH_FIELDS = ["name", "fingermap", "board", "magic"] as const;
type PatchField = (typeof PATCH_FIELDS)[number];
type PatchEditField = Exclude<PatchField, "name">;

// `EditResult`'s error branch (registry.ts's `FormatEdits` contract): no
// stored payload -- cmini/1's or akl/1's, both `additionalProperties:
// false` with no top-level `error` key -- can ever collide with this
// shape, so the presence of an `error` key alone disambiguates it from a
// genuine payload.
function isEditError(r: EditResult): r is { error: ErrBody } {
  return typeof r === "object" && r !== null && "error" in (r as object);
}

// Runs one PATCH verb's edit (09 §2.6): no `edits` entry for this format at
// all, or the edit's own `{error}` answer, both refuse the verb -- with the
// edit's own `invalid_payload` forwarded verbatim (it names its own path),
// anything else collapsing to the generic `unsupported_for_format` naming
// the format and verb. `p`/`arg`/the return are typed `any` (registry.ts's
// own `Payload = any`, §5: "a format's payload shape is its own business")
// -- `unknown` here would make every concrete `edits.set*` (declared with
// the format's own narrower per-verb argument type, e.g. `map:
// Record<string, string>`) fail assignment to this slot under
// `strictFunctionTypes`.
/* eslint-disable @typescript-eslint/no-explicit-any */
function runEdit(
  format: string,
  verb: PatchEditField,
  edit: ((p: any, arg: any) => EditResult) | undefined,
  payload: any,
  arg: any,
): any {
  if (edit === undefined) throw unsupportedForFormat(format, verb);
  const result = edit(payload, arg);
  if (isEditError(result)) {
    if (result.error.error === "invalid_payload") throw new ApiError(400, result.error);
    throw unsupportedForFormat(format, verb);
  }
  return result;
}
/* eslint-enable @typescript-eslint/no-explicit-any */

// PATCH /v1/layouts/{ref}: owner or admin; one or more of {name, fingermap,
// board, magic}, applied in that order to a clone of the current payload
// via the record's format `edits` (09 §2.6, §3 T4), validated once as a
// whole, one event: `renamed` when the body is exactly {name}, `fingermap`
// when exactly {fingermap}, else `updated` with `detail: { fields }` in
// application order. `name` goes through the same `check_name` POST uses;
// it may differ from the current name only by case (still `renamed` --
// `appendWrite`'s self-exclusion, §2.3, allows it).
export async function patchLayout(
  env: Bindings,
  now: Clock,
  actor: Actor,
  ref: string,
  body: PatchBody,
  ifMatch: IfMatch,
): Promise<{ record: RecordRow; seq: number }> {
  const db = env.DB;
  requireIfMatch(ifMatch);
  const { record, admin } = await loadForWrite(db, ref, actor, { allowDeleted: false });
  await requireRev(db, record, ifMatch);

  // 20-spark.md S2 (LDB-F16/F21): any legacy-stored record is converted to
  // spark FIRST, whatever the PATCH names -- `storedAsSpark` is the SAME
  // conversion every read and every carry-forward write uses, so a
  // fingermap/board PATCH on a `cmini/1` record no longer needs the cmini
  // adapter's own `edits` at all (it never has: spark's `edits` covers
  // fingermap/board/magic uniformly). Every field in this PATCH (name/
  // fingermap/board/magic) is then applied against the NEW format, not
  // the old one -- one write, one format.
  const stored = storedAsSpark(record.format, record.payload);
  let format = stored.format;
  let payload: unknown = stored.payload;

  const module = getFormat(format);
  if (module === undefined) {
    throw unknownFormat(
      format,
      listFormats().map((f) => f.id),
    );
  }

  const fields = PATCH_FIELDS.filter((f) => body[f] !== undefined);

  let name = record.name;
  if (body.name !== undefined) {
    const nameCheck = checkName(body.name);
    if (!nameCheck.ok) throw invalidName(body.name, nameCheck.message);
    name = body.name;
  }

  if (body.fingermap !== undefined) {
    payload = runEdit(format, "fingermap", module.edits?.setFingermap, payload, body.fingermap);
  }
  if (body.board !== undefined) {
    payload = runEdit(format, "board", module.edits?.setBoard, payload, body.board);
  }
  if (body.magic !== undefined) {
    payload = runEdit(format, "magic", module.edits?.setMagic, payload, body.magic);
  }

  const { hasMagic } = validatePayload(format, payload);

  const kind = fields.length === 1 && fields[0] === "name" ? "renamed" : fields.length === 1 && fields[0] === "fingermap" ? "fingermap" : "updated";

  // 20-spark.md S2 (decision 6): magic edits fork like any other write now
  // -- there is no more magic-only exemption on a NEW write. `modified_at`
  // bumps unconditionally and no event ever writes `detail.magic_only`
  // again (LDB-I12 narrowed: `core/follows.ts` keeps skipping the marker
  // on HISTORICAL events only).
  return commitWrite(db, now, {
    kind,
    layoutId: record.id,
    name,
    owner: record.owner,
    modified_at: now(),
    format,
    payload,
    actor: actor.user_id,
    via: actor.via,
    admin,
    hasMagic,
    ...(kind === "updated" ? { detail: { fields } } : {}),
  });
}
