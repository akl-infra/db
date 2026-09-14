// [SITE-16] the production bundle contains no dev mock switch. `src/lib/
// devMock.ts` (the `?mock=admin`/`?mock=owner` QA switch, W1b deliverable
// 5) is imported only behind a static `if (import.meta.env.DEV)` in
// `src/index.tsx` -- Vite inlines that to `false` for a production build,
// so Rollup drops the dynamic import (and the whole module) out of
// `dist/`. Builds once, greps every emitted chunk for the module's own
// distinctive literals; same build-then-grep shape as
// tests/tools/no-hostname-leak.test.ts.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const SITE_ROOT = path.resolve(import.meta.dirname, "..", "..");

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

describe("[SITE-16] no dev mock switch in the production bundle", () => {
  it("builds, then finds none of devMock.ts's own literals anywhere in dist/", () => {
    // A dedicated, OS-tmp `--outDir` (never the shared `dist/`): vitest
    // runs test FILES in parallel by default, and tests/tools/
    // no-hostname-leak.test.ts also runs `vite build` against the same
    // `dist/` with `emptyOutDir: true` -- two concurrent builds racing on
    // one output directory is a real, reproducible flake (confirmed while
    // writing this test: this test's own clean build was clobbered mid-air
    // by the other file's build before the grep below could read it).
    // Building to an isolated directory sidesteps the race entirely.
    const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "akldb-site-devmock-"));
    try {
      // Force real production mode regardless of vitest's own process
      // having set `NODE_ENV=test` -- `vite build` inherits `process.env`
      // from this test runner by default, and (confirmed empirically) a
      // `NODE_ENV=test` in the environment flips `import.meta.env.DEV` to
      // `true` even under the `build` command, which would defeat exactly
      // the dead-code elimination this test exists to prove. A real
      // CI/deploy `npm run build` is unaffected -- it's a separate
      // top-level command, not a child of a vitest process, so it never
      // inherits vitest's own `NODE_ENV`; this override just makes the
      // test spawn the same real conditions on its own.
      execFileSync("npx", ["vite", "build", "--outDir", outDir, "--emptyOutDir"], {
        cwd: SITE_ROOT,
        stdio: "pipe",
        env: { ...process.env, NODE_ENV: "production" },
      });

      const files = walk(outDir).filter((f) => /\.(js|css|html)$/.test(f));
      expect(files.length).toBeGreaterThan(0);

      const needles = ["mock=admin", "mock=owner", "Dev admin (mock)", "Dev owner (mock)", "setMeForDevMock", "applyDevMock"];
      for (const needle of needles) {
        const offenders = files.filter((f) => fs.readFileSync(f, "utf8").includes(needle));
        expect(offenders, `found dev-mock literal "${needle}" in: ${offenders.join(", ")}`).toEqual([]);
      }
    } finally {
      fs.rmSync(outDir, { recursive: true, force: true });
    }
  }, 60_000); // a real build: seconds, more with other files' builds running alongside
});

// Regression: `session.ts`'s `void refreshMe()` fires its `/auth/me` fetch
// at import time, BEFORE `index.tsx`'s `if (import.meta.env.DEV)
// applyDevMock()` guard even runs -- a real Chrome QA bug caught while
// writing this slice: the mock briefly "took" (`setMeForDevMock` runs
// synchronously right after) and then a tick later the already-in-flight
// `refreshMe()` resolved with the real (signed-out) `/auth/me` answer and
// silently overwrote it. `devMockActive` in session.ts is the fix -- this
// pins the exact race with a manually-resolved fetch promise.
describe("dev mock wins a `refreshMe()` already in flight", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("setMeForDevMock is not clobbered by a slower, already-started refreshMe()", async () => {
    vi.resetModules();
    let resolveMeFetch: (r: Response) => void;
    const pendingMeFetch = new Promise<Response>((resolve) => {
      resolveMeFetch = resolve;
    });
    vi.stubGlobal("fetch", vi.fn(() => pendingMeFetch));

    // Importing session.ts fires `void refreshMe()`, which awaits the
    // still-pending fetch above -- exactly the "already in flight" state a
    // real page load leaves it in by the time `applyDevMock()` runs.
    const session = await import("../../src/session.ts");

    session.setMeForDevMock({ user: { user_id: "1", name: "Dev admin (mock)", via: "discord", admin: true }, signin: true });
    expect(session.meResource()?.user?.admin).toBe(true);

    // The slow, real `/auth/me` now resolves -- signed out, as it would
    // against an unconfigured local Discord app.
    resolveMeFetch!(new Response(JSON.stringify({ user: null, signin: false }), { status: 200, headers: { "Content-Type": "application/json" } }));
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(session.meResource()?.user?.admin).toBe(true); // still the mock, not clobbered
  });
});
