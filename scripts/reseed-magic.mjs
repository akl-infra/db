#!/usr/bin/env node
// db/scripts/reseed-magic.mjs -- the periodic magic reseed from akl.gg prod
// (docs/decisions/26-magic-reseed.md). Until akl.gg's own rules editor
// writes to akldb, the site's D1 table is where a published rule set lands
// first; this script keeps every akldb record's `magic` equal to what akl.gg
// publishes, so the day the site flips to akldb nothing is behind.
//
//   npm run reseed-magic              # live: seeds every record that differs
//   npm run reseed-magic -- --dry-run # reads only; prints what it would seed
//
// Environment (the CI job in .github/workflows/ci.yml sets all of these):
//   DB_BASE_URL                 the akldb origin, e.g. https://api.akldb.org
//   AKLGG_RULES_URL             akl.gg's public index of published rule sets
//                               (default https://akl.gg/api/magic-rules --
//                               `{<layout id>: <rule set>}`, no auth)
//   RESEED_CLIENT_ID            the ops client's id (client lane, 02-auth §3)
//   RESEED_CLIENT_PRIVATE_KEY   its base64url PKCS8 Ed25519 private key
//   RESEED_ACTOR                the admin Discord user id the seed acts as
//                               (`POST /v1/admin/magic-seed` is admin-only;
//                               LDB-G2: never a constant in code)
//
// Per rule set, in the index's order:
//   1. `GET /v1/layouts/{id}?format=spark/1` (public). 404 (`not_found` or
//      `format_absent`) -> `missing`: akl.gg publishes rule sets for
//      layouts akldb has no record of (deleted from cmini, or workbench
//      experiments that never became a layout) -- reported, never created.
//   2. The candidate is the rule set stripped to spark/1's three fields and
//      RETAGGED from akl.gg's bare-string default vocabulary
//      (`'repeat_previous'` / a literal char / `'none'`) to spark/1's
//      kind-tagged union (`{kind: "repeat"}` / `{kind: "char", char}` /
//      absent). Equal to the record's current `magic` -> `identical`, no
//      request sent (a re-run after a full pass sends zero writes).
//   3. The guard, from the public read alone: the record is seeded only if
//      its spark/1 row was last written by a system client (the seed itself
//      or the cmini import) OR it has no magic and is not forked. Anything
//      else means a person wrote to this record in akldb since -- their
//      magic is never clobbered by akl.gg's copy, and (because the seed
//      route sets `upstream.state = following`) a fork they made is never
//      undone by it. Reported as `edited`.
//   4. Live only: `POST /v1/admin/magic-seed {ref: <record id>, magic}`,
//      client-lane signed. 200 -> `seeded`; `400 magic_collision` /
//      `400 invalid_payload` -> `collision` / `invalid` (the DB's own
//      refusal, reported and failed on -- akl.gg's rules must land verbatim,
//      never auto-amended); one `429` is waited out and retried; any other
//      answer aborts the run.
//
// Exit 1 if anything landed in `collision` or `invalid` (a human decides),
// 0 otherwise -- `missing` and `edited` are expected outcomes, printed so
// they are read, never failed on.
//
// Plain Node: the signing string is duplicated from src/auth/client.ts
// (`signingString`, byte for byte -- the same copy scripts/gen-vectors.mjs
// keeps, and tests/auth/client.test.ts proves the vectors) because a bare
// `node` run cannot import the Worker's TS. Everything else is exported so
// tests/tools/reseed-magic.test.ts drives the whole run with a fake fetch.
import crypto from "node:crypto";
import process from "node:process";
import url from "node:url";

export const DEFAULT_RULES_URL = "https://akl.gg/api/magic-rules";
export const USER_AGENT = "akl-db-reseed/1.0";
export const MAGIC_FIELDS = ["magic_keys", "chiral_keys", "adaptive_swaps"];
// The two writers whose last write on a spark/1 row means "nobody edited
// this in akldb since": `core/write.ts`'s `seedMagic` and `import/apply.ts`'s
// `SYSTEM_SOURCE`.
export const SYSTEM_CLIENTS = new Set(["system:magic-seed", "system:cmini-import"]);

// --- the candidate ---------------------------------------------------------

// akl.gg's bare-string default -> spark/1's tagged union (ported from the
// retired scripts/migrate_magic_rules_to_db.py's `_tag_wire_value`, itself
// web/src/core/akl1.ts's `toWireDefault`). `null` means "omit the field".
export function tagWireValue(value) {
  if (value === undefined || value === null || value === "" || value === "none") return null;
  if (value === "repeat_previous") return { kind: "repeat" };
  return { kind: "char", char: String(value) };
}

export function candidateFrom(ruleSet) {
  const out = {};
  for (const field of MAGIC_FIELDS) {
    if (Array.isArray(ruleSet?.[field])) out[field] = JSON.parse(JSON.stringify(ruleSet[field]));
  }
  for (const mk of out.magic_keys ?? []) {
    const tagged = tagWireValue(mk.default);
    if (tagged === null) delete mk.default;
    else mk.default = tagged;
    // design/layout-db/27-magic-emit.md: akl.gg still authors `{after,
    // output}` with `output` repeating the context (its own validator
    // guarantees `output` starts with `after`); spark/1's rule is `{after,
    // emit}`, what the key emits after the context. A rule that does not
    // extend its context (impossible past akl.gg's gate; guarded anyway)
    // cannot be a magic-key rule and is demoted to the raw escape hatch.
    if (Array.isArray(mk.rules)) {
      const kept = [];
      for (const r of mk.rules) {
        if (typeof r?.after !== "string" || typeof r?.output !== "string") continue;
        if (r.output.startsWith(r.after) && r.output.length > r.after.length) kept.push({ after: r.after, emit: r.output.slice(r.after.length) });
        else (out.rules ??= []).push({ inputs: r.after + mk.key, output: r.output });
      }
      mk.rules = kept;
    }
  }
  for (const ck of out.chiral_keys ?? []) {
    for (const field of ["same", "opposite"]) {
      if (!(field in ck)) continue;
      const tagged = tagWireValue(ck[field]);
      if (tagged === null) delete ck[field];
      else ck[field] = tagged;
    }
  }
  return out;
}

// Deterministic JSON: object keys sorted, list order kept (rule order is
// meaningful -- scaffold precedence). Empty lists are dropped on both sides
// so `{chiral_keys: []}` and an absent field compare equal, which is how
// spark/1's `hasMagic` reads them too.
export function canonicalMagic(magic) {
  const m = magic ?? {};
  const kept = {};
  for (const field of MAGIC_FIELDS) {
    if (Array.isArray(m[field]) && m[field].length > 0) kept[field] = m[field];
  }
  return JSON.stringify(sortKeys(kept));
}

function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((k) => [k, sortKeys(value[k])]),
    );
  }
  return value;
}

export function magicEqual(a, b) {
  return canonicalMagic(a) === canonicalMagic(b);
}

// --- the guard ---------------------------------------------------------------

// `record` is a `GET /v1/layouts/{ref}?format=spark/1` body. Returns null
// when seeding is safe, or the reason it isn't.
export function editedReason(record) {
  const row = record?.formats?.["spark/1"];
  const client = row?.source?.client ?? null;
  if (client !== null && SYSTEM_CLIENTS.has(client)) return null;
  const hasMagic = row?.has_magic === true;
  const forked = record?.upstream?.state === "forked";
  if (!hasMagic && !forked) return null;
  if (hasMagic) return `magic last written by ${client ?? "an unrecorded client"}`;
  return `forked by ${client ?? "an unrecorded client"}`;
}

// --- signing -------------------------------------------------------------------

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

// --- the run -----------------------------------------------------------------------

export const BUCKETS = ["seeded", "identical", "edited", "missing", "collision", "invalid"];

async function readJson(res) {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function getRecord(fetchImpl, baseUrl, id) {
  const res = await fetchImpl(`${baseUrl}/v1/layouts/${encodeURIComponent(id)}?format=spark/1`, {
    headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
  });
  if (res.status === 404) return null;
  if (res.status !== 200) throw new Error(`${id}: GET record answered ${res.status}: ${JSON.stringify(await readJson(res)).slice(0, 300)}`);
  return readJson(res);
}

async function postSeed(fetchImpl, baseUrl, sign, ref, magic, sleep) {
  const path = "/v1/admin/magic-seed";
  const bodyBytes = Buffer.from(JSON.stringify({ ref, magic }), "utf8");
  const send = () =>
    fetchImpl(`${baseUrl}${path}`, {
      method: "POST",
      headers: { ...sign("POST", path, bodyBytes), "Content-Type": "application/json", "User-Agent": USER_AGENT },
      body: bodyBytes,
    });
  let res = await send();
  if (res.status === 429) {
    const wait = Number(res.headers.get("Retry-After") ?? "5");
    await sleep((Number.isFinite(wait) ? wait : 5) * 1000);
    res = await send();
  }
  return { status: res.status, body: await readJson(res) };
}

// Drives one full pass. `fetchImpl`/`sign`/`sleep`/`log` are injected so the
// test can run it offline; `sign` may be null only with `dryRun`.
export async function reseedMagic({ baseUrl, rulesUrl = DEFAULT_RULES_URL, fetchImpl = fetch, sign = null, dryRun = false, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), log = console.log }) {
  if (!dryRun && sign === null) throw new Error("a live run needs a signer");
  const base = baseUrl.replace(/\/+$/, "");
  const indexRes = await fetchImpl(rulesUrl, { headers: { "User-Agent": USER_AGENT, Accept: "application/json" } });
  if (indexRes.status !== 200) throw new Error(`rules index ${rulesUrl} answered ${indexRes.status}`);
  const index = await readJson(indexRes);
  if (index === null || typeof index !== "object" || Array.isArray(index)) throw new Error(`rules index ${rulesUrl} is not an object keyed by layout id`);

  const report = Object.fromEntries(BUCKETS.map((b) => [b, []]));
  for (const id of Object.keys(index)) {
    const record = await getRecord(fetchImpl, base, id);
    if (record === null) {
      report.missing.push({ id });
      log(`${id}: missing (no spark/1 record in akldb)`);
      continue;
    }
    const candidate = candidateFrom(index[id]);
    if (magicEqual(candidate, record.payload?.magic)) {
      report.identical.push({ id });
      continue;
    }
    const reason = editedReason(record);
    if (reason !== null) {
      report.edited.push({ id, reason });
      log(`${id}: edited in akldb (${reason}) -- left alone`);
      continue;
    }
    if (dryRun) {
      report.seeded.push({ id, dry_run: true });
      log(`${id}: would seed (dry run)`);
      continue;
    }
    const { status, body } = await postSeed(fetchImpl, base, sign, record.id, candidate, sleep);
    if (status === 200) {
      report.seeded.push({ id, rev: body?.rev ?? null });
      log(`${id}: seeded (spark/1 rev ${body?.rev ?? "?"})`);
    } else if (status === 400 && (body?.error === "magic_collision" || body?.error === "invalid_payload")) {
      const bucket = body.error === "magic_collision" ? "collision" : "invalid";
      report[bucket].push({ id, error: body });
      log(`${id}: ${bucket} -- ${body.message ?? ""}`);
    } else {
      throw new Error(`${id}: unexpected seed response ${status}: ${JSON.stringify(body).slice(0, 300)}`);
    }
  }
  return report;
}

export function summarize(report) {
  return Object.fromEntries(BUCKETS.map((b) => [b, report[b].length]));
}

function usage(msg) {
  console.error(`error: ${msg}`);
  console.error("usage: node scripts/reseed-magic.mjs [--dry-run]  (env: DB_BASE_URL, RESEED_CLIENT_ID, RESEED_CLIENT_PRIVATE_KEY, RESEED_ACTOR, optional AKLGG_RULES_URL)");
  process.exit(2);
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const dryRun = argv.includes("--dry-run");
  const baseUrl = env.DB_BASE_URL;
  if (!baseUrl) usage("DB_BASE_URL is required");
  let sign = null;
  if (!dryRun) {
    const { RESEED_CLIENT_ID: clientId, RESEED_CLIENT_PRIVATE_KEY: privateKeyB64url, RESEED_ACTOR: actor } = env;
    if (!clientId || !privateKeyB64url || !actor) usage("RESEED_CLIENT_ID, RESEED_CLIENT_PRIVATE_KEY and RESEED_ACTOR are required for a live run");
    sign = makeSigner({ clientId, privateKeyB64url, actor });
  }
  const report = await reseedMagic({ baseUrl, rulesUrl: env.AKLGG_RULES_URL || DEFAULT_RULES_URL, sign, dryRun });
  console.log(`reseed-magic${dryRun ? " (dry run)" : ""}: ${JSON.stringify(summarize(report))}`);
  return report.collision.length > 0 || report.invalid.length > 0 ? 1 : 0;
}

if (process.argv[1] && import.meta.url === url.pathToFileURL(process.argv[1]).href) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      console.error(`reseed-magic: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    },
  );
}
