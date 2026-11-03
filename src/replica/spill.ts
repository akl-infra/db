// S3 spill for big log bodies (phase B). A commit unit whose encoded body is over 300,000 bytes (a dump-restore batch
// reaches about 458 KB; a DynamoDB item holds 400 KB) is written to the object store as `log/<unitId>.json.zst` BEFORE the
// append, and the log item carries `{spill, hash}` instead of the body. Readers fetch the object, decompress it and verify
// the sha256 of the JSON text against `hash`; a missing or damaged object is an error, never a silent empty body.
// Orphans (an append that lost, timed out and never landed) are harmless: nothing points at them.
import { createHash } from "node:crypto";
import { LogEntryTooLargeError, MAX_BODY_BYTES, checkedBody, encodeBody, type ImageRef, type NewLogEntry } from "./log";
import type { ObjectStore } from "./objects";
import { SNAPSHOT_LEVEL, SPILL_LEVEL, zstdCompress, zstdDecompress } from "./zstd";

/** Bodies over this many bytes are spilled (a DynamoDB item is 400 KB; the inline budget is MAX_BODY_BYTES = 350,000). */
export const SPILL_THRESHOLD = 300_000;
/** A sanity cap: one unit is never legitimately this big. */
export const MAX_SPILL_BYTES = 64 * 1024 * 1024;

export const spillKey = (unitId: string): string => `log/${unitId}.json.zst`;

/** The cutover image's object (phase E). Not matched by retention's orphan sweep (`.json.zst` only): the base of a replay from 0 stays. */
export const imageKey = (unitId: string): string => `log/${unitId}.image.zst`;
/** A sanity cap on an image (a Lambda holds 2 GB; the database is tens of MB). */
export const MAX_IMAGE_BYTES = 512 * 1024 * 1024;

/** What a log item stores for one body: the JSON inline, or a reference to the spilled object. */
export type StoredBody = { body: string; spill?: undefined } | { body?: undefined; spill: string; hash: string };

/** A spilled body could not be read back intact. */
export class SpillError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "SpillError";
  }
}

const sha256Hex = (b: Uint8Array | string): string => createHash("sha256").update(b).digest("hex");

export class BodySpiller {
  /** The last few spilled unit ids: an append retried after an ambiguous outcome reuses the same entry and need not upload again. */
  readonly #memo = new Map<string, { spill: string; hash: string }>();
  readonly uploads = { count: 0 };

  constructor(readonly blobs: ObjectStore | undefined, readonly threshold: number = SPILL_THRESHOLD) {}

  /**
   * Choose inline or spill for `entry` and, for a spill, upload it first. Without an object store the body must fit
   * `inlineLimit` (as before phase B) or LogEntryTooLargeError says so.
   */
  async store(entry: Pick<NewLogEntry, "unitId" | "stmts" | "hash" | "name" | "at">, inlineLimit: number = MAX_BODY_BYTES): Promise<StoredBody> {
    if (this.blobs === undefined) return { body: checkedBody(entry, inlineLimit) };
    const json = encodeBody(entry);
    const bytes = Buffer.byteLength(json, "utf8");
    if (bytes <= Math.min(this.threshold, inlineLimit)) return { body: json };
    if (bytes > MAX_SPILL_BYTES) throw new LogEntryTooLargeError(bytes, MAX_SPILL_BYTES);
    const memo = this.#memo.get(entry.unitId);
    if (memo !== undefined) return memo;
    const raw = Buffer.from(json, "utf8");
    const hash = sha256Hex(raw);
    const key = spillKey(entry.unitId);
    await this.blobs.put(key, zstdCompress(raw, SPILL_LEVEL), { sha256: hash, size: String(bytes), unit: entry.unitId });
    const ref = { spill: key, hash };
    this.#memo.set(entry.unitId, ref);
    if (this.#memo.size > 4) this.#memo.delete(this.#memo.keys().next().value as string);
    this.uploads.count++;
    return ref;
  }

  /** The JSON text of a stored body, fetched and verified when it was spilled. */
  async load(item: { body?: string; spill?: string; hash?: string }, label: string): Promise<string> {
    if (item.spill === undefined) {
      if (item.body === undefined) throw new SpillError(`${label}: the log item has neither a body nor a spill reference`);
      return item.body;
    }
    if (this.blobs === undefined) throw new SpillError(`${label}: its body is spilled to ${item.spill} but no object store is configured`);
    const obj = await this.blobs.get(item.spill);
    if (obj === null) throw new SpillError(`${label}: spilled body ${item.spill} is missing from the object store`);
    return verify(obj.bytes, item, label);
  }

  /**
   * Upload the cutover image BEFORE the append (like a spilled body; an orphan from a lost append is harmless). Returns the
   * reference the entry carries and the raw image's sha256, which is the entry's `hash`.
   */
  async storeImage(
    unitId: string,
    raw: Uint8Array,
    extra: Pick<ImageRef, "tables" | "source">,
    level: number = SNAPSHOT_LEVEL,
  ): Promise<{ image: ImageRef; hash: string }> {
    if (this.blobs === undefined) throw new SpillError("the image entry needs an object store");
    if (raw.byteLength > MAX_IMAGE_BYTES) throw new LogEntryTooLargeError(raw.byteLength, MAX_IMAGE_BYTES);
    const hash = sha256Hex(raw);
    const z = zstdCompress(raw, level);
    const key = imageKey(unitId);
    await this.blobs.put(key, z, { sha256: hash, size: String(raw.byteLength), unit: unitId });
    return { image: { key, bytes: raw.byteLength, zbytes: z.byteLength, tables: extra.tables, ...(extra.source !== undefined ? { source: extra.source } : {}) }, hash };
  }

  /** The decompressed image of an image entry. Fetches and decompresses and checks the size; the sha256 is the REPLICA's to judge (CV10). */
  async loadImage(ref: ImageRef, label: string): Promise<Uint8Array> {
    if (this.blobs === undefined) throw new SpillError(`${label}: its image is ${ref.key} but no object store is configured`);
    const obj = await this.blobs.get(ref.key);
    if (obj === null) throw new SpillError(`${label}: image ${ref.key} is missing from the object store`);
    return unpackImage(obj.bytes, ref, label);
  }

  /** loadImage() for a MemoryObjects store, without awaiting. */
  loadImageSync(ref: ImageRef, peek: (key: string) => { bytes: Uint8Array } | undefined, label: string): Uint8Array {
    const obj = peek(ref.key);
    if (obj === undefined) throw new SpillError(`${label}: image ${ref.key} is missing from the object store`);
    return unpackImage(obj.bytes, ref, label);
  }

  /** load() for a MemoryObjects store, without awaiting (MemoryLog.entries()). */
  loadSync(item: { body?: string; spill?: string; hash?: string }, peek: (key: string) => { bytes: Uint8Array } | undefined, label: string): string {
    if (item.spill === undefined) return item.body ?? "";
    const obj = peek(item.spill);
    if (obj === undefined) throw new SpillError(`${label}: spilled body ${item.spill} is missing from the object store`);
    return verify(obj.bytes, item, label);
  }
}

function unpackImage(compressed: Uint8Array, ref: ImageRef, label: string): Uint8Array {
  let raw: Uint8Array;
  try {
    raw = zstdDecompress(compressed);
  } catch (e) {
    throw new SpillError(`${label}: image ${ref.key} does not decompress: ${e instanceof Error ? e.message : String(e)}`, { cause: e });
  }
  if (raw.byteLength !== ref.bytes) throw new SpillError(`${label}: image ${ref.key} is ${raw.byteLength} bytes, the log entry says ${ref.bytes}`);
  return raw;
}

function verify(compressed: Uint8Array, item: { spill?: string; hash?: string }, label: string): string {
  let raw: Uint8Array;
  try {
    raw = zstdDecompress(compressed);
  } catch (e) {
    throw new SpillError(`${label}: spilled body ${item.spill} does not decompress: ${e instanceof Error ? e.message : String(e)}`, { cause: e });
  }
  const got = sha256Hex(raw);
  if (got !== item.hash) throw new SpillError(`${label}: spilled body ${item.spill} has sha256 ${got}, the log item says ${item.hash}`);
  return Buffer.from(raw).toString("utf8");
}
