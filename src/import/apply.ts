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
import { fromCmini } from "../../formats/adapters/cmini/translate";
import { canonical } from "../core/canonical";
import { ApiError } from "../core/errors";
import { appendInfo, appendLike, commitWrite, type CommitInput } from "../core/events";
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

async function importMapByUpstreamId(db: Bindings["DB"], upstreamId: string): Promise<string | null> {
  const row = await db.prepare("SELECT layout_id FROM import_map WHERE upstream_id = ?").bind(upstreamId).first<{ layout_id: string }>();
  return row?.layout_id ?? null;
}

async function insertImportMap(db: Bindings["DB"], upstreamId: string, layoutId: string): Promise<void> {
  await db.prepare("INSERT INTO import_map (upstream_id, layout_id) VALUES (?, ?)").bind(upstreamId, layoutId).run();
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
  return layout;
}

// Case 1/2/3 (07 §6 S5's table): the upstream id has no `import_map` row
// yet.
async function applyNew(db: Bindings["DB"], now: Clock, upstreamId: string, detail: ParsedUpstreamDetail): Promise<void> {
  const existing = await readByName(db, detail.name);

  if (existing === null) {
    const layout = await importCreate(db, now, upstreamId, detail.name, detail);
    await insertImportMap(db, upstreamId, layout.id);
    await importLikes(db, now, layout.id, detail.likes);
    return;
  }

  if (existing.owner === detail.owner) {
    // Case 2: name held by a live local record, same owner -- map it,
    // treat as not-following, tell the owner what upstream has.
    await insertImportMap(db, upstreamId, existing.id);
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
  await insertImportMap(db, upstreamId, layout.id);
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
async function applyMapped(db: Bindings["DB"], now: Clock, upstreamId: string, detail: ParsedUpstreamDetail, record: LayoutRow): Promise<void> {
  const prior = await upstreamOf(db, record);
  const following = prior?.state === "following";
  const localLikeIds = await currentLikeIds(db, record.id);
  const upstreamLikeIds = new Set(detail.likes);

  if (following) {
    const sparkRow = await db.prepare("SELECT * FROM layout_formats WHERE layout_id = ? AND lineage = ?").bind(record.id, SPARK_LINEAGE).first<{ payload_json: string }>();
    const currentSparkPayload: unknown = sparkRow === null ? {} : JSON.parse(sparkRow.payload_json);
    const layoutDiffers = layoutFieldsDiffer(record, detail);
    const payloadDiffers = sparkPayloadDiffers(currentSparkPayload, detail);

    if (layoutDiffers || payloadDiffers) {
      // Case 4: content differs -- one `imported` event per scope that
      // actually changed, in ONE batch, guarded by this read's own `n`
      // (21-formats.md §2.2).
      const upstream = nextUpstream(prior, "import:cmini", true);
      const input: CommitInput = {
        layoutId: record.id,
        creating: false,
        currentN: record.n,
        currentLayout: record,
        currentFormats: new Map(), // unused by commitWrite except for computing the format's existing rev, read fresh below when needed
        modified_at: detail.modified_at,
        actor: "system:cmini-import",
        via: "import:cmini",
        source: SYSTEM_SOURCE,
        upstream,
        ...(layoutDiffers
          ? { layout: { kind: "imported", name: detail.name, owner: detail.owner, created_at: detail.created_at, deleted: false, detail: { source: "cmini", upstream_id: upstreamId } } }
          : {}),
        ...(payloadDiffers
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
          : {}),
      };
      // `currentFormats` must carry the layout's EXISTING format rows (for
      // the spark row's own current rev, when this write touches it).
      input.currentFormats = await formatsForLayout(db, record.id);
      await commitWrite(db, now, input);
    }

    // Case 5 (and the like half of case 4): likes replaced wholesale.
    for (const u of upstreamLikeIds) {
      if (!localLikeIds.has(u)) await importAppendLike(db, now, "liked", record.id, u);
    }
    for (const u of localLikeIds) {
      if (!upstreamLikeIds.has(u)) await importAppendLike(db, now, "unliked", record.id, u);
    }
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

  const layoutId = await importMapByUpstreamId(db, upstreamId);
  if (layoutId === null) {
    await applyNew(db, now, upstreamId, parsed.detail);
  } else {
    const record = await readById(db, layoutId);
    if (record === null) throw new Error(`applyFetchedId: import_map points to missing layout '${layoutId}'`);
    await applyMapped(db, now, upstreamId, parsed.detail, record);
  }
  return { errors: [] };
}

export async function applyDeleteAction(db: Bindings["DB"], now: Clock, action: DeleteAction): Promise<void> {
  await applyDelete(db, now, action.layoutId);
}

export async function applyAuthors(db: Bindings["DB"], now: Clock, authors: Record<string, string>): Promise<void> {
  const stored = await readStoredAuthors(db);
  await writeAuthorNames(db, now, planAuthorNames(authors, stored));
}
