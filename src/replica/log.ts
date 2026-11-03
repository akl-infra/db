// The commit log (design A, handoff/akldb-on-aws-build-plan.md phase A). Every
// D1 commit unit (one `.run()` that changes rows, or one `.batch()`) is
// appended here, gap-free and totally ordered; every replica replays the
// entries it has not seen by re-executing the logged statements.
// Backends: log-memory.ts (tests, fault injection) and log-ddb.ts (DynamoDB).
// Node-free on purpose: nothing in this file touches sqlite.

export type LogEntryKind = "unit" | "migration" | "image";

/**
 * The cutover image (phase E, LDB-CV10): the whole of D1's database as ONE log entry, always seq 1. The entry's `hash` is the
 * sha256 of the raw SQLite image; the image itself lives in the object store as `key` (zstd), never in the log item.
 */
export interface ImageRef {
  /** Object-store key of the zstd-compressed image: `log/<unitId>.image.zst`. */
  key: string;
  /** Raw (decompressed) image size in bytes. */
  bytes: number;
  /** Compressed object size in bytes. */
  zbytes: number;
  /** The D1 export's per-table proof: row count and the canonical-rows checksum (scripts/cutover/checksum.mjs). */
  tables: Record<string, { count: number; checksum: string }>;
  /** Free-form provenance (the D1 time-travel bookmark, the freeze seq ...). */
  source?: Record<string, string | number | null>;
}

/** One statement of a unit, exactly as bound: `params` are null, number, string or Uint8Array (booleans are already 1/0). */
export interface LogStmt {
  sql: string;
  params: unknown[];
  /** `db.exec(sql)` (possibly several statements, no params), for `D1Database.exec`. */
  exec?: true;
}

export interface LogEntry {
  /** 1, 2, 3 ... with no gap. */
  seq: number;
  /** A ULID minted per commit attempt: the handle that resolves an ambiguous append (SH6). */
  unitId: string;
  kind: LogEntryKind;
  stmts: LogStmt[];
  /** sha256 hex of the writer's session changeset (kind "unit"), or of the migration SQL (kind "migration"). */
  hash: string;
  /** Migration file name (`0001_init.sql`), as wrangler records it in d1_migrations. */
  name?: string;
  /** Migration only: the `applied_at` the replicas record (`YYYY-MM-DD HH:MM:SS`), never CURRENT_TIMESTAMP. */
  at?: string;
  /**
   * The connection's last_insert_rowid() the writer ran the unit from. Replicas restore it before replaying, so a statement
   * that reads last_insert_rowid() (SQL) or a non-insert statement's meta.last_row_id sees the same value everywhere (SH8).
   * Absent on entries written before this field existed: replay then keeps the replica's own value.
   */
  lrid?: number;
  /** Image only (kind "image"): where the image is and what the D1 export proved about it. `stmts` is empty, `hash` is the raw image's sha256. */
  image?: ImageRef;
  /**
   * Image only, set by a backend when it READS the entry: the decompressed image. The backend fetches and decompresses; it does
   * NOT judge the bytes: the replica compares their sha256 with `hash` and halts on a mismatch (LDB-CV10).
   */
  imageData?: Uint8Array;
}

export type NewLogEntry = Omit<LogEntry, "seq" | "imageData">;

/** The image entry was appended anywhere but seq 1, or an entry claims to be an image without being one (LDB-CV10). */
export class ImageEntryRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImageEntryRefusedError";
  }
}

/** Every backend calls this first: an image entry is seq 1 (`expectedHead` 0) or it is refused, and only an image carries `image`. */
export function assertImageAppend(expectedHead: number, entry: Pick<NewLogEntry, "kind" | "image" | "unitId">): void {
  if (entry.kind === "image") {
    if (expectedHead !== 0) throw new ImageEntryRefusedError(`an image entry must be the log's first entry (seq 1); the head is ${expectedHead}, so seq ${expectedHead + 1} is refused (unit ${entry.unitId})`);
    if (entry.image === undefined) throw new ImageEntryRefusedError(`image entry ${entry.unitId} carries no image reference`);
  } else if (entry.image !== undefined) {
    throw new ImageEntryRefusedError(`entry ${entry.unitId} is a ${entry.kind} but carries an image reference`);
  }
}

export interface CommitLog {
  /** The newest seq, read strongly (0 for an empty log). */
  head(): Promise<number>;
  /** The entries with `afterSeq < seq <= upTo`, in order, read strongly. */
  read(afterSeq: number, upTo: number): Promise<LogEntry[]>;
  /**
   * Append `entry` as seq `expectedHead + 1` if and only if the head is still `expectedHead`.
   * "conflict": it was not appended (someone else was first). An ambiguous outcome (network error or timeout
   * after the request left) throws AmbiguousAppendError: the entry may or may not be in the log.
   */
  append(expectedHead: number, entry: NewLogEntry): Promise<"ok" | "conflict">;
  /** One entry, read strongly; null if absent. */
  get(seq: number): Promise<LogEntry | null>;
}

/** Retention (RP3): the part of a log backend that marks old entries for expiry. DynamoDB deletes an item some time after its `ttl` (epoch seconds) passes. */
export interface ExpirableLog {
  /**
   * Give the entries `afterSeq < seq <= upToSeq` an expiry time of `atSec` (epoch seconds), at most `max` of them per call, in
   * seq order. `through` is the highest seq handled (`afterSeq` when none): the caller records it and continues from there.
   * A backend never expires HEAD, and this does not decide WHICH entries are safe to expire: retention.ts does.
   */
  expire(afterSeq: number, upToSeq: number, atSec: number, max: number): Promise<{ marked: number; through: number }>;
}

/** The outcome of an append is unknown: resolve it by reading `seq + 1` back and comparing unit ids (SH6). */
export class AmbiguousAppendError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "AmbiguousAppendError";
  }
}

/** The backend refused for capacity (throttling, 5xx) after its own bounded retries; nothing was written. Retryable. */
export class LogThrottledError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "LogThrottledError";
  }
}

/** An entry whose encoded body does not fit one DynamoDB item (phase B moves big bodies to S3). */
export class LogEntryTooLargeError extends Error {
  constructor(readonly bytes: number, readonly limit: number) {
    super(`commit log entry body is ${bytes} bytes, over the ${limit}-byte item budget (phase B stores big bodies in S3)`);
    this.name = "LogEntryTooLargeError";
  }
}

/** A DynamoDB item is 400 KB; the body gets 350,000 bytes of it. */
export const MAX_BODY_BYTES = 350_000;

interface BodyJson {
  stmts: { sql: string; params: unknown[]; exec?: true }[];
  hash: string;
  name?: string;
  at?: string;
  lrid?: number;
  image?: ImageRef;
}

function encodeParam(p: unknown): unknown {
  if (p instanceof Uint8Array) return { $blob: Buffer.from(p.buffer, p.byteOffset, p.byteLength).toString("base64") };
  return p;
}

function decodeParam(p: unknown): unknown {
  if (typeof p === "object" && p !== null && "$blob" in p) return new Uint8Array(Buffer.from((p as { $blob: string }).$blob, "base64"));
  return p;
}

/** The JSON text stored in an entry's body attribute. */
export function encodeBody(entry: Pick<NewLogEntry, "stmts" | "hash" | "name" | "at" | "lrid" | "image">): string {
  const body: BodyJson = {
    stmts: entry.stmts.map((s) => ({ sql: s.sql, params: s.params.map(encodeParam), ...(s.exec === true ? { exec: true as const } : {}) })),
    hash: entry.hash,
    ...(entry.name !== undefined ? { name: entry.name } : {}),
    ...(entry.at !== undefined ? { at: entry.at } : {}),
    ...(entry.lrid !== undefined ? { lrid: entry.lrid } : {}),
    ...(entry.image !== undefined ? { image: entry.image } : {}),
  };
  return JSON.stringify(body);
}

export function decodeBody(json: string): Pick<LogEntry, "stmts" | "hash" | "name" | "at" | "lrid" | "image"> {
  const body = JSON.parse(json) as BodyJson;
  return {
    stmts: body.stmts.map((s) => ({ sql: s.sql, params: s.params.map(decodeParam), ...(s.exec === true ? { exec: true as const } : {}) })),
    hash: body.hash,
    ...(body.name !== undefined ? { name: body.name } : {}),
    ...(body.at !== undefined ? { at: body.at } : {}),
    ...(body.lrid !== undefined ? { lrid: body.lrid } : {}),
    ...(body.image !== undefined ? { image: body.image } : {}),
  };
}

/** Throws LogEntryTooLargeError when the encoded body is over `limit` (default MAX_BODY_BYTES); returns the encoded body. */
export function checkedBody(entry: Pick<NewLogEntry, "stmts" | "hash" | "name" | "at" | "lrid" | "image">, limit: number = MAX_BODY_BYTES): string {
  const body = encodeBody(entry);
  const bytes = Buffer.byteLength(body, "utf8");
  if (bytes > limit) throw new LogEntryTooLargeError(bytes, limit);
  return body;
}
