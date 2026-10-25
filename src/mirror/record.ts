// The tee record (design/aws-port.md §5.2): what lane T's recorder sends and lane Z's applier reads.
// One recorded storage write (design/aws-port.md §5.2). FROZEN once T's first commit lands.
export interface TeeCall {
  v: 1;
  /** "<area>.<method>", e.g. "events.commitWrite". */
  method: string;
  /** Arguments encoded with encodeTee(); a Clock argument becomes {"$clock": [iso, ...]}, the values it returned. */
  args: unknown[];
  /** The outcome, encoded. */
  outcome: { ok: unknown } | { error: { name: string; status?: number; body?: unknown; message: string } };
  /** Event seqs this call committed, ascending ([] if none). */
  seqs: number[];
  /** Date.now() when the call returned. */
  atMs: number;
}
export interface TeeBatch {
  v: 1;
  /** Which way the mirror runs: "d1->ddb" before the cutover, "ddb->d1" after. */
  direction: "d1->ddb" | "ddb->d1";
  /** A random id; ingest dedupes on it. */
  batchId: string;
  calls: TeeCall[];
}
/** Headers: X-Akldb-Tee-Ts (epoch s, ±300 s), X-Akldb-Tee-Sig = hex HMAC-SHA256(secret, ts + "\n" + body). */
export const TEE_TS_HEADER = "X-Akldb-Tee-Ts";
export const TEE_SIG_HEADER = "X-Akldb-Tee-Sig";
/** Tagged JSON: Map -> {"$map": [[k, v], ...]}, Set -> {"$set": [...]}, Uint8Array -> {"$bytes": b64}, undefined -> {"$u": 1}. */
// Beyond the pinned tags (lane T's codec, agreed with lane Z): a plain object with a key that starts with "$" (or is "__proto__")
// is wrapped {"$obj": [[k, v], ...]} so user JSON can never be mistaken for a tag; Date -> {"$date": iso};
// a non-finite or negative-zero number -> {"$num": "NaN" | "Infinity" | "-Infinity" | "-0"}; an object property whose value is
// undefined stays, as {"$u": 1}. {"$clock": [iso, ...]} decodes to a RecordedClock.

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function toBase64(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i]!;
    const b = bytes[i + 1];
    const c = bytes[i + 2];
    out += B64[a >> 2]! + B64[((a & 3) << 4) | ((b ?? 0) >> 4)]!;
    out += b === undefined ? "=" : B64[((b & 15) << 2) | ((c ?? 0) >> 6)]!;
    out += c === undefined ? "=" : B64[c & 63]!;
  }
  return out;
}

function fromBase64(s: string): Uint8Array {
  const clean = s.replace(/=+$/, "");
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let o = 0;
  let acc = 0;
  let bits = 0;
  for (const ch of clean) {
    const v = B64.indexOf(ch);
    if (v < 0) throw new TypeError("decodeTee: bad base64");
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (acc >> bits) & 255;
    }
  }
  return out;
}

/** The values a Clock argument returned while its call ran, in order. */
export class RecordedClock {
  constructor(readonly values: string[]) {}
}

/** A Clock that returns the recorded values in order and throws if read more often than recorded. */
export function replayClock(rc: RecordedClock): () => string {
  let i = 0;
  return () => {
    if (i >= rc.values.length) throw new Error(`replayClock: read ${i + 1} times, recorded ${rc.values.length}`);
    return rc.values[i++]!;
  };
}

function isPlain(v: object): boolean {
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

function needsObjTag(keys: string[]): boolean {
  return keys.some((k) => k.startsWith("$") || k === "__proto__");
}

export function encodeTee(value: unknown): unknown {
  if (value === undefined) return { $u: 1 };
  if (value === null || typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number") {
    if (Number.isFinite(value) && !Object.is(value, -0)) return value;
    return { $num: Object.is(value, -0) ? "-0" : String(value) };
  }
  if (typeof value !== "object") throw new TypeError(`encodeTee: cannot encode a ${typeof value}`);
  if (Array.isArray(value)) return value.map((v) => encodeTee(v));
  if (value instanceof Uint8Array) return { $bytes: toBase64(value) };
  if (value instanceof Map) return { $map: [...value].map(([k, v]) => [encodeTee(k), encodeTee(v)]) };
  if (value instanceof Set) return { $set: [...value].map((v) => encodeTee(v)) };
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) throw new TypeError("encodeTee: invalid Date");
    return { $date: value.toISOString() };
  }
  if (value instanceof RecordedClock) return { $clock: [...value.values] };
  if (!isPlain(value)) throw new TypeError("encodeTee: cannot encode a class instance");
  const keys = Object.keys(value);
  if (needsObjTag(keys)) return { $obj: keys.map((k) => [k, encodeTee((value as Record<string, unknown>)[k])]) };
  const out: Record<string, unknown> = {};
  for (const k of keys) out[k] = encodeTee((value as Record<string, unknown>)[k]);
  return out;
}

function setOwn(o: Record<string, unknown>, k: string, v: unknown): void {
  Object.defineProperty(o, k, { value: v, enumerable: true, writable: true, configurable: true });
}

export function decodeTee(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((v) => decodeTee(v));
  const o = value as Record<string, unknown>;
  const keys = Object.keys(o);
  if (keys.length === 1 && keys[0]!.startsWith("$")) {
    const tag = keys[0]!;
    const body = o[tag];
    switch (tag) {
      case "$u":
        return undefined;
      case "$bytes":
        return fromBase64(body as string);
      case "$map":
        return new Map((body as unknown[][]).map(([k, v]) => [decodeTee(k), decodeTee(v)]));
      case "$set":
        return new Set((body as unknown[]).map((v) => decodeTee(v)));
      case "$date":
        return new Date(body as string);
      case "$num":
        return body === "NaN" ? NaN : body === "Infinity" ? Infinity : body === "-Infinity" ? -Infinity : -0;
      case "$clock":
        return new RecordedClock([...(body as string[])]);
      case "$obj": {
        const out: Record<string, unknown> = {};
        for (const [k, v] of body as [string, unknown][]) setOwn(out, k, decodeTee(v));
        return out;
      }
      default:
        throw new TypeError(`decodeTee: unknown tag ${tag}`);
    }
  }
  const out: Record<string, unknown> = {};
  for (const k of keys) {
    if (k.startsWith("$")) throw new TypeError(`decodeTee: stray key ${k}`);
    setOwn(out, k, decodeTee(o[k]));
  }
  return out;
}
