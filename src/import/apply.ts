// Per-record import appliers (07 §6 S5's case table). Every write goes
// through events.ts's appendWrite/appendInfo/appendLike -- the only
// sanctioned way to touch `layouts` (onlywriter.test.ts) -- plus direct
// reads/writes of `import_map`, a table events.ts doesn't own.
import type { Bindings } from "../env";
import * as cmini1 from "../../formats/adapters/cmini/index";
import * as akl1 from "../../formats/spark/1/index";
import { fromCmini, toCmini } from "../../formats/adapters/cmini/translate";
import { canonical } from "../core/canonical";
import { appendInfo, appendLike, appendWrite } from "../core/events";
import { nextUpstream, upstreamOf } from "../core/upstream";
import { readById, readByName, type RecordRow } from "../core/records";
import type { Clock } from "../core/time";
import { parseSnowflake, type RawUpstreamDetail } from "./upstream";
import type { DeleteAction } from "./plan";

const RECORD_FIELDS = new Set(["name", "user", "likes", "created_at", "modified_at"]);
// LDB-I10 (M1, design/layout-db/17-magic-ownership.md §2/§3): cmini's magic
// is never akl.gg's -- dropped here, before validation, so it can never
// reach `ParsedUpstreamDetail.payload` at all. This is a stronger guarantee
// than "the change-detection projection ignores it" (below): a fresh
// `applyNew` write and `applyMapped`'s upstream-derived fields alike simply
// never see the field, so `hasMagic(payload)` on either is always false --
// the only way a payload built from `detail.payload` ends up carrying magic
// is `applyMapped` deliberately carrying the RECORD's own magic forward
// (LDB-I11, below), never upstream's.
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

// detail minus the record fields (name user likes created_at modified_at)
// and (LDB-I10) `magic`; `link` stays in the payload (07 §5.1) -- only
// those six keys are ever stripped.
function payloadFromRaw(raw: RawUpstreamDetail): unknown {
  const payload: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (!RECORD_FIELDS.has(k) && !IMPORT_DROPPED_FIELDS.has(k)) payload[k] = v;
  }
  return payload;
}

// Validates the record-level fields cmini/1's own `validate()` doesn't see
// (name/user/created_at/modified_at/likes are record fields, stripped
// before the payload ever reaches the format), then the payload itself. A
// failure here is never a tick failure (07 §6 S5): the caller skips the
// record and reports {id, path, message}.
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

// The comparable projection of a fetched detail, likes AND magic stripped
// (LDB-I10/I11: upstream's payload never carries magic to begin with, after
// `payloadFromRaw`'s drop above, but projecting through `projectNoMagic`
// here too -- rather than plain `project` -- keeps this function correct
// on its own terms, not just correct because of what its one caller
// happens to feed it) -- used both for the content-differs decision and
// for repeat-suppression, so neither is ever tripped by a likes-only or
// magic-only change (06 §2's separate like diff owns likes; 17-magic-
// ownership.md §3 owns magic).
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

// The full projection (real likes) -- what's stored in an `upstream_changed`
// event's `detail` (03 §5: "upstream_changed: upstream's cmini/1 detail").
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

// LDB-I11: the record's own magic (nothing before M2; akl.gg's rules,
// lifted onto an `akl/1` record from M2 on -- LDB-I12's lift branch in
// `core/write.ts`'s `patchLayout`) is never a difference against upstream --
// excluded here the same way `projectUpstreamNoLikes` excludes upstream's.
// An `akl/1` record is compared through the same `?as=cmini/1` lowering
// every OTHER reader of a following record sees (LDB-P5: "every following
// record read `?as=cmini/1` equals upstream on the projection") -- `toCmini`
// -- rather than casting its payload straight to `cmini1.Payload`, which
// would compare the wrong shape entirely (an akl/1 `board` object where
// cmini1's own is a bare word, `tag`/`blame`/`combos`/`link` nested under
// `x.cmini` instead of top-level) and spuriously call every akl/1 following
// record's content "different" on every tick.
function projectLocalNoLikes(record: RecordRow): unknown {
  const payload: cmini1.Payload = record.format === "akl/1" ? toCmini(record.payload as akl1.Payload) : (record.payload as cmini1.Payload);
  return cmini1.projectNoMagic({
    name: record.name,
    owner: record.owner,
    created_at: record.created_at,
    modified_at: record.modified_at,
    likes: [],
    payload,
  });
}

// "Content differs" (07 §6 S5): the two sides' cmini/1 projections, likes
// and magic excluded, disagree.
export function contentDiffers(record: RecordRow, detail: ParsedUpstreamDetail): boolean {
  return canonical(projectLocalNoLikes(record)) !== canonical(projectUpstreamNoLikes(detail));
}

async function currentLikeIds(db: Bindings["DB"], layoutId: string): Promise<Set<string>> {
  const { results } = await db
    .prepare("SELECT user_id FROM likes WHERE layout_id = ?")
    .bind(layoutId)
    .all<{ user_id: string }>();
  return new Set(results.map((r) => r.user_id));
}

async function importMapByUpstreamId(db: Bindings["DB"], upstreamId: string): Promise<string | null> {
  const row = await db
    .prepare("SELECT layout_id FROM import_map WHERE upstream_id = ?")
    .bind(upstreamId)
    .first<{ layout_id: string }>();
  return row?.layout_id ?? null;
}

async function insertImportMap(db: Bindings["DB"], upstreamId: string, layoutId: string): Promise<void> {
  await db.prepare("INSERT INTO import_map (upstream_id, layout_id) VALUES (?, ?)").bind(upstreamId, layoutId).run();
}

// The name a shadowed import lands on: `<name>~cmini`, `~cmini2`, ... the
// first not held by any LIVE record (06 §2). Unreachable in phase 1 (no
// local writers create the colliding record in the first place) but built
// and tested per the brief.
async function freeShadowName(db: Bindings["DB"], name: string): Promise<string> {
  let candidate = `${name}~cmini`;
  let n = 2;
  while ((await readByName(db, candidate)) !== null) {
    candidate = `${name}~cmini${n}`;
    n++;
  }
  return candidate;
}

async function importLikes(db: Bindings["DB"], now: Clock, layoutId: string, userIds: string[]): Promise<void> {
  for (const userId of userIds) {
    await appendLike(db, now, { kind: "liked", layoutId, userId, via: "import:cmini" });
  }
}

// Case 1/2/3 (07 §6 S5's table): the upstream id has no `import_map` row
// yet.
async function applyNew(
  db: Bindings["DB"],
  now: Clock,
  upstreamId: string,
  detail: ParsedUpstreamDetail,
): Promise<void> {
  const existing = await readByName(db, detail.name);

  if (existing === null) {
    // Case 1: name free. No prior record to read `upstreamOf` from -- the
    // caller (this function) already knows the link it's about to create,
    // so it seeds `nextUpstream`'s `prior` with it directly (20-spark.md
    // S3a, `core/upstream.ts`'s header note).
    const { record } = await appendWrite(db, now, {
      kind: "imported",
      name: detail.name,
      owner: detail.owner,
      created_at: detail.created_at,
      modified_at: detail.modified_at,
      format: "cmini/1",
      payload: detail.payload,
      actor: "system:cmini-import",
      via: "import:cmini",
      detail: { source: "cmini", upstream_id: upstreamId },
      hasMagic: cmini1.hasMagic(detail.payload),
      upstream: nextUpstream({ source: "cmini", id: upstreamId, state: "following" }, "imported", "import:cmini"),
    });
    await insertImportMap(db, upstreamId, record.id);
    await importLikes(db, now, record.id, detail.likes);
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
      detail: projectUpstreamFull(detail),
    });
    return;
  }

  // Case 3: name held by a different owner -- import shadowed, and tell
  // the CONFLICTING (existing) record's owner first.
  await appendInfo(db, now, {
    kind: "import_conflict",
    layoutId: existing.id,
    actor: "system:cmini-import",
    via: "import:cmini",
    detail: { upstream_id: upstreamId, upstream_name: detail.name, conflicts_with: existing.id },
  });
  const shadowName = await freeShadowName(db, detail.name);
  const { record } = await appendWrite(db, now, {
    kind: "imported",
    name: shadowName,
    owner: detail.owner,
    created_at: detail.created_at,
    modified_at: detail.modified_at,
    format: "cmini/1",
    payload: detail.payload,
    actor: "system:cmini-import",
    via: "import:cmini",
    detail: { source: "cmini", upstream_id: upstreamId, shadowed: { upstream_name: detail.name } },
    hasMagic: cmini1.hasMagic(detail.payload),
    upstream: nextUpstream({ source: "cmini", id: upstreamId, state: "following" }, "imported", "import:cmini"),
  });
  await insertImportMap(db, upstreamId, record.id);
  await importLikes(db, now, record.id, detail.likes);
}

async function latestUpstreamChangedNoLikes(db: Bindings["DB"], layoutId: string): Promise<string | null> {
  const row = await db
    .prepare("SELECT detail_json FROM events WHERE layout_id = ? AND kind = 'upstream_changed' ORDER BY seq DESC LIMIT 1")
    .bind(layoutId)
    .first<{ detail_json: string | null }>();
  if (row?.detail_json === undefined || row.detail_json === null) return null;
  const parsed = JSON.parse(row.detail_json) as Record<string, unknown>;
  // `magic: undefined` (canonical() drops undefined-valued keys, core/
  // canonical.ts) rather than trusting every stored `upstream_changed`
  // detail to already lack it: an event written before M1 landed can still
  // carry upstream's old magic in its `detail_json` verbatim, and this
  // comparison must keep agreeing with `projectUpstreamNoLikes` (LDB-I1's
  // idempotence) regardless of when the last announcement was written.
  return canonical({ ...parsed, likes: [], magic: undefined });
}

// Case 4/5/6/7: the upstream id is mapped to an existing record.
async function applyMapped(
  db: Bindings["DB"],
  now: Clock,
  upstreamId: string,
  detail: ParsedUpstreamDetail,
  record: RecordRow,
): Promise<void> {
  const prior = await upstreamOf(db, record);
  const following = prior?.state === "following";
  const differs = contentDiffers(record, detail);
  const localLikeIds = await currentLikeIds(db, record.id);
  const upstreamLikeIds = new Set(detail.likes);

  if (following) {
    if (differs) {
      // Case 4: content differs -- replace it (a tombstone comes back).
      // LDB-I11 (M1, design/layout-db/17-magic-ownership.md §3): the
      // record's own `magic` survives this write byte-for-byte -- upstream
      // never supplies one (`detail.payload` already lacks it, LDB-I10), so
      // whatever is carried forward is whatever the RECORD already held
      // (nothing, for anything imported after M1; a legacy cmini import's
      // magic, until the one-time strip route removes it; akl.gg's rules,
      // once M2 lands, or a magic-only PATCH lift, LDB-I12).
      //
      // LDB-I12 (M2's prerequisite, design/layout-db/18-command-decisions.md
      // §2 item 1): a record can now be `akl/1` and still follow upstream
      // (a magic-only PATCH lifts it, `core/write.ts`'s `patchLayout`, and
      // stays followed -- `core/follows.ts`'s `followsUpstream` skips
      // magic-only writes). That record's `magic` idiom is native (unlike
      // cmini/1's flat rows), so it cannot be carried forward with a bare
      // object spread over upstream's cmini/1 detail -- upstream's keys/
      // board/free/x are translated into akl/1 first (`fromCmini`, the
      // SAME lossless translation the lift itself uses, LDB-F5), and only
      // then does the record's own `magic` get carried over untouched.
      if (record.format === "akl/1") {
        const existing = record.payload as akl1.Payload;
        const payload: akl1.Payload = { ...fromCmini(detail.payload), magic: existing.magic };
        await appendWrite(db, now, {
          kind: "imported",
          layoutId: record.id,
          name: detail.name,
          owner: detail.owner,
          created_at: detail.created_at,
          modified_at: detail.modified_at,
          format: "akl/1",
          payload,
          actor: "system:cmini-import",
          via: "import:cmini",
          detail: { source: "cmini", upstream_id: upstreamId },
          deleted: false,
          hasMagic: akl1.hasMagic(payload),
          upstream: nextUpstream(prior, "imported", "import:cmini"),
          expectRev: record.rev,
        });
      } else {
        const existingPayload = record.payload as cmini1.Payload;
        const payload: cmini1.Payload = { ...detail.payload, magic: existingPayload.magic };
        await appendWrite(db, now, {
          kind: "imported",
          layoutId: record.id,
          name: detail.name,
          owner: detail.owner,
          created_at: detail.created_at, // follows upstream too: a layout cmini deleted and re-added between two ticks moves it (2026-09-10, kate-2/eclipse-v2 flagged forever by the diff)
          modified_at: detail.modified_at,
          format: "cmini/1",
          payload,
          actor: "system:cmini-import",
          via: "import:cmini",
          detail: { source: "cmini", upstream_id: upstreamId },
          deleted: false,
          hasMagic: cmini1.hasMagic(payload),
          upstream: nextUpstream(prior, "imported", "import:cmini"),
          expectRev: record.rev,
        });
      }
    }
    // Case 5 (and the like half of case 4): likes replaced wholesale.
    for (const u of upstreamLikeIds) {
      if (!localLikeIds.has(u)) await appendLike(db, now, { kind: "liked", layoutId: record.id, userId: u, via: "import:cmini" });
    }
    for (const u of localLikeIds) {
      if (!upstreamLikeIds.has(u)) await appendLike(db, now, { kind: "unliked", layoutId: record.id, userId: u, via: "import:cmini" });
    }
    return;
  }

  if (differs) {
    // Case 6: not following -- inform only, and only if this is new news
    // (not a repeat of the daily pass re-announcing the same content).
    const latest = await latestUpstreamChangedNoLikes(db, record.id);
    const current = canonical(projectUpstreamNoLikes(detail));
    if (latest !== current) {
      await appendInfo(db, now, {
        kind: "upstream_changed",
        layoutId: record.id,
        actor: "system:cmini-import",
        via: "import:cmini",
        detail: projectUpstreamFull(detail),
      });
    }
  }
  // Case 7 (and the like half of case 6): union only, never unlike.
  for (const u of upstreamLikeIds) {
    if (!localLikeIds.has(u)) await appendLike(db, now, { kind: "liked", layoutId: record.id, userId: u, via: "import:cmini" });
  }
}

async function hasUpstreamDeletedInfo(db: Bindings["DB"], layoutId: string): Promise<boolean> {
  const row = await db
    .prepare("SELECT 1 FROM events WHERE layout_id = ? AND kind = 'upstream_deleted' AND rev IS NULL LIMIT 1")
    .bind(layoutId)
    .first();
  return row !== null;
}

// Case 8/9: upstream no longer has this id (unlisted, or a 404 discovered
// while fetching a listed id -- 07 §0.1).
export async function applyDelete(db: Bindings["DB"], now: Clock, layoutId: string): Promise<void> {
  const record = await readById(db, layoutId);
  if (record === null) return; // defensive: import_map pointed at a missing row

  const prior = await upstreamOf(db, record);
  const following = prior?.state === "following";
  if (following) {
    await appendWrite(db, now, {
      kind: "upstream_deleted",
      layoutId,
      name: record.name,
      owner: record.owner,
      modified_at: now(),
      format: record.format,
      payload: record.payload,
      actor: "system:cmini-import",
      via: "import:cmini",
      deleted: true,
      upstream: nextUpstream(prior, "upstream_deleted", "import:cmini"),
      expectRev: record.rev,
    });
    return;
  }

  if (!(await hasUpstreamDeletedInfo(db, layoutId))) {
    await appendInfo(db, now, {
      kind: "upstream_deleted",
      layoutId,
      actor: "system:cmini-import",
      via: "import:cmini",
    });
  }
}

export interface FetchedIdResult {
  errors: { id: string; path: string; message: string }[];
}

// The single entry point per fetched id (used by both cmini.ts's tick loop
// and cases.test.ts directly): dispatches to applyNew/applyMapped/
// applyDelete depending on the upstream id's current `import_map` state and
// whether the fetch came back 404.
export async function applyFetchedId(
  db: Bindings["DB"],
  now: Clock,
  upstreamId: string,
  raw: RawUpstreamDetail | "notfound",
): Promise<FetchedIdResult> {
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

// GET /authors -> upsert rows whose name differs (07 §6 S5); no events, and
// a row whose name already matches is left untouched (so `authors_modified
// at`/`last_seen_at` only moves on a real change).
export async function applyAuthors(db: Bindings["DB"], now: Clock, authors: Record<string, string>): Promise<void> {
  for (const [name, userId] of Object.entries(authors)) {
    const existing = await db.prepare("SELECT name FROM authors WHERE user_id = ?").bind(userId).first<{ name: string }>();
    const at = now();
    if (existing === null) {
      await db
        .prepare("INSERT INTO authors (user_id, name, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?)")
        .bind(userId, name, at, at)
        .run();
    } else if (existing.name !== name) {
      await db.prepare("UPDATE authors SET name = ?, last_seen_at = ? WHERE user_id = ?").bind(name, at, userId).run();
    }
  }
}
