// Per-record import appliers (21-formats.md §2.2: "cmini import" rows).
// Every write goes through `core/events.ts`'s `commitWrite`/`appendInfo`/
// `appendLike` (onlywriter.test.ts) -- plus direct reads/writes of
// `import_map`, a table events.ts doesn't own. The importer touches the
// layout's own fields (name/owner/created_at) and lineage `spark` ONLY
// (21-formats.md §3 F2); every write is a system write, built from a
// single fresh read and committed with THAT read's `n` as the base --
// `commitWrite`'s own `layout_revs` PK guard is what gives this "expectN"
// semantics (a write since the read makes the base stale, which always
// collides with an already-committed row at that `n`) -- so a losing race
// is a plain `RevConflictError`, caught per id by the tick loop
// (`import/cmini.ts`), never retried here.
import { ulid } from "ulidx";
import type { Bindings } from "../env";
import * as cmini1 from "../../formats/adapters/cmini/index";
import * as akl1 from "../../formats/spark/1/index";
import { fromCmini, describeImportChanges } from "../../formats/adapters/cmini/translate";
import { canonical } from "../core/canonical";
import { ApiError } from "../core/errors";
import { appendInfo, appendLike, appendLinkChange, commitWrite, type CommitInput } from "../core/events";
import { validateLinkUrl } from "../core/links";
import { nextUpstream, upstreamOf } from "../core/upstream";
import { formatsForLayout, readById, readByName, type LayoutRow } from "../core/records";
import type { Clock } from "../core/time";
import { parseSnowflake, type RawUpstreamDetail } from "./upstream";
import { planAuthorNames, readStoredAuthors, writeAuthorNames } from "./authors";
import type { DeleteAction } from "./plan";

const SPARK_LINEAGE = "spark";
const SPARK_FORMAT = "spark/1";
const SYSTEM_SOURCE = { client: "system:cmini-import", version: null };

const RECORD_FIELDS = new Set(["name", "user", "likes", "created_at", "modified_at"]);
// LDB-I10 (M1): cmini's magic is never akl.gg's -- dropped here, before
// validation, so it can never reach `ParsedUpstreamDetail.payload` at all.
const IMPORT_DROPPED_FIELDS = new Set(["magic"]);

export interface ParsedUpstreamDetail {
  name: string;
  owner: string; // snowflake, as text
  created_at: string;
  modified_at: string;
  likes: string[]; // snowflakes, as text
  payload: cmini1.Payload;
}

export interface ShapeErr {
  path: string;
  message: string;
}

export type ParseResult = { ok: true; detail: ParsedUpstreamDetail } | { ok: false; error: ShapeErr };

function payloadFromRaw(raw: RawUpstreamDetail): unknown {
  const payload: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (!RECORD_FIELDS.has(k) && !IMPORT_DROPPED_FIELDS.has(k)) payload[k] = v;
  }
  return payload;
}

export function parseUpstreamDetail(raw: unknown): ParseResult {
  if (typeof raw !== "object" || raw === null) {
    return { ok: false, error: { path: "/", message: "detail response is not an object" } };
  }
  const r = raw as Record<string, unknown>;

  if (typeof r.name !== "string") {
    return { ok: false, error: { path: "/name", message: "missing or non-string 'name'" } };
  }
  const owner = parseSnowflake(r.user);
  if (owner === null) {
    return { ok: false, error: { path: "/user", message: "missing or invalid 'user' (not a snowflake)" } };
  }
  if (typeof r.created_at !== "string") {
    return { ok: false, error: { path: "/created_at", message: "missing or non-string 'created_at'" } };
  }
  if (typeof r.modified_at !== "string") {
    return { ok: false, error: { path: "/modified_at", message: "missing or non-string 'modified_at'" } };
  }

  const likes: string[] = [];
  if (r.likes !== undefined) {
    if (!Array.isArray(r.likes)) {
      return { ok: false, error: { path: "/likes", message: "'likes' is not an array" } };
    }
    for (const u of r.likes) {
      const s = parseSnowflake(u);
      if (s === null) return { ok: false, error: { path: "/likes", message: "'likes' contains a non-snowflake value" } };
      likes.push(s);
    }
  }

  const payload = payloadFromRaw(r);
  const check = cmini1.validate(payload);
  if (!check.ok) {
    const path = typeof check.error.path === "string" ? check.error.path : "/";
    return { ok: false, error: { path, message: check.error.message } };
  }

  return {
    ok: true,
    detail: {
      name: r.name,
      owner,
      created_at: r.created_at,
      modified_at: r.modified_at,
      likes,
      payload: payload as cmini1.Payload,
    },
  };
}

function projectUpstreamNoLikes(detail: ParsedUpstreamDetail): unknown {
  return cmini1.projectNoMagic({
    name: detail.name,
    owner: detail.owner,
    created_at: detail.created_at,
    modified_at: detail.modified_at,
    likes: [],
    payload: detail.payload,
  });
}

function projectUpstreamFull(detail: ParsedUpstreamDetail): cmini1.CminiDetail {
  return cmini1.project({
    name: detail.name,
    owner: detail.owner,
    created_at: detail.created_at,
    modified_at: detail.modified_at,
    likes: detail.likes,
    payload: detail.payload,
  });
}

function payloadMinusMagic(p: akl1.Payload): unknown {
  const { magic: _magic, ...rest } = p;
  return rest;
}

// 21-formats.md §2.2: the layout scope (name/owner/created_at) and the
// spark scope (payload, magic excluded) are compared INDEPENDENTLY, so an
// upstream rename with no payload change writes only the layout event, and
// vice versa.
export function layoutFieldsDiffer(record: LayoutRow, detail: ParsedUpstreamDetail): boolean {
  return record.name !== detail.name || record.owner !== detail.owner || record.created_at !== detail.created_at;
}

export function sparkPayloadDiffers(currentPayload: unknown, detail: ParsedUpstreamDetail): boolean {
  return canonical(payloadMinusMagic(currentPayload as akl1.Payload)) !== canonical(payloadMinusMagic(fromCmini(detail.payload)));
}

// The overall "is there anything new to apply" gate (07 §6 S5's original
// "content differs" -- kept as the union of the two scoped diffs above so
// case 4/6's outer branch is unchanged).
export function contentDiffers(record: LayoutRow, currentSparkPayload: unknown, detail: ParsedUpstreamDetail): boolean {
  return layoutFieldsDiffer(record, detail) || sparkPayloadDiffers(currentSparkPayload, detail);
}

async function currentLikeIds(db: Bindings["DB"], layoutId: string): Promise<Set<string>> {
  const { results } = await db.prepare("SELECT user_id FROM likes WHERE layout_id = ?").bind(layoutId).all<{ user_id: string }>();
  return new Set(results.map((r) => r.user_id));
}

interface ImportMapRow {
  layoutId: string;
  // B2 sticky shadow (migrations/0013): the last name UPSTREAM itself
  // reported for this id -- null only for a row written before the
  // migration existed (falls back to the layout's own current `name`,
  // its only possible value at the time).
  upstreamName: string | null;
}

async function importMapRow(db: Bindings["DB"], upstreamId: string): Promise<ImportMapRow | null> {
  const row = await db.prepare("SELECT layout_id, upstream_name FROM import_map WHERE upstream_id = ?").bind(upstreamId).first<{ layout_id: string; upstream_name: string | null }>();
  if (row === null) return null;
  return { layoutId: row.layout_id, upstreamName: row.upstream_name };
}

async function importMapByUpstreamId(db: Bindings["DB"], upstreamId: string): Promise<string | null> {
  const row = await importMapRow(db, upstreamId);
  return row?.layoutId ?? null;
}

// `upstreamName` is upstream's OWN reported name at creation time -- for a
// shadowed create (`applyNew`'s case 3) this is the CONTESTED name, never
// the shadow name the layout is actually stored under, so the following
// path's sticky-collision check (`applyMapped`) has the right baseline
// from the very first tick. `upstreamModifiedAt` (migrations/0018) is
// upstream's `modified_at` as of THIS fetch -- `applyFetchedId` also sets
// it directly after this call returns, but passing it here too means a
// brand-new row never has a NULL-fallback gap between insert and that
// follow-up write.
async function insertImportMap(db: Bindings["DB"], upstreamId: string, layoutId: string, upstreamName: string, upstreamModifiedAt: string): Promise<void> {
  await db
    .prepare("INSERT INTO import_map (upstream_id, layout_id, upstream_name, upstream_modified_at) VALUES (?, ?, ?, ?)")
    .bind(upstreamId, layoutId, upstreamName, upstreamModifiedAt)
    .run();
}

async function updateImportMapUpstreamName(db: Bindings["DB"], upstreamId: string, upstreamName: string): Promise<void> {
  await db.prepare("UPDATE import_map SET upstream_name = ? WHERE upstream_id = ?").bind(upstreamName, upstreamId).run();
}

// LDB-I24 (migrations/0018): recorded after EVERY successful fetch-and-
// apply (`applyFetchedId`, following writes, following no-ops, forked/
// informational paths, and name-collision shadows alike) -- whether or not
// the apply actually wrote anything, since `layouts.modified_at` itself
// only moves on a layout-scope write (`core/events.ts`'s `commitWrite`) and
// upstream can change something spark/1 doesn't carry at all (the board
// word, docs/decisions/26-no-board.md) with nothing to write in the first
// place. Never called on the `"notfound"` (delete) path, and never when
// parsing failed or apply threw -- the next tick must retry those from the
// same stale value.
async function recordUpstreamModifiedAt(db: Bindings["DB"], upstreamId: string, upstreamModifiedAt: string): Promise<void> {
  await db.prepare("UPDATE import_map SET upstream_modified_at = ? WHERE upstream_id = ?").bind(upstreamModifiedAt, upstreamId).run();
}

async function freeShadowName(db: Bindings["DB"], name: string): Promise<string> {
  let candidate = `${name}~cmini`;
  let n = 2;
  while ((await readByName(db, candidate)) !== null) {
    candidate = `${name}~cmini${n}`;
    n++;
  }
  return candidate;
}

// Coordinator review (MEDIUM, third batch): D13 L1/L2 made a repeat
// like/redundant unlike a real error, `appendLike` throws instead of
// silently no-opping -- but the importer must never let that abort a
// tick and strand every id queued behind it (LDB-P14). Two ways it can
// happen even though every call site already guards on its own read of
// current state: (a) cmini's own `likes` array is a plain, undeduped
// array (parseUpstreamDetail), so a repeated id in ONE record's response
// calls this twice for the same user; (b) a real user likes/unlikes
// through the live API between this function's read and its own
// `appendLike` call. Either lands on `already_liked`/`not_liked` --
// exactly the state the importer wanted anyway, so both are swallowed
// HERE ONLY. The public API (routes/likes.ts) stays strict (L1/L2).
async function importAppendLike(db: Bindings["DB"], now: Clock, kind: "liked" | "unliked", layoutId: string, userId: string): Promise<void> {
  try {
    await appendLike(db, now, { kind, layoutId, userId, via: "import:cmini", source: SYSTEM_SOURCE });
  } catch (e) {
    if (e instanceof ApiError && (e.body.error === "already_liked" || e.body.error === "not_liked")) return;
    throw e;
  }
}

async function importLikes(db: Bindings["DB"], now: Clock, layoutId: string, userIds: string[]): Promise<void> {
  // (a) above: dedupe before ever calling appendLike, rather than relying
  // on the catch to paper over a call this function could just not make.
  for (const userId of new Set(userIds)) {
    await importAppendLike(db, now, "liked", layoutId, userId);
  }
}

// L5 moderation follow-up (§4.4, LDB-MD3/MD5): the latest `link_approved`/
// `link_cleared` event's own `via` -- null when the layout has never had
// one. Used only to decide whether the importer still "owns" this
// layout's link (its own prior auto-carry) or an admin has since taken it
// over, in which case the import must never touch it again.
async function latestLinkVia(db: Bindings["DB"], layoutId: string): Promise<string | null> {
  const row = await db
    .prepare("SELECT via FROM events WHERE layout_id = ? AND kind IN ('link_approved', 'link_cleared') ORDER BY seq DESC LIMIT 1")
    .bind(layoutId)
    .first<{ via: string }>();
  return row?.via ?? null;
}

// LDB-I1 (a full re-pass with unchanged content appends zero new events):
// without this, a cmini `link` that's ALWAYS invalid (never https, say)
// would re-append `import_error` on EVERY tick forever, since `importLink`
// itself has no other state to compare a rejected value against (only an
// ACCEPTED one lands in `layouts.link`). Dedupes against the layout's own
// latest `import_error` event, keyed by this specific rejection's raw
// value -- an unrelated import_error (a real apply failure) is simply
// treated as "not the same rejection", so this repeats once more rather
// than staying silent, which is the safe direction to err in.
async function latestRejectedLink(db: Bindings["DB"], layoutId: string): Promise<string | undefined> {
  const row = await db
    .prepare("SELECT detail_json FROM events WHERE layout_id = ? AND kind = 'import_error' ORDER BY seq DESC LIMIT 1")
    .bind(layoutId)
    .first<{ detail_json: string | null }>();
  if (row?.detail_json === undefined || row.detail_json === null) return undefined;
  const parsed = JSON.parse(row.detail_json) as { link_rejected?: string };
  return parsed.link_rejected;
}

// design/layout-db/23-geometry.md's link-approval-on-import follow-up
// (LDB-MD3/MD5, LDB-F23): cmini's own `link` field is carried onto the
// record as an already-APPROVED link -- the import itself is treated as
// the verification, never queued as a pending submission -- but only for
// as long as the importer itself is the one who last decided this
// layout's link (`via === "import:cmini"`, or no decision yet). Once an
// admin has approved/cleared a link by hand, every later import tick
// leaves it alone even if cmini's own field keeps changing.
async function importLink(db: Bindings["DB"], now: Clock, upstreamId: string, layoutId: string, currentLink: string | null, cminiLink: string | undefined): Promise<void> {
  let next: string | null;
  if (cminiLink === undefined) {
    next = null;
  } else {
    const validated = validateLinkUrl(cminiLink);
    if (!validated.ok) {
      // Skip with an info log -- not https, too long, or carrying
      // credentials -- rather than let a bad upstream value ever reach
      // `layouts.link`. Reported once per distinct rejected value, not on
      // every tick (LDB-I1: a full re-pass with unchanged content appends
      // zero new events).
      if ((await latestRejectedLink(db, layoutId)) !== cminiLink) {
        await appendInfo(db, now, {
          kind: "import_error",
          layoutId,
          actor: "system:cmini-import",
          via: "import:cmini",
          source: SYSTEM_SOURCE,
          detail: { upstream_id: upstreamId, message: `cmini link rejected: ${validated.message}`, link_rejected: cminiLink },
        });
      }
      return;
    }
    next = validated.url;
  }
  if (next === currentLink) return; // no change -- nothing to record
  const via = await latestLinkVia(db, layoutId);
  if (via !== null && via !== "import:cmini") return; // an admin decision stands, never overridden

  await appendLinkChange(db, now, {
    layoutId,
    kind: next === null ? "link_cleared" : "link_approved",
    link: next,
    actor: "system:cmini-import",
    via: "import:cmini",
    admin: false,
    source: SYSTEM_SOURCE,
  });
}

// Case 1/3: create both scopes in one batch (21-formats.md §2.2's "cmini
// import: create" row -- `imported` (layout) then `imported` (spark/1)).
async function importCreate(db: Bindings["DB"], now: Clock, upstreamId: string, name: string, detail: ParsedUpstreamDetail, extraDetail?: object): Promise<LayoutRow> {
  const payload = fromCmini(detail.payload);
  const id = ulid();
  const input: CommitInput = {
    layoutId: id,
    creating: true,
    currentN: 0,
    currentLayout: null,
    currentFormats: new Map(),
    layout: { kind: "imported", name, owner: detail.owner, created_at: detail.created_at, deleted: false, detail: { source: "cmini", upstream_id: upstreamId, ...extraDetail } },
    format: { kind: "imported", lineage: SPARK_LINEAGE, format: SPARK_FORMAT, payload, hasMagic: akl1.hasMagic(payload) },
    modified_at: detail.modified_at,
    actor: "system:cmini-import",
    via: "import:cmini",
    source: SYSTEM_SOURCE,
    upstream: { source: "cmini", id: upstreamId, state: "following" },
  };
  const { layout } = await commitWrite(db, now, input);
  // design/layout-db/23-geometry.md §4.6 (LDB-F28): name every key/free
  // position `fromCmini` relabelled (a `TB` finger, or an `LT`/`RT` thumb
  // disagreeing with its column) -- informational only, no rev bump.
  const changes = describeImportChanges(detail.payload);
  if (changes.relabeled.length > 0) {
    await appendInfo(db, now, {
      kind: "import_relabel",
      layoutId: layout.id,
      actor: "system:cmini-import",
      via: "import:cmini",
      source: SYSTEM_SOURCE,
      detail: { relabeled: changes.relabeled },
    });
  }
  // Link-approval-on-import follow-up (LDB-MD3/MD5, LDB-F23): a brand-new
  // import always starts with `link: null`, so this only ever fires when
  // cmini's own record already carries one.
  await importLink(db, now, upstreamId, layout.id, null, detail.payload.link);
  return layout;
}

// Case 1/2/3 (07 §6 S5's table): the upstream id has no `import_map` row
// yet.
async function applyNew(db: Bindings["DB"], now: Clock, upstreamId: string, detail: ParsedUpstreamDetail): Promise<void> {
  const existing = await readByName(db, detail.name);

  if (existing === null) {
    const layout = await importCreate(db, now, upstreamId, detail.name, detail);
    await insertImportMap(db, upstreamId, layout.id, detail.name, detail.modified_at);
    await importLikes(db, now, layout.id, detail.likes);
    return;
  }

  if (existing.owner === detail.owner) {
    // Case 2: name held by a live local record, same owner -- map it,
    // treat as not-following, tell the owner what upstream has.
    await insertImportMap(db, upstreamId, existing.id, detail.name, detail.modified_at);
    await appendInfo(db, now, {
      kind: "upstream_changed",
      layoutId: existing.id,
      actor: "system:cmini-import",
      via: "import:cmini",
      source: SYSTEM_SOURCE,
      detail: projectUpstreamFull(detail),
    });
    return;
  }

  // Case 3: name held by a different owner -- import shadowed.
  await appendInfo(db, now, {
    kind: "import_conflict",
    layoutId: existing.id,
    actor: "system:cmini-import",
    via: "import:cmini",
    source: SYSTEM_SOURCE,
    detail: { upstream_id: upstreamId, upstream_name: detail.name, conflicts_with: existing.id },
  });
  const shadowName = await freeShadowName(db, detail.name);
  const layout = await importCreate(db, now, upstreamId, shadowName, detail, { shadowed: { upstream_name: detail.name } });
  // B2 sticky shadow: `upstream_name` is the CONTESTED name ("detail.name"),
  // never the shadow name the layout actually lives under -- so a
  // following tick where upstream keeps reporting this SAME name doesn't
  // look like a fresh rename and re-collide (`applyMapped`'s own check).
  await insertImportMap(db, upstreamId, layout.id, detail.name, detail.modified_at);
  await importLikes(db, now, layout.id, detail.likes);
}

async function latestUpstreamChangedNoLikes(db: Bindings["DB"], layoutId: string): Promise<string | null> {
  const row = await db
    .prepare("SELECT detail_json FROM events WHERE layout_id = ? AND kind = 'upstream_changed' ORDER BY seq DESC LIMIT 1")
    .bind(layoutId)
    .first<{ detail_json: string | null }>();
  if (row?.detail_json === undefined || row.detail_json === null) return null;
  const parsed = JSON.parse(row.detail_json) as Record<string, unknown>;
  return canonical({ ...parsed, likes: [], magic: undefined });
}

// Case 4/5/6/7: the upstream id is mapped to an existing layout.
async function applyMapped(db: Bindings["DB"], now: Clock, upstreamId: string, detail: ParsedUpstreamDetail, record: LayoutRow, recordedUpstreamName: string | null): Promise<void> {
  const prior = await upstreamOf(db, record);
  const following = prior?.state === "following";
  const localLikeIds = await currentLikeIds(db, record.id);
  const upstreamLikeIds = new Set(detail.likes);

  if (following) {
    const sparkRow = await db.prepare("SELECT * FROM layout_formats WHERE layout_id = ? AND lineage = ?").bind(record.id, SPARK_LINEAGE).first<{ payload_json: string }>();
    const currentSparkPayload: unknown = sparkRow === null ? {} : JSON.parse(sparkRow.payload_json);
    // B2 sticky shadow (coordinator follow-up, migrations/0013): whether
    // upstream has renamed this id is decided against the LAST name
    // upstream itself reported (`import_map.upstream_name`), never against
    // our own `record.name` -- once a rename has been shadowed away
    // (`record.name` permanently different from what upstream calls it),
    // comparing against `record.name` would treat every following tick as
    // "another rename to attempt", re-colliding and escalating
    // `~cmini2`, `~cmini3`, ... forever. A pre-migration row (null) falls
    // back to the layout's own name (its only possible value at the time).
    const upstreamNameKnown = recordedUpstreamName ?? record.name;
    const nameChangedUpstream = upstreamNameKnown !== detail.name;
    // B3 (audit-db.md): a following tombstone that upstream lists again is
    // revived even when every field this compares (name/owner/created_at)
    // is otherwise unchanged -- `deleted` is the one thing that differs.
    // Folding `record.deleted` in here, only for the following path, is
    // what makes an identical re-add still trigger the LAYOUT-scope write
    // case 4 already knows how to make.
    const layoutDiffers = nameChangedUpstream || record.owner !== detail.owner || record.created_at !== detail.created_at || record.deleted;
    const payloadDiffers = sparkPayloadDiffers(currentSparkPayload, detail);

    if (layoutDiffers || payloadDiffers) {
      // Case 4 (and B3's revival): content differs -- one `imported` event
      // per scope that actually changed, in ONE batch, guarded by this
      // read's own `n` (21-formats.md §2.2).
      const upstream = nextUpstream(prior, "import:cmini", true);
      const currentFormats = await formatsForLayout(db, record.id);
      const formatPart: Partial<CommitInput> = payloadDiffers
        ? (() => {
            // LDB-I11 (M1): the layout's own `magic` survives byte-for-byte
            // -- upstream never supplies one (already stripped), so
            // whatever is carried forward is whatever the format row
            // already held.
            const existingMagic = (currentSparkPayload as akl1.Payload).magic;
            const payload: akl1.Payload = { ...fromCmini(detail.payload), magic: existingMagic };
            return {
              format: { kind: "imported" as const, lineage: SPARK_LINEAGE, format: SPARK_FORMAT, payload, hasMagic: akl1.hasMagic(payload), detail: { source: "cmini", upstream_id: upstreamId } },
            };
          })()
        : {};

      // B2 (audit-db.md): an upstream rename landing on a name a LIVE
      // local layout already holds must never wedge the import. Built as
      // a function of `name` so a `name_taken` catch below can retry
      // under a shadow name exactly like `applyNew`'s case 3, instead of
      // rethrowing and aborting the tick.
      const buildInput = (name: string, extraDetail?: object): CommitInput => ({
        layoutId: record.id,
        creating: false,
        currentN: record.n,
        currentLayout: record,
        currentFormats,
        modified_at: detail.modified_at,
        actor: "system:cmini-import",
        via: "import:cmini",
        source: SYSTEM_SOURCE,
        upstream,
        ...(layoutDiffers
          ? { layout: { kind: "imported", name, owner: detail.owner, created_at: detail.created_at, deleted: false, detail: { source: "cmini", upstream_id: upstreamId, ...extraDetail } } }
          : {}),
        ...formatPart,
      });

      // B2 sticky shadow: the name THIS write attempts is upstream's own
      // (new) name only when upstream actually renamed since last time --
      // that's the one case worth a fresh collision check. Otherwise
      // (owner/created_at/deleted changed, or a revival, with upstream's
      // name unchanged) keep OUR OWN current name -- already reconciled,
      // possibly a standing shadow -- so an unrelated field change can
      // never re-attempt (and re-lose) the same rename.
      const targetName = nameChangedUpstream ? detail.name : record.name;

      try {
        await commitWrite(db, now, buildInput(targetName));
      } catch (e) {
        if (!(e instanceof ApiError && e.body.error === "name_taken")) throw e;
        // Only reachable when `targetName === detail.name` (our own
        // current name can never collide with itself) -- nothing was
        // written yet (the clash check throws before the batch), so
        // `record`/`currentFormats` are still good for the retry below.
        const holder = await readByName(db, detail.name);
        await appendInfo(db, now, {
          kind: "import_conflict",
          layoutId: record.id,
          actor: "system:cmini-import",
          via: "import:cmini",
          source: SYSTEM_SOURCE,
          detail: { upstream_id: upstreamId, upstream_name: detail.name, conflicts_with: holder?.id ?? null },
        });
        const shadowName = await freeShadowName(db, detail.name);
        await commitWrite(db, now, buildInput(shadowName, { shadowed: { upstream_name: detail.name } }));
      }

      // design/layout-db/23-geometry.md §4.6 (LDB-F28): only relevant when
      // the format scope actually changed this tick (`payloadDiffers`) --
      // `fromCmini` is deterministic, so a payload that DIDN'T change never
      // has a NEW relabel to report either (the same relabel, if any, was
      // already recorded on a prior tick).
      if (payloadDiffers) {
        const changes = describeImportChanges(detail.payload);
        if (changes.relabeled.length > 0) {
          await appendInfo(db, now, {
            kind: "import_relabel",
            layoutId: record.id,
            actor: "system:cmini-import",
            via: "import:cmini",
            source: SYSTEM_SOURCE,
            detail: { relabeled: changes.relabeled },
          });
        }
      }

      // B2 sticky shadow: record upstream's name as of THIS tick so the
      // next one compares against it, not our own name -- once recorded,
      // a standing collision (upstream still wants the SAME name) is
      // never treated as a fresh rename again, shadowed or not, and never
      // auto-reclaims the name later even if it frees up (a shadow is
      // stable once assigned; only upstream reporting a DIFFERENT name
      // reopens the question).
      if (nameChangedUpstream) await updateImportMapUpstreamName(db, upstreamId, detail.name);
    }

    // Case 5 (and the like half of case 4/B3): UNION only -- add every
    // upstream liker we don't already have. B1 (audit-db.md, saltorbit
    // 2026-09-12): likes are a union of cmini's and ours by user id; the
    // importer never emits `unliked` for a following layout (or any
    // layout -- case 7 below already never did).
    for (const u of upstreamLikeIds) {
      if (!localLikeIds.has(u)) await importAppendLike(db, now, "liked", record.id, u);
    }
    // Link-approval-on-import follow-up (LDB-MD3/MD5, LDB-F23): checked
    // every following tick, independent of `layoutDiffers`/`payloadDiffers`
    // -- cmini's `link` field can change on its own -- but never for a
    // layout whose link an admin has since taken over (`importLink`'s own
    // `latestLinkVia` guard).
    await importLink(db, now, upstreamId, record.id, record.link, detail.payload.link);
    return;
  }

  const sparkRow = await db.prepare("SELECT payload_json FROM layout_formats WHERE layout_id = ? AND lineage = ?").bind(record.id, SPARK_LINEAGE).first<{ payload_json: string }>();
  const currentSparkPayload: unknown = sparkRow === null ? {} : JSON.parse(sparkRow.payload_json);
  if (contentDiffers(record, currentSparkPayload, detail)) {
    // Case 6: not following -- inform only, and only if this is new news.
    const latest = await latestUpstreamChangedNoLikes(db, record.id);
    const current = canonical(projectUpstreamNoLikes(detail));
    if (latest !== current) {
      await appendInfo(db, now, {
        kind: "upstream_changed",
        layoutId: record.id,
        actor: "system:cmini-import",
        via: "import:cmini",
        source: SYSTEM_SOURCE,
        detail: projectUpstreamFull(detail),
      });
    }
  }
  // Case 7 (and the like half of case 6): union only, never unlike.
  for (const u of upstreamLikeIds) {
    if (!localLikeIds.has(u)) await importAppendLike(db, now, "liked", record.id, u);
  }
}

async function hasUpstreamDeletedInfo(db: Bindings["DB"], layoutId: string): Promise<boolean> {
  const row = await db.prepare("SELECT 1 FROM events WHERE layout_id = ? AND kind = 'upstream_deleted' AND rev IS NULL LIMIT 1").bind(layoutId).first();
  return row !== null;
}

// Case 8/9: upstream no longer has this id -- layout scope only (D3: a
// deletion is a layout-level fact; formats are untouched, restorable).
export async function applyDelete(db: Bindings["DB"], now: Clock, layoutId: string): Promise<void> {
  const record = await readById(db, layoutId);
  if (record === null) return; // defensive: import_map pointed at a missing row

  const prior = await upstreamOf(db, record);
  const following = prior?.state === "following";
  if (following) {
    const upstream = nextUpstream(prior, "import:cmini", true);
    const input: CommitInput = {
      layoutId,
      creating: false,
      currentN: record.n,
      currentLayout: record,
      currentFormats: new Map(),
      layout: { kind: "upstream_deleted", name: record.name, owner: record.owner, created_at: record.created_at, deleted: true },
      modified_at: now(),
      actor: "system:cmini-import",
      via: "import:cmini",
      source: SYSTEM_SOURCE,
      upstream,
    };
    await commitWrite(db, now, input);
    return;
  }

  if (!(await hasUpstreamDeletedInfo(db, layoutId))) {
    await appendInfo(db, now, { kind: "upstream_deleted", layoutId, actor: "system:cmini-import", via: "import:cmini", source: SYSTEM_SOURCE });
  }
}

export interface FetchedIdResult {
  errors: { id: string; path: string; message: string }[];
}

export async function applyFetchedId(db: Bindings["DB"], now: Clock, upstreamId: string, raw: RawUpstreamDetail | "notfound"): Promise<FetchedIdResult> {
  if (raw === "notfound") {
    const layoutId = await importMapByUpstreamId(db, upstreamId);
    if (layoutId !== null) await applyDelete(db, now, layoutId);
    return { errors: [] };
  }

  const parsed = parseUpstreamDetail(raw);
  if (!parsed.ok) {
    return { errors: [{ id: upstreamId, path: parsed.error.path, message: parsed.error.message }] };
  }

  const mapRow = await importMapRow(db, upstreamId);
  if (mapRow === null) {
    await applyNew(db, now, upstreamId, parsed.detail);
  } else {
    const record = await readById(db, mapRow.layoutId);
    if (record === null) throw new Error(`applyFetchedId: import_map points to missing layout '${mapRow.layoutId}'`);
    await applyMapped(db, now, upstreamId, parsed.detail, record, mapRow.upstreamName);
  }
  // LDB-I24: recorded once the apply above has returned WITHOUT throwing --
  // a following write, a following no-op, a forked/informational path, and
  // a name-collision shadow all reach here alike. Never reached on the
  // `"notfound"`/parse-failure returns above, and never if `applyNew`/
  // `applyMapped` itself threw (e.g. `RevConflictError`, LDB-P14): those
  // must leave this id's stale value in place so the next tick retries it.
  await recordUpstreamModifiedAt(db, upstreamId, parsed.detail.modified_at);
  return { errors: [] };
}

export async function applyDeleteAction(db: Bindings["DB"], now: Clock, action: DeleteAction): Promise<void> {
  await applyDelete(db, now, action.layoutId);
}

export async function applyAuthors(db: Bindings["DB"], now: Clock, authors: Record<string, string>): Promise<void> {
  const stored = await readStoredAuthors(db);
  await writeAuthorNames(db, now, planAuthorNames(authors, stored));
}

// B5 (design/layout-db/review/audit-db.md B5): `import/cmini.ts`'s per-id
// loop catches every non-`RevConflictError` thrown by `applyFetchedId` so
// one bad id never aborts the rest of the tick; this is what "recorded"
// means for that id instead -- an info event on whatever local layout it's
// mapped to, so the failure is visible on the feed rather than silently
// swallowed. A brand-new id (never reached `import_map`, e.g. `applyNew`
// itself threw before inserting the map row) has no layout to attach an
// event to; it's still counted by the caller, just with nothing written
// here -- the same id will be replanned and retried next tick regardless.
export async function recordImportError(db: Bindings["DB"], now: Clock, upstreamId: string, message: string): Promise<void> {
  const layoutId = await importMapByUpstreamId(db, upstreamId);
  if (layoutId === null) return;
  await appendInfo(db, now, {
    kind: "import_error",
    layoutId,
    actor: "system:cmini-import",
    via: "import:cmini",
    source: SYSTEM_SOURCE,
    detail: { upstream_id: upstreamId, message },
  });
}
