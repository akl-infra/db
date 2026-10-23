import type { Bindings } from "../env";

// A conservative shared gate: all moderation message edits share the same
// destination/token today. Keeping this in D1 also covers isolate replacement.
// Link/WPM creation also uses this gate; request-only best-effort comment
// creation does not (deferral there needs a durable announcement outbox).
export class DeliveryDeferred extends Error {}
const BODY_LIMIT = 256 * 1024;
const TIMEOUT_MS = 5000;

export async function discordJson(response: Response): Promise<unknown> {
  if (!response.body) throw new Error("Missing Discord body");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => { void reader.cancel().catch(() => {}); reject(new Error("Discord body timeout")); }, TIMEOUT_MS); });
  try {
    while (true) {
      const { done, value } = await Promise.race([reader.read(), deadline]);
      if (done) break;
      size += value.byteLength;
      if (size > BODY_LIMIT) throw new Error("Discord body too large");
      chunks.push(value);
    }
  } finally {
    clearTimeout(timer);
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return JSON.parse(new TextDecoder().decode(bytes));
}

function seconds(value: unknown): number {
  const n = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : NaN;
  return Number.isFinite(n) && n >= 0 ? Math.ceil(n * 1000) : 0;
}

export function retryDelay(headers: Headers, body: unknown, now: number): number {
  const retry = headers.get("Retry-After");
  const date = retry === null || Number.isFinite(Number(retry)) ? 0 : Math.max(0, Date.parse(retry) - now) || 0;
  const json = typeof body === "object" && body !== null && "retry_after" in body ? seconds(body.retry_after) : 0;
  return Math.max(seconds(retry), date, json, seconds(headers.get("X-RateLimit-Reset-After")), 1000);
}

// Caller consumes/cancels the body while the timeout remains active. Holding
// the shared lease through body handling ensures a 429 is persisted before
// another isolate can send its next request. No network retries here.
export async function deliver<T>(db: Bindings["DB"], fetchImpl: typeof fetch, url: string, init: RequestInit, consume: (response: Response) => Promise<T>): Promise<T> {
  const token = crypto.randomUUID();
  const now = Date.now();
  const claim = await db.prepare(`UPDATE modqueue_delivery_gate SET lease_token = ?, lease_until = ?
    WHERE id = 1 AND retry_at <= ? AND (lease_token IS NULL OR lease_until <= ?)`)
    .bind(token, now + 30_000, now, now).run();
  if (claim.meta.changes !== 1) throw new DeliveryDeferred();
  try {
    const response = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (response.status === 429) {
      let body: unknown;
      try { body = await discordJson(response); } catch { /* header/fallback still applies */ }
      await db.prepare("UPDATE modqueue_delivery_gate SET retry_at = MAX(retry_at, ?) WHERE id = 1 AND lease_token = ?")
        .bind(Date.now() + retryDelay(response.headers, body, Date.now()), token).run();
      throw new DeliveryDeferred();
    }
    if (response.headers.get("X-RateLimit-Remaining") === "0") {
      await db.prepare("UPDATE modqueue_delivery_gate SET retry_at = MAX(retry_at, ?) WHERE id = 1 AND lease_token = ?")
        .bind(Date.now() + retryDelay(response.headers, null, Date.now()), token).run();
    }
    try { return await consume(response); }
    finally { void response.body?.cancel().catch(() => {}); }
  } finally {
    await db.prepare("UPDATE modqueue_delivery_gate SET lease_token = NULL, lease_until = 0 WHERE id = 1 AND lease_token = ?").bind(token).run();
  }
}
