// [LDB-API4] Request ids and Server-Timing (API 1.39). Any client may send `X-Request-ID`; akldb uses it for that request,
// echoes it, and quotes it in its own logs, so one failing request can be found from either side. A value that does not
// match REQUEST_ID_RE is ignored (never refused) and replaced, so nothing a client sends can reach a header or a log line
// unvalidated: no space, control character, quote or newline can pass the charset.
import { randomUUID } from "node:crypto";

export const REQUEST_ID_HEADER = "X-Request-ID";
export const REQUEST_ID_RE = /^[A-Za-z0-9._:-]{8,64}$/;

/** The id to use for a request: `supplied` when it is valid, else a fresh UUID. */
export function effectiveRequestId(supplied: string | null | undefined, mint: () => string = randomUUID): string {
  return typeof supplied === "string" && REQUEST_ID_RE.test(supplied) ? supplied : mint();
}

const ms = (n: number): string => (Number.isFinite(n) && n >= 0 ? (Math.round(n * 10) / 10).toString() : "0");

/** `akldb;dur=12.3`, plus `, akldb-boot;dur=850` when this request booted the replica. */
export function serverTiming(appMs: number, bootMs?: number): string {
  return `akldb;dur=${ms(appMs)}${bootMs !== undefined ? `, ${bootTiming(bootMs)}` : ""}`;
}

/** `akldb-boot;dur=850`: the wait for the replica's boot, alone (the Lambda front appends it to the app's own entry). */
export function bootTiming(bootMs: number): string {
  return `akldb-boot;dur=${ms(bootMs)}`;
}

/** Appends `value` to an existing Server-Timing header value (a response may already carry one from a layer below). */
export function appendServerTiming(existing: string | null, value: string): string {
  return existing !== null && existing !== "" ? `${existing}, ${value}` : value;
}
