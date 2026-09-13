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
// The real production hostnames: api.akldb.org (saltorbit 2026-09-13, the
// documented base URL) and the workers.dev origin it kept answering on. A
// chunk naming EITHER outside the docs-content chunk is a leak.
const HOSTNAME_NEEDLES = ["api.akldb.org", "akl-db.akl-58a"];

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
      return HOSTNAME_NEEDLES.some((needle) => content.includes(needle));
    });

    const unexpected = offenders.filter((f) => !path.basename(f).startsWith("docs-content"));
    expect(unexpected, `hostname literal leaked into: ${unexpected.join(", ")}`).toEqual([]);
    // And the exception really is there (the test isn't vacuously passing
    // because the docs chunk failed to build at all).
    expect(offenders.some((f) => path.basename(f).startsWith("docs-content"))).toBe(true);
  });
});

// [SITE-12] saltorbit, 2026-09-13: akldb.org does not link out to akl.gg and
// does not render layouts -- it shows the record and the stored format as
// plain text. The bundle must carry no akl.gg URL and no board component.
describe("[SITE-12] no akl.gg link-out in the client bundle", () => {
  it("builds, then finds no akl.gg literal in any bundle chunk", () => {
    execFileSync("npx", ["vite", "build"], { cwd: SITE_ROOT, stdio: "pipe" });
    // The docs chunk is the adoption guide's own prose (it names akl.gg as
    // one client of the DB) -- isolated exactly as SITE-7 isolates it.
    const offenders = walk(DIST_DIR).filter(
      (f) => /\.(js|css|html)$/.test(f) && !path.basename(f).startsWith("docs-content") && fs.readFileSync(f, "utf8").includes("akl.gg"),
    );
    expect(offenders.map((f) => path.basename(f))).toEqual([]);
  });
});

// [SITE-37] LDB-A14 (saltorbit, 2026-09-13, "rogue trusted client" hardening):
// "I don't want to give destructive clients a handbook" -- the destructive-
// write budget/threshold that trips an automatic suspension is never
// displayed or described anywhere on akldb.org, application code or copy.
// Same isolated-exception shape as SITE-7/SITE-12: `db/docs/adoption.md`'s
// own public rate-limit prose ("1000 writes / 10 minutes per actor... an
// additional 5000 / 10 minutes per client id... one person's own budget")
// is a PRE-EXISTING, unrelated, publicly-documented general rate limit --
// not the destructive-write abuse-containment threshold LDB-A14 guards --
// and lives only in the isolated docs-content chunk, exactly like the
// hostname/akl.gg literals above.
describe("[SITE-37] no budget/threshold string (LDB-A14) outside the docs-content chunk", () => {
  it("builds, then finds no /budget|threshold/i match in any application bundle chunk", () => {
    execFileSync("npx", ["vite", "build"], { cwd: SITE_ROOT, stdio: "pipe" });
    const NEEDLE = /budget|threshold/i;
    const offenders = walk(DIST_DIR).filter(
      (f) => /\.(js|css|html)$/.test(f) && !path.basename(f).startsWith("docs-content") && NEEDLE.test(fs.readFileSync(f, "utf8")),
    );
    expect(offenders.map((f) => path.basename(f))).toEqual([]);
    // And the one known, unrelated exception really is still there (this
    // test isn't vacuously passing because the docs chunk failed to build).
    const docsChunk = walk(DIST_DIR).find((f) => path.basename(f).startsWith("docs-content") && /\.(js|css|html)$/.test(f));
    expect(docsChunk).toBeDefined();
    expect(NEEDLE.test(fs.readFileSync(docsChunk!, "utf8"))).toBe(true);
  });
});
