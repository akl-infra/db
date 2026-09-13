// [SITE-7] the built application bundle has no reference to akl-db's
// hostname except via DB_BASE_URL at the edge (server-side only). Runs the
// real build, then greps dist/ -- excluding the docs-content chunk (vite
// .config.ts's manualChunks split), whose whole JOB is to render db/docs/
// adoption.md's real API guide verbatim, hostname included (S8). This
// proves the actual application code -- session/proxy/api/pages -- never
// hardcodes the DB origin anywhere outside that one intentional exception.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const SITE_ROOT = path.resolve(import.meta.dirname, "..", "..");
const DIST_DIR = path.join(SITE_ROOT, "dist");
const HOSTNAME_NEEDLE = "akl-db.akl-58a"; // the real production hostname's distinctive prefix

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

describe("[SITE-7] no hardcoded akl-db hostname in the client bundle", () => {
  it("builds, then finds the literal only in the isolated docs-content chunk", () => {
    execFileSync("npx", ["vite", "build"], { cwd: SITE_ROOT, stdio: "pipe" });
    expect(fs.existsSync(DIST_DIR)).toBe(true);

    const files = walk(DIST_DIR);
    expect(files.length).toBeGreaterThan(0);

    const offenders = files.filter((f) => {
      if (!/\.(js|css|html)$/.test(f)) return false;
      const content = fs.readFileSync(f, "utf8");
      return content.includes(HOSTNAME_NEEDLE);
    });

    const unexpected = offenders.filter((f) => !path.basename(f).startsWith("docs-content"));
    expect(unexpected, `hostname literal leaked into: ${unexpected.join(", ")}`).toEqual([]);
    // And the exception really is there (the test isn't vacuously passing
    // because the docs chunk failed to build at all).
    expect(offenders.some((f) => path.basename(f).startsWith("docs-content"))).toBe(true);
  });
});
