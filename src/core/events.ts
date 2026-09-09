// Records + events, the fold (07 §6 S4). `appendWrite` is the only code
// under `src/` that writes `layouts`/`layout_revs` (checked by
// tests/tools/onlywriter.test.ts); `records.ts` only reads. The fold rule
// is uniform: a rev-bumping event sets the record to its `after` (record
// minus payload) plus the payload stored for that rev in `layout_revs`;
// `liked`/`unliked` move `like_count` by +-1; every other (informational)
// event changes nothing.
import type { Bindings } from "../env";
import { canonical } from "./canonical";
import { nameTaken } from "./errors";
import { type RecordRow, readById } from "./records";
import { ulid } from "ulidx";
import type { Clock } from "./time";

export type WriteKind =
  | "created"
  | "updated"
  | "renamed"
  | "fingermap"
  | "transferred"
  | "deleted"
  | "restored"
  | "imported"
  | "upstream_deleted";

export type InfoKind = "upstream_changed" | "import_conflict";

// A record minus its payload -- what `before`/`after` store on an event and
// what a list row carries (03 §2).
export type RecordSansPayload = Omit<RecordRow, "payload">;

export interface Write {
  kind: WriteKind;
  layoutId?: string; // absent = create
  name: string;
  owner: string;
  created_at?: string; // creates only; ignored on an update (the record's own created_at never moves)
  modified_at: string;
  format: string;
  payload: unknown;
  actor: string;
  via: string;
  admin?: boolean;
  detail?: object;
  deleted?: boolean;
  hasMagic?: boolean; // 07 §6 S4: "passed in by the caller ... default false"; S5/S6 compute it from the format
}

export interface Info {
  kind: InfoKind;
  layoutId: string;
  actor: string;
  via: string;
  detail?: object;
}

export interface Like {
  kind: "liked" | "unliked";
  layoutId: string;
  userId: string;
  via: string;
}

// A parsed `events` row (03 §5's wire shape, D1's 0/1 and JSON-string
// columns converted to real types).
export interface Event {
  seq: number;
  at: string;
  kind: string;
  layout_id: string | null;
  name: string | null;
  owner: string | null;
  rev: number | null; // the record's rev AFTER this event; null = no bump
  actor: string;
  via: string;
  admin: boolean;
  detail: unknown;
  before: RecordSansPayload | null;
  after: RecordSansPayload | null;
}

export interface EventDbRow {
  seq: number;
  at: string;
  kind: string;
  layout_id: string | null;
  name: string | null;
  owner: string | null;
  rev: number | null;
  actor: string;
  via: string;
  admin: number;
  detail_json: string | null;
  before_json: string | null;
  after_json: string | null;
}

export function rowToEvent(row: EventDbRow): Event {
  return {
    seq: row.seq,
    at: row.at,
    kind: row.kind,
    layout_id: row.layout_id,
    name: row.name,
    owner: row.owner,
    rev: row.rev,
    actor: row.actor,
    via: row.via,
    admin: row.admin !== 0,
    detail: row.detail_json === null ? null : JSON.parse(row.detail_json),
    before: row.before_json === null ? null : (JSON.parse(row.before_json) as RecordSansPayload),
    after: row.after_json === null ? null : (JSON.parse(row.after_json) as RecordSansPayload),
  };
}

function sansPayload(rec: RecordRow): RecordSansPayload {
  const { payload: _payload, ...rest } = rec;
  return rest;
}

// One batch: `events` (rev = previous + 1) -> `layout_revs` (event_seq =
// last_insert_rowid(), the same D1 connection/transaction the whole batch
// runs on, 07 §4) -> `layouts` (INSERT OR REPLACE, keyed by id).
export async function appendWrite(
  db: Bindings["DB"],
  now: Clock,
  w: Write,
): Promise<{ record: RecordRow; seq: number }> {
  const at = now();
  const creating = w.layoutId === undefined;
  const id = creating ? ulid() : w.layoutId!;

  let current: RecordRow | null = null;
  if (!creating) {
    current = await readById(db, id);
    if (current === null) {
      throw new Error(`appendWrite: layoutId '${id}' does not exist`);
    }
  }

  const deleted = w.deleted ?? false;
  const name = w.name; // tombstones keep their literal name (01 §1); layouts_name_live
  // (migrations/0001_init.sql) enforces uniqueness among LIVE records only

  if (!deleted) {
    // Case-insensitive collision against any OTHER live record (self-
    // exclusion by id lets an update keep its own current name, and lets
    // `renamed` and `imported`-revival reuse a name a tombstone isn't
    // occupying live-wise even though it still carries it). A deleted
    // write skips this: two records -- one live, one a tombstone -- may
    // share a name; only claiming a LIVE slot for it needs the check
    // (layouts_name_live's own WHERE clause would let the DB itself catch
    // this too, but pre-checking gives the clean `name_taken` error).
    const clash = await db
      .prepare("SELECT 1 FROM layouts WHERE deleted = 0 AND name = ? AND id != ? LIMIT 1")
      .bind(w.name, id)
      .first();
    if (clash !== null) throw nameTaken(w.name);
  }

  const rev = creating ? 1 : current!.rev + 1; // continues across deleted -> restored/imported/upstream_deleted
  const created_at = creating ? (w.created_at ?? w.modified_at) : current!.created_at;
  const like_count = creating ? 0 : current!.like_count; // appendWrite never moves like_count
  const has_magic = w.hasMagic ?? false;

  const before: RecordSansPayload | null = current === null ? null : sansPayload(current);
  const after: RecordSansPayload = {
    id,
    name,
    owner: w.owner,
    rev,
    created_at,
    modified_at: w.modified_at,
    deleted,
    like_count,
    has_magic,
    format: w.format,
  };

  const payloadJson = canonical(w.payload);

  const results = await db.batch([
    db
      .prepare(
        `INSERT INTO events (at, kind, layout_id, name, owner, rev, actor, via, admin, detail_json, before_json, after_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        at,
        w.kind,
        id,
        name,
        w.owner,
        rev,
        w.actor,
        w.via,
        w.admin === true ? 1 : 0,
        w.detail === undefined ? null : canonical(w.detail),
        before === null ? null : canonical(before),
        canonical(after),
      ),
    db
      .prepare(
        `INSERT INTO layout_revs (layout_id, rev, event_seq, format, payload_json)
         VALUES (?, ?, last_insert_rowid(), ?, ?)`,
      )
      .bind(id, rev, w.format, payloadJson),
    db
      .prepare(
        `INSERT OR REPLACE INTO layouts (id, name, owner, rev, created_at, modified_at, deleted, format, payload_json, like_count, has_magic)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        id,
        name,
        w.owner,
        rev,
        created_at,
        w.modified_at,
        deleted ? 1 : 0,
        w.format,
        payloadJson,
        like_count,
        has_magic ? 1 : 0,
      ),
  ]);

  const seq = results[0]?.meta.last_row_id;
  if (seq === undefined) throw new Error("appendWrite: events insert returned no last_row_id");

  return { record: { ...after, payload: w.payload }, seq };
}

// Informational: `rev` NULL, `layouts` untouched. Still carries the
// record's current name/owner (not just its id) so a feed reader doesn't
// need a second lookup to know what the event is about.
export async function appendInfo(db: Bindings["DB"], now: Clock, i: Info): Promise<{ seq: number }> {
  const current = await readById(db, i.layoutId);
  if (current === null) throw new Error(`appendInfo: layoutId '${i.layoutId}' does not exist`);

  const result = await db
    .prepare(
      `INSERT INTO events (at, kind, layout_id, name, owner, rev, actor, via, admin, detail_json, before_json, after_json)
       VALUES (?, ?, ?, ?, ?, NULL, ?, ?, 0, ?, NULL, NULL)`,
    )
    .bind(
      now(),
      i.kind,
      i.layoutId,
      current.name,
      current.owner,
      i.actor,
      i.via,
      i.detail === undefined ? null : canonical(i.detail),
    )
    .run();

  const seq = result.meta.last_row_id;
  return { seq };
}

// Idempotent: liking an already-liked record (or unliking one that isn't
// liked) appends no event and leaves `like_count` untouched -- the only
// case in this module with no batch at all.
export async function appendLike(
  db: Bindings["DB"],
  now: Clock,
  l: Like,
): Promise<{ seq: number | null; like_count: number }> {
  const current = await readById(db, l.layoutId);
  if (current === null) throw new Error(`appendLike: layoutId '${l.layoutId}' does not exist`);

  const existing = await db
    .prepare("SELECT 1 FROM likes WHERE layout_id = ? AND user_id = ?")
    .bind(l.layoutId, l.userId)
    .first();
  const alreadyLiked = existing !== null;
  const wantsLike = l.kind === "liked";

  if (wantsLike === alreadyLiked) {
    return { seq: null, like_count: current.like_count };
  }

  const at = now();
  const like_count = current.like_count + (wantsLike ? 1 : -1);

  const results = await db.batch([
    db
      .prepare(
        `INSERT INTO events (at, kind, layout_id, name, owner, rev, actor, via, admin, detail_json, before_json, after_json)
         VALUES (?, ?, ?, ?, ?, NULL, ?, ?, 0, NULL, NULL, NULL)`,
      )
      .bind(at, l.kind, l.layoutId, current.name, current.owner, l.userId, l.via),
    wantsLike
      ? db.prepare("INSERT INTO likes (layout_id, user_id, at) VALUES (?, ?, ?)").bind(l.layoutId, l.userId, at)
      : db.prepare("DELETE FROM likes WHERE layout_id = ? AND user_id = ?").bind(l.layoutId, l.userId),
    db.prepare("UPDATE layouts SET like_count = ? WHERE id = ?").bind(like_count, l.layoutId),
  ]);

  const seq = results[0]?.meta.last_row_id;
  if (seq === undefined) throw new Error("appendLike: events insert returned no last_row_id");
  return { seq, like_count };
}

// A function boundary here (rather than inlining the spread in the loop
// below) sidesteps a TS control-flow-analysis quirk: narrowing `state`
// through its own reassignment inside a `for` loop resolves it to `never`
// at the spread (confirmed against a minimal repro outside this file).
function bumpLikeCount(prev: RecordSansPayload, delta: 1 | -1): RecordSansPayload {
  return { ...prev, like_count: prev.like_count + delta };
}

// Replays one record's own events (in seq order) against the payloads
// stored for its revs. Returns null if the record was never written
// (an empty event list).
export function foldRecord(
  events: Event[],
  revs: Map<number, { format: string; payload: unknown }>,
): RecordRow | null {
  let state: RecordSansPayload | null = null;
  let payload: unknown;

  for (const e of events) {
    if (e.rev !== null) {
      if (e.after === null) throw new Error(`foldRecord: rev-bumping event (seq ${e.seq}) has no 'after'`);
      const rev = revs.get(e.rev);
      if (rev === undefined) throw new Error(`foldRecord: no layout_revs entry for rev ${e.rev}`);
      state = e.after;
      payload = rev.payload;
    } else if (e.kind === "liked" || e.kind === "unliked") {
      if (state === null) throw new Error(`foldRecord: like event (seq ${e.seq}) precedes any write`);
      state = bumpLikeCount(state, e.kind === "liked" ? 1 : -1);
    }
    // else: informational -- no state change
  }

  return state === null ? null : { ...state, payload };
}

// `since` exclusive; first event is seq 1 (`since=0` = everything); `next`
// is the last seq returned; `limit` capped at 1000 (03 §5, 07 §6 S4).
export async function feed(
  db: Bindings["DB"],
  since: number,
  limit: number,
  kinds?: string[],
): Promise<{ next: number; items: Event[] }> {
  const cappedLimit = Math.min(limit, 1000);
  const params: unknown[] = [since];
  let sql = "SELECT * FROM events WHERE seq > ?";
  if (kinds !== undefined && kinds.length > 0) {
    sql += ` AND kind IN (${kinds.map(() => "?").join(",")})`;
    params.push(...kinds);
  }
  sql += " ORDER BY seq ASC LIMIT ?";
  params.push(cappedLimit);

  const { results } = await db
    .prepare(sql)
    .bind(...params)
    .all<EventDbRow>();
  const items = results.map(rowToEvent);
  const next = items.length > 0 ? items[items.length - 1]!.seq : since;
  return { next, items };
}
