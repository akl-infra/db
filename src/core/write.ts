// The write pipeline (21-formats.md §2.2/§2.4): one function per verb, all
// sharing the same spine -- resolve -> authorize -> check (scoped
// If-Match) -> `commitWrite`, with a retry wrapper around the ones that can
// race a DIFFERENT scope of the same layout. `src/routes/write.ts` is glue
// only (parse the request, call one of these, `c.json` the result) so
// LDB-W1 holds: no file under `src/routes/` prepares a D1 statement.
import { ulid } from "ulidx";
import type { Actor } from "../auth/actor";
import type { Bindings } from "../env";
import { checkDestructiveBudget } from "./clients";
import { clientIdFromVia } from "./destructive-budget";
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
  magicEdited,
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
  appendInheritedLikes,
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
  type Upstream,
} from "./records";
import type { Clock } from "./time";
import { nextUpstream } from "./upstream";

const TRANSFER_USER_ID_RE = /^\d{17,20}$/;
const MAX_RETRIES = 3; // 21-formats.md §2.2: "retries up to 3 times"

// saltorbit 2026-09-13 ("rogue trusted client" hardening, [LDB-A10]): the
// bare client id (never the `client:<id>` `via` string) for a client-lane
// actor, or `undefined` on the Discord/bearer lane -- ONLY this module's
// verb functions decide whether a given write is DESTRUCTIVE (add-vs-
// replace on a format is a call-site fact `commitWrite` itself can't
// infer), so this is the one place a `CommitInput.destructiveBudget` gets
// built.
function destructiveClientOf(actor: Actor): string | undefined {
  return clientIdFromVia(actor.via);
}

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
  let lastInput: CommitInput | undefined;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const input = await build();
    lastInput = input;
    try {
      const result = await commitWrite(db, now, input);
      // [LDB-A10] the ONE place every destructive, client-lane write
      // passes through on its way out -- checked AFTER the commit (the
      // tripping write itself always lands; every request after it is
      // refused, `403 client_suspended`, `auth/client.ts`). A losing
      // retry attempt above never reaches here (its whole batch, counter
      // increment included, rolled back with everything else).
      if (result.budgetProbe !== undefined) {
        await checkDestructiveBudget(db, now, result.budgetProbe);
      }
      return result;
    } catch (e) {
      if (e instanceof RevConflictError) {
        continue;
      }
      throw e;
    }
  }
  // Coordinator review (M2): every attempt's own `build()` re-reads the
  // layout fresh and checks ITS scope's If-Match against that read -- a
  // real staleness on this write's own scope already throws a proper
  // `409 stale` from inside `build()` (requireLayoutRev/requireFormatRev)
  // well before this point. Reaching here means every attempt's own
  // If-Match matched, but something else kept winning the race on the
  // shared `layout_revs (layout_id, n)` PK anyway (extreme contention).
  // §2.3's own body shape still applies -- a fresh read, never a raw
  // `RevConflictError` leaking through as an unmapped 500.
  return await staleFromExhaustedRetry(db, lastInput!);
}

async function staleFromExhaustedRetry(db: Bindings["DB"], lastInput: CommitInput): Promise<never> {
  const lwf = await byRefWithFormats(db, lastInput.layoutId);
  if (lwf === null) throw internal(); // unreachable: this layout existed as of every build() attempt above
  const { layout, formats } = lwf;
  if (lastInput.format !== undefined) {
    const lineageId = lastInput.format.lineage;
    const row = formats.get(lineageId);
    const rev = row?.rev ?? 0;
    // Coordinator review (LOW, third batch): an exhausted retry on a
    // format ADD (`If-None-Match: *`) can reach here with NO existing row
    // for this lineage at all -- there is no prior rev-bumping event for
    // a format scope that has never been written, so `last_write` is
    // `null` rather than a doomed `latestRevBumpingEvent` call (which
    // assumes one always exists and 500s otherwise).
    const lastWrite = row === undefined ? null : await latestRevBumpingEvent(db, layout.id, row.format);
    throw stale(lineageId, rev, fullWire(layout, formats, row !== undefined ? { format: row.format, payload: row.payload } : undefined), lastWrite);
  }
  const lastWrite = await latestRevBumpingEvent(db, layout.id, null);
  throw stale("layout", layout.layout_rev, fullWire(layout, formats), lastWrite);
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

// LDB-L8c: one query instead of two (`latestTombstoneIdByName` +
// `likeUserIds`, before this) -- a CTE picks the same "latest tombstone of
// this name" row `latestTombstoneIdByName` did, then LEFT JOINs its likes
// so a name with no tombstone (zero rows back), a tombstone with none
// (one row, `user_id` null), and a tombstone with likes (one row per
// liker) are all told apart from the SAME single round trip.
async function tombstoneLikers(db: Bindings["DB"], name: string): Promise<{ tombstoneId: string | null; userIds: string[] }> {
  const { results } = await db
    .prepare(
      `WITH t AS (SELECT id FROM layouts WHERE name = ? AND deleted = 1 ORDER BY modified_at DESC, layout_rev DESC LIMIT 1)
       SELECT t.id AS tombstone_id, lk.user_id AS user_id FROM t LEFT JOIN likes lk ON lk.layout_id = t.id ORDER BY lk.user_id ASC`,
    )
    .bind(name)
    .all<{ tombstone_id: string; user_id: string | null }>();
  if (results.length === 0) return { tombstoneId: null, userIds: [] };
  const tombstoneId = results[0]!.tombstone_id;
  const userIds = results.filter((r): r is { tombstone_id: string; user_id: string } => r.user_id !== null).map((r) => r.user_id);
  return { tombstoneId, userIds };
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

  // LDB-L8c: the tombstone/likers lookup and the create's own commit touch
  // entirely disjoint rows (a would-be OLD tombstone vs. the brand-new
  // id), so they run CONCURRENTLY rather than one after the other -- both
  // are still separate D1 round trips (the lookup is read-only and can't
  // travel inside `commitWrite`'s own batch, which is built from `input`
  // alone and has no reason to know about tombstone inheritance), but
  // overlapping them halves the wall-clock cost of paying for both.
  const [{ tombstoneId, userIds }, result] = await Promise.all([tombstoneLikers(db, body.name), commitAndMapErrors(db, now, () => Promise.resolve(input))]);

  let layout = result.layout;
  if (tombstoneId !== null && userIds.length > 0) {
    // LDB-L8c: every inherited like used to be its own `appendLike` call
    // (a read, a pre-check, a batch EACH -- 3 D1 round trips per liker).
    // One batch instead, however many likers.
    const { like_count } = await appendInheritedLikes(db, now, {
      layoutId: layout.id,
      name: layout.name,
      owner: layout.owner,
      userIds,
      via: "name_inherited",
      detail: { from: tombstoneId },
      source,
    });
    layout = { ...layout, like_count };
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
  // Coordinator review (LOW): sending BOTH a real `If-Match` and
  // `If-None-Match: *` at once is never a valid "pick one" -- refused
  // before either is acted on, same as any other malformed If-Match,
  // rather than silently picking "add" and ignoring the If-Match header.
  if (adding && ifMatchHeader.kind !== "absent") {
    throw badRequest("'If-Match' and 'If-None-Match: *' cannot both be sent -- If-Match replaces, If-None-Match: * adds", "If-Match");
  }
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
    // [LDB-A10]: replacing an EXISTING format's payload is destructive
    // (the old payload is only reachable again via a bulk revert, from
    // `layout_revs`, never by re-reading -- LDB-F16 owns "no default
    // format" but nothing hands the old bytes back on a plain retry).
    // Adding a NEW lineage is never destructive -- nothing existing is
    // overwritten -- same posture as `createLayout`.
    const clientId = !adding ? destructiveClientOf(actor) : undefined;

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
      ...(clientId !== undefined ? { destructiveBudget: { clientId } } : {}),
    };
  };

  const result = await commitWithRetry(db, now, build);
  return { layout: result.layout, formats: result.formats, format: chained.format, lineage: lin, payload: chained.payload };
}

// PATCH /v1/layouts/{ref}: either `{name}` (layout scope, `If-Match:
// "layout:<n>"`) or `{format, fingermap | magic ...}` (that format's
// scope; `board` left with spark/1's field, design/layout-db/26-no-board.md). Both at once is `400 mixed_patch` (21-formats.md §2.2).
export interface PatchBody {
  name?: string;
  format?: string;
  fingermap?: Record<string, string>;
  magic?: unknown;
}

const FORMAT_EDIT_FIELDS = ["fingermap", "magic"] as const;
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
    const clientId = destructiveClientOf(actor);
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
      // [LDB-A10]: renaming a live layout is destructive (it releases the
      // old name, LDB-P4 -- reversible only via a bulk revert, never a
      // retry).
      ...(clientId !== undefined ? { destructiveBudget: { clientId } } : {}),
    };
  };

  const result = await commitAndMapErrors(db, now, build);
  return { layout: result.layout, formats: result.formats };
}

// PATCH {format, fingermap | magic}: applied in order to a clone of that
// format's current payload, validated once as a whole, one event.
export async function patchFormat(
  env: Bindings,
  now: Clock,
  actor: Actor,
  ref: string,
  format: string,
  edits: { fingermap?: Record<string, string>; magic?: unknown },
  ifMatchHeader: IfMatch,
  version: string | null,
): Promise<WriteOutcome> {
  const db = env.DB;
  const lin = lineage(format);
  requireScopedIfMatch(ifMatchHeader, lin); // MF-11: before any read
  const source: Source = { client: actor.source_client, version };

  // Coordinator review (M5): PATCH's own `format` field used to be
  // completely ignored beyond computing its LINEAGE for scoping -- every
  // edit silently applied to whatever major happened to be stored,
  // regardless of what the caller actually named. `{format: "spark/9"}`
  // must never edit `spark/1`. Resolve the NAMED format through the
  // registry first, same as any other write (`unknown_format` if it isn't
  // registered at all, `format_not_writable` if it's output-role, e.g.
  // `mana2/1`) -- before touching the record at all.
  const namedResolved = resolveFormat(format);
  if (namedResolved === undefined) throw unknownFormat(format, listFormats().map((f) => f.id));
  if (namedResolved.module.role === "output") throw formatNotWritable(format);

  const build = async (): Promise<CommitInput> => {
    const { lwf, admin } = await loadForWrite(db, ref, actor, { allowDeleted: false });
    const existing = lwf.formats.get(lin);
    if (existing === undefined) throw formatAbsent(format);
    const module = getFormat(existing.format);
    if (module === undefined) throw unknownFormat(existing.format, listFormats().map((f) => f.id));

    // Coordinator review (M5, LDB-P13's own R1 rule -- the same one
    // `putFormat` runs): if the NAMED format differs from what's actually
    // stored, it must be able to show the stored content whole. Naming an
    // OLDER major that can't (the record's current content already
    // outgrew it) is `409 format_behind`, exactly like a PUT would refuse
    // -- never a silent edit applied against a translated-down (and
    // possibly lossy) view.
    if (format !== existing.format) {
      const view = translate({ format: existing.format, payload: existing.payload }, format);
      if ("held" in view) throw formatBehind(format, existing.format, existing.rev);
    }

    const checked = requireScopedIfMatch(ifMatchHeader, lin);
    await requireFormatRev(db, lwf.layout, existing, checked, lwf.formats);

    let payload: unknown = existing.payload;
    const fields = FORMAT_EDIT_FIELDS.filter((f) => edits[f] !== undefined);
    if (edits.fingermap !== undefined) payload = runEdit(existing.format, "fingermap", module.edits?.setFingermap, payload, edits.fingermap);
    if (edits.magic !== undefined) payload = runEdit(existing.format, "magic", module.edits?.setMagic, payload, edits.magic);

    const { hasMagic } = validatePayload(existing.format, payload);
    const kind = fields.length === 1 && fields[0] === "fingermap" ? "fingermap" : "updated";
    const touches = lin === "spark";
    const upstream = nextUpstream(lwf.layout.upstream, actor.via, touches);
    // [LDB-A10]: patchFormat only ever edits an EXISTING format
    // (`formatAbsent` above, if it isn't there) -- always a replacement,
    // so always destructive on the client lane, same as `putFormat`'s own
    // non-adding branch.
    const clientId = destructiveClientOf(actor);

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
      ...(clientId !== undefined ? { destructiveBudget: { clientId } } : {}),
    };
  };

  const result = await commitWithRetry(db, now, build);
  const written = result.formats.get(lin)!;
  return { layout: result.layout, formats: result.formats, format: written.format, lineage: lin, payload: written.payload };
}

// docs/decisions/26-magic-reseed.md §3, added 2026-09-14 (akldb is no
// longer disposable): the guard `scripts/reseed-magic.mjs`'s own
// `editedReason` applied client-side, from the public read alone, is now
// enforced HERE too -- a seed a person's own PATCH raced (or a caller
// other than the periodic reseed) can no longer clobber a person's magic
// or un-fork their record. Seeding is safe only if the spark/1 row's last
// writer was a system client (the seed itself, or the cmini import
// carrying a seeded magic forward -- the import never writes a forked
// record), OR the row has no magic AND the layout is not forked (a fresh
// import, a bot-native record: nothing to clobber, nothing to un-fork).
// Returns the reason to refuse with (the writer's client id, or a fixed
// fallback for a legacy row with no recorded source), or `null` if seeding
// is safe -- mirrors `scripts/reseed-magic.mjs`'s own `editedReason`.
const MAGIC_SEED_SYSTEM_CLIENTS = new Set(["system:magic-seed", "system:cmini-import"]);
export function magicSeedRefusalReason(existingSource: Source | null, hasMagic: boolean, upstream: Upstream | null): string | null {
  const client = existingSource?.client ?? null;
  if (client !== null && MAGIC_SEED_SYSTEM_CLIENTS.has(client)) return null;
  const forked = upstream?.state === "forked";
  if (!hasMagic && !forked) return null;
  return client ?? "an unrecorded client";
}

// design/layout-db/23-geometry.md §10.1 (the 2026-09-13 cutover): the
// one-time magic RE-SEED after a wipe + fresh cmini import, from akl.gg's
// published rule sets. A SYSTEM write (20-spark.md decision 14: "only system
// writes -- import, one-time migrations -- never fork"): actor
// `system:magic-seed`, via `seed:aklgg`, and the record's `upstream` state is
// set to `following` (a seed is not an author's edit, so a record that an
// earlier, mistaken user-lane seed had forked is un-forked by it). Admin
// lane only (`routes/admin.ts`); the candidate `magic` goes through the
// stored format's own `setMagic` edit + `validate()` exactly like a PATCH.
// **Amended 2026-09-14** (`magicSeedRefusalReason` above): refuses with
// `409 magic_edited` before touching anything if the guard says this
// record's magic was last written by a person, or the layout is forked
// with no magic to justify un-forking it.
export async function seedMagic(env: Bindings, now: Clock, ref: string, magic: unknown, version: string | null): Promise<WriteOutcome> {
  const db = env.DB;
  const lin = "spark";
  const source: Source = { client: "system:magic-seed", version };
  const build = async (): Promise<CommitInput> => {
    const lwf = await byRefWithFormats(db, ref);
    if (lwf === null || lwf.layout.deleted) throw notFound(`no layout '${ref}'`, ref);
    const existing = lwf.formats.get(lin);
    if (existing === undefined) throw formatAbsent("spark/1");
    const refusal = magicSeedRefusalReason(existing.source, existing.has_magic, lwf.layout.upstream);
    if (refusal !== null) throw magicEdited(refusal);
    const module = getFormat(existing.format);
    if (module === undefined) throw unknownFormat(existing.format, listFormats().map((f) => f.id));
    const payload = runEdit(existing.format, "magic", module.edits?.setMagic, existing.payload, magic);
    const { hasMagic } = validatePayload(existing.format, payload);
    return {
      layoutId: lwf.layout.id,
      creating: false,
      currentN: lwf.layout.n,
      currentLayout: lwf.layout,
      currentFormats: lwf.formats,
      format: { kind: "updated", lineage: lin, format: existing.format, payload, hasMagic, detail: { fields: ["magic"], seed: "aklgg" } },
      modified_at: now(),
      actor: "system:magic-seed",
      via: "seed:aklgg",
      admin: false,
      source,
      upstream: lwf.layout.upstream === null ? null : { ...lwf.layout.upstream, state: "following" },
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
    const clientId = destructiveClientOf(actor);
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
      // [LDB-A10]: the archetypal destructive write -- restorable
      // (LDB-P8), but only by the owner/an admin noticing, or a bulk
      // revert.
      ...(clientId !== undefined ? { destructiveBudget: { clientId } } : {}),
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
    if (!TRANSFER_USER_ID_RE.test(body.to)) throw badRequest(`unknown user '${body.to}'`, "/to");
    // LDB-L8d: `loadForWrite`'s own read and the `to` author-existence
    // check touch different tables and neither depends on the other's
    // result -- run them concurrently rather than sequentially so their
    // two D1 round trips overlap in wall time (the count is unchanged;
    // only the wall-clock cost is).
    const [{ lwf, admin }, author] = await Promise.all([loadForWrite(db, ref, actor, { allowDeleted: false }), db.prepare("SELECT 1 FROM authors WHERE user_id = ?").bind(body.to).first()]);

    if (body.to === lwf.layout.owner) throw badRequest("already the owner", "/to");
    if (author === null) throw badRequest(`unknown user '${body.to}'`, "/to");

    const upstream = nextUpstream(lwf.layout.upstream, actor.via, true);
    const clientId = destructiveClientOf(actor);
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
      // [LDB-A10]: giving away someone's layout to another user is
      // destructive from the original owner's point of view -- they lose
      // write access to it outright.
      ...(clientId !== undefined ? { destructiveBudget: { clientId } } : {}),
    };
  };

  const result = await commitWithRetry(db, now, build);
  return { layout: result.layout, formats: result.formats };
}

// Shared by `routes/write.ts`'s PATCH handler: `{name}` and any of
// {fingermap, magic} together is `400 mixed_patch`; the latter without
// `format` is `400 format_required`.
export function classifyPatch(body: PatchBody): { kind: "rename"; name: string } | { kind: "format"; format: string; edits: { fingermap?: Record<string, string>; magic?: unknown } } {
  const hasEdits = body.fingermap !== undefined || body.magic !== undefined;
  if (body.name !== undefined && hasEdits) throw mixedPatch();
  if (body.name !== undefined) return { kind: "rename", name: body.name };
  if (!hasEdits) throw badRequest("PATCH body must set 'name' or a format edit", "/");
  if (body.format === undefined) throw formatRequired();
  return { kind: "format", format: body.format, edits: { fingermap: body.fingermap, magic: body.magic } };
}
