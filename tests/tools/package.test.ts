// [LDB-G7] @akl/layout-formats (db/formats/, 12 §3 X5 item 1) packs every
// format's built entry and schema.json, no test or fixture file, imports
// cleanly from a clean install, and its `exports` map names exactly the
// registered format ids and the cmini adapter's own subpath
// (`./adapters/cmini`) -- 21-formats.md D5/D12 deleted every alias
// (`./akl/1`, `./cmini/1`) -- a third registered format, a new alias, or
// a new adapter landing without its own package.json "exports" entry
// fails here, not silently at a consumer's `import` months later.
import { execFileSync, execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { list } from "../../formats/registry.ts";

const DB_ROOT = path.resolve(import.meta.dirname, "..", "..");
const FORMATS_ROOT = path.join(DB_ROOT, "formats");
// The one unregistered adapter this package still ships a subpath for
// (20-spark.md S1). Not registry-driven (there's no generic "adapters"
// discovery mechanism yet, unlike registered formats/aliases) -- a second
// adapter would need this list extended by hand, same as it needs its own
// package.json "exports" entry by hand.
const ADAPTER_SUBPATHS = ["adapters/cmini"];

interface PackedFile {
  path: string;
  size: number;
}
interface PackResult {
  files: PackedFile[];
}

function npmPackDryRun(): PackResult {
  const out = execSync("npm pack --dry-run --json", { cwd: FORMATS_ROOT, encoding: "utf8" });
  const parsed = JSON.parse(out) as PackResult[];
  const result = parsed[0];
  if (!result) throw new Error("npm pack --dry-run --json returned no entries");
  return result;
}

describe("[LDB-G7] @akl/layout-formats packages db/formats", () => {
  beforeAll(() => {
    // Idempotent -- tsup's `clean: true` wipes and rewrites dist/ every
    // run, so a package.test.ts run right after `npm run build:formats`
    // (or right after a fresh checkout with none) both end up in the same
    // state.
    execSync("npm run build", { cwd: FORMATS_ROOT, stdio: "pipe" });
  }, 60_000);

  it("[LDB-G7] npm pack lists dist/index.js, every dist/<format>/1/index.js, dist/adapters/cmini/index.js, and every schema.json, no test or fixture file", () => {
    const paths = npmPackDryRun().files.map((f) => f.path);

    expect(paths).toContain("dist/index.js");
    expect(paths).toContain("dist/spark/1/index.js");
    expect(paths).toContain("dist/mana2/1/index.js");
    expect(paths).toContain("dist/adapters/cmini/index.js");
    expect(paths).toContain("spark/1/schema.json");
    expect(paths).toContain("mana2/1/schema.json");
    expect(paths).toContain("adapters/cmini/schema.json");

    const suspect = paths.filter((p) => /\.test\.|\/fixtures\//.test(p));
    expect(suspect).toEqual([]);
  });

  it("[LDB-G7] package.json's exports map names exactly the registered format ids ∪ the adapter subpaths", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(FORMATS_ROOT, "package.json"), "utf8")) as {
      exports: Record<string, unknown>;
    };
    const registeredIds = list().map((f) => f.id); // "spark/1", "mana2/1"

    for (const id of [...registeredIds, ...ADAPTER_SUBPATHS]) {
      expect(pkg.exports, `package.json "exports" has no "./${id}" entry`).toHaveProperty(`./${id}`);
      expect(pkg.exports, `no "./${id}/schema.json" entry`).toHaveProperty(`./${id}/schema.json`);
    }
    // The reverse direction too: no subpath export for anything that isn't
    // a registered format or the one known adapter -- 21-formats.md D5/D12
    // deleted every alias (`./akl/1`, `./cmini/1`).
    const exportedFormatIds = Object.keys(pkg.exports).filter((k) => k !== "." && !k.endsWith("/schema.json"));
    expect(new Set(exportedFormatIds)).toEqual(new Set([...registeredIds, ...ADAPTER_SUBPATHS].map((id) => `./${id}`)));
  });

  it("[LDB-G7] a clean install of the packed tarball imports and runs @akl/layout-formats/spark/1", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ldb-layout-formats-pack-"));
    try {
      const tarballName = execSync("npm pack --json", { cwd: FORMATS_ROOT, encoding: "utf8" });
      const packed = (JSON.parse(tarballName) as { filename: string }[])[0];
      if (!packed) throw new Error("npm pack --json produced no tarball");
      const tarballPath = path.join(FORMATS_ROOT, packed.filename);
      try {
        fs.writeFileSync(path.join(tmpDir, "package.json"), JSON.stringify({ name: "ldb-g7-probe", private: true, type: "module" }));
        execFileSync("npm", ["install", "--no-audit", "--no-fund", tarballPath], { cwd: tmpDir, stdio: "pipe" });

        const probeScript = `import("@akl/layout-formats/spark/1").then((m) => { const r = m.validate({ keys: [] }); if (!r.ok) { console.error(JSON.stringify(r)); process.exit(1); } process.exit(0); }).catch((e) => { console.error(e); process.exit(1); });`;
        execFileSync("node", ["-e", probeScript], { cwd: tmpDir, stdio: "pipe" });
      } finally {
        fs.rmSync(tarballPath, { force: true });
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }, 120_000);
});
