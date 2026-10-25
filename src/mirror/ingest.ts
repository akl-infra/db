// The mirror's ingest (design/aws-port.md §5.2 item 1-2; lane Z): `AuthType NONE` plus HMAC-SHA256 over the timestamped body.
// Verify the signature and the timestamp, dedupe on `batchId`, enqueue every call (by first seq, or by the time it returned),
// then wake the applier. Platform-neutral: the same function sits behind the `mirror-ingest` Function URL (direction "d1->ddb")
// and behind the D1 Worker's `/__mirror` route (direction "ddb->d1", off unless MIRROR_SECRET is set).
import { MAX_UNIT, QueueConflict, type MirrorQueue } from "./queue";
import { TEE_SIG_HEADER, TEE_TS_HEADER, type TeeBatch, type TeeCall } from "./record";
import { isMirrorWrite } from "./verify";

export interface IngestRequest {
  /** Header lookup, case-insensitive (a `Headers`, or a lower-cased record from a Lambda event). */
  header(name: string): string | null;
  /** The exact request body text the signature covers. */
  body: string;
}

export interface IngestDeps {
  secret: string;
  queue: MirrorQueue;
  nowMs(): number;
  /** Wake the applier (Lambda async invoke; the Worker route's waitUntil). A failure here never fails the ingest: the 1-minute schedule covers it. */
  wake?(): Promise<void>;
  log?(line: Record<string, unknown>): void;
  /** Largest accepted body (default 5 MB; a Function URL takes 6 MB). */
  maxBodyBytes?: number;
}

export interface IngestResult {
  status: number;
  body: Record<string, unknown>;
}

const SKEW_SEC = 300;
const UNIT_BYTES = 3_000_000;
const BATCH_ID = /^[A-Za-z0-9_-]{1,128}$/;
const enc = new TextEncoder();

const hex = (bytes: ArrayBuffer): string => [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");

async function hmacKey(secret: string, usage: "sign" | "verify"): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [usage]);
}

/** hex HMAC-SHA256(secret, ts + "\n" + body): what the sender puts in X-Akldb-Tee-Sig. */
export async function signTee(secret: string, ts: number | string, body: string): Promise<string> {
  return hex(await crypto.subtle.sign("HMAC", await hmacKey(secret, "sign"), enc.encode(`${ts}\n${body}`)));
}

async function signatureValid(secret: string, ts: string, body: string, sig: string): Promise<boolean> {
  if (!/^[0-9a-f]{64}$/.test(sig)) return false;
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) bytes[i] = parseInt(sig.slice(2 * i, 2 * i + 2), 16);
  return crypto.subtle.verify("HMAC", await hmacKey(secret, "verify"), bytes, enc.encode(`${ts}\n${body}`)); // constant time
}

function badCall(call: unknown, i: number): string | null {
  const c = call as Partial<TeeCall> | null;
  if (c === null || typeof c !== "object") return `calls[${i}] is not an object`;
  if (c.v !== 1) return `calls[${i}].v`;
  if (typeof c.method !== "string") return `calls[${i}].method`;
  if (!Array.isArray(c.args)) return `calls[${i}].args`;
  if (typeof c.atMs !== "number" || !Number.isFinite(c.atMs) || c.atMs <= 0 || !Number.isInteger(c.atMs)) return `calls[${i}].atMs`;
  if (!Array.isArray(c.seqs) || c.seqs.some((s, k) => !Number.isInteger(s) || s <= 0 || (k > 0 && s !== c.seqs![k - 1]! + 1))) return `calls[${i}].seqs (positive, contiguous, ascending)`;
  const o = c.outcome as Record<string, unknown> | null | undefined;
  if (o === null || typeof o !== "object" || !("ok" in o || "error" in o)) return `calls[${i}].outcome`;
  if ("error" in o) {
    const e = o.error as { name?: unknown; message?: unknown } | null;
    if (e === null || typeof e !== "object" || typeof e.name !== "string" || typeof e.message !== "string") return `calls[${i}].outcome.error`;
  }
  return null;
}

/** Split a batch into atomic units: at most MAX_UNIT calls and about UNIT_BYTES of JSON each. */
export function splitUnits(calls: readonly TeeCall[]): TeeCall[][] {
  const units: TeeCall[][] = [];
  let cur: TeeCall[] = [];
  let bytes = 0;
  for (const call of calls) {
    const n = JSON.stringify(call).length;
    if (cur.length > 0 && (cur.length >= MAX_UNIT || bytes + n > UNIT_BYTES)) {
      units.push(cur);
      cur = [];
      bytes = 0;
    }
    cur.push(call);
    bytes += n;
  }
  if (cur.length > 0) units.push(cur);
  return units;
}

export async function handleIngest(req: IngestRequest, deps: IngestDeps): Promise<IngestResult> {
  const log = deps.log ?? ((line) => console.log(JSON.stringify(line)));
  const reject = (status: number, error: string, extra: Record<string, unknown> = {}): IngestResult => ({ status, body: { error, ...extra } });

  if (deps.secret === "") return reject(404, "off"); // dormant until a secret is configured
  if (req.body.length > (deps.maxBodyBytes ?? 5_000_000)) return reject(413, "too_large");
  const ts = req.header(TEE_TS_HEADER);
  const sig = req.header(TEE_SIG_HEADER);
  if (ts === null || sig === null || !/^\d{1,12}$/.test(ts)) return reject(401, "unauthorized");
  if (Math.abs(deps.nowMs() / 1000 - Number(ts)) > SKEW_SEC) return reject(401, "stale_timestamp");
  if (!(await signatureValid(deps.secret, ts, req.body, sig.toLowerCase()))) return reject(401, "unauthorized");

  let batch: TeeBatch;
  try {
    batch = JSON.parse(req.body) as TeeBatch;
  } catch {
    return reject(400, "bad_json");
  }
  if (batch === null || typeof batch !== "object" || batch.v !== 1 || typeof batch.batchId !== "string" || !BATCH_ID.test(batch.batchId) || !Array.isArray(batch.calls)) {
    return reject(400, "bad_batch");
  }
  if (batch.direction !== deps.queue.direction) return reject(409, "wrong_direction", { expected: deps.queue.direction });
  for (let i = 0; i < batch.calls.length; i++) {
    const bad = badCall(batch.calls[i], i);
    if (bad !== null) return reject(400, "bad_call", { detail: bad });
    if (!isMirrorWrite(batch.calls[i]!.method)) {
      log({ code: "MIRROR_UNKNOWN_METHOD", method: batch.calls[i]!.method, batchId: batch.batchId });
      return reject(422, "unknown_method", { method: batch.calls[i]!.method });
    }
  }

  const units = splitUnits(batch.calls);
  let duplicate = true;
  try {
    for (let i = 0; i < units.length; i++) {
      const r = await deps.queue.enqueue(units.length === 1 ? batch.batchId : `${batch.batchId}/${i}`, units[i]!);
      if (!r.duplicate) duplicate = false;
    }
  } catch (e) {
    if (e instanceof QueueConflict) {
      log({ code: "MIRROR_SEQ_CONFLICT", batchId: batch.batchId, key: e.sk });
      return reject(409, "seq_conflict", { key: e.sk });
    }
    throw e;
  }
  if (!duplicate && units.length > 0 && deps.wake !== undefined) {
    try {
      await deps.wake();
    } catch (e) {
      log({ code: "MIRROR_WAKE_FAILED", message: e instanceof Error ? e.message : String(e) });
    }
  }
  return { status: 202, body: { ok: true, batchId: batch.batchId, calls: batch.calls.length, duplicate } };
}

/** The Worker-route form: a `Request` in, a `Response` out. */
export async function ingestResponse(request: Request, deps: IngestDeps): Promise<Response> {
  if (request.method !== "POST") return new Response(JSON.stringify({ error: "method_not_allowed" }), { status: 405, headers: { "content-type": "application/json" } });
  const r = await handleIngest({ header: (n) => request.headers.get(n), body: await request.text() }, deps);
  return new Response(JSON.stringify(r.body), { status: r.status, headers: { "content-type": "application/json" } });
}
