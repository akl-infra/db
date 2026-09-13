// Sealed session cookie (design/akldb-site/01-plan.md S2). No storage: the
// whole session -- the Discord access token, its expiry, and the user's id
// and display name -- lives AES-GCM-sealed inside one cookie,
// `__Host-akldb_session`. There is no refresh token and no D1 (unlike
// akl.gg's functions/_lib/tokens.mjs, which keeps one specifically to do a
// refresh-and-retry on a stale token -- this site deliberately can't, so a
// `401 token_invalid` from the DB just clears the cookie, see proxy.ts).
//
// AES-GCM (not the HMAC-signed-but-plaintext scheme functions/_lib/
// session.mjs uses for akl.gg's cookie) because this payload's
// `access_token` field genuinely is a secret worth encrypting, not just a
// tamper-evident claim -- akl.gg's cookie only ever carries a Discord id and
// a display name, both already public.
//
// Key derivation: SHA-256(SESSION_SECRET) as raw AES-256-GCM key material.
// A secret of any length collapses to exactly 32 bytes this way; rotating
// SESSION_SECRET invalidates every outstanding session cookie at once
// (verifiable: SITE-1's tamper/re-keyed case).

export interface SessionPayload {
  access_token: string;
  expires_at: number; // epoch ms
  user_id: string;
  name: string;
}

export const SESSION_COOKIE = "__Host-akldb_session";
export const OAUTH_STATE_COOKIE = "__Host-akldb_oauth_state";

// No refresh token is kept (S2): a session never outlives Discord's own
// token, and even a very long-lived Discord token is capped here so a
// stolen cookie can't act forever.
export const MAX_SESSION_SECONDS = 7 * 24 * 60 * 60; // 7 days

function b64urlEncode(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(str: string): Uint8Array {
  const padded = str.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (str.length % 4)) % 4);
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function deriveKey(secret: string): Promise<CryptoKey> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  return crypto.subtle.importKey("raw", digest, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

/** Seal a session payload into the cookie's value (no `<name>=` prefix). */
export async function sealSession(payload: SessionPayload, secret: string): Promise<string> {
  const key = await deriveKey(secret);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = new TextEncoder().encode(JSON.stringify(payload));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plaintext);
  return `${b64urlEncode(iv)}.${b64urlEncode(new Uint8Array(ciphertext))}`;
}

/**
 * Open a sealed session. Returns null for anything malformed, tampered,
 * sealed under a different key, or expired -- callers always treat null as
 * "not signed in", never throw (SITE-1).
 */
export async function openSession(token: string | null | undefined, secret: string): Promise<SessionPayload | null> {
  if (!secret || !token) return null;
  const dot = token.indexOf(".");
  if (dot === -1) return null;
  const ivPart = token.slice(0, dot);
  const ctPart = token.slice(dot + 1);
  if (!ivPart || !ctPart) return null;
  let iv: Uint8Array;
  let ciphertext: Uint8Array;
  try {
    iv = b64urlDecode(ivPart);
    ciphertext = b64urlDecode(ctPart);
  } catch {
    return null;
  }
  if (iv.length !== 12) return null;
  try {
    const key = await deriveKey(secret);
    // Mixing DOM lib types with @cloudflare/workers-types widens Uint8Array
    // to Uint8Array<ArrayBufferLike> (it could in principle back a
    // SharedArrayBuffer), which BufferSource's DOM definition doesn't
    // accept -- both are real, freshly-allocated ArrayBuffers here
    // (b64urlDecode never slices another buffer), so this cast is safe.
    const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv: iv as BufferSource }, key, ciphertext as BufferSource);
    const payload = JSON.parse(new TextDecoder().decode(plaintext)) as SessionPayload;
    if (
      typeof payload !== "object" ||
      payload === null ||
      typeof payload.access_token !== "string" ||
      typeof payload.expires_at !== "number" ||
      typeof payload.user_id !== "string" ||
      typeof payload.name !== "string"
    ) {
      return null;
    }
    if (payload.expires_at <= Date.now()) return null; // expired
    return payload;
  } catch {
    return null; // wrong key, tampered ciphertext, bad GCM tag, malformed JSON
  }
}

export function sessionCookieHeader(value: string, maxAgeSeconds: number): string {
  // __Host- requires: Secure, Path=/, no Domain (RFC 6265bis) -- enforced by
  // construction here, never by caller discipline.
  return `${SESSION_COOKIE}=${value}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}`;
}

export function clearSessionCookieHeader(): string {
  return `${SESSION_COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0`;
}

export function oauthStateCookieHeader(state: string): string {
  return `${OAUTH_STATE_COOKIE}=${state}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=600`;
}

export function clearOauthStateCookieHeader(): string {
  return `${OAUTH_STATE_COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0`;
}

export function parseCookies(cookieHeader: string | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!cookieHeader) return out;
  for (const part of cookieHeader.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (!k) continue;
    try {
      out[k] = decodeURIComponent(v);
    } catch {
      out[k] = v;
    }
  }
  return out;
}
