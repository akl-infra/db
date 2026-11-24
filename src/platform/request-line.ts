// [LDB-MD29] One INFO line per HTTP invocation of the Lambda front (`akldb-req v=1 ...`), so an error burst can be read as who, what
// and from where without API Gateway access logs. Pure: `requestLine` formats, the helpers below reduce a raw header or address to
// a token that is safe to log. Every value is a single token (no space, no `?`, no quote), and the line never carries a raw IP, a
// query string, a path id (only `ph`, 8 hex of sha256(pathname)), the actor, or any header value except the ones listed here.
import { createHash, createHmac } from "node:crypto";

export interface RequestLineFields {
  rid: string;
  gw?: string | undefined;
  ray?: string | undefined;
  m: string;
  r?: string | undefined;
  ph: string;
  st?: number | undefined;
  ms: number;
  cold: boolean;
  boot?: number | undefined;
  edge: "cf" | "direct";
  gate: "ok" | "missing" | "bad";
  ua?: string | undefined;
  cli?: string | undefined;
  cc?: string | undefined;
  ipk?: string | undefined;
  b: number;
  err?: string | undefined;
  hold: boolean;
}

/** One value as a single safe token: anything outside the allowed set becomes `_`, empty becomes `-`. */
function tok(v: string | number | undefined, max: number): string {
  if (v === undefined) return "-";
  const s = String(v).replace(/[^A-Za-z0-9._:=/*-]/g, "_").slice(0, max);
  return s === "" ? "-" : s;
}

const int = (n: number | undefined): string => (n !== undefined && Number.isFinite(n) && n >= 0 ? String(Math.round(n)) : "-");

export function requestLine(f: RequestLineFields): string {
  return [
    "akldb-req",
    "v=1",
    `rid=${tok(f.rid, 64)}`,
    `gw=${tok(f.gw, 64)}`,
    `ray=${tok(f.ray, 40)}`,
    `m=${tok(f.m, 12)}`,
    `r=${tok(f.r === "/*" || f.r === "*" ? undefined : f.r, 80)}`,
    `ph=${tok(f.ph, 8)}`,
    `st=${int(f.st)}`,
    `ms=${int(f.ms)}`,
    `cold=${f.cold ? 1 : 0}`,
    `boot=${int(f.boot)}`,
    `edge=${f.edge}`,
    `gate=${f.gate}`,
    `ua=${tok(f.ua, 40)}`,
    `cli=${tok(f.cli, 40)}`,
    `cc=${tok(f.cc, 4)}`,
    `ipk=${tok(f.ipk, 8)}`,
    `b=${int(f.b)}`,
    `err=${tok(f.err, 40)}`,
    `hold=${f.hold ? 1 : 0}`,
  ].join(" ");
}

/** sha256(pathname)[0:8]: lets one path be counted without logging it (a path may carry a layout id). */
export const pathHash = (pathname: string): string => createHash("sha256").update(pathname).digest("hex").slice(0, 8);

/** The first product token of a User-Agent (`[\w./-]{1,40}`), `browser` for Mozilla/*, else undefined. */
export function uaToken(ua: string | undefined): string | undefined {
  const first = ua?.trim().split(/\s+/, 1)[0] ?? "";
  if (first.startsWith("Mozilla/")) return "browser";
  return /^[\w./-]{1,40}/.exec(first)?.[0];
}

/** The two-character `cf-ipcountry` code (`US`, `XX`, `T1`), else undefined. */
export const countryToken = (cc: string | undefined): string | undefined => (cc !== undefined && /^[A-Za-z0-9]{2}$/.test(cc) ? cc : undefined);

/** A `cf-ray` value (`8a1b2c3d4e5f6a7b-IAD`), else undefined. */
export const rayToken = (ray: string | undefined): string | undefined => (ray !== undefined && /^[A-Za-z0-9-]{1,40}$/.test(ray) ? ray : undefined);

/** `HMAC-SHA256(origin secret, "ipk:" + UTC day + ":" + ip)[0:8]`: stable within one UTC day, unlinkable across days, and not reversible without the secret. */
export function ipKey(secret: string, day: string, ip: string): string {
  return createHmac("sha256", secret).update(`ipk:${day}:${ip}`).digest("hex").slice(0, 8);
}

/** The `error` code of a small JSON error body (never a base64 body, never one over 2 KB), else undefined. */
export function errorCodeOf(body: string | undefined, isBase64Encoded: boolean | undefined): string | undefined {
  if (body === undefined || isBase64Encoded === true || body.length > 2048 || !body.startsWith("{")) return undefined;
  try {
    const e = (JSON.parse(body) as { error?: unknown }).error;
    return typeof e === "string" ? e : undefined;
  } catch {
    return undefined;
  }
}
