// Shared helpers for the client-lane suites (10 C1): seeding a `clients`
// row directly (no admin route round trip needed for most tests), and
// signing a request the way `scripts/gen-vectors.mjs` does, but live over
// Web Crypto -- workerd has Ed25519 (confirmed 2026-09-09 against this
// exact wrangler/miniflare pin), so this exercises the same crypto path
// `verifyClientRequest` verifies against, not a re-derivation of it.
import { base64UrlToBytes, bytesToBase64Url } from "../../src/auth/client";
import type { Clock } from "../../src/core/time";
import { SELF, testStore } from "../harness";
import vectors from "../vectors/client-signing.json" with { type: "json" };

export { vectors };

export interface SeedClientOpts {
  id: string;
  name?: string;
  pubkeyB64url: string;
  ownerUserId: string;
  // A comma-separated set (LEDGER.md L4): exactly one scope cap
  // (`act-as-user` | `act-as-owner-only`) plus any extra caps (e.g.
  // `"act-as-owner-only,feed:wait"`) -- widened from a two-value union
  // now that `caps` carries more than the scope alone.
  caps: string;
  status?: "active" | "revoked";
  discordAppId?: string | null;
}

// Upsert, not a plain INSERT: several suites seed the SAME well-known
// vector client id (`vectors.vectors[0].client_id`) in their own
// `beforeAll` -- idempotent re-seeding here means each describe block can
// stay self-contained instead of relying on file-wide ordering.
// Callable as seedClient(now, opts) or, for older call sites, seedClient(db, now, opts); the db is ignored.
export async function seedClient(now: Clock, opts: SeedClientOpts): Promise<void>;
export async function seedClient(_db: unknown, now: Clock, opts: SeedClientOpts): Promise<void>;
export async function seedClient(...args: [Clock, SeedClientOpts] | [unknown, Clock, SeedClientOpts]): Promise<void> {
  const [now, opts] = args.length === 2 ? args : [args[1], args[2]];
  const at = now();
  const row = {
    id: opts.id,
    name: opts.name ?? `test-client-${opts.id}`,
    pubkey: opts.pubkeyB64url,
    owner_user_id: opts.ownerUserId,
    caps: opts.caps,
    discord_app_id: opts.discordAppId ?? null,
    status: opts.status ?? "active",
    revoked_at: opts.status === "revoked" ? at : null,
  };
  const { id, ...fields } = row;
  if ((await testStore.patch("clients", { id }, fields)) === 0) await testStore.insert("clients", { ...row, created_at: at });
}

export async function generateKeyPair(): Promise<{ privateKey: CryptoKey; pubkeyB64url: string }> {
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const rawKey = (await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer;
  return { privateKey: pair.privateKey, pubkeyB64url: bytesToBase64Url(new Uint8Array(rawKey)) };
}

export async function importPrivateKeyPkcs8(pkcs8B64url: string): Promise<CryptoKey> {
  const bytes = base64UrlToBytes(pkcs8B64url);
  if (bytes === null) throw new Error("bad pkcs8 in test fixture");
  return crypto.subtle.importKey("pkcs8", bytes.slice(), { name: "Ed25519" }, false, ["sign"]);
}

async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", bytes.slice()));
}

export interface SignOpts {
  privateKey: CryptoKey;
  clientId: string;
  actor: string;
  method: string;
  pathWithQuery: string;
  body?: Uint8Array;
  timestamp?: number; // epoch seconds; default now
  nonce?: Uint8Array; // 16 bytes; default random
}

// Builds the five `X-Akl-*` headers for a live SELF.fetch call -- the same
// signing string `src/auth/client.ts:signingString` builds, computed
// independently here (a test that imported the module's own function to
// check its own function would prove nothing).
export async function signHeaders(opts: SignOpts): Promise<Record<string, string>> {
  const timestamp = String(opts.timestamp ?? Math.floor(Date.now() / 1000));
  const nonceBytes = opts.nonce ?? crypto.getRandomValues(new Uint8Array(16));
  const nonce = bytesToBase64Url(nonceBytes);
  const bodyBytes = opts.body ?? new Uint8Array(0);
  const hash = bytesToBase64Url(await sha256(bodyBytes));
  const signingString = `akl-v1\n${opts.method.toUpperCase()}\n${opts.pathWithQuery}\n${timestamp}\n${nonce}\n${opts.actor}\n${hash}`;
  const sig = await crypto.subtle.sign("Ed25519", opts.privateKey, new TextEncoder().encode(signingString));
  return {
    "X-Akl-Client": opts.clientId,
    "X-Akl-Timestamp": timestamp,
    "X-Akl-Nonce": nonce,
    "X-Akl-Actor": opts.actor,
    "X-Akl-Signature": bytesToBase64Url(new Uint8Array(sig)),
  };
}
