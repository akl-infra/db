// 20-spark.md S3a (decision 5/6, LDB-I14): the upstream write rule, in one
// function every writer uses, plus the read-side fallback for a record
// this field hasn't been written on yet.
import type { Bindings } from "../env";
import { legacyFollows } from "./follows";
import type { RecordRow, Upstream } from "./records";
import type { WriteKind } from "./events";

// S4 (`db/src/core/migrate.ts`) adds `"migrated"` to `WriteKind` itself;
// `nextUpstream` already has to understand it (I14's own text), so this
// widens the parameter type here rather than waiting on that slice.
export type UpstreamWriteKind = WriteKind | "migrated";

// The LDB-I14 rule:
//  - `migrated` never changes it -- a migration's write carries forward
//    whatever `prior` already resolved to (the legacy rule, the first time).
//  - `null` stays `null` -- a write with no known upstream link at all (a
//    plain user create, or any write on a record that has never had one)
//    never acquires one out of nowhere.
//  - otherwise, an import-system write (`via: "import:cmini"` -- create,
//    update, revival, the rev-bumping `upstream_deleted` tombstone, and
//    strip) sets/keeps `following`; the importer never writes `forked`
//    (guarded at the call site by `expectRev`, LDB-P14).
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
export function nextUpstream(prior: Upstream | null, kind: UpstreamWriteKind, via: string): Upstream | null {
  if (kind === "migrated") return prior;
  if (prior === null) return null;
  if (via === "import:cmini") return { ...prior, state: "following" };
  return { ...prior, state: "forked" };
}

// Read-side: a record's OWN `upstream` field when it's non-null, else the
// permanent legacy fallback (LDB-P11) -- keeps every write correct between
// the 0005 deploy and the S4 migration, and after a restore of a pre-0005
// dump (whose rows carry no `upstream_*` columns at all, so `rowToRecord`
// reads them back `null`). The fallback only ever answers `following` or
// `null`, never `forked` (R-L6: a mapped-but-not-following record, e.g.
// import case 2's same-owner name clash, has an `import_map` row but was
// never actually "the record importing wrote" -- the legacy model has no
// way to tell that apart from "no link at all", so it doesn't try).
export async function upstreamOf(db: Bindings["DB"], rec: RecordRow): Promise<Upstream | null> {
  if (rec.upstream !== null) return rec.upstream;
  const row = await db.prepare("SELECT upstream_id FROM import_map WHERE layout_id = ?").bind(rec.id).first<{ upstream_id: string }>();
  if (row === null) return null;
  const following = await legacyFollows(db, rec.id);
  if (!following) return null;
  return { source: "cmini", id: row.upstream_id, state: "following" };
}
