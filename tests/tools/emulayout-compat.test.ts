// [LDB-EM1] The deploy is gated on emulayout's reader accepting the shape corpus (INVARIANTS.md). This file holds
// the corpus-vs-akldb-validator assertion (the corpus can never drift from what akldb itself accepts), the
// classification rules of scripts/emulayout-compat.mjs, and an end-to-end run of the script against a FAKE
// emulayout checkout (accepting / dropping / rejecting), so no test here touches the network or emulayout's code.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as spark1 from "../../formats/spark/1/index.ts";
// @ts-expect-error -- plain .mjs script, untyped
import * as compat from "../../scripts/emulayout-compat.mjs";

const REPO = path.resolve(import.meta.dirname, "..", "..");
const records: { file: string; name: string; payload: any }[] = compat.loadRecords(REPO);

describe("[LDB-EM1] the shape corpus is what akldb accepts", () => {
  it("[LDB-EM1] every corpus record and every frozen spark/1 fixture passes akldb's own validator", () => {
    expect(records.length).toBeGreaterThan(50);
    for (const r of records) {
      const result = spark1.validate(r.payload);
      expect(result.ok, `${r.file}: ${result.ok ? "" : JSON.stringify(result.error)}`).toBe(true);
    }
  });

  it("[LDB-EM1] record names are unique, case-insensitively (emulayout refuses a repeated name)", () => {
    const names = records.map((r) => r.name.toLowerCase());
    expect(new Set(names).size).toBe(names.length);
  });

  it("[LDB-EM1] the corpus covers every spark/1 feature (add a record when a new shape lands)", () => {
    const has = (f: (p: any) => boolean) => records.some((r) => f(r.payload));
    const magicKeys = (p: any): any[] => p.magic?.magic_keys ?? [];
    const checks: Record<string, boolean> = {
      "default repeat": has((p) => magicKeys(p).some((k) => k.default?.kind === "repeat")),
      "default char": has((p) => magicKeys(p).some((k) => k.default?.kind === "char")),
      "default skip_repeat": has((p) => magicKeys(p).some((k) => k.default?.kind === "skip_repeat")),
      "rule after string": has((p) => magicKeys(p).some((k) => k.rules?.some((r: any) => typeof r.after === "string"))),
      "rule after array with null": has((p) => magicKeys(p).some((k) => k.rules?.some((r: any) => Array.isArray(r.after) && r.after.includes(null)))),
      "rule after array without null": has((p) => magicKeys(p).some((k) => k.rules?.some((r: any) => Array.isArray(r.after) && !r.after.includes(null)))),
      "magic except": has((p) => magicKeys(p).some((k) => k.except)),
      "chiral": has((p) => p.magic?.chiral_keys?.length),
      "chiral skip": has((p) => p.magic?.chiral_keys?.some((k: any) => k.skip === true)),
      "chiral null side": has((p) => p.magic?.chiral_keys?.some((k: any) => k.opposite === null)),
      "adaptive swap": has((p) => p.magic?.adaptive_swaps?.length),
      "raw rules": has((p) => p.magic?.rules?.length),
      "alts 2-key": has((p) => p.alts?.some((a: any) => a.ngram.length === 2)),
      "alts 3-key wildcard": has((p) => p.alts?.some((a: any) => a.ngram.length === 3 && a.ngram[1] === null)),
      "alts 1-key": has((p) => p.alts?.some((a: any) => a.ngram.length === 1)),
      "combos": has((p) => p.combos?.length),
      "number row (-1)": has((p) => p.keys.some((k: any) => k.row === -1)),
      "thumb row": has((p) => p.keys.some((k: any) => k.finger === "LT" || k.finger === "RT")),
      "thumb finger on a letter row (1.37)": has((p) => p.keys.some((k: any) => (k.finger === "LT" || k.finger === "RT") && k.row <= 2)),
      "row 4": has((p) => p.keys.some((k: any) => k.row === 4)),
      "free key (no char)": has((p) => p.keys.some((k: any) => k.char === undefined)),
      "duplicate char": has((p) => { const c = p.keys.map((k: any) => k.char).filter(Boolean); return new Set(c).size < c.length; }),
      "non-BMP char": has((p) => p.keys.some((k: any) => k.char && [...k.char][0]!.codePointAt(0)! > 0xffff)),
      "wide board (col >= 10)": has((p) => p.keys.some((k: any) => k.col >= 10)),
      "unicode record name": records.some((r) => /[^\x00-\x7f]/.test(r.name)),
    };
    const missing = Object.entries(checks).filter(([, ok]) => !ok).map(([n]) => n);
    expect(missing).toEqual([]);
  });
});

describe("[LDB-EM1] classification", () => {
  const rec = (name: string, status: string, extra: object = {}) => ({ name, status, dropped: [], error: null, ...extra });
  const result = (records: any[], catalog: any = { ok: true, layouts: records.length, skipped: 0 }) => ({ records, catalog });

  it("[LDB-EM1] summarize counts accepted / dropped / rejected and fails on a rejection or a catalog failure", () => {
    const s = compat.summarize(result([rec("a", "accepted"), rec("b", "dropped", { dropped: [{ path: "x", reason: "r" }] }), rec("c", "rejected", { error: "bad" })]));
    expect([s.total, s.accepted, s.dropped.length, s.rejected.length, s.ok]).toEqual([3, 1, 1, 1, false]);
    expect(compat.summarize(result([rec("a", "accepted"), rec("b", "dropped")])).ok).toBe(true);
    expect(compat.summarize(result([rec("a", "accepted")], { ok: false, error: "count" })).ok).toBe(false);
  });

  it("[LDB-EM1] verdict: ok is 0; a new rejection is 1; the same rejections on the baseline are 3 (emulayout broken independently), or 0 only with the known-broken override naming that exact commit", () => {
    const good = compat.summarize(result([rec("a", "accepted")]));
    const bad = compat.summarize(result([rec("a", "rejected", { error: "e" })]));
    const worse = compat.summarize(result([rec("a", "rejected", { error: "e" }), rec("b", "rejected", { error: "e" })]));
    expect(compat.verdict(good, null).code).toBe(0);
    expect(compat.verdict(bad, null).code).toBe(1);
    expect(compat.verdict(bad, good).code).toBe(1);
    expect(compat.verdict(worse, bad).code).toBe(1);
    const same = compat.verdict(bad, bad, { sha: "abc" });
    expect(same.code).toBe(3);
    expect(same.note).toMatch(/independently/);
    expect(compat.verdict(bad, bad, { sha: "abc", knownBrokenSha: "other" }).code).toBe(3);
    const skipped = compat.verdict(bad, bad, { sha: "abc", knownBrokenSha: "abc" });
    expect(skipped.code).toBe(0);
    expect(skipped.note).toMatch(/SKIPPED/);
    // a catalog-level failure that the baseline does not have is new
    const catBad = compat.summarize(result([rec("a", "accepted")], { ok: false, error: "count" }));
    expect(compat.verdict(catBad, good).code).toBe(1);
  });

  it("[LDB-EM1] the report names each rejection with the record and emulayout's own message", () => {
    const text = compat.formatReport("corpus", compat.summarize(result([rec("a", "rejected", { error: "emulayout said no" }), rec("b", "dropped", { dropped: [{ path: "layout.magic.x", reason: "skip" }] })])));
    expect(text).toContain("REJECTED a: emulayout said no");
    expect(text).toContain("DROPS    b: magic.x (skip)");
  });

  it("[LDB-EM1] the environment given to emulayout's code carries no secrets", () => {
    vi.stubEnv("CLOUDFLARE_API_TOKEN", "s3cret");
    vi.stubEnv("GH_TOKEN", "s3cret");
    const env = compat.scrubbedEnv("/tmp/h");
    expect(Object.keys(env).sort()).toEqual(["GIT_CONFIG_NOSYSTEM", "GIT_TERMINAL_PROMPT", "HOME", "LANG", "PATH", "TMPDIR"]);
    expect(JSON.stringify(env)).not.toContain("s3cret");
  });
});

// A fake emulayout checkout: the same two entry points, in plain JS. Rejects a record with a number row (row -1)
// and reports what it can see of its environment in the message; drops a magic rule whose `after` is an array.
const FAKE_CACHE = `
export const AKLDB_META_URL = "u:meta", AKLDB_LAYOUTS_URL = "u:spark", AKLDB_MANA_LAYOUTS_URL = "u:mana", AKLDB_AUTHORS_URL = "u:authors";
import { validateSparkLayout } from "../src/lib/sparkSchema.ts";
export function parseAkldbLayouts(json, manaJson) {
  let skipped = 0; const layouts = [];
  for (const item of json.items) {
    try { validateSparkLayout(item.payload, "p"); layouts.push(item); }
    catch (e) { skipped++; console.warn("  ⚠ skipping AKLDB layout " + item.name + ": " + e.message); }
  }
  return { layouts, skipped };
}
export async function ensureAkldbCatalog({ fetchImpl }) {
  const get = async (u) => JSON.parse(await (await fetchImpl(u)).text());
  const meta = await get(AKLDB_META_URL); const layouts = await get(AKLDB_LAYOUTS_URL);
  const parsed = parseAkldbLayouts(layouts, await get(AKLDB_MANA_LAYOUTS_URL));
  if (parsed.layouts.length + parsed.skipped !== meta.layout_count) throw new Error("count mismatch");
  return { json: { layouts: parsed } };
}`;
const FAKE_SCHEMA = (mode: "accept" | "reject") => `
export function validateSparkLayout(p) {
  const dropped = [];
  if (${mode === "reject" ? "true" : "false"} && p.keys.some((k) => k.row === -1)) throw new Error("fake: number row refused; env=" + (process.env.CLOUDFLARE_API_TOKEN ?? "unset"));
  for (const m of p.magic?.magic_keys ?? []) for (const r of m.rules ?? []) if (Array.isArray(r.after)) dropped.push({ path: "p.magic", reason: "array after" });
  return { layout: p, dropped };
}`;

const tmpDirs: string[] = [];
function fakeEmulayout(mode: "accept" | "reject") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fake-emulayout-"));
  tmpDirs.push(dir);
  fs.mkdirSync(path.join(dir, "bin"));
  fs.mkdirSync(path.join(dir, "src/lib"), { recursive: true });
  fs.writeFileSync(path.join(dir, "bin/akldb-cache.js"), FAKE_CACHE);
  fs.writeFileSync(path.join(dir, "src/lib/sparkSchema.ts"), FAKE_SCHEMA(mode));
  return dir;
}
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

async function runScript(dir: string, extra: string[] = []) {
  const out: string[] = [];
  vi.spyOn(console, "log").mockImplementation((...a) => void out.push(a.join(" ")));
  vi.spyOn(console, "error").mockImplementation((...a) => void out.push(a.join(" ")));
  const code: number = await compat.main(["--emulayout-dir", dir, "--runtime", process.execPath, ...extra]);
  return { code, text: out.join("\n") };
}

describe("[LDB-EM1] the script against a fake emulayout", () => {
  it("[LDB-EM1] an accepting reader exits 0; drops are reported, never failures", async () => {
    const { code, text } = await runScript(fakeEmulayout("accept"));
    expect(text).toMatch(/rejected 0/);
    expect(text).toMatch(/DROPS\s+corpus\/16-skip-magic-rule-after-null/);
    expect(text).toContain("catalog-level parse: ok");
    expect(code).toBe(0);
  });

  it("[LDB-EM1] a rejecting reader exits 1 and names the record and its message, with no secret from our environment in the reader's", async () => {
    vi.stubEnv("CLOUDFLARE_API_TOKEN", "s3cret");
    const { code, text } = await runScript(fakeEmulayout("reject"));
    expect(code).toBe(1);
    expect(text).toMatch(/REJECTED corpus\/05-number-row-minus-one: fake: number row refused; env=unset/);
    expect(text).not.toContain("s3cret");
    expect(text).toContain("FAILED (exit 1)");
  });

  it("[LDB-EM1] the same rejections on the unchanged baseline exit 3, and the known-broken override (exact commit) turns that into a loud skip", async () => {
    const dir = fakeEmulayout("reject");
    // an unchanged baseline: a copy of the current corpus as its own repo root
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "emulayout-baseline-"));
    tmpDirs.push(baseDir);
    for (const { dir: d } of compat.CORPUS_DIRS) fs.cpSync(path.join(REPO, d), path.join(baseDir, d), { recursive: true });
    const args = ["--baseline-dir", baseDir];
    const base = await runScript(dir, args);
    expect(base.text).toMatch(/baseline \(/);
    expect(base.code).toBe(3);
    expect(base.text).toMatch(/broken independently/);
    // the fake dir is not a git checkout, so its "sha" is the fixed label below
    vi.stubEnv("EMULAYOUT_KNOWN_BROKEN_SHA", "local-directory");
    const skipped = await runScript(dir, args);
    expect(skipped.code).toBe(0);
    expect(skipped.text).toMatch(/SKIPPED/);
    vi.stubEnv("EMULAYOUT_KNOWN_BROKEN_SHA", "some-other-commit");
    expect((await runScript(dir, args)).code).toBe(3);
    // a record the baseline does not have, rejected now, is new: exit 1
    fs.rmSync(path.join(baseDir, "tests/emulayout/corpus/05-number-row-minus-one.json"));
    vi.stubEnv("EMULAYOUT_KNOWN_BROKEN_SHA", "");
    expect((await runScript(dir, args)).code).toBe(1);
  });

  it("[LDB-EM1] --baseline-ref reads the corpus from git (a ref without the corpus falls back to the frozen fixtures)", async () => {
    const { text } = await runScript(fakeEmulayout("reject"), ["--baseline-ref", "HEAD"]);
    expect(text).toMatch(/baseline \(HEAD\)/);
  });

  it("[LDB-EM1] a missing emulayout checkout is an infrastructure error (2), never a pass", async () => {
    const { code, text } = await runScript(path.join(os.tmpdir(), "does-not-exist-emulayout"));
    expect(code).toBe(2);
    expect(text).toMatch(/could not run/);
  });
});
