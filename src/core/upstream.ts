// 20-spark.md S3a (decision 5/6, LDB-I14): the upstream write rule, in one
// function every writer uses, plus the read-side accessor.
//
// 21-formats.md D12: the legacy fallback (`core/follows.ts`'s
// `legacyFollows`, this file's own `legacyUpstreamMap`, and `upstreamOf`'s
// `import_map` query) is deleted -- after the D8 wipe every imported row
// carries the `upstream` the importer wrote at create time (LDB-I14's
// `nextUpstream`, below), so `rec.upstream` is never null for a record
// that has ever been import-mapped. `upstreamOf` is now a plain read of
// that column; kept as a function (not inlined at call sites) so nothing
// has to change if a future need ever reintroduces a fallback.
import type { Bindings } from "../env";
import type { RecordRow, Upstream } from "./records";
import type { WriteKind } from "./events";

// The LDB-I14 rule:
//  - `null` stays `null` -- a write with no known upstream link at all (a
//    plain user create, or any write on a record that has never had one)
//    never acquires one out of nowhere.
//  - otherwise, an import-system write (`via: "import:cmini"` -- create,
//    update, revival, and the rev-bumping `upstream_deleted` tombstone)
//    sets/keeps `following`; the importer never writes `forked` (guarded
//    at the call site by `expectRev`, LDB-P14).
//  - every other (user) rev-bumping write -- PUT, PATCH (magic included,
//    decision 6), rename, fingermap, transfer, delete, restore -- forks:
//    `state: "forked"`, same `source`/`id`.
//
// `prior` is `source`/`id`-bearing whenever the write knows an upstream
// link exists: for an update, that's `upstreamOf(db, record)`; for an
// import create (no existing record to read a prior FROM), the caller
// passes the freshly known `{source, id}` with `state` set to whatever --
// this function only ever looks at `prior`'s `state` on the fork branch,
// and an import write can't reach that branch (`via` is always
// `"import:cmini"` there), so the placeholder never surfaces.
export function nextUpstream(prior: Upstream | null, kind: WriteKind, via: string): Upstream | null {
  if (prior === null) return null;
  if (via === "import:cmini") return { ...prior, state: "following" };
  return { ...prior, state: "forked" };
}

// Read-side: a record's own `upstream` field, straight off the row. Takes
// `db` (unused) to keep every call site's shape unchanged.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export async function upstreamOf(db: Bindings["DB"], rec: RecordRow): Promise<Upstream | null> {
  return rec.upstream;
}
