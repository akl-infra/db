// The client lane (02 §3, 10 C1): Ed25519-signed requests from an
// admin-registered bot, asserting the Discord user id it acts for.
// `verifyClientRequest` is the whole seven-step chain; `src/auth/discord.ts`'s
// `resolveActor` calls it when `X-Akl-Client` is present and no bearer is.
//
// Body bytes: the caller reads them ONCE via Hono's cached `c.req.arrayBuffer()`
// (HonoRequest's body cache, so a route's later `c.req.json()` sees the same
// bytes -- no request cloning) and passes them in here; this module never
// reads the body itself, so it stays testable against a plain `Request` +
// a `Uint8Array` with no Hono in the picture.
import type { Bindings } from "../env";
import type { Actor } from "./actor";
import {
  actorNotAllowed,
  badSignature,
  clientReadOnly,
  clientRevoked,
  clientSuspended,
  replay,
  staleTimestamp,
  unknownClient,
} from "../core/errors";
import type { Clock } from "../core/time";
import { roleOf } from "./roles";
import { toStore, type StoreArg } from "../store/arg";

const TIMESTAMP_RE = /^\d{1,12}$/;
const ACTOR_RE = /^\d{17,20}$/;
const SKEW_SECONDS = 300;
// `authors.last_seen_at` is refreshed at most once per this window (step 7).
const LAST_SEEN_GRANULARITY_MS = 60 * 60 * 1000;

// `clients.caps` (10 C1) is a comma-separated set: exactly one SCOPE cap
// (mutually exclusive -- whom the client may act as) plus zero or more
// EXTRA caps (additive capabilities, LEDGER.md L4's `feed:wait` the first
// one). Stored as one TEXT column, e.g. `"act-as-owner-only,feed:wait"` --
// no migration needed, the column already held a single scope-cap string.
export type ScopeCap = "act-as-user" | "act-as-owner-only";
export type ExtraCap = "feed:wait" | "read-only";
export const SCOPE_CAPS: readonly ScopeCap[] = ["act-as-user", "act-as-owner-only"];
export const EXTRA_CAPS: readonly ExtraCap[] = ["feed:wait", "read-only"];

export function parseCaps(raw: string): string[] {
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

// The one scope cap a `caps` string carries, or undefined if none of its
// tokens is a registered scope cap (a malformed/legacy row -- callers
// treat this the same as "no act-as-owner-only", i.e. permissive, since a
// row that passed `registerClient`'s own validation always has exactly
// one).
export function scopeCapOf(caps: string): ScopeCap | undefined {
  const tokens = parseCaps(caps);
  return (SCOPE_CAPS as string[]).find((c) => tokens.includes(c)) as ScopeCap | undefined;
}

export function hasCap(caps: string, cap: ExtraCap): boolean {
  return parseCaps(caps).includes(cap);
}

// Injectable so a unit test can force a verifier failure without a real
// (mis-)signed vector, and so the wasm-free `crypto.subtle.verify('Ed25519', ...)`
// path is the only thing that changes between test and production.
export type VerifyImpl = (pubkey: Uint8Array, signature: Uint8Array, message: Uint8Array) => Promise<boolean>;

export interface ClientDeps {
  verify?: VerifyImpl;
}

// base64url, no padding -- what every header on this lane carries (02 §3.2).
// `null` for anything that isn't valid base64url, so every malformed-header
// case collapses to the same `badSignature()` at the call site (step 1: "one
// error for every malformed case -- no oracle on which header was wrong").
export function base64UrlToBytes(s: string): Uint8Array | null {
  if (s.length === 0 || !/^[A-Za-z0-9_-]+$/.test(s)) return null;
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const std = s.replace(/-/g, "+").replace(/_/g, "/") + pad;
  try {
    const bin = atob(std);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

export function bytesToBase64Url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  // Copy into a fresh, exactly-sized buffer first: `bytes` may be a view
  // over a larger ArrayBuffer (`new Uint8Array(await req.arrayBuffer())`
  // is fine, but a defensive copy here means this function never depends
  // on the caller's buffer not being reused/detached afterward).
  const digest = await crypto.subtle.digest("SHA-256", bytes.slice());
  return new Uint8Array(digest);
}

const defaultVerify: VerifyImpl = async (pubkey, signature, message) => {
  const key = await crypto.subtle.importKey("raw", pubkey.slice(), { name: "Ed25519" }, false, ["verify"]);
  return crypto.subtle.verify("Ed25519", key, signature, message);
};

// Builds the exact string 02 §3.2 defines. Exported so the bot's TS client
// (10 V3) and `scripts/gen-vectors.mjs` build byte-identical strings without
// re-deriving the format -- the interop the vectors exist to prove.
export function signingString(
  method: string,
  pathWithQuery: string,
  timestamp: string,
  nonce: string,
  actor: string,
  bodyHashB64url: string,
): string {
  return `akl-v1\n${method.toUpperCase()}\n${pathWithQuery}\n${timestamp}\n${nonce}\n${actor}\n${bodyHashB64url}`;
}

export async function bodyHash(bodyBytes: Uint8Array): Promise<string> {
  return bytesToBase64Url(await sha256(bodyBytes));
}

// The seven steps of 10 C1 §4, in order. `request` supplies method/url/
// headers only -- its body is never read here (`bodyBytes` already is it).
export async function verifyClientRequest(
  dbArg: StoreArg,
  now: Clock,
  request: Request,
  bodyBytes: Uint8Array,
  deps: ClientDeps = {},
): Promise<Actor> {
  const store = toStore(dbArg);
  // Step 1: headers, all-or-nothing shape-checked.
  const clientId = request.headers.get("X-Akl-Client");
  const timestampRaw = request.headers.get("X-Akl-Timestamp");
  const nonceRaw = request.headers.get("X-Akl-Nonce");
  const actorRaw = request.headers.get("X-Akl-Actor");
  const signatureRaw = request.headers.get("X-Akl-Signature");
  if (clientId === null || timestampRaw === null || nonceRaw === null || actorRaw === null || signatureRaw === null) {
    throw badSignature();
  }
  if (!TIMESTAMP_RE.test(timestampRaw)) throw badSignature();
  const nonceBytes = base64UrlToBytes(nonceRaw);
  if (nonceBytes === null || nonceBytes.length !== 16) throw badSignature();
  if (!ACTOR_RE.test(actorRaw)) throw badSignature();
  const sigBytes = base64UrlToBytes(signatureRaw);
  if (sigBytes === null || sigBytes.length !== 64) throw badSignature();

  // Step 2: the client itself.
  const client = await store.auth.client(clientId);
  if (client === null) throw unknownClient();
  if (client.status === "revoked") throw clientRevoked();
  // saltorbit 2026-09-13 ("rogue trusted client" hardening): checked live, on
  // every request, exactly like `revoked` above -- never cached (same
  // posture LDB-A9 already established for `status`). Distinct error code
  // (`403 client_suspended`, not the 401 `client_revoked`) so a client
  // library can tell "an admin can undo this" from "this key is dead for
  // good".
  if (client.status === "suspended") throw clientSuspended();

  // Step 3: the clock.
  const nowSeconds = Math.floor(new Date(now()).getTime() / 1000);
  const timestamp = Number(timestampRaw);
  const skew = nowSeconds - timestamp;
  if (Math.abs(skew) > SKEW_SECONDS) throw staleTimestamp(skew);

  // Step 4: the signature, over the request exactly as sent (no query
  // canonicalisation -- `url.search` as the client put it on the wire).
  const url = new URL(request.url);
  const hash = await bodyHash(bodyBytes);
  const message = signingString(request.method, `${url.pathname}${url.search}`, timestampRaw, nonceRaw, actorRaw, hash);

  const pubkeyBytes = base64UrlToBytes(client.pubkey);
  // A corrupt stored key can't happen via the admin route's own 32-byte
  // check (below), but a signature can never verify against a malformed
  // key either way -- same refusal, no special case.
  const verify = deps.verify ?? defaultVerify;
  const ok = pubkeyBytes !== null && (await verify(pubkeyBytes, sigBytes, new TextEncoder().encode(message)));
  if (!ok) throw badSignature();

  // Step 4b (decision 31): a `read-only` client may send only GET and HEAD.
  // After the signature (a forged request can't probe a client's caps), before
  // the nonce (a refused request writes nothing -- no nonce, no author row,
  // and the idempotency/rate-limit middlewares behind this never run).
  if (hasCap(client.caps, "read-only") && request.method !== "GET" && request.method !== "HEAD") {
    throw clientReadOnly(request.method);
  }

  // Step 5: the nonce -- one INSERT, its PK IS the replay check, run only
  // AFTER the signature verifies (a forged request must never burn a real
  // nonce).
  if (!(await store.auth.insertNonce(client.id, nonceRaw, now()))) throw replay();

  // Step 6: caps.
  if (scopeCapOf(client.caps) === "act-as-owner-only" && actorRaw !== client.owner_user_id) {
    throw actorNotAllowed(actorRaw, client.owner_user_id);
  }

  // Step 7: the actor. `authors` upserted like resolveBearer's, except the
  // client lane carries no display name (D14): `name` is set to the id
  // ONLY on first sight and never overwritten afterward -- a real name
  // still wins whenever it arrived through the user lane, before or after.
  // LDB-I17: that first-sight placeholder is marked `name_source =
  // 'client'`; the conflict branch never touches `name`/`name_source`, and
  // the cmini import may replace the placeholder with an upstream name
  // (`import/authors.ts`).
  //
  // `last_seen_at` is bookkeeping with HOUR granularity: a request inside
  // the hour after the stored value writes nothing (a polling client would
  // otherwise rewrite this row on every request). The refresh is a
  // conditional upsert, so two concurrent requests can't move it backwards.
  const at = now();
  const staleBefore = new Date(new Date(at).getTime() - LAST_SEEN_GRANULARITY_MS).toISOString();
  // `touchClientAuthor` is the read / conditional upsert / fallback read
  // sequence (store/d1/auth.ts); it answers the stored name.
  // A `read-only` client only reads the name (decision 31): no placeholder
  // author, no `authors_head` move; an unknown actor falls back to its id,
  // exactly the placeholder an upsert would have stored.
  const name = hasCap(client.caps, "read-only")
    ? await store.auth.authorName(actorRaw)
    : await store.auth.touchClientAuthor(actorRaw, at, staleBefore);
  const roles = await roleOf(store, actorRaw);

  return {
    user_id: actorRaw,
    name: name ?? actorRaw,
    via: `client:${client.id}`,
    ...roles,
    // 20-spark.md S3s (LDB-P15): same string `via` already carries on this
    // lane -- the signed request already names the client unambiguously.
    source_client: `client:${client.id}`,
    client_caps: client.caps,
  };
}

// Nightly (`0 3 * * *`, wired into src/index.ts's `scheduled()`, alongside
// `pruneAuthCache`/`pruneRateLimits`): a nonce is only ever accepted within
// ±300 s of its own timestamp (step 3 above), so 900 s is a safe margin
// over that window -- nothing younger than it can still matter to a live
// request.
export async function pruneNonces(dbArg: StoreArg, now: Clock): Promise<void> {
  const store = toStore(dbArg);
  const cutoff = new Date(new Date(now()).getTime() - 900 * 1000).toISOString();
  await store.auth.pruneNonces(cutoff);
}
