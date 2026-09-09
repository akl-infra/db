// [LDB-P5] The D12 mirror diff, live (07 §6 S8; §7's daily job): every
// upstream cmini layout read back `?as=cmini/1` must equal upstream on the
// projection. Runs ONLY when `DB_BASE_URL` is set (the daily job sets it to
// the deployed service's origin) -- when set, this does NOT skip on a
// network hiccup: it retries for up to 30 minutes, then fails loud. That's
// the `ci-gate-split-256` lesson db.yml's own comments cite: "a skip nobody
// reads is a pass".
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
    "[LDB-P5] every following record read ?as=cmini/1 equals upstream on the projection",
    async () => {
      const summary = await diffUntilReachable(DB_BASE_URL!);
      if (!summary.ok) {
        // The whole point of this job (07 §6 S8): never paper over a real
        // difference -- print exactly what diverged before failing.
        console.error(JSON.stringify(summary, null, 2));
      }

      expect(summary.held, "held records: as=cmini/1 should always be identity in phase 1").toEqual([]);
      expect(summary.corpus.missing).toEqual([]);
      expect(summary.corpus.invalidUpstream).toEqual([]);
      expect(summary.corpus.contentDiffs).toEqual([]);
      expect(summary.corpus.extra).toEqual([]);
      expect(summary.corpus.extraUnresolved).toEqual([]);
      expect(summary.layoutCount).toEqual({
        upstream: summary.layoutCount.upstream,
        ours: summary.layoutCount.upstream,
        equal: true,
      });
      expect(summary.authors.missing).toEqual([]);
      expect(summary.authors.extra).toEqual([]);
      // `aliasCount` is informational only (an old upstream name for an id
      // we already have under a newer one, diffAuthors's own header note)
      // -- never asserted here.
      expect(summary.ok).toBe(true);
    },
    TEST_TIMEOUT_MS,
  );
});
