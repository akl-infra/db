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
import * as cmini1 from "../../formats/cmini/1/index";
import { fromCmini } from "../../formats/akl/1/translate";
import { requireIfMatch, type IfMatch } from "./ifmatch";
import {
  ApiError,
  badRequest,
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
import { canonical } from "./canonical";
import { appendLike, appendWrite, RevConflictError, rowToEvent, type EventDbRow, type Write } from "./events";
import { checkName } from "./names";
import { byRef, readById, readByName, toWire, type RecordRow } from "./records";
import type { Clock } from "./time";
import type { EditResult, FormatModule } from "../formats/registry";

const RESTORE_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const TRANSFER_USER_ID_RE = /^\d{17,20}$/;

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

export function validatePayload(format: string, payload: unknown): { module: FormatModule; hasMagic: boolean } {
  const module = getFormat(format);
  if (module === undefined) {
    throw unknownFormat(
      format,
      listFormats().map((f) => f.id),
    );
  }
  const result = module.validate(payload);
  if (!result.ok) throw new ApiError(400, result.error);
  return { module, hasMagic: module.hasMagic(payload) };
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
  const { hasMagic } = validatePayload(body.format, body.payload);

  const tombstoneId = await latestTombstoneIdByName(env.DB, body.name);

  const result = await commitWrite(env.DB, now, {
    kind: "created",
    name: body.name,
    owner: actor.user_id,
    modified_at: now(),
    format: body.format,
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

// `magic` is always a top-level payload key in every format that has one
// (cmini/1's flat `MagicRow[]`, akl/1's `MagicIntent` object) -- stripping
// it this way, rather than through a format-specific projection, is exactly
// right for comparing a payload against ANOTHER payload already known to
// be the same format (this function's two call sites below never compare
// across formats without lifting one side first).
function payloadMinusMagic(payload: unknown): unknown {
  if (typeof payload !== "object" || payload === null) return payload;
  const { magic: _magic, ...rest } = payload as Record<string, unknown>;
  return rest;
}

// LDB-I12 (design/layout-db/18-command-decisions.md §2 item 1): "a PATCH
// whose body is ONLY {magic} ... (and the migration's equivalent) keeps
// the record following cmini". `scripts/migrate_magic_rules_to_db.py`
// writes through PUT (a whole-payload replace, `format: "akl/1"` even for
// a `cmini/1` record it read via `?as=akl/1`), not PATCH -- this is that
// migration's equivalent: a PUT is magic-only when its payload, minus
// `magic`, is byte-for-byte the record's own current content minus `magic`
// (translated to a common format first when the format itself changed,
// the same lossless `fromCmini` lift `patchLayout`'s magic PATCH uses).
// Anything else that changed alongside magic -- keys, board, free, x --
// fails this and forks as any other PUT always has.
function isMagicOnlyReplace(record: RecordRow, newFormat: string, newPayload: unknown): boolean {
  if (newFormat === record.format) {
    return canonical(payloadMinusMagic(newPayload)) === canonical(payloadMinusMagic(record.payload));
  }
  if (record.format === "cmini/1" && newFormat === "akl/1") {
    const lifted = fromCmini(record.payload as cmini1.Payload);
    return canonical(payloadMinusMagic(newPayload)) === canonical(payloadMinusMagic(lifted));
  }
  return false;
}

// PUT /v1/layouts/{ref}: owner or admin; whole payload replaced, name/
// owner/created_at kept, format may change.
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
  const { hasMagic } = validatePayload(body.format, body.payload);
  const magicOnly = isMagicOnlyReplace(record, body.format, body.payload);

  return commitWrite(db, now, {
    kind: "updated",
    layoutId: record.id,
    name: record.name,
    owner: record.owner,
    // A magic-only write leaves `modified_at` alone (2026-09-10): magic is a
    // layer the cmini import never touches, so the record's own modified_at
    // keeps mirroring upstream's -- the seed bumped 67 records' and the
    // daily diff flagged every one until the next upstream change.
    modified_at: magicOnly ? record.modified_at : now(),
    format: body.format,
    payload: body.payload,
    actor: actor.user_id,
    via: actor.via,
    ...(magicOnly ? { detail: { magic_only: true } } : {}),
    admin,
    hasMagic,
  });
}

// DELETE /v1/layouts/{ref}: owner or admin; tombstones (payload/format/name
// kept, `deleted: true`); frees the name.
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

  return commitWrite(db, now, {
    kind: "deleted",
    layoutId: record.id,
    name: record.name,
    owner: record.owner,
    modified_at: now(),
    format: record.format,
    payload: record.payload,
    actor: actor.user_id,
    via: actor.via,
    admin,
    deleted: true,
    hasMagic: record.has_magic,
  });
}

// POST /v1/layouts/{ref}/restore: `{ref}` must be the id (a tombstone has
// no live name, so byRef's name path never finds one anyway); owner within
// 30 days, admin any time (09 §6.7); no `If-Match` -- a tombstone has one
// possible next state. Format/payload/has_magic are the tombstone's own,
// carried through verbatim (no re-validation: they were valid when stored).
export async function restoreLayout(
  env: Bindings,
  now: Clock,
  actor: Actor,
  ref: string,
): Promise<{ record: RecordRow; seq: number }> {
  const db = env.DB;
  const { record, admin } = await loadForWrite(db, ref, actor, { allowDeleted: true });

  if (!record.deleted) {
    throw badRequest(`'${record.name}' is not deleted`, "/ref");
  }

  const deletedAtMs = new Date(record.modified_at).getTime();
  const nowMs = new Date(now()).getTime();
  // `actor.admin`, not the `admin` flag above: that flag means "passed
  // ownership only via admin", but the 30-day extension is granted to any
  // admin (09 §6.7), owner-admin included.
  if (!actor.admin && nowMs - deletedAtMs > RESTORE_WINDOW_MS) {
    throw notFound(`no layout '${ref}'`, ref);
  }

  return commitWrite(db, now, {
    kind: "restored",
    layoutId: record.id,
    name: record.name,
    owner: record.owner,
    modified_at: now(),
    format: record.format,
    payload: record.payload,
    actor: actor.user_id,
    via: actor.via, // stops a follow of upstream (LDB-I2a): this becomes the latest rev-bumping event
    admin,
    deleted: false,
    hasMagic: record.has_magic,
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

  return commitWrite(db, now, {
    kind: "transferred",
    layoutId: record.id,
    name: record.name,
    owner: body.to,
    modified_at: now(),
    format: record.format,
    payload: record.payload,
    actor: actor.user_id,
    via: actor.via,
    admin,
    hasMagic: record.has_magic,
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

  // LDB-I12 (design/layout-db/18-command-decisions.md §2 item 1;
  // 17-magic-ownership.md §3's "format wrinkle"): cmini/1 has no magic
  // idiom of its own (no `setMagic` in its `edits`), so a `magic` PATCH on
  // a cmini/1 record lifts it to akl/1 FIRST -- `fromCmini` is the same
  // lossless cmini/1 -> akl/1 translation the import uses (LDB-F5), so
  // keys/board/free/x survive exactly; any magic `fromCmini` lifted out of
  // cmini/1's own flat rows is then overwritten by the PATCH's own value
  // below, same as it would be for a record that was already akl/1. Every
  // other field in this same PATCH (name/fingermap/board) is then applied
  // against the NEW format, not the old one -- one write, one format.
  let format = record.format;
  let payload: unknown = structuredClone(record.payload);
  if (body.magic !== undefined && format === "cmini/1") {
    payload = fromCmini(payload as cmini1.Payload);
    format = "akl/1";
  }

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
  // LDB-I12: a PATCH whose body is ONLY {magic} never touches keys/board/
  // name -- `detail.magic_only` marks the `updated` event so `followsUpstream`
  // (core/follows.ts) can skip past it when looking for "the latest write"
  // that would fork a following record from upstream.
  const magicOnly = fields.length === 1 && fields[0] === "magic";

  return commitWrite(db, now, {
    kind,
    layoutId: record.id,
    name,
    owner: record.owner,
    modified_at: magicOnly ? record.modified_at : now(), // magic-only: see replaceLayout
    format,
    payload,
    actor: actor.user_id,
    via: actor.via,
    admin,
    hasMagic,
    ...(kind === "updated" ? { detail: magicOnly ? { fields, magic_only: true } : { fields } } : {}),
  });
}
