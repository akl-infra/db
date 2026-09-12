// [LDB-P5] The shrunk upstream mirror diff, live (LEDGER.md L4; the daily
// job): layout count equality, plus a sampled compare of DEFAULT_SAMPLE_SIZE
// random following layouts read back `?format=spark/1` against upstream
// (converted through `fromCmini`) on the projection. Runs ONLY when
// `DB_BASE_URL` is set (the daily job sets it to the deployed service's
// origin) -- when set, this does NOT skip on a network hiccup: it retries
// for up to 30 minutes, then fails loud. That's the `ci-gate-split-256`
// lesson db.yml's own comments cite: "a skip nobody reads is a pass".
import { describe, expect, it } from "vitest";
import { diffUpstream, httpOurs, type DiffSummary } from "../src/import/diff";

const DB_BASE_URL = process.env.DB_BASE_URL;
const UPSTREAM_URL = process.env.UPSTREAM_URL ?? "https://clemenpine.com/layoutapi/v3";
const UA = process.env.IMPORT_UA ?? "akl-db-import/1.0";

const RETRY_WINDOW_MS = 30 * 60 * 1000;
const RETRY_SLEEP_MS = 30 * 1000;
const TEST_TIMEOUT_MS = RETRY_WINDOW_MS + 60 * 1000; // the retry budget plus headroom for the final attempt itself

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Retries ONLY a thrown (network/shape) failure -- `diffUpstream` never
// throws for a real content difference, it returns a summary describing
// one (see diff.ts). So a summary with `ok: false` comes back immediately,
// no retry: that's the finding, not a flake.
async function diffUntilReachable(dbBaseUrl: string): Promise<DiffSummary> {
  const deadline = Date.now() + RETRY_WINDOW_MS;
  let lastErr: unknown;
  for (;;) {
    try {
      return await diffUpstream({ ours: httpOurs(dbBaseUrl), upstreamUrl: UPSTREAM_URL, ua: UA });
    } catch (e) {
      lastErr = e;
      if (Date.now() >= deadline) {
        throw new Error(`diff-upstream: unreachable after retrying for ${RETRY_WINDOW_MS / 60_000} min: ${String(lastErr)}`);
      }
      await sleep(RETRY_SLEEP_MS);
    }
  }
}

describe.skipIf(DB_BASE_URL === undefined || DB_BASE_URL === "")("upstream diff (daily, live)", () => {
  it(
    "[LDB-P5] [LDB-I13] layout counts agree, and a random sample of following layouts equals upstream on the projection",
    async () => {
      const summary = await diffUntilReachable(DB_BASE_URL!);
      if (!summary.ok) {
        // The whole point of this job (07 §6 S8): never paper over a real
        // difference -- print exactly what diverged before failing.
        console.error(JSON.stringify(summary, null, 2));
      }

      expect(summary.layoutCount).toEqual({
        upstream: summary.layoutCount.upstream,
        ours: summary.layoutCount.upstream,
        equal: true,
      });
      expect(summary.missing).toEqual([]);
      expect(summary.invalidUpstream).toEqual([]);
      expect(summary.contentDiffs).toEqual([]);
      expect(summary.ok).toBe(true);
    },
    TEST_TIMEOUT_MS,
  );
});
