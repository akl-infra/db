#!/usr/bin/env node
// db/scripts/report-drill.mjs -- step 4 of the Fly restore drill
// (design/layout-db/12-implementation-phase5.md §3 X4): signs and POSTs
// the drill's report to `$DB_BASE_URL/v1/admin/drill` on the client lane.
//
// Duplicates `db/src/auth/client.ts`'s `signingString` byte for byte, the
// same way `bot/scripts/sign.mjs` and `bot/src/client/sign.ts` already do
// (a plain Node script can't resolve this project's extensionless
// TS-to-TS imports without a bundler) -- kept honest by
// `tests/drill/report-drill.test.ts` reproducing every vector in
// `tests/vectors/client-signing.json` through the functions below, the
// same way `bot/tests/client/sign.test.ts` does for the bot's own copy.
//
// Two invocation modes:
//   --ok true|false [--detail '<json>']
//     The design doc's own shape: send exactly this report. Exit code
//     reflects whether the POST itself succeeded (the report was
//     recorded) -- NOT the `ok` value sent; a red drill correctly
//     recorded is a successful invocation of this script.
//   --fetch <path> [--restore <path>] [--verify <path>] --duration-ms <n>
//     What `db/drill/run.sh` actually calls: reads the JSON each drill
//     step wrote (a missing `--restore`/`--verify` means that step never
//     ran because an earlier one failed), derives `ok` as the AND of every
//     step that was supplied, and builds `detail` from them. Exit code is
//     0 iff `ok === true` AND the POST succeeded -- this mode's result IS
//     `db/drill/run.sh`'s own exit code (LDB-D5: "ok: true only when the
//     restored database equals the dump byte-for-byte on every record").
import fs from "node:fs";
import url from "node:url";
import { canonical } from "../src/core/canonical.ts";

// `routes/admin.ts`'s own cap on `POST /v1/admin/drill`'s `detail`
// (12 §3 X4: "detail?: object <= 4 KB", measured on the canonical
// encoding) -- checked here too so an oversized detail fails loudly and
// locally instead of round-tripping to the server first.
const DRILL_DETAIL_MAX_BYTES = 4096;

export function base64UrlEncode(bytes) {
  return Buffer.from(bytes).toString("base64url");
}
export function base64UrlDecode(s) {
  return new Uint8Array(Buffer.from(s, "base64url"));
}

/** Imports a base64url PKCS8-DER Ed25519 private key -- `DRILL_PRIVATE_KEY`'s
 * shape (`bot/scripts/gen-key.mjs`'s own output), never logged. */
export async function importPrivateKey(pkcs8B64url) {
  const der = base64UrlDecode(pkcs8B64url);
  return crypto.subtle.importKey("pkcs8", der.slice(), { name: "Ed25519" }, false, ["sign"]);
}

async function sha256(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", bytes.slice());
  return new Uint8Array(digest);
}

// `db/src/auth/client.ts`'s `signingString`, byte for byte (02 §3.2).
export function signingString(method, pathWithQuery, timestamp, nonce, actor, bodyHashB64url) {
  return `akl-v1\n${method.toUpperCase()}\n${pathWithQuery}\n${timestamp}\n${nonce}\n${actor}\n${bodyHashB64url}`;
}

/** An absent body and an empty-string body both hash as zero bytes. */
export async function bodyHash(bodyBytes) {
  return base64UrlEncode(await sha256(bodyBytes));
}

export async function signRequest(
  key,
  clientId,
  actor,
  method,
  pathWithQuery,
  body,
  nowMs,
  nonce = crypto.getRandomValues(new Uint8Array(16)),
) {
  const timestamp = String(Math.floor(nowMs / 1000));
  const nonceB64 = base64UrlEncode(nonce);
  const hash = await bodyHash(body ?? new Uint8Array(0));
  const message = signingString(method, pathWithQuery, timestamp, nonceB64, actor, hash);
  const signature = await crypto.subtle.sign("Ed25519", key, new TextEncoder().encode(message));
  return {
    "X-Akl-Client": clientId,
    "X-Akl-Timestamp": timestamp,
    "X-Akl-Nonce": nonceB64,
    "X-Akl-Actor": actor,
    "X-Akl-Signature": base64UrlEncode(new Uint8Array(signature)),
  };
}

// Builds the exact `POST /v1/admin/drill` body `src/routes/schemas.ts`'s
// `drillReportSchema` accepts: `{ok: boolean, detail?: object}`,
// `additionalProperties: false`. Throws (never silently truncates) when
// `detail`'s canonical encoding is over the 4 KB cap.
export function buildReportBody(ok, detail) {
  if (typeof ok !== "boolean") throw new Error("buildReportBody: 'ok' must be a boolean");
  if (detail === undefined) return { ok };
  if (typeof detail !== "object" || detail === null || Array.isArray(detail)) {
    throw new Error("buildReportBody: 'detail' must be a plain object");
  }
  const bytes = new TextEncoder().encode(canonical(detail)).length;
  if (bytes > DRILL_DETAIL_MAX_BYTES) {
    throw new Error(`buildReportBody: 'detail' is ${bytes} bytes, over the ${DRILL_DETAIL_MAX_BYTES}-byte cap`);
  }
  return { ok, detail };
}

// `--fetch`/`--restore`/`--verify` mode: assembles `{ok, detail}` from the
// JSON each drill step already wrote to disk. A step whose path was never
// passed (an earlier step failed first, so it never ran) folds into `ok`
// as `false` and into `checks.<step>` as `null` -- distinct from a step
// that ran and reported `ok: false`.
export function readStepJson(pathOrNull) {
  if (pathOrNull === null || pathOrNull === undefined) return null;
  try {
    return JSON.parse(fs.readFileSync(pathOrNull, "utf8"));
  } catch (e) {
    return { ok: false, step: "unreadable", path: pathOrNull, error: String(e) };
  }
}

export function assembleFromSteps({ fetchResult, restoreResult, verifyResult, durationMs, now = new Date() }) {
  const ok = Boolean(fetchResult?.ok) && Boolean(restoreResult?.ok) && Boolean(verifyResult?.ok);
  const detail = {
    at: now.toISOString(),
    dump: fetchResult?.latest ? { key: fetchResult.latest.key, sha256: fetchResult.sha256, bytes: fetchResult.bytes } : null,
    checks: {
      fetch: fetchResult === null ? null : Boolean(fetchResult.ok),
      restore: restoreResult === null ? null : Boolean(restoreResult.ok),
      verify: verifyResult === null ? null : Boolean(verifyResult.ok),
    },
    duration_ms: Number.isFinite(durationMs) ? durationMs : null,
  };
  return { ok, detail };
}

function parseArgs(argv) {
  const out = { ok: null, detail: undefined, fetch: null, restore: null, verify: null, durationMs: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--ok") out.ok = argv[++i];
    else if (argv[i] === "--detail") out.detail = argv[++i];
    else if (argv[i] === "--fetch") out.fetch = argv[++i];
    else if (argv[i] === "--restore") out.restore = argv[++i];
    else if (argv[i] === "--verify") out.verify = argv[++i];
    else if (argv[i] === "--duration-ms") out.durationMs = Number(argv[++i]);
  }
  return out;
}

async function postReport(body) {
  const dbBaseUrl = process.env.DB_BASE_URL;
  const clientId = process.env.DRILL_CLIENT_ID;
  const privateKeyB64url = process.env.DRILL_PRIVATE_KEY;
  const actor = process.env.DRILL_ACTOR;
  if (!dbBaseUrl || !clientId || !privateKeyB64url || !actor) {
    throw new Error("DB_BASE_URL, DRILL_CLIENT_ID, DRILL_PRIVATE_KEY and DRILL_ACTOR must all be set");
  }

  const bodyText = JSON.stringify(body);
  const bodyBytes = new TextEncoder().encode(bodyText);
  const key = await importPrivateKey(privateKeyB64url);
  const headers = await signRequest(key, clientId, actor, "POST", "/v1/admin/drill", bodyBytes, Date.now());

  const res = await fetch(`${dbBaseUrl}/v1/admin/drill`, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: bodyText,
  });
  const text = await res.text();
  return { status: res.status, ok: res.ok, text };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  let body;
  let mode;
  if (args.ok === "true" || args.ok === "false") {
    mode = "manual";
    const detail = args.detail === undefined ? undefined : JSON.parse(args.detail);
    body = buildReportBody(args.ok === "true", detail);
  } else if (args.fetch !== null) {
    mode = "steps";
    const fetchResult = readStepJson(args.fetch);
    const restoreResult = readStepJson(args.restore);
    const verifyResult = readStepJson(args.verify);
    const { ok, detail } = assembleFromSteps({ fetchResult, restoreResult, verifyResult, durationMs: args.durationMs });
    body = buildReportBody(ok, detail);
  } else {
    console.error(
      "usage: node scripts/report-drill.mjs --ok true|false [--detail '<json>']\n" +
        "   or: node scripts/report-drill.mjs --fetch <path> [--restore <path>] [--verify <path>] --duration-ms <n>",
    );
    process.exit(1);
    return;
  }

  let result;
  try {
    result = await postReport(body);
  } catch (e) {
    console.log(JSON.stringify({ recorded: false, error: String(e) }));
    process.exit(1);
    return;
  }

  if (!result.ok) {
    console.log(JSON.stringify({ recorded: false, status: result.status, body: result.text }));
    process.exit(1);
    return;
  }

  console.log(result.text); // the server's own `{recorded: true}` -- no secret ever reaches here
  // "steps" mode's exit code is the drill's own result (LDB-D5); "manual"
  // mode's is just "was it recorded" -- the caller supplied `ok` on
  // purpose and isn't asking this script to re-judge it.
  if (mode === "steps" && body.ok !== true) process.exit(1);
}

const isMain = process.argv[1] !== undefined && url.pathToFileURL(process.argv[1]).href === import.meta.url;
if (isMain) {
  main().catch((err) => {
    console.error(err);
    console.log(JSON.stringify({ recorded: false, error: String(err) }));
    process.exit(1);
  });
}
