// The diff cron (12 §3 X4, `0 4 * * *`): runs the shrunk upstream mirror
// diff (`import/diff.ts`, LEDGER.md L4) against OUR OWN D1 -- `d1Ours`
// reads `layouts`/`likes` directly, never over HTTP. That is what makes
// this cron LDB-C4-safe: a single-invocation cron that fetched its own
// origin over HTTP would be its own subrequest, its own rate-limit
// customer, and a self-dependency a slow or wedged Worker could deadlock
// against. `diffTick` writes `import_state['cmini.last_diff']` on every
// run, success or failure (LDB-M1) -- a thrown fetch/parse failure never
// leaves the previous run's `at` looking current.
import type { Bindings } from "../env";
import { canonical } from "../core/canonical";
import { rowToLayout, type LayoutDbRow } from "../core/records";
import type { Clock } from "../core/time";
import type { Payload as SparkPayload } from "../../formats/spark/1/index.ts";
import { DEFAULT_SAMPLE_SIZE, diffUpstream, type DiffSummary, type FetchImpl, type OursEntry, type OursSource } from "./diff";

export const IMPORT_STATE_KEY = "cmini.last_diff"; // exported for `/v1/meta`'s one-query head (src/index.ts)
const SAMPLE_CAP = 10;

async function likesFor(db: Bindings["DB"], ids: string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>(ids.map((id) => [id, []]));
  for (let i = 0; i < ids.length; i += 90) {
    const chunk = ids.slice(i, i + 90);
    const rows = await db
      .prepare(
        `SELECT layout_id, user_id FROM likes WHERE layout_id IN (${chunk.map(() => "?").join(",")}) ORDER BY layout_id, user_id ASC`,
      )
      .bind(...chunk)
      .all<{ layout_id: string; user_id: string }>();
    for (const r of rows.results) out.get(r.layout_id)!.push(r.user_id);
  }
  return out;
}

// `OursSource` backed directly by this Worker's own D1 (12 §3 X4). No
// `fetchImpl` anywhere in this function -- `diffTick`'s own fetchImpl
// (injected in tests, real `fetch` in production) is used ONLY for the
// upstream half inside `diffUpstream`, never here.
//
// `sampleFollowing` picks the sample with ONE `ORDER BY RANDOM() LIMIT n`
// query (LEDGER.md L4: the shrunk diff never enumerates the whole corpus
// any more), then reads each sampled layout's own `spark/1` row + likes.
export function d1Ours(env: Bindings): OursSource {
  const db = env.DB;
  return {
    async linkedLayoutCount() {
      // `upstream_source IS NOT NULL` is exactly `upstreamFromRow`'s own
      // "has an upstream" test (core/records.ts).
      const row = await db.prepare("SELECT COUNT(*) AS n FROM layouts WHERE deleted = 0 AND upstream_source IS NOT NULL").first<{ n: number }>();
      return row?.n ?? 0;
    },
    async sampleFollowing(n) {
      const { results } = await db
        .prepare(
          `SELECT l.*, f.payload_json AS spark_payload_json
             FROM layouts l
             JOIN layout_formats f ON f.layout_id = l.id AND f.lineage = 'spark'
            WHERE l.deleted = 0 AND l.upstream_state = 'following'
            ORDER BY RANDOM() LIMIT ?`,
        )
        .bind(n)
        .all<LayoutDbRow & { spark_payload_json: string }>();

      const likes = await likesFor(db, results.map((r) => r.id));
      const out: OursEntry[] = [];
      for (const row of results) {
        const layout = rowToLayout(row);
        out.push({
          ref: layout.id,
          name: layout.name,
          owner: layout.owner,
          created_at: layout.created_at,
          modified_at: layout.modified_at,
          likes: likes.get(layout.id) ?? [],
          payload: JSON.parse(row.spark_payload_json) as SparkPayload,
          upstream: layout.upstream ?? null,
        });
      }
      return out;
    },
  };
}

// The row `import_state['cmini.last_diff']` holds (12 §3 X4) -- `/v1/meta`
// reads only `{at, ok}` off it (LDB-M1); `GET /v1/admin/health` (admin-only)
// serves the whole thing. A failed run (network/shape error the retries
// inside `diffUpstream` couldn't recover from) carries none of the summary
// fields -- `error` instead, `at`/`ok: false` always present either way.
export interface LastDiffRecord {
  at: string;
  ok: boolean;
  duration_ms?: number;
  layout_count?: { upstream: number; ours: number; equal: boolean };
  sample_size?: number;
  matched?: number;
  missing?: number;
  invalid_upstream?: number;
  content_diffs?: number;
  samples?: {
    missing: string[];
    content_diffs: { name: string; path: string }[];
  };
  error?: string;
}

function summaryToLastDiff(at: string, durationMs: number, summary: DiffSummary): LastDiffRecord {
  return {
    at,
    ok: summary.ok,
    duration_ms: durationMs,
    layout_count: summary.layoutCount,
    sample_size: summary.sampleSize,
    matched: summary.matched,
    missing: summary.missing.length,
    invalid_upstream: summary.invalidUpstream.length,
    content_diffs: summary.contentDiffs.length,
    samples: {
      missing: summary.missing.slice(0, SAMPLE_CAP).map((d) => d.name),
      content_diffs: summary.contentDiffs.slice(0, SAMPLE_CAP).map((d) => ({ name: d.name, path: d.path })),
    },
  };
}

async function writeImportState(db: Bindings["DB"], key: string, value: string): Promise<void> {
  await db
    .prepare("INSERT INTO import_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .bind(key, value)
    .run();
}

// `fetchImpl` is injected in tests (a `FakeUpstream`-style stub that refuses
// any URL not under the upstream base -- LDB-C4's own proof that this
// function never calls its own origin) and defaults to real `fetch` in
// production, same pattern `import/cmini.ts`'s `tick()` uses. `sampleSize`
// is test-only (production always takes the default): a test corpus can
// override it to cover every candidate deterministically rather than
// relying on `ORDER BY RANDOM()` to happen to pick a specific mutated row.
export async function diffTick(env: Bindings, now: Clock, fetchImpl?: FetchImpl, sampleSize?: number): Promise<LastDiffRecord> {
  const at = now();
  const startedAt = Date.now();
  try {
    const summary = await diffUpstream({
      upstreamUrl: env.IMPORT_SOURCE_URL,
      ua: env.IMPORT_UA,
      ours: d1Ours(env),
      sampleSize: sampleSize ?? DEFAULT_SAMPLE_SIZE,
      fetchImpl,
    });
    const record = summaryToLastDiff(at, Date.now() - startedAt, summary);
    await writeImportState(env.DB, IMPORT_STATE_KEY, canonical(record));
    return record;
  } catch (e) {
    const record: LastDiffRecord = { at, ok: false, error: e instanceof Error ? e.message : String(e) };
    await writeImportState(env.DB, IMPORT_STATE_KEY, canonical(record));
    return record;
  }
}

export async function lastDiff(db: Bindings["DB"]): Promise<LastDiffRecord | null> {
  const row = await db.prepare("SELECT value FROM import_state WHERE key = ?").bind(IMPORT_STATE_KEY).first<{ value: string }>();
  return row === null ? null : (JSON.parse(row.value) as LastDiffRecord);
}

// LDB-D8: same catch-up rule `dump/write.ts`'s `dumpDue` states for the
// nightly dump -- hour=4 stays the preferred slot (`src/index.ts`'s
// `scheduled()`), but any OTHER tick runs the diff too once
// `cmini.last_diff` is missing or >24h old, so a dropped hour=4 dispatch is
// caught within one tick of the next successful one instead of silently
// skipping a day. Pure (no D1/clock read), same reason `dumpDue` is.
const DIFF_STALE_MS = 24 * 60 * 60 * 1000;

export function diffDue(record: LastDiffRecord | null, nowIso: string): boolean {
  if (record === null) return true;
  return Date.parse(nowIso) - Date.parse(record.at) > DIFF_STALE_MS;
}
