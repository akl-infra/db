// GET /v1/formats, /v1/formats/{name}/{N}/schema.json (01 §4, 07 §6 S6).
// No ETag/304 here -- the registry only changes at deploy time, not from
// the event log, so there's nothing for a head-seq-keyed ETag to track.
import { Hono } from "hono";
import type { Bindings } from "../env";
import { notFound } from "../core/errors";
import { get as getFormat, list as listFormats } from "../formats/registry";
import { lineage, majorOf, latestOf, hasEdge } from "../../formats/registry.ts";

export const formatsRoute = new Hono<{ Bindings: Bindings }>();

// `can_translate_to` (20-spark.md S1, extended by S5's chain -- 19 §4.2:
// "`can_translate_to` equals the set of formats `path()` reaches"): every
// OTHER registered format `hasEdge()` reaches STRUCTURALLY -- same lineage,
// always (the chain), or a different lineage with a registered cross edge
// at ANY major, not just this module's own. 21-formats.md D5/D12 deleted
// every alias (`akl/1`, `cmini/1`'s `adapter:cmini` read path), so this is
// now just the chain-reachable set -- no alias union any more.
function reachableFormats(f: { id: string }): string[] {
  return listFormats()
    .map((m) => m.id)
    .filter((id) => id !== f.id && hasEdge(f.id, id));
}

formatsRoute.get("/v1/formats", (c) => {
  const body = listFormats().map((f) => ({
    id: f.id,
    owner: f.owner,
    description: f.description,
    role: f.role,
    // 20-spark.md S5 (19 §4.2): `lineage`/`major`/`latest` let a client
    // detect a new major without parsing the id string itself.
    lineage: lineage(f.id),
    major: majorOf(f.id),
    latest: majorOf(f.id) === latestOf(lineage(f.id)),
    // 21-formats.md D5/D12: no more aliases -- always empty until a future
    // format reintroduces one.
    aliases: [] as string[],
    can_translate_to: reachableFormats(f),
  }));
  return c.json(body);
});

formatsRoute.get("/v1/formats/:name/:major/schema.json", (c) => {
  const id = `${c.req.param("name")}/${c.req.param("major")}`;
  // 21-formats.md D5: `cmini/1` is no longer reachable at all (was served
  // here directly, from the unregistered adapter's own schema, for a
  // legacy-stored row's benefit -- D12's wipe means no such row exists any
  // more) -- an unregistered id answers `404`, same as any other.
  const mod = getFormat(id);
  if (mod === undefined) throw notFound(`no format '${id}'`, id);
  return c.json(mod.schema, 200, { "Content-Type": "application/schema+json" });
});
