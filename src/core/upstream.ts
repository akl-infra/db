// 20-spark.md S3a (decision 5/6, LDB-I14): the upstream write rule, in one
// function every writer uses, plus the read-side fallback for a record
// this field hasn't been written on yet.
import type { Bindings } from "../env";
import { legacyFollows } from "./follows";
import type { RecordRow, Upstream } from "./records";
import type { WriteKind } from "./events";

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
export function nextUpstream(prior: Upstream | null, kind: WriteKind, via: string): Upstream | null {
  if (kind === "migrated") return prior;
  if (prior === null) return null;
  if (via === "import:cmini") return { ...prior, state: "following" };
  return { ...prior, state: "forked" };
}

// Read-side: a record's OWN `upstream` field when it's non-null, else the
// permanent legacy fallback (LDB-P11) -- keeps every write correct between
// the 0005 deploy and the S4 migration, and after a restore of a pre-0005
// dump (whose rows carry no `upstream_*` columns at all, so `rowToRecord`
// reads them back `null`).
//
// **Corrected 2026-09-10** (S4 review, the lead's fix for a migration
// non-termination bug this slice found): an `import_map` row is I14's own
// "does the importer still own this record's keys and board" question --
// its answer is `following` or `forked`, never "no link at all". The
// earlier text here (R-L6) had the fallback answer `null` for a mapped
// record `legacyFollows` says isn't following (e.g. import case 2's
// same-owner name clash, or ANY imported record a user has since edited),
// reasoning that the legacy model "can't tell that apart from no link at
// all" -- but it doesn't need to: an `import_map` row IS the link, `state`
// is just whichever of the two the legacy rule computes. `null` is now
// reserved for the one case that's actually ambiguous: no `import_map` row
// exists at all (a plain user record that was never imported). Only a
// record with NO `import_map` row reads `null` here.
// The bulk twin of `upstreamOf`'s legacy fallback (20-spark.md, found by the
// 2026-09-11 preview dry run): one statement over `import_map`, each mapped
// layout's latest rev-bumping event, skipping `migrated` events and events
// whose detail carries `magic_only: true` -- exactly `legacyFollows`'s rule
// (JSON `true` only; malformed detail is not a marker, never an error).
// Used where a whole corpus needs its follow state at once (the D12 diff's
// `d1Ours`) and a per-record `upstreamOf` would cost one query per record.
// `legacyUpstreamMap(db).get(id)` equals `upstreamOf(db, rec)` for every
// record whose stored `upstream` is null (LDB-P5 amended, tested).
export async function legacyUpstreamMap(db: Bindings["DB"]): Promise<Map<string, Upstream>> {
  const { results } = await db
    .prepare(
      `SELECT m.layout_id AS layout_id, m.upstream_id AS upstream_id,
         (SELECT e.via FROM events e
            WHERE e.layout_id = m.layout_id
              AND e.rev IS NOT NULL
              AND e.kind != 'migrated'
              AND (CASE WHEN json_valid(e.detail_json) THEN json_type(e.detail_json, '$.magic_only') ELSE NULL END) IS NOT 'true'
            ORDER BY e.seq DESC LIMIT 1) AS via
       FROM import_map m`,
    )
    .all<{ layout_id: string; upstream_id: string; via: string | null }>();
  const out = new Map<string, Upstream>();
  for (const r of results) {
    out.set(r.layout_id, { source: "cmini", id: r.upstream_id, state: r.via === "import:cmini" ? "following" : "forked" });
  }
  return out;
}

export async function upstreamOf(db: Bindings["DB"], rec: RecordRow): Promise<Upstream | null> {
  if (rec.upstream !== null) return rec.upstream;
  const row = await db.prepare("SELECT upstream_id FROM import_map WHERE layout_id = ?").bind(rec.id).first<{ upstream_id: string }>();
  if (row === null) return null;
  const following = await legacyFollows(db, rec.id);
  return { source: "cmini", id: row.upstream_id, state: following ? "following" : "forked" };
}
