// [LDB-D5] db/scripts/drill-fetch-dump.mjs's sha256/byte-count check --
// "the drill's report is only `ok: true` when the restored database
// equals the dump byte-for-byte on every record" starts here, at the very
// first byte the drill ever reads off the wire: a corrupt or truncated
// transfer must be caught before `drill-restore.mjs` ever sees it.
import { describe, expect, it } from "vitest";
// drill-fetch-dump.mjs is a plain script (no .d.ts) -- typed locally the
// same way tests/tools/codeowners.test.ts's own `.mjs` import is, rather
// than widening db/tsconfig.json's `allowJs` setting for one test file.
// @ts-expect-error -- see above
import { checkDumpIntegrity, sha256HexAsync } from "../../scripts/drill-fetch-dump.mjs";

describe("[LDB-D5] drill-fetch-dump.mjs -- checkDumpIntegrity", () => {
  it("[LDB-D5] passes a good dump (sha256 and byte count both match latest.json)", async () => {
    const bytes = new TextEncoder().encode("a real dump body, gzipped in practice but bytes are bytes here");
    const sha256 = await sha256HexAsync(bytes);
    const latestJson = { key: "dump-2026-01-01.json.gz", url: "/v1/dump/dump-2026-01-01.json.gz", sha256, bytes: bytes.length };

    const result = checkDumpIntegrity(latestJson, bytes, sha256);
    expect(result).toEqual({ ok: true, sha256, bytes: bytes.length, reasons: [] });
  });

  it("[LDB-D5] fails a corrupted dump (bytes changed in transit -- sha256 no longer matches)", async () => {
    const original = new TextEncoder().encode("the original dump body");
    const originalSha256 = await sha256HexAsync(original);
    const latestJson = { key: "dump-2026-01-01.json.gz", url: "/v1/dump/dump-2026-01-01.json.gz", sha256: originalSha256, bytes: original.length };

    const corrupted = new TextEncoder().encode("the ORIGINAL dump body"); // same length, different bytes
    const corruptedSha256 = await sha256HexAsync(corrupted);
    const result = checkDumpIntegrity(latestJson, corrupted, corruptedSha256);

    expect(result.ok).toBe(false);
    expect(result.reasons).toEqual([`sha256 mismatch: got ${corruptedSha256}, latest.json says ${originalSha256}`]);
  });

  it("[LDB-D5] fails a truncated dump (byte count no longer matches, even if a sha256 collision were possible)", async () => {
    const full = new TextEncoder().encode("the complete dump body, several bytes long");
    const fullSha256 = await sha256HexAsync(full);
    const latestJson = { key: "dump-2026-01-01.json.gz", url: "/v1/dump/dump-2026-01-01.json.gz", sha256: fullSha256, bytes: full.length };

    const truncated = full.slice(0, full.length - 5);
    const truncatedSha256 = await sha256HexAsync(truncated);
    const result = checkDumpIntegrity(latestJson, truncated, truncatedSha256);

    expect(result.ok).toBe(false);
    expect(result.reasons).toContain(`sha256 mismatch: got ${truncatedSha256}, latest.json says ${fullSha256}`);
    expect(result.reasons).toContain(`byte count mismatch: got ${truncated.length}, latest.json says ${full.length}`);
  });

  it("[LDB-D5] fails when latest.json itself is missing sha256/bytes fields (never treats absence as a pass)", async () => {
    const bytes = new TextEncoder().encode("some bytes");
    const result = checkDumpIntegrity({ key: "k", url: "/v1/dump/k" }, bytes, await sha256HexAsync(bytes));
    expect(result.ok).toBe(false);
    expect(result.reasons.length).toBe(2);
  });
});
