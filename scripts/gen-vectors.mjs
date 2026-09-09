#!/usr/bin/env node
// Generates + freezes db/tests/vectors/client-signing.json (10 C1 §4, 02
// §3.2): (key, request, expected signature) triples that
// `src/auth/client.ts`'s `verifyClientRequest` accepts and the bot's TS
// client (10 V3) must reproduce byte-for-byte -- the interop contract
// between the two, so this script is the ONLY place either side's test
// suite may derive a signature from scratch.
//
// This script does not import `src/auth/client.ts`: that module's imports
// are extension-less, resolved by a bundler in the Worker/test build
// (scripts/goldens.mjs's header explains the same constraint for
// `src/formats/*`) -- plain Node ESM resolution can't follow them. The
// signing-string format and base64url/sha256 rules are duplicated here
// deliberately small and literal so the two copies can't drift silently;
// `tests/client/sign.test.ts`-equivalent coverage (`tests/auth/client.test.ts`)
// proves the WORKER side reproduces every vector this script writes, which
// is the interop check that matters.
//
// Deterministic: every key seed and nonce is fixed below, so re-running
// with no code change reproduces byte-identical output. `--check`
// recomputes into memory and diffs against the committed file instead of
// writing -- that diff is the freeze (tests/tools/vectors.test.ts runs this
// flag as a test, LDB-B4's sibling on the db/ side).
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import url from "node:url";

const SCRIPTS_DIR = path.dirname(url.fileURLToPath(import.meta.url));
const DB_ROOT = path.join(SCRIPTS_DIR, "..");
const OUT_FILE = path.join(DB_ROOT, "tests", "vectors", "client-signing.json");
const CHECK = process.argv.includes("--check");

// 32 fixed bytes; the PKCS8 wrapper for a raw Ed25519 seed is one constant
// DER prefix (RFC 8410) -- 10 C1 §4 names this exact hex string.
const PKCS8_ED25519_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

function b64url(buf) {
  return Buffer.from(buf).toString("base64url");
}

function keyFromSeedHex(id, seedHex) {
  const seed = Buffer.from(seedHex, "hex");
  if (seed.length !== 32) throw new Error(`key '${id}': seed must be 32 bytes, got ${seed.length}`);
  const der = Buffer.concat([PKCS8_ED25519_PREFIX, seed]);
  const privateKey = crypto.createPrivateKey({ key: der, format: "der", type: "pkcs8" });
  const publicKey = crypto.createPublicKey(privateKey);
  // SPKI DER for a raw-32-byte Ed25519 public key always ends in exactly
  // those 32 bytes (a fixed 12-byte SPKI header precedes them) -- simpler
  // than parsing ASN.1 for a format this constrained.
  const rawPub = publicKey.export({ type: "spki", format: "der" }).subarray(-32);
  // PKCS8 DER, exported straight out of Node -- byte-identical to `der`
  // above (Node's own export normalizes the same way it imported), carried
  // in the vectors file so a Web Crypto consumer (the workers test suite,
  // the bot's TS client) can `importKey('pkcs8', ...)` directly without
  // reconstructing the DER wrapper itself.
  const pkcs8 = privateKey.export({ type: "pkcs8", format: "der" });
  return {
    id,
    seedHex,
    privateKey,
    pubkey_b64url: b64url(rawPub),
    pkcs8_b64url: b64url(pkcs8),
  };
}

// akl-v1 signing string (02 §3.2), byte for byte.
function signingString(method, pathWithQuery, timestamp, nonce, actor, bodyHashB64url) {
  return `akl-v1\n${method.toUpperCase()}\n${pathWithQuery}\n${timestamp}\n${nonce}\n${actor}\n${bodyHashB64url}`;
}

// An absent body and an empty-string body both hash as zero bytes (02 §3.2,
// 10 C1 §4's vector list) -- `body: null` and `body: ""` both take this path.
function bodyHashOf(bodyText) {
  const bytes = bodyText ? Buffer.from(bodyText, "utf8") : Buffer.alloc(0);
  return b64url(crypto.createHash("sha256").update(bytes).digest());
}

function sign(privateKey, message) {
  return b64url(crypto.sign(null, Buffer.from(message, "utf8"), privateKey));
}

// Deterministic 16-byte nonces (no real randomness -- reproducibility is
// the whole point of a frozen fixture): sha256("nonce:<label>") truncated.
function nonceFor(label) {
  return b64url(crypto.createHash("sha256").update(`nonce:${label}`).digest().subarray(0, 16));
}

const KEYS = {
  k1: keyFromSeedHex("k1", "dba37dbf20281991da86aeb66e45f47c71e629dc6bc8d3783bfc14da344c77f0"),
};

const CLIENT_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const ACTOR = "184412255822020608";
const ACTOR_20_DIGIT = "20000000000000000019";
const BASE_TS = 1788000000;

// { name, key, method, path, timestamp, actor, body }. `body` is `null`
// (no body / absent) or a JSON string exactly as it would go on the wire --
// this script does not re-serialize an object, so the vector pins the
// EXACT bytes that were hashed (a `JSON.stringify` difference between two
// implementations would otherwise be invisible here and visible only as a
// mismatched signature at verify time).
const CASES = [
  { name: "get-no-body", key: "k1", method: "GET", path: "/v1/me", timestamp: BASE_TS, actor: ACTOR, body: null },
  {
    name: "post-layouts-body",
    key: "k1",
    method: "POST",
    path: "/v1/layouts",
    timestamp: BASE_TS,
    actor: ACTOR,
    body: JSON.stringify({ name: "test-layout", format: "akl/1", payload: { keys: {} } }),
  },
  {
    name: "put-layouts-body",
    key: "k1",
    method: "PUT",
    path: "/v1/layouts/01ARZ3NDEKTSV4RRFFQ69G5FAV",
    timestamp: BASE_TS,
    actor: ACTOR,
    body: JSON.stringify({ format: "akl/1", payload: { keys: {} } }),
  },
  {
    name: "patch-layouts-body",
    key: "k1",
    method: "PATCH",
    path: "/v1/layouts/01ARZ3NDEKTSV4RRFFQ69G5FAV",
    timestamp: BASE_TS,
    actor: ACTOR,
    body: JSON.stringify({ name: "renamed-layout" }),
  },
  {
    name: "delete-no-body",
    key: "k1",
    method: "DELETE",
    path: "/v1/layouts/01ARZ3NDEKTSV4RRFFQ69G5FAV",
    timestamp: BASE_TS,
    actor: ACTOR,
    body: null,
  },
  {
    name: "get-with-query",
    key: "k1",
    method: "GET",
    path: "/v1/layouts?liked_by=184412255822020608&limit=5",
    timestamp: BASE_TS,
    actor: ACTOR,
    body: null,
  },
  {
    name: "post-body-non-ascii",
    key: "k1",
    method: "POST",
    path: "/v1/layouts",
    timestamp: BASE_TS,
    actor: ACTOR,
    body: JSON.stringify({ name: "café", format: "akl/1", payload: { keys: {} } }),
  },
  {
    name: "post-body-empty-string",
    key: "k1",
    method: "POST",
    path: "/v1/layouts/01ARZ3NDEKTSV4RRFFQ69G5FAV/restore",
    timestamp: BASE_TS,
    actor: ACTOR,
    body: "",
  },
  {
    name: "post-transfer",
    key: "k1",
    method: "POST",
    path: "/v1/layouts/01ARZ3NDEKTSV4RRFFQ69G5FAV/transfer",
    timestamp: BASE_TS,
    actor: ACTOR,
    body: JSON.stringify({ to: "184412255822020609" }),
  },
  {
    name: "put-like",
    key: "k1",
    method: "PUT",
    path: "/v1/layouts/01ARZ3NDEKTSV4RRFFQ69G5FAV/like",
    timestamp: BASE_TS,
    actor: ACTOR,
    body: null,
  },
  {
    name: "timestamp-plus-300",
    key: "k1",
    method: "GET",
    path: "/v1/me",
    timestamp: BASE_TS + 300,
    actor: ACTOR,
    body: null,
  },
  {
    name: "timestamp-minus-300",
    key: "k1",
    method: "GET",
    path: "/v1/me",
    timestamp: BASE_TS - 300,
    actor: ACTOR,
    body: null,
  },
  {
    name: "actor-20-digit",
    key: "k1",
    method: "GET",
    path: "/v1/me",
    timestamp: BASE_TS,
    actor: ACTOR_20_DIGIT,
    body: null,
  },
];

function buildVector(c) {
  const key = KEYS[c.key];
  const timestamp = String(c.timestamp);
  const nonce = nonceFor(c.name);
  const hash = bodyHashOf(c.body);
  const signing_string = signingString(c.method, c.path, timestamp, nonce, c.actor, hash);
  const signature_b64url = sign(key.privateKey, signing_string);
  return {
    name: c.name,
    key: c.key,
    client_id: CLIENT_ID,
    method: c.method,
    path: c.path,
    timestamp,
    nonce,
    actor: c.actor,
    body: c.body,
    signing_string,
    signature_b64url,
  };
}

function build() {
  return {
    version: 1,
    keys: Object.values(KEYS).map((k) => ({
      id: k.id,
      seed_hex: k.seedHex,
      pubkey_b64url: k.pubkey_b64url,
      pkcs8_b64url: k.pkcs8_b64url,
    })),
    vectors: CASES.map(buildVector),
  };
}

function main() {
  const built = build();
  const text = JSON.stringify(built, null, 2) + "\n";

  if (CHECK) {
    const existing = fs.existsSync(OUT_FILE) ? fs.readFileSync(OUT_FILE, "utf8") : null;
    if (existing !== text) {
      console.error(`${path.relative(DB_ROOT, OUT_FILE)} is out of date -- run 'node scripts/gen-vectors.mjs' to regenerate.`);
      process.exitCode = 1;
      return;
    }
    console.log(`${path.relative(DB_ROOT, OUT_FILE)} matches (--check OK)`);
    return;
  }

  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  fs.writeFileSync(OUT_FILE, text);
  console.log(`wrote ${path.relative(DB_ROOT, OUT_FILE)}`);
}

main();
