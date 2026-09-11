// The diff cron (12 §3 X4, `0 4 * * *`): runs the D12 mirror diff
// (`import/diff.ts`) against OUR OWN D1 -- `d1Ours` reads `layouts`/
// `likes`/`authors`/`events` directly, through the same functions the read
// routes use (`core/records.ts`'s `list`, `formats/registry.ts`'s
// `translate`), never over HTTP. That is what makes this cron LDB-C4-safe:
// a single-invocation cron that fetched its own origin over HTTP would be
// its own subrequest, its own rate-limit customer, and a self-dependency a
// slow or wedged Worker could deadlock against. `diffTick` writes
// `import_state['cmini.last_diff']` on every run, success or failure
// (LDB-M1) -- a thrown fetch/parse failure never leaves the previous run's
// `at` looking current.
import type { Bindings } from "../env";
import { canonical } from "../core/canonical";
import { decodeCursor, list as listRecords, type ListCursor } from "../core/records";
import type { Clock } from "../core/time";
import type { Payload as SparkPayload } from "../../formats/spark/1/index.ts";
import { diffUpstream, type DiffSummary, type FetchImpl, type OursSource } from "./diff";

const PAGE_SIZE = 500; // 12 §0.3: pages our side from D1 in 500-record pages, one list query per page
export const IMPORT_STATE_KEY = "cmini.last_diff"; // exported for `/v1/meta`'s one-query head (src/index.ts)
const SAMPLE_CAP = 10;

// Chunked IN-list, same shape `routes/layouts.ts`'s own `likesByLayout`
// uses (D1's <= 100 bound params) -- duplicated rather than imported: that
// module is route glue (Hono `Context`), this one has none of that, and
// the query itself is three lines.
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
// 20-spark.md S3b (§8 R-H6): yields the record's own payload directly --
// comparison happens in spark now, and every row already carries its own
// `upstream` (S3a), so no `/history` follow-up (the old `followsUpstream`
// method, deleted) is needed either. 21-formats.md D12 deleted the legacy
// fallback (`legacyUpstreamMap`/`storedAsSpark`) this used to need: after
// the D8 wipe every row is already spark-shaped with its own `upstream`
// column set.
export function d1Ours(env: Bindings): OursSource {
  const db = env.DB;
  return {
    async *full() {
      let cursor: ListCursor | undefined;
      for (;;) {
        // 21-formats.md §3 F2: the D12 diff still compares in spark only --
        // a layout with no `spark/1` row simply never appears in this
        // corpus (unreachable in F2: every stored row is spark/1; real once
        // a second format lands, and `diffCorpus`'s own `missing`/`extra`
        // bookkeeping already treats an absent entry correctly either way).
        const page = await listRecords(db, { sourceLineage: "spark", sort: "name", limit: PAGE_SIZE, cursor });
        const likes = await likesFor(
          db,
          page.items.map(({ layout }) => layout.id),
        );
        for (const { layout, format } of page.items) {
          yield {
            ref: layout.id,
            name: layout.name,
            owner: layout.owner,
            created_at: layout.created_at,
            modified_at: layout.modified_at,
            likes: likes.get(layout.id) ?? [],
            payload: format.payload as SparkPayload,
            upstream: layout.upstream ?? null,
          };
        }
        if (page.nextCursor === null) break;
        const decoded = decodeCursor(page.nextCursor);
        if (decoded === null) break; // unreachable: we just encoded it ourselves
        cursor = decoded;
      }
    },
    async authors() {
      const { results } = await db.prepare("SELECT user_id, name FROM authors ORDER BY name").all<{ user_id: string; name: string }>();
      const body: Record<string, string> = {};
      for (const row of results) body[row.name] = row.user_id;
      return body;
    },
    async layoutCount() {
      const row = await db.prepare("SELECT COUNT(*) AS n FROM layouts WHERE deleted = 0").first<{ n: number }>();
      return row?.n ?? 0;
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
  upstream_count?: number;
  our_count?: number;
  held?: string[];
  layout_count?: { upstream: number; ours: number; equal: boolean };
  authors?: { missing: number; extra: number; alias_count: number };
  corpus?: { matched: number; missing: number; invalid_upstream: number; content_diffs: number; extra: number; divergent: number; unresolved: number };
  samples?: {
    missing: string[];
    content_diffs: { name: string; path: string }[];
    extra: string[];
  };
  error?: string;
}

function summaryToLastDiff(at: string, durationMs: number, summary: DiffSummary): LastDiffRecord {
  return {
    at,
    ok: summary.ok,
    duration_ms: durationMs,
    upstream_count: summary.upstreamCount,
    our_count: summary.ourCount,
    held: summary.held,
    layout_count: summary.layoutCount,
    authors: { missing: summary.authors.missing.length, extra: summary.authors.extra.length, alias_count: summary.authors.aliasCount },
    corpus: {
      matched: summary.corpus.matched,
      missing: summary.corpus.missing.length,
      invalid_upstream: summary.corpus.invalidUpstream.length,
      content_diffs: summary.corpus.contentDiffs.length,
      extra: summary.corpus.extra.length,
      divergent: summary.corpus.divergent.length,
      unresolved: summary.corpus.unresolved.length,
    },
    samples: {
      missing: summary.corpus.missing.slice(0, SAMPLE_CAP).map((d) => d.name),
      content_diffs: summary.corpus.contentDiffs.slice(0, SAMPLE_CAP).map((d) => ({ name: d.name, path: d.path })),
      extra: summary.corpus.extra.slice(0, SAMPLE_CAP).map((d) => d.name),
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
// production, same pattern `import/cmini.ts`'s `tick()` uses.
export async function diffTick(env: Bindings, now: Clock, fetchImpl?: FetchImpl): Promise<LastDiffRecord> {
  const at = now();
  const startedAt = Date.now();
  try {
    const summary = await diffUpstream({
      upstreamUrl: env.IMPORT_SOURCE_URL,
      ua: env.IMPORT_UA,
      ours: d1Ours(env),
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
