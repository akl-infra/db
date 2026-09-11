// The write pipeline (21-formats.md §2.2/§2.4): one function per verb, all
// sharing the same spine -- resolve -> authorize -> check (scoped
// If-Match) -> `commitWrite`, with a retry wrapper around the ones that can
// race a DIFFERENT scope of the same layout. `src/routes/write.ts` is glue
// only (parse the request, call one of these, `c.json` the result) so
// LDB-W1 holds: no file under `src/routes/` prepares a D1 statement.
import { ulid } from "ulidx";
import type { Actor } from "../auth/actor";
import type { Bindings } from "../env";
import { get as getFormat, latestId, lineage, list as listFormats, resolveFormat, translate, walk } from "../formats/registry";
import type { EditResult, FormatModule } from "../formats/registry";
import { parseIfMatch, requireScopedIfMatch, type CheckedIfMatch, type IfMatch, type IfNoneMatch } from "./ifmatch";
import {
  ApiError,
  badRequest,
  formatAbsent,
  formatBehind,
  formatExists,
  formatNotWritable,
  formatRequired,
  internal,
  invalidName,
  mixedPatch,
  nameTaken,
  notFound,
  notOwner,
  stale,
  unknownFormat,
  unsupportedForFormat,
  type ErrBody,
  type LastWrite,
} from "./errors";
import {
  appendLike,
  commitWrite,
  RevConflictError,
  rowToEvent,
  type CommitInput,
  type CommitResult,
  type EventDbRow,
} from "./events";
import { checkName } from "./names";
import {
  byRefWithFormats,
  fullWire,
  readByName,
  type FormatRow,
  type LayoutRow,
  type LayoutWithFormats,
  type Source,
} from "./records";
import type { Clock } from "./time";
import { nextUpstream } from "./upstream";

const TRANSFER_USER_ID_RE = /^\d{17,20}$/;
const MAX_RETRIES = 3; // 21-formats.md §2.2: "retries up to 3 times"

// byRef + every format the layout has, in one read (records.ts's
// `byRefWithFormats`); a tombstone is reachable only by id and only when
// `allowDeleted`.
export async function loadForWrite(
  db: Bindings["DB"],
  ref: string,
  actor: Actor,
  opts: { allowDeleted: boolean },
): Promise<{ lwf: LayoutWithFormats; admin: boolean }> {
  const lwf = await byRefWithFormats(db, ref);
  if (lwf === null || (lwf.layout.deleted && !opts.allowDeleted)) {
    throw notFound(`no layout '${ref}'`, ref);
  }
  if (lwf.layout.owner === actor.user_id) return { lwf, admin: false };
  if (actor.admin) return { lwf, admin: true };
  throw notOwner(lwf.layout.name, lwf.layout.owner);
}

async function latestRevBumpingEvent(db: Bindings["DB"], layoutId: string, format: string | null): Promise<LastWrite> {
  const row = await db
    .prepare("SELECT * FROM events WHERE layout_id = ? AND rev IS NOT NULL AND format IS ? ORDER BY seq DESC LIMIT 1")
    .bind(layoutId, format)
    .first<EventDbRow>();
  if (row === null) throw internal(); // unreachable: every record reaching this point was created by a rev-bumping write of this same scope
  const e = rowToEvent(row);
  return { seq: e.seq, at: e.at, actor: e.actor, via: e.via, kind: e.kind, admin: e.admin };
}

// The `If-Match` pre-check for the LAYOUT scope (21-formats.md §2.3, MF-11):
// the layout is already in hand; only `last_write` needs a read on a
// mismatch.
async function requireLayoutRev(db: Bindings["DB"], layout: LayoutRow, checked: CheckedIfMatch, formats: Map<string, FormatRow>): Promise<void> {
  if ("any" in checked) return;
  if (checked.rev === layout.layout_rev) return;
  const lastWrite = await latestRevBumpingEvent(db, layout.id, null);
  throw stale("layout", layout.layout_rev, fullWire(layout, formats), lastWrite);
}

// Same for a FORMAT scope.
async function requireFormatRev(db: Bindings["DB"], layout: LayoutRow, row: FormatRow, checked: CheckedIfMatch, formats: Map<string, FormatRow>): Promise<void> {
  if ("any" in checked) return;
  if (checked.rev === row.rev) return;
  const lastWrite = await latestRevBumpingEvent(db, layout.id, row.format);
  throw stale(row.lineage, row.rev, fullWire(layout, formats, { format: row.format, payload: row.payload }), lastWrite);
}

// 21-formats.md §2.2 (MF-6): a write reads its layout fresh, checks its OWN
// scope's If-Match against that fresh read, and attempts the commit. If a
// concurrent write to a DIFFERENT scope of the same layout took the next
// `n` first, `commitWrite` throws `RevConflictError` -- `build()` is
// called again (a fresh read, so if THIS scope changed underneath, the
// If-Match check above now fails loudly with `409 stale`; if it didn't,
// the retry naturally lands on the now-current `n`). System writers
// (`expectN`) call `commitWrite` directly and never go through this.
async function commitWithRetry(db: Bindings["DB"], now: Clock, build: () => Promise<CommitInput>): Promise<CommitResult> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const input = await build();
    try {
      return await commitWrite(db, now, input);
    } catch (e) {
      if (e instanceof RevConflictError) {
        lastErr = e;
        continue;
      }
      throw e;
    }
  }
  throw lastErr instanceof Error ? lastErr : internal();
}

// 21-formats.md §2.4 (LDB-F16, narrowed to "no default"): every write
// resolves `format` through the registry and stores natively. `mana2/1`
// resolves but its `role` is `"output"` -> `400 format_not_writable`;
// `cmini/1` and anything unregistered don't resolve at all -> `400
// unknown_format`.
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

// 20-spark.md S5 (LDB-P13): a format is stored at its lineage's LATEST
// major always -- a write naming an older major is chained up here before
// the commit. `up` never holds (LDB-F18), so this never itself throws.
function chainToLatest(module: FormatModule, payload: unknown): { format: string; payload: unknown; hasMagic: boolean; writtenAs?: string } {
  const latest = latestId(lineage(module.id));
  if (latest === undefined || latest === module.id) {
    return { format: module.id, payload, hasMagic: module.hasMagic(payload) };
  }
  const chained = walk(module.id, latest, payload);
  if (typeof chained === "object" && chained !== null && (chained as { held?: unknown }).held === true) {
    throw internal(); // unreachable per LDB-F18's own chain contract
  }
  const latestModule = getFormat(latest);
  if (latestModule === undefined) throw internal();
  const validated = latestModule.validate(chained);
  if (!validated.ok) throw internal();
  return { format: latest, payload: chained, hasMagic: latestModule.hasMagic(chained), writtenAs: module.id };
}

// `nameTaken()`'s own thrown body always carries the clashing `name`
// (`commitWrite`'s pre-check only knows a name clashed, not who holds it)
// -- read straight off the caught error, so every caller here needs no
// separate "what name was I trying to claim" parameter of its own (restore
// without a `{name}` reuses the tombstone's own name, computed only
// inside `build`, which this could not otherwise see).
async function commitAndMapErrors(db: Bindings["DB"], now: Clock, build: () => Promise<CommitInput>): Promise<CommitResult> {
  try {
    return await commitWithRetry(db, now, build);
  } catch (e) {
    if (e instanceof ApiError && e.body.error === "name_taken" && e.body.holder === undefined && typeof e.body.name === "string") {
      const clashName = e.body.name;
      const holderRec = await readByName(db, clashName);
      if (holderRec !== null) throw nameTaken(clashName, { id: holderRec.id, owner: holderRec.owner });
    }
    throw e;
  }
}

export interface CreateBody {
  name: string;
  format: string;
  payload: unknown;
}

async function latestTombstoneIdByName(db: Bindings["DB"], name: string): Promise<string | null> {
  const row = await db
    .prepare("SELECT id FROM layouts WHERE name = ? AND deleted = 1 ORDER BY modified_at DESC, layout_rev DESC LIMIT 1")
    .bind(name)
    .first<{ id: string }>();
  return row?.id ?? null;
}

async function likeUserIds(db: Bindings["DB"], layoutId: string): Promise<string[]> {
  const { results } = await db.prepare("SELECT user_id FROM likes WHERE layout_id = ? ORDER BY user_id ASC").bind(layoutId).all<{ user_id: string }>();
  return results.map((r) => r.user_id);
}

export interface WriteOutcome {
  layout: LayoutRow;
  formats: Map<string, FormatRow>;
  format: string;
  lineage: string;
  payload: unknown;
}
export interface LayoutOnlyOutcome {
  layout: LayoutRow;
  formats: Map<string, FormatRow>;
}

// POST /v1/layouts: a create is TWO events in one batch (21-formats.md
// §2.2) -- `created` (layout scope) then `format_added` (the named
// format's scope). LDB-P9: a name currently held by a tombstone (any
// owner) has its likes copied onto the new layout as `liked` events
// `via: "name_inherited"`.
export async function createLayout(env: Bindings, now: Clock, actor: Actor, body: CreateBody, version: string | null): Promise<WriteOutcome> {
  const db = env.DB;
  const nameCheck = checkName(body.name);
  if (!nameCheck.ok) throw invalidName(body.name, nameCheck.message);
  const { module } = validatePayload(body.format, body.payload);
  const chained = chainToLatest(module, body.payload);
  const lin = lineage(chained.format);

  const tombstoneId = await latestTombstoneIdByName(db, body.name);
  const source: Source = { client: actor.source_client, version };
  const id = ulid();
  const modified_at = now();

  const input: CommitInput = {
    layoutId: id,
    creating: true,
    currentN: 0,
    currentLayout: null,
    currentFormats: new Map(),
    layout: { kind: "created", name: body.name, owner: actor.user_id, created_at: modified_at, deleted: false },
    format: {
      kind: "format_added",
      lineage: lin,
      format: chained.format,
      payload: chained.payload,
      hasMagic: chained.hasMagic,
      ...(chained.writtenAs !== undefined ? { detail: { written_as: chained.writtenAs } } : {}),
    },
    modified_at,
    actor: actor.user_id,
    via: actor.via,
    source,
    upstream: null, // a plain user create has no prior link -- nextUpstream(null, ...) is always null
  };

  const result = await commitAndMapErrors(db, now, () => Promise.resolve(input));

  let layout = result.layout;
  if (tombstoneId !== null) {
    for (const userId of await likeUserIds(db, tombstoneId)) {
      const r = await appendLike(db, now, { kind: "liked", layoutId: layout.id, userId, via: "name_inherited", detail: { from: tombstoneId }, source });
      layout = { ...layout, like_count: r.like_count };
    }
  }
  return { layout, formats: result.formats, format: chained.format, lineage: lin, payload: chained.payload };
}

export interface FormatBody {
  format: string;
  payload: unknown;
}

// PUT /v1/layouts/{ref}: `If-None-Match: *` adds a NEW format to the
// layout (`409 format_exists` if it already has that lineage); `If-Match`
// replaces the format it names (`404 format_absent` if the layout doesn't
// have it, checked against a fresh read every retry).
export async function putFormat(
  env: Bindings,
  now: Clock,
  actor: Actor,
  ref: string,
  body: FormatBody,
  ifMatchHeader: IfMatch,
  ifNoneMatchHeader: IfNoneMatch,
  version: string | null,
): Promise<WriteOutcome> {
  const db = env.DB;
  const { module } = validatePayload(body.format, body.payload);
  const chained = chainToLatest(module, body.payload);
  const lin = lineage(chained.format);

  const adding = ifNoneMatchHeader.kind === "any";
  // 21-formats.md §2.4: replacing needs a scoped `If-Match` naming THIS
  // format's own lineage (MF-11, checked before any read); adding needs
  // only the explicit `If-None-Match: *` this function was called with.
  if (!adding) requireScopedIfMatch(ifMatchHeader, lin);

  const source: Source = { client: actor.source_client, version };

  const build = async (): Promise<CommitInput> => {
    const { lwf, admin } = await loadForWrite(db, ref, actor, { allowDeleted: false });
    const existing = lwf.formats.get(lin) ?? null;

    if (adding) {
      if (existing !== null) throw formatExists(chained.format);
    } else {
      if (existing === null) throw formatAbsent(chained.format);
      const checked = requireScopedIfMatch(ifMatchHeader, lin);
      await requireFormatRev(db, lwf.layout, existing, checked, lwf.formats);

      // 20-spark.md S5 (19 §3 R1, LDB-P13): a write naming a format the
      // format row (as CURRENTLY stored) cannot be shown as would be a
      // blind overwrite -- the client could never have read this format
      // whole in that major, so a pure upcast of the write would silently
      // drop whatever made it hold. Checked only when the write actually
      // names a DIFFERENT major than the format's current one.
      if (body.format !== existing.format) {
        const view = translate({ format: existing.format, payload: existing.payload }, body.format);
        if ("held" in view) throw formatBehind(body.format, existing.format, existing.rev);
      }
    }

    const touches = lin === "spark";
    const upstream = nextUpstream(lwf.layout.upstream, actor.via, touches);

    return {
      layoutId: lwf.layout.id,
      creating: false,
      currentN: lwf.layout.n,
      currentLayout: lwf.layout,
      currentFormats: lwf.formats,
      format: {
        kind: adding ? "format_added" : "updated",
        lineage: lin,
        format: chained.format,
        payload: chained.payload,
        hasMagic: chained.hasMagic,
        ...(chained.writtenAs !== undefined ? { detail: { written_as: chained.writtenAs } } : {}),
      },
      modified_at: now(),
      actor: actor.user_id,
      via: actor.via,
      admin,
      source,
      upstream,
    };
  };

  const result = await commitWithRetry(db, now, build);
  return { layout: result.layout, formats: result.formats, format: chained.format, lineage: lin, payload: chained.payload };
}

// PATCH /v1/layouts/{ref}: either `{name}` (layout scope, `If-Match:
// "layout:<n>"`) or `{format, fingermap | board | magic ...}` (that
// format's scope). Both at once is `400 mixed_patch` (21-formats.md §2.2).
export interface PatchBody {
  name?: string;
  format?: string;
  fingermap?: Record<string, string>;
  board?: unknown;
  magic?: unknown;
}

const FORMAT_EDIT_FIELDS = ["fingermap", "board", "magic"] as const;
type FormatEditField = (typeof FORMAT_EDIT_FIELDS)[number];

function isEditError(r: EditResult): r is { error: ErrBody } {
  return typeof r === "object" && r !== null && "error" in (r as object);
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function runEdit(format: string, verb: FormatEditField, edit: ((p: any, arg: any) => EditResult) | undefined, payload: any, arg: any): any {
  if (edit === undefined) throw unsupportedForFormat(format, verb);
  const result = edit(payload, arg);
  if (isEditError(result)) {
    if (result.error.error === "invalid_payload") throw new ApiError(400, result.error);
    throw unsupportedForFormat(format, verb);
  }
  return result;
}
/* eslint-enable @typescript-eslint/no-explicit-any */

// PATCH {name}: layout scope only.
export async function renameLayout(env: Bindings, now: Clock, actor: Actor, ref: string, name: string, ifMatchHeader: IfMatch, version: string | null): Promise<LayoutOnlyOutcome> {
  const db = env.DB;
  const nameCheck = checkName(name);
  if (!nameCheck.ok) throw invalidName(name, nameCheck.message);
  requireScopedIfMatch(ifMatchHeader, "layout"); // MF-11: before any read
  const source: Source = { client: actor.source_client, version };

  const build = async (): Promise<CommitInput> => {
    const { lwf, admin } = await loadForWrite(db, ref, actor, { allowDeleted: false });
    const checked = requireScopedIfMatch(ifMatchHeader, "layout");
    await requireLayoutRev(db, lwf.layout, checked, lwf.formats);
    const upstream = nextUpstream(lwf.layout.upstream, actor.via, true);
    return {
      layoutId: lwf.layout.id,
      creating: false,
      currentN: lwf.layout.n,
      currentLayout: lwf.layout,
      currentFormats: lwf.formats,
      layout: { kind: "renamed", name, owner: lwf.layout.owner, created_at: lwf.layout.created_at, deleted: false },
      modified_at: now(),
      actor: actor.user_id,
      via: actor.via,
      admin,
      source,
      upstream,
    };
  };

  const result = await commitAndMapErrors(db, now, build);
  return { layout: result.layout, formats: result.formats };
}

// PATCH {format, fingermap | board | magic}: applied in order to a clone
// of that format's current payload, validated once as a whole, one event.
export async function patchFormat(
  env: Bindings,
  now: Clock,
  actor: Actor,
  ref: string,
  format: string,
  edits: { fingermap?: Record<string, string>; board?: unknown; magic?: unknown },
  ifMatchHeader: IfMatch,
  version: string | null,
): Promise<WriteOutcome> {
  const db = env.DB;
  const lin = lineage(format);
  requireScopedIfMatch(ifMatchHeader, lin); // MF-11: before any read
  const source: Source = { client: actor.source_client, version };

  const build = async (): Promise<CommitInput> => {
    const { lwf, admin } = await loadForWrite(db, ref, actor, { allowDeleted: false });
    const existing = lwf.formats.get(lin);
    if (existing === undefined) throw formatAbsent(format);
    const module = getFormat(existing.format);
    if (module === undefined) throw unknownFormat(existing.format, listFormats().map((f) => f.id));

    const checked = requireScopedIfMatch(ifMatchHeader, lin);
    await requireFormatRev(db, lwf.layout, existing, checked, lwf.formats);

    let payload: unknown = existing.payload;
    const fields = FORMAT_EDIT_FIELDS.filter((f) => edits[f] !== undefined);
    if (edits.fingermap !== undefined) payload = runEdit(existing.format, "fingermap", module.edits?.setFingermap, payload, edits.fingermap);
    if (edits.board !== undefined) payload = runEdit(existing.format, "board", module.edits?.setBoard, payload, edits.board);
    if (edits.magic !== undefined) payload = runEdit(existing.format, "magic", module.edits?.setMagic, payload, edits.magic);

    const { hasMagic } = validatePayload(existing.format, payload);
    const kind = fields.length === 1 && fields[0] === "fingermap" ? "fingermap" : "updated";
    const touches = lin === "spark";
    const upstream = nextUpstream(lwf.layout.upstream, actor.via, touches);

    return {
      layoutId: lwf.layout.id,
      creating: false,
      currentN: lwf.layout.n,
      currentLayout: lwf.layout,
      currentFormats: lwf.formats,
      format: {
        kind,
        lineage: lin,
        format: existing.format,
        payload,
        hasMagic,
        ...(kind === "updated" ? { detail: { fields } } : {}),
      },
      modified_at: now(),
      actor: actor.user_id,
      via: actor.via,
      admin,
      source,
      upstream,
    };
  };

  const result = await commitWithRetry(db, now, build);
  const written = result.formats.get(lin)!;
  return { layout: result.layout, formats: result.formats, format: written.format, lineage: lin, payload: written.payload };
}

// DELETE /v1/layouts/{ref}: layout scope only -- formats are untouched
// (D3: name/owner/likes/deletion are the layout's; a tombstone's own
// formats stay exactly as they were, restorable).
export async function deleteLayout(env: Bindings, now: Clock, actor: Actor, ref: string, ifMatchHeader: IfMatch, version: string | null): Promise<LayoutOnlyOutcome> {
  const db = env.DB;
  requireScopedIfMatch(ifMatchHeader, "layout");
  const source: Source = { client: actor.source_client, version };

  const build = async (): Promise<CommitInput> => {
    const { lwf, admin } = await loadForWrite(db, ref, actor, { allowDeleted: false });
    const checked = requireScopedIfMatch(ifMatchHeader, "layout");
    await requireLayoutRev(db, lwf.layout, checked, lwf.formats);
    const upstream = nextUpstream(lwf.layout.upstream, actor.via, true);
    return {
      layoutId: lwf.layout.id,
      creating: false,
      currentN: lwf.layout.n,
      currentLayout: lwf.layout,
      currentFormats: lwf.formats,
      layout: { kind: "deleted", name: lwf.layout.name, owner: lwf.layout.owner, created_at: lwf.layout.created_at, deleted: true },
      modified_at: now(),
      actor: actor.user_id,
      via: actor.via,
      admin,
      source,
      upstream,
    };
  };

  const result = await commitWithRetry(db, now, build);
  return { layout: result.layout, formats: result.formats };
}

export interface RestoreBody {
  name?: string;
}

// POST /v1/layouts/{ref}/restore: layout scope, no If-Match (a tombstone
// has one possible next state); `{ref}` must be the id.
export async function restoreLayout(env: Bindings, now: Clock, actor: Actor, ref: string, body: RestoreBody = {}, version: string | null): Promise<LayoutOnlyOutcome> {
  const db = env.DB;
  const source: Source = { client: actor.source_client, version };

  const build = async (): Promise<CommitInput> => {
    const { lwf, admin } = await loadForWrite(db, ref, actor, { allowDeleted: true });
    if (!lwf.layout.deleted) throw badRequest(`'${lwf.layout.name}' is not deleted`, "/ref");

    let name = lwf.layout.name;
    let renamedFrom: string | undefined;
    if (body.name !== undefined && body.name !== lwf.layout.name) {
      const nameCheck = checkName(body.name);
      if (!nameCheck.ok) throw invalidName(body.name, nameCheck.message);
      name = body.name;
      renamedFrom = lwf.layout.name;
    }

    const upstream = nextUpstream(lwf.layout.upstream, actor.via, true);
    return {
      layoutId: lwf.layout.id,
      creating: false,
      currentN: lwf.layout.n,
      currentLayout: lwf.layout,
      currentFormats: lwf.formats,
      layout: {
        kind: "restored",
        name,
        owner: lwf.layout.owner,
        created_at: lwf.layout.created_at,
        deleted: false,
        ...(renamedFrom !== undefined ? { detail: { renamed_from: renamedFrom } } : {}),
      },
      modified_at: now(),
      actor: actor.user_id,
      via: actor.via,
      admin,
      source,
      upstream,
    };
  };

  const result = await commitAndMapErrors(db, now, build);
  return { layout: result.layout, formats: result.formats };
}

export interface TransferBody {
  to: string;
}

// POST /v1/layouts/{ref}/transfer: layout scope; `If-Match` is
// presence-only (no draft to be stale against).
export async function transferLayout(env: Bindings, now: Clock, actor: Actor, ref: string, body: TransferBody, ifMatchHeader: IfMatch, version: string | null): Promise<LayoutOnlyOutcome> {
  const db = env.DB;
  requireScopedIfMatch(ifMatchHeader, "layout");
  const source: Source = { client: actor.source_client, version };

  const build = async (): Promise<CommitInput> => {
    const { lwf, admin } = await loadForWrite(db, ref, actor, { allowDeleted: false });

    if (body.to === lwf.layout.owner) throw badRequest("already the owner", "/to");
    if (!TRANSFER_USER_ID_RE.test(body.to)) throw badRequest(`unknown user '${body.to}'`, "/to");
    const author = await db.prepare("SELECT 1 FROM authors WHERE user_id = ?").bind(body.to).first();
    if (author === null) throw badRequest(`unknown user '${body.to}'`, "/to");

    const upstream = nextUpstream(lwf.layout.upstream, actor.via, true);
    return {
      layoutId: lwf.layout.id,
      creating: false,
      currentN: lwf.layout.n,
      currentLayout: lwf.layout,
      currentFormats: lwf.formats,
      layout: { kind: "transferred", name: lwf.layout.name, owner: body.to, created_at: lwf.layout.created_at, deleted: false },
      modified_at: now(),
      actor: actor.user_id,
      via: actor.via,
      admin,
      source,
      upstream,
    };
  };

  const result = await commitWithRetry(db, now, build);
  return { layout: result.layout, formats: result.formats };
}

// Shared by `routes/write.ts`'s PATCH handler: `{name}` and any of
// {fingermap, board, magic} together is `400 mixed_patch`; the latter
// without `format` is `400 format_required`.
export function classifyPatch(body: PatchBody): { kind: "rename"; name: string } | { kind: "format"; format: string; edits: { fingermap?: Record<string, string>; board?: unknown; magic?: unknown } } {
  const hasEdits = body.fingermap !== undefined || body.board !== undefined || body.magic !== undefined;
  if (body.name !== undefined && hasEdits) throw mixedPatch();
  if (body.name !== undefined) return { kind: "rename", name: body.name };
  if (!hasEdits) throw badRequest("PATCH body must set 'name' or a format edit", "/");
  if (body.format === undefined) throw formatRequired();
  return { kind: "format", format: body.format, edits: { fingermap: body.fingermap, board: body.board, magic: body.magic } };
}
