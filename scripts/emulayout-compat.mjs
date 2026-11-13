#!/usr/bin/env node
// Does an akldb change still read cleanly in emulayout (https://github.com/emulayout/emulayout.github.io), an
// external public project that syncs akldb's whole catalog through a strict reader (INVARIANTS.md LDB-EM1)?
//
//   npm run check:emulayout                 corpus mode (offline apart from fetching emulayout's source)
//   npm run check:emulayout -- --live       also run the live public catalog (api.akldb.org) through the reader
//
// What it does: clones emulayout's master (sparse: src/lib and bin only) into a scratch directory outside this
// repo, prints the commit, and runs ITS reader (`validateSparkLayout`, `parseAkldbLayouts`, `ensureAkldbCatalog`,
// under bun, its own runtime) over every record of the shape corpus -- tests/emulayout/corpus/*.json plus the
// frozen spark/1 fixtures -- wrapped in the /v1/layouts?full=1 envelope with the mana2/1 projection akldb itself
// computes. Third-party code: it runs with a scrubbed environment (no secrets, a throwaway HOME), only the three
// reader entry points are called, the catalog fetch is served from memory, and nothing of theirs is written
// into this repo. It is not a sandbox (bun can still reach the network); the guard is that nothing sensitive is
// in its environment and the code is public.
//
// Exit codes: 0 ok; 1 a corpus record is rejected (or the catalog-level parse fails) and the baseline does not
// explain it; 2 usage/infrastructure error; 3 emulayout rejects the SAME records on the unchanged baseline too
// (emulayout's master is broken independently of this change) -- 0 instead only when
// EMULAYOUT_KNOWN_BROKEN_SHA names exactly the emulayout commit under test. The baseline is the corpus as of
// --baseline-ref <git ref> (CI: the PR's base commit) or --baseline-dir <repo root>. --live reports and never fails.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HARNESS = path.join(REPO, "scripts", "emulayout-harness.mjs");
export const EMULAYOUT_URL = "https://github.com/emulayout/emulayout.github.io";
export const API_ORIGIN = "https://api.akldb.org";
export const USER_AGENT = "akldb-emulayout-compat/1";

// ---- records ---------------------------------------------------------------------------------------------

// Where the corpus lives, relative to a repo root (the baseline is the same layout at another ref).
export const CORPUS_DIRS = [
  { dir: "tests/emulayout/corpus", prefix: "corpus/", pick: (f) => f.endsWith(".json") },
  // The frozen spark/1 fixtures (formats/spark/1/fixtures): real catalog shapes. Skip the derived goldens.
  { dir: "formats/spark/1/fixtures", prefix: "fixture/", pick: (f) => /^\d+-.*\.json$/.test(f) && !/\.(lowered|mana2-1)\.json$/.test(f) },
];

/** A corpus file is a bare spark/1 payload, or {name, owner?, link?, likes?, payload} to also set record fields. */
export function loadRecords(root, dirs = CORPUS_DIRS) {
  const records = [];
  for (const { dir, prefix, pick } of dirs) {
    const abs = path.join(root, dir);
    if (!fs.existsSync(abs)) continue;
    for (const file of fs.readdirSync(abs).filter(pick).sort()) {
      const doc = JSON.parse(fs.readFileSync(path.join(abs, file), "utf8"));
      const wrapped = doc && typeof doc === "object" && "payload" in doc && !("keys" in doc);
      const base = file.replace(/\.json$/, "");
      records.push({
        file: `${dir}/${file}`,
        name: prefix + (wrapped && typeof doc.name === "string" ? doc.name : base),
        owner: wrapped && doc.owner ? String(doc.owner) : "100000000000000000",
        link: wrapped && typeof doc.link === "string" ? doc.link : null,
        likes: wrapped && Array.isArray(doc.likes) ? doc.likes.map(String) : [],
        payload: wrapped ? doc.payload : doc,
      });
    }
  }
  return records;
}

// ---- envelopes (the /v1/layouts?full=1 shape emulayout consumes) -----------------------------------------------

const T0 = "2026-01-01T00:00:00Z";

/** Wraps corpus records the way the API serves them, with akldb's own spark/1 -> mana2/1 projection. */
export async function buildInput(records) {
  const { translate } = await import("../formats/index.ts");
  // etag.ts's WIRE_VERSION is the API minor (version.ts: API_MINOR = WIRE_VERSION); read it as text, because the
  // src/ modules use extensionless imports plain node cannot load.
  const API_MINOR = Number(/export const WIRE_VERSION\s*=\s*(\d+)/.exec(fs.readFileSync(path.join(REPO, "src/core/etag.ts"), "utf8"))?.[1]);
  if (!Number.isInteger(API_MINOR)) throw new Error("cannot read WIRE_VERSION from src/core/etag.ts");
  const spark = [];
  const mana = [];
  records.forEach((r, i) => {
    const id = `01CORPUS${String(i).padStart(18, "0")}`;
    const row = {
      id,
      name: r.name,
      owner: r.owner,
      layout_rev: 1,
      created_at: T0,
      modified_at: T0,
      deleted: false,
      like_count: r.likes.length,
      likes: r.likes,
      link: r.link,
      formats: { "spark/1": { rev: 1, created_at: T0, modified_at: T0, has_alts: false, has_combos: false, has_magic: false } },
    };
    spark.push({ ...row, format: "spark/1", payload: r.payload });
    const t = translate({ format: "spark/1", payload: r.payload }, "mana2/1");
    if ("payload" in t) mana.push({ ...row, format: "mana2/1", payload: t.payload });
  });
  return {
    spark: { items: spark },
    mana: { items: mana },
    authors: { compat: "100000000000000000" },
    meta: {
      layout_count: spark.length,
      author_count: 1,
      seq: 1,
      revision: T0,
      layouts_modified_at: T0,
      authors_modified_at: T0,
      formats: ["spark/1", "mana2/1"],
      api: { major: 1, minor: API_MINOR },
    },
  };
}

export async function fetchLiveInput(fetchImpl = fetch) {
  const get = async (p) => {
    const res = await fetchImpl(API_ORIGIN + p, { headers: { Accept: "application/json", "User-Agent": USER_AGENT }, signal: AbortSignal.timeout(120_000) });
    if (!res.ok) throw new Error(`GET ${p}: HTTP ${res.status}`);
    return JSON.parse(await res.text());
  };
  const [meta, spark, mana, authors] = await Promise.all([
    get("/v1/meta"),
    get("/v1/layouts?full=1&format=spark%2F1"),
    get("/v1/layouts?full=1&format=mana2%2F1"),
    get("/v1/authors"),
  ]);
  return { meta, spark, mana, authors };
}

// ---- emulayout ---------------------------------------------------------------------------------------------

/** No secrets, no user config: PATH plus a throwaway HOME. */
export function scrubbedEnv(home) {
  const env = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home, TMPDIR: home, LANG: "C.UTF-8", GIT_TERMINAL_PROMPT: "0", GIT_CONFIG_NOSYSTEM: "1" };
  return env;
}

function run(cmd, args, opts) {
  const r = spawnSync(cmd, args, { encoding: "utf8", maxBuffer: 1 << 30, ...opts });
  if (r.error) throw r.error;
  return r;
}

/** Fetches emulayout's reader sources at `ref` (a branch name or a commit SHA) into `dest`; returns the commit SHA. */
export function fetchEmulayout(dest, ref, env) {
  const git = (args, cwd) => {
    const r = run("git", ["-c", "core.hooksPath=/dev/null", ...args], { cwd, env });
    if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr.trim()}`);
    return r.stdout.trim();
  };
  if (/^[0-9a-f]{40}$/.test(ref)) {
    fs.mkdirSync(dest, { recursive: true });
    git(["init", "-q"], dest);
    git(["remote", "add", "origin", EMULAYOUT_URL], dest);
    git(["sparse-checkout", "set", "src/lib", "bin"], dest);
    git(["fetch", "-q", "--depth", "1", "--filter=blob:none", "origin", ref], dest);
    git(["checkout", "-q", "FETCH_HEAD"], dest);
  } else {
    git(["clone", "-q", "--depth", "1", "--filter=blob:none", "--sparse", "--branch", ref, EMULAYOUT_URL, dest]);
    git(["sparse-checkout", "set", "src/lib", "bin"], dest);
  }
  return git(["rev-parse", "HEAD"], dest);
}

export function resolveRuntime(name) {
  if (name && name !== "bun") return name;
  const r = run("bun", ["--version"], {});
  if (r.error || r.status !== 0) throw new Error("bun is required: emulayout's reader imports extensionless TypeScript modules that node cannot load (install bun, or pass --runtime <path> for a stand-in)");
  return "bun";
}

/** Spawns the harness in emulayout's runtime over `input`; returns {records, catalog}. */
export function runReader({ runtime, emulayoutDir, input, scratch, env }) {
  const inputPath = path.join(scratch, `input-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(inputPath, JSON.stringify({ ...input, scratch }));
  const work = path.join(scratch, "work");
  fs.mkdirSync(work, { recursive: true });
  const r = run(runtime, [HARNESS, emulayoutDir, inputPath], { cwd: work, env });
  fs.rmSync(inputPath, { force: true });
  if (r.status !== 0) throw new Error(`the reader harness failed (exit ${r.status}): ${(r.stderr || r.stdout).trim().slice(0, 2000)}`);
  const line = r.stdout.trim().split("\n").pop();
  return JSON.parse(line);
}

// ---- classification --------------------------------------------------------------------------------------------

/** Counts and lists from a harness result. A catalog that fails as a unit is a failure on its own. */
export function summarize(result) {
  const rejected = result.records.filter((r) => r.status === "rejected");
  const dropped = result.records.filter((r) => r.status === "dropped");
  return {
    total: result.records.length,
    accepted: result.records.filter((r) => r.status === "accepted").length,
    dropped,
    rejected,
    catalog: result.catalog,
    ok: rejected.length === 0 && result.catalog.ok === true,
    result,
  };
}

/** The verdict for a corpus run, given the baseline's summary (or null): which exit code, and why. */
export function verdict(head, base, { sha, knownBrokenSha } = {}) {
  if (head.ok) return { code: 0, note: null };
  if (!base) return { code: 1, note: "emulayout rejects the corpus (no baseline to compare)" };
  const baseNames = new Set(base.rejected.map((r) => r.name));
  const fresh = head.rejected.filter((r) => !baseNames.has(r.name));
  const catalogFresh = head.catalog.ok !== true && base.catalog.ok === true;
  if (fresh.length > 0 || catalogFresh) return { code: 1, note: `${fresh.length} record(s) newly rejected${catalogFresh ? " and the catalog-level parse newly fails" : ""} compared with the baseline` };
  if (knownBrokenSha && knownBrokenSha === sha) return { code: 0, note: `SKIPPED: emulayout ${sha.slice(0, 12)} also rejects the unchanged baseline and EMULAYOUT_KNOWN_BROKEN_SHA names it. Remove the override once emulayout is fixed.` };
  return { code: 3, note: "emulayout's master rejects the UNCHANGED baseline corpus too: broken independently of this change. Set EMULAYOUT_KNOWN_BROKEN_SHA to this emulayout commit to let the job pass until they fix it." };
}

export function formatReport(title, s, { verbose = false } = {}) {
  const lines = [`${title}: ${s.total} records, accepted ${s.accepted}, accepted with drops ${s.dropped.length}, rejected ${s.rejected.length}`];
  for (const r of s.dropped) lines.push(`  DROPS    ${r.name}: ${r.dropped.map((d) => `${d.path.replace(/^layout\./, "")} (${d.reason})`).join("; ")}`);
  for (const r of s.rejected) lines.push(`  REJECTED ${r.name}: ${r.error}`);
  lines.push(`  catalog-level parse: ${s.catalog.ok ? `ok (${s.catalog.layouts} read, ${s.catalog.skipped} skipped)` : `FAILED: ${s.catalog.error}`}`);
  return lines.join("\n");
}

export function perRecordTable(result) {
  return result.records.map((r) => `${r.status.padEnd(9)} ${r.name}`).join("\n");
}

// ---- CLI ---------------------------------------------------------------------------------------------------------

function parseArgs(argv) {
  const o = { live: false, ref: "master", runtime: undefined, dir: undefined, baselineRef: undefined, baselineDir: undefined, table: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => argv[++i] ?? (() => { throw new Error(`${a} needs a value`); })();
    if (a === "--live") o.live = true;
    else if (a === "--table") o.table = true;
    else if (a === "--ref") o.ref = val();
    else if (a === "--runtime") o.runtime = val();
    else if (a === "--emulayout-dir") o.dir = path.resolve(val());
    else if (a === "--baseline-ref") o.baselineRef = val();
    else if (a === "--baseline-dir") o.baselineDir = path.resolve(val());
    else throw new Error(`unknown argument ${a}`);
  }
  return o;
}

/** The unchanged baseline: the corpus files and fixtures as they were at `ref`, read with `git archive`. */
function loadBaselineRecords(ref, scratch, env) {
  const dest = path.join(scratch, "baseline");
  fs.mkdirSync(dest, { recursive: true });
  const dirs = CORPUS_DIRS.map((d) => d.dir);
  const ar = run("git", ["-C", REPO, "archive", "--format=tar", ref, "--", ...dirs], { env, encoding: "buffer" });
  if (ar.status !== 0) {
    // A ref that predates the corpus (the PR that adds it) has no baseline for it; use the fixtures it does have.
    const fx = run("git", ["-C", REPO, "archive", "--format=tar", ref, "--", CORPUS_DIRS[1].dir], { env, encoding: "buffer" });
    if (fx.status !== 0) throw new Error(`git archive ${ref} failed: ${String(ar.stderr).trim()}`);
    return untar(fx.stdout, dest, env);
  }
  return untar(ar.stdout, dest, env);
}
function untar(buf, dest, env) {
  const t = spawnSync("tar", ["-x", "-C", dest], { input: buf, env });
  if (t.status !== 0) throw new Error(`tar failed: ${String(t.stderr)}`);
  return loadRecords(dest);
}

export async function main(argv) {
  const opts = parseArgs(argv);
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "emulayout-compat-"));
  const home = path.join(scratch, "home");
  fs.mkdirSync(home);
  const env = scrubbedEnv(home);
  try {
    const runtime = resolveRuntime(opts.runtime);
    let emulayoutDir = opts.dir;
    let sha;
    if (emulayoutDir) {
      const r = run("git", ["-C", emulayoutDir, "rev-parse", "HEAD"], { env });
      sha = r.status === 0 ? r.stdout.trim() : "local-directory";
    } else {
      emulayoutDir = path.join(scratch, "emulayout");
      sha = fetchEmulayout(emulayoutDir, opts.ref, env);
    }
    const rv = run(runtime, ["--version"], {});
    console.log(`emulayout ${sha} (${opts.dir ? opts.dir : `${EMULAYOUT_URL}@${opts.ref}`}); runtime ${runtime} ${String(rv.stdout).trim()}`);

    const records = loadRecords(REPO);
    if (records.length === 0) throw new Error("the corpus is empty");
    const head = summarize(runReader({ runtime, emulayoutDir, input: await buildInput(records), scratch, env }));
    console.log(formatReport("corpus", head));
    if (opts.table) console.log(perRecordTable(head.result));

    let base = null;
    if (!head.ok && (opts.baselineRef || opts.baselineDir)) {
      const baseRecords = opts.baselineDir ? loadRecords(opts.baselineDir) : loadBaselineRecords(opts.baselineRef, scratch, env);
      base = summarize(runReader({ runtime, emulayoutDir, input: await buildInput(baseRecords), scratch, env }));
      console.log(formatReport(`baseline (${opts.baselineRef ?? opts.baselineDir})`, base));
    }
    const v = verdict(head, base, { sha, knownBrokenSha: process.env.EMULAYOUT_KNOWN_BROKEN_SHA });
    if (v.note) console.log(v.note);

    if (opts.live) {
      const live = summarize(runReader({ runtime, emulayoutDir, input: await fetchLiveInput(), scratch, env }));
      console.log(formatReport("live catalog (report only; never fails the run)", live));
    }
    console.log(v.code === 0 ? "emulayout compatibility: OK" : `emulayout compatibility: FAILED (exit ${v.code})`);
    return v.code;
  } catch (e) {
    console.error(`emulayout compatibility check could not run: ${e instanceof Error ? e.message : e}`);
    return 2;
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
