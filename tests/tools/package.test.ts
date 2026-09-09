// [LDB-G7] @akl/layout-formats (db/formats/, 12 §3 X5 item 1) packs every
// format's built entry and schema.json, no test or fixture file, imports
// cleanly from a clean install, and its `exports` map names exactly the
// registered format ids -- a fourth format landing in the registry
// (db/formats/registry.ts) without its own package.json "exports" entry
// fails here, not silently at a consumer's `import` months later.
import { execFileSync, execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { list } from "../../formats/registry.ts";

const DB_ROOT = path.resolve(import.meta.dirname, "..", "..");
const FORMATS_ROOT = path.join(DB_ROOT, "formats");

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

  it("[LDB-G7] npm pack lists dist/index.js, every dist/<format>/1/index.js and every schema.json, no test or fixture file", () => {
    const paths = npmPackDryRun().files.map((f) => f.path);

    expect(paths).toContain("dist/index.js");
    expect(paths).toContain("dist/cmini/1/index.js");
    expect(paths).toContain("dist/akl/1/index.js");
    expect(paths).toContain("dist/mana2/1/index.js");
    expect(paths).toContain("cmini/1/schema.json");
    expect(paths).toContain("akl/1/schema.json");
    expect(paths).toContain("mana2/1/schema.json");

    const suspect = paths.filter((p) => /\.test\.|\/fixtures\//.test(p));
    expect(suspect).toEqual([]);
  });

  it("[LDB-G7] package.json's exports map names exactly the registered format ids", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(FORMATS_ROOT, "package.json"), "utf8")) as {
      exports: Record<string, unknown>;
    };
    const registeredIds = list().map((f) => f.id); // e.g. "cmini/1", "akl/1", "mana2/1"
    for (const id of registeredIds) {
      expect(pkg.exports, `package.json "exports" has no "./${id}" entry for registered format '${id}'`).toHaveProperty(
        `./${id}`,
      );
      expect(pkg.exports, `no "./${id}/schema.json" entry`).toHaveProperty(`./${id}/schema.json`);
    }
    // The reverse direction too: no subpath export for a format that isn't
    // (or is no longer) registered.
    const exportedFormatIds = Object.keys(pkg.exports).filter((k) => k !== "." && !k.endsWith("/schema.json"));
    expect(new Set(exportedFormatIds)).toEqual(new Set(registeredIds.map((id) => `./${id}`)));
  });

  it("[LDB-G7] a clean install of the packed tarball imports and runs @akl/layout-formats/akl/1", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ldb-layout-formats-pack-"));
    try {
      const tarballName = execSync("npm pack --json", { cwd: FORMATS_ROOT, encoding: "utf8" });
      const packed = (JSON.parse(tarballName) as { filename: string }[])[0];
      if (!packed) throw new Error("npm pack --json produced no tarball");
      const tarballPath = path.join(FORMATS_ROOT, packed.filename);
      try {
        fs.writeFileSync(path.join(tmpDir, "package.json"), JSON.stringify({ name: "ldb-g7-probe", private: true, type: "module" }));
        execFileSync("npm", ["install", "--no-audit", "--no-fund", tarballPath], { cwd: tmpDir, stdio: "pipe" });

        const probeScript = `import("@akl/layout-formats/akl/1").then((m) => { const r = m.validate({ keys: {} }); if (!r.ok) { console.error(JSON.stringify(r)); process.exit(1); } process.exit(0); }).catch((e) => { console.error(e); process.exit(1); });`;
        execFileSync("node", ["-e", probeScript], { cwd: tmpDir, stdio: "pipe" });
      } finally {
        fs.rmSync(tarballPath, { force: true });
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  }, 120_000);
});
