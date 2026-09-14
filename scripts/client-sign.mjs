#!/usr/bin/env node
// db/scripts/client-sign.mjs -- the client-lane signer for this repo's own
// scripts (02-auth.md §3.2, 10 C1 §4): `makeSigner()` for callers in Node
// (scripts/reseed-magic.mjs), and a CLI that prints the five signed headers
// for one request so a shell wrapper (scripts/ops-call.sh) can hand them to
// curl:
//
//   node scripts/client-sign.mjs <METHOD> <path-or-url> [--body=<json>]
//
// Reads CLIENT_ID / CLIENT_PRIVATE_KEY / OPS_ACTOR from the environment --
// the maintainer's `db.env.ops` beside the clones (README "Secrets and
// bindings") -- never from a flag, and never prints the key. Output is one
// `Name: value` line per header (plus `Content-Type: application/json` when
// a body was given), the shape `curl -H` takes verbatim.
//
// Plain Node: `signingString` is duplicated from src/auth/client.ts byte for
// byte (a bare `node` run cannot import the Worker's TS; the same copy
// scripts/gen-vectors.mjs keeps). tests/tools/reseed-magic.test.ts proves
// `makeSigner` reproduces tests/vectors/client-signing.json, the vectors
// src/auth/client.ts itself verifies against (LDB-P25, LDB-A4).
import crypto from "node:crypto";
import process from "node:process";
import url from "node:url";

// src/auth/client.ts's `signingString`, byte for byte (02-auth.md §3.2).
export function signingString(method, pathWithQuery, timestamp, nonce, actor, bodyHashB64url) {
  return `akl-v1\n${method.toUpperCase()}\n${pathWithQuery}\n${timestamp}\n${nonce}\n${actor}\n${bodyHashB64url}`;
}

export function makeSigner({ clientId, privateKeyB64url, actor, now = () => Date.now(), randomNonce = () => crypto.randomBytes(16) }) {
  const key = crypto.createPrivateKey({ key: Buffer.from(privateKeyB64url, "base64url"), format: "der", type: "pkcs8" });
  return function sign(method, pathWithQuery, bodyBytes) {
    const timestamp = String(Math.floor(now() / 1000));
    const nonce = Buffer.from(randomNonce()).toString("base64url");
    const bodyHash = crypto.createHash("sha256").update(bodyBytes).digest("base64url");
    const message = signingString(method, pathWithQuery, timestamp, nonce, actor, bodyHash);
    const signature = crypto.sign(null, Buffer.from(message, "utf8"), key).toString("base64url");
    return {
      "X-Akl-Client": clientId,
      "X-Akl-Timestamp": timestamp,
      "X-Akl-Nonce": nonce,
      "X-Akl-Actor": actor,
      "X-Akl-Signature": signature,
    };
  };
}

// The signer built from the environment every script in this repo shares.
export function signerFromEnv(env = process.env) {
  const { CLIENT_ID: clientId, CLIENT_PRIVATE_KEY: privateKeyB64url, OPS_ACTOR: actor } = env;
  if (!clientId || !privateKeyB64url || !actor) {
    throw new Error("CLIENT_ID, CLIENT_PRIVATE_KEY and OPS_ACTOR must be set (db.env.ops beside the clones)");
  }
  return makeSigner({ clientId, privateKeyB64url, actor });
}

function main(argv) {
  const positional = argv.filter((a) => !a.startsWith("--"));
  const flags = Object.fromEntries(argv.filter((a) => a.startsWith("--")).map((a) => (a.includes("=") ? [a.slice(2, a.indexOf("=")), a.slice(a.indexOf("=") + 1)] : [a.slice(2), "true"])));
  const [method, rawPath] = positional;
  if (!method || !rawPath) {
    console.error("usage: node scripts/client-sign.mjs <METHOD> <path-or-url> [--body=<json>]  (env: CLIENT_ID, CLIENT_PRIVATE_KEY, OPS_ACTOR)");
    return 2;
  }
  // Only the path+query is ever signed (02 §3.2); a full URL is accepted for convenience.
  const u = new URL(rawPath, "https://placeholder.invalid/");
  const bodyBytes = flags.body === undefined ? new Uint8Array(0) : Buffer.from(String(flags.body), "utf8");
  const headers = signerFromEnv()(method, `${u.pathname}${u.search}`, bodyBytes);
  for (const [k, v] of Object.entries(headers)) console.log(`${k}: ${v}`);
  if (flags.body !== undefined) console.log("Content-Type: application/json");
  return 0;
}

if (process.argv[1] && import.meta.url === url.pathToFileURL(process.argv[1]).href) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (err) {
    console.error(`client-sign: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
