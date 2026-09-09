#!/usr/bin/env node
// db/scripts/drill-fetch-dump.mjs -- step 1 of the Fly restore drill
// (design/layout-db/12-implementation-phase5.md §3 X4 "the drill on
// Fly", LDB-D5): GETs `$DB_BASE_URL/v1/dump/latest.json`, then the dump
// object it names, and verifies the fetched bytes against latest.json's
// own `sha256`/`bytes` fields BEFORE anything downstream ever touches
// them -- a corrupt or truncated transfer must never reach
// `drill-restore.mjs`.
//
// `checkDumpIntegrity` is exported separately from the CLI so
// `tests/drill/*.test.ts` can exercise the sha256/byte check against a
// corrupted dump and a good one with no network involved at all.
import fs from "node:fs";
import path from "node:path";
import url from "node:url";
import zlib from "node:zlib";
import { webcrypto } from "node:crypto";

// `crypto.subtle`'s digest is async -- what every other signer/verifier in
// this codebase already uses (`src/auth/client.ts`, `bot/src/client/
// sign.ts`), so this stays consistent rather than reaching for
// `node:crypto`'s sync hash instead.
export async function sha256HexAsync(bytes) {
  const digest = await webcrypto.subtle.digest("SHA-256", bytes.slice());
  return Buffer.from(digest).toString("hex");
}

// Pure: given the parsed `latest.json` body and the raw bytes fetched for
// the key it names, checks both of LDB-D5's byte-for-byte claims -- sha256
// and byte count -- and reports which (if any) failed. `sha256` here is
// already computed (async digesting happens once, at the call site) so
// this function itself stays synchronous and trivially testable.
export function checkDumpIntegrity(latestJson, bytes, sha256) {
  const reasons = [];
  if (typeof latestJson?.sha256 !== "string" || sha256 !== latestJson.sha256) {
    reasons.push(`sha256 mismatch: got ${sha256}, latest.json says ${latestJson?.sha256}`);
  }
  if (typeof latestJson?.bytes !== "number" || bytes.length !== latestJson.bytes) {
    reasons.push(`byte count mismatch: got ${bytes.length}, latest.json says ${latestJson?.bytes}`);
  }
  return { ok: reasons.length === 0, sha256, bytes: bytes.length, reasons };
}

async function fetchBytes(u) {
  const res = await fetch(u);
  if (!res.ok) throw new Error(`GET ${u} -> ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

function parseArgs(argv) {
  const out = { base: null, out: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--base") out.base = argv[++i];
    else if (argv[i] === "--out") out.out = argv[++i];
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.base || !args.out) {
    console.error("usage: node scripts/drill-fetch-dump.mjs --base <DB_BASE_URL> --out <dir>");
    process.exit(1);
    return;
  }
  fs.mkdirSync(args.out, { recursive: true });

  const latestUrl = `${args.base}/v1/dump/latest.json`;
  let latestJson;
  try {
    const latestBytes = await fetchBytes(latestUrl);
    latestJson = JSON.parse(Buffer.from(latestBytes).toString("utf8"));
  } catch (e) {
    console.log(JSON.stringify({ ok: false, step: "latest.json", url: latestUrl, error: String(e) }));
    process.exit(1);
    return;
  }
  fs.writeFileSync(path.join(args.out, "latest.json"), JSON.stringify(latestJson));

  const dumpUrl = `${args.base}${latestJson.url}`;
  let dumpBytes;
  try {
    dumpBytes = await fetchBytes(dumpUrl);
  } catch (e) {
    console.log(JSON.stringify({ ok: false, step: "dump", url: dumpUrl, error: String(e) }));
    process.exit(1);
    return;
  }

  const sha256 = await sha256HexAsync(dumpBytes);
  const check = checkDumpIntegrity(latestJson, dumpBytes, sha256);
  if (!check.ok) {
    console.log(JSON.stringify({ ok: false, step: "integrity", url: dumpUrl, latest: latestJson, ...check }));
    process.exit(1);
    return;
  }

  const gzPath = path.join(args.out, path.basename(latestJson.key ?? "dump.json.gz"));
  fs.writeFileSync(gzPath, Buffer.from(dumpBytes));
  const dumpJsonPath = path.join(args.out, "dump.json");
  fs.writeFileSync(dumpJsonPath, zlib.gunzipSync(Buffer.from(dumpBytes)));

  console.log(
    JSON.stringify({
      ok: true,
      latest: latestJson,
      sha256: check.sha256,
      bytes: check.bytes,
      dumpPath: dumpJsonPath,
      gzPath,
    }),
  );
}

const isMain = process.argv[1] !== undefined && url.pathToFileURL(process.argv[1]).href === import.meta.url;
if (isMain) {
  main().catch((err) => {
    console.error(err);
    console.log(JSON.stringify({ ok: false, step: "unexpected", error: String(err) }));
    process.exit(1);
  });
}
