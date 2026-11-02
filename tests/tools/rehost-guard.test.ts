// [LDB-G16] docs/decisions/21-formats.md D8, amended 2026-09-14: akldb is
// no longer disposable, so `scripts/rehost.mjs`'s two raw destructive paths
// (this file; `POST /v1/admin/magic-seed`'s guard is LDB-P26,
// tests/api/admin.test.ts) get extra guards for their production target. A
// `--remote` rehost restores directly into PRODUCTION `akl-db` (`--env
// preview` is gone with akl-db-preview, 2026-11-02, and refused) -- this drives the pure decision functions the script exports
// directly (mirrors tests/tools/reseed-magic.test.ts's own pattern of
// importing a plain script's exports), so the guard logic is proven without
// running wrangler or hitting a real network.
import { describe, expect, it } from "vitest";
// rehost.mjs is a plain script (no .d.ts) -- typed locally, the same way
// tests/tools/reseed-magic.test.ts imports scripts/reseed-magic.mjs.
// @ts-expect-error -- see above
import * as rehost from "../../scripts/rehost.mjs";

const isProductionTarget = rehost.isProductionTarget as (remote: boolean) => boolean;
const checkWipeFlag = rehost.checkWipeFlag as (remote: boolean, wipe: string | null) => string | null;
const parseArgs = rehost.parseArgs as (argv: string[]) => Record<string, unknown>;
const checkSeqLoss = rehost.checkSeqLoss as (
  remote: boolean,
  liveSeq: number,
  dumpSeq: number,
  acceptLoss: boolean,
) => string | null;
const metaUrlFor = rehost.metaUrlFor as (dbBaseUrl: string | undefined) => string;

describe("[LDB-G16] isProductionTarget: every --remote run", () => {
  it("[LDB-G16] true for --remote, false for --local", () => {
    expect(isProductionTarget(true)).toBe(true);
    expect(isProductionTarget(false)).toBe(false);
  });
  it("[LDB-G16] --env is refused, so no old preview command line can reach production unguarded", () => {
    for (const argv of [["--dump", "x", "--remote", "--env", "preview"], ["--dump", "x", "--env=preview"], ["--env", "preview", "--local"]]) {
      expect(() => parseArgs(argv), argv.join(" ")).toThrow(/--env is gone/);
    }
    expect(parseArgs(["--dump", "x", "--remote", "--wipe=akl-db"])).toMatchObject({ dump: "x", remote: true, wipe: "akl-db" });
  });
});

describe("[LDB-G16] checkWipeFlag: --wipe=akl-db required for the production target only", () => {
  it("[LDB-G16] refuses a production run with no --wipe, or the wrong value", () => {
    expect(checkWipeFlag(true, null)).toMatch(/refusing/);
    expect(checkWipeFlag(true, "akl-db-preview")).toMatch(/refusing/);
    expect(checkWipeFlag(true, "yes")).toMatch(/refusing/);
  });
  it("[LDB-G16] allows a production run with the exact literal --wipe=akl-db", () => {
    expect(checkWipeFlag(true, "akl-db")).toBeNull();
  });
  it("[LDB-G16] never guards --local, --wipe absent or not", () => {
    expect(checkWipeFlag(false, null)).toBeNull();
    expect(checkWipeFlag(false, "akl-db")).toBeNull();
  });
});

describe("[LDB-G16] checkSeqLoss: refuse restoring over a live service that has moved on", () => {
  it("[LDB-G16] refuses when live seq is ahead of the dump's, unless --accept-loss", () => {
    expect(checkSeqLoss(true, 100, 50, false)).toMatch(/live akl-db is at seq 100.*dump's seq 50/);
    expect(checkSeqLoss(true, 100, 50, true)).toBeNull();
  });
  it("[LDB-G16] allows when the dump is at or ahead of live (nothing to lose)", () => {
    expect(checkSeqLoss(true, 50, 50, false)).toBeNull();
    expect(checkSeqLoss(true, 50, 100, false)).toBeNull();
  });
  it("[LDB-G16] never guards --local", () => {
    expect(checkSeqLoss(false, 100, 0, false)).toBeNull();
  });
});

describe("[LDB-G16] metaUrlFor: DB_BASE_URL overrides the production default", () => {
  it("[LDB-G16] defaults to the real production origin", () => {
    expect(metaUrlFor(undefined)).toBe("https://api.akldb.org/v1/meta");
  });
  it("[LDB-G16] uses DB_BASE_URL when set, trailing slash tolerated", () => {
    expect(metaUrlFor("https://staging.example.com")).toBe("https://staging.example.com/v1/meta");
    expect(metaUrlFor("https://staging.example.com/")).toBe("https://staging.example.com/v1/meta");
  });
});
