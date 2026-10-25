// Sends recorded calls to the mirror's ingest (design/aws-port.md §5.2 item 1): one signed POST per burst of
// work, handed to the platform's background hook so it never delays a response. Three tries; a failed tee is one
// log line, TEE_FAILED, and nothing else.
import { TEE_SIG_HEADER, TEE_TS_HEADER, type TeeBatch, type TeeCall } from "./record";

export interface TeeSenderOptions {
  url: string;
  secret: string;
  direction: TeeBatch["direction"];
  /** `platform.background`: keeps the isolate alive for the task without delaying the response. */
  background(task: Promise<unknown>): void;
  fetch?: (input: string, init: RequestInit) => Promise<Response>;
  /** Calls arriving within this window go out as one batch. */
  settleMs?: number;
  /** Waits before tries 2 and 3. */
  backoffMs?: readonly number[];
}

const encoder = new TextEncoder();

async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(message)));
  return [...sig].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

let batchCounter = 0;
/** Unique per batch; deliberately not crypto.randomUUID, so the tee never consumes the request's random stream. */
function newBatchId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}-${(batchCounter++).toString(36)}`;
}

export interface TeeSender {
  add(call: TeeCall): void;
}

export function createTeeSender(opts: TeeSenderOptions): TeeSender {
  const doFetch = opts.fetch ?? ((input, init) => fetch(input, init));
  const settleMs = opts.settleMs ?? 25;
  const backoff = opts.backoffMs ?? [250, 1000];
  let buffer: TeeCall[] = [];
  let scheduled = false;

  async function post(batch: TeeBatch): Promise<void> {
    const body = JSON.stringify(batch);
    let last = "";
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt > 0) await sleep(backoff[Math.min(attempt - 1, backoff.length - 1)]!);
      try {
        const ts = String(Math.floor(Date.now() / 1000));
        const sig = await hmacHex(opts.secret, `${ts}\n${body}`);
        const res = await doFetch(opts.url, {
          method: "POST",
          headers: { "content-type": "application/json", [TEE_TS_HEADER]: ts, [TEE_SIG_HEADER]: sig },
          body,
        });
        if (res.ok) return;
        last = `status ${res.status}`;
        await res.body?.cancel();
      } catch (e) {
        last = e instanceof Error ? e.message : String(e);
      }
    }
    console.error(`TEE_FAILED batch ${batch.batchId} (${batch.calls.length} calls): ${last}`);
  }

  async function flush(): Promise<void> {
    try {
      await sleep(settleMs);
      while (buffer.length > 0) {
        const calls = buffer;
        buffer = [];
        await post({ v: 1, direction: opts.direction, batchId: newBatchId(), calls });
      }
    } catch (e) {
      console.error(`TEE_FAILED flush: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      scheduled = false;
      // Calls that arrived after the last loop check but before `scheduled` cleared.
      if (buffer.length > 0) schedule();
    }
  }

  function schedule(): void {
    if (scheduled) return;
    scheduled = true;
    opts.background(flush());
  }

  return {
    add(call) {
      buffer.push(call);
      schedule();
    },
  };
}
