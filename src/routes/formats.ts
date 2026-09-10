// GET /v1/formats, /v1/formats/{name}/{N}/schema.json (01 §4, 07 §6 S6).
// No ETag/304 here -- the registry only changes at deploy time, not from
// the event log, so there's nothing for a head-seq-keyed ETag to track.
import { Hono } from "hono";
import type { Bindings } from "../env";
import { notFound } from "../core/errors";
import { get as getFormat, list as listFormats } from "../formats/registry";
import { ALIASES, lineage, majorOf, latestOf, hasEdge } from "../../formats/registry.ts";
import * as cminiAdapter from "../../formats/adapters/cmini/index.ts";

export const formatsRoute = new Hono<{ Bindings: Bindings }>();

// Every alias id whose target is exactly `formatId` -- reachable FROM
// `formatId` for free (reading `?as=<alias>` of a `formatId`-shaped
// payload is always the identity translation, LDB-F20/F21).
function aliasesFor(formatId: string): string[] {
  return Object.entries(ALIASES)
    .filter(([, a]) => a.target === formatId)
    .map(([alias]) => alias);
}

// `can_translate_to` (20-spark.md S1, extended by S5's chain -- 19 §4.2:
// "`can_translate_to` equals the set of formats `path()` reaches"): every
// OTHER registered format `hasEdge()` reaches STRUCTURALLY (same lineage,
// always -- the chain; a different lineage with a registered cross edge at
// ANY major, not just this module's own), PLUS every alias reachable from
// it -- an alias whose target IS this format (identity via the alias,
// e.g. `akl/1` from `spark/1`), or whose target is one of the chain-
// reachable ids above, or the special `adapter:cmini` target when this
// format is `spark/1` (the one format the cmini adapter's `toCmini` can be
// reached from).
function reachableFormats(f: { id: string }): string[] {
  const chainReachable = listFormats()
    .map((m) => m.id)
    .filter((id) => id !== f.id && hasEdge(f.id, id));
  const viaAlias = Object.entries(ALIASES)
    .filter(([, a]) => a.target === f.id || chainReachable.includes(a.target) || (a.target === "adapter:cmini" && f.id === "spark/1"))
    .map(([alias]) => alias);
  return [...chainReachable, ...viaAlias];
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
    aliases: aliasesFor(f.id),
    can_translate_to: reachableFormats(f),
  }));
  return c.json(body);
});

formatsRoute.get("/v1/formats/:name/:major/schema.json", (c) => {
  const id = `${c.req.param("name")}/${c.req.param("major")}`;
  // 20-spark.md S2: `cmini/1` is no longer a registered `FormatModule`
  // (`getFormat` can't answer it -- its alias target is the unregistered
  // adapter, not a module this registry owns), but its schema still
  // describes a real legacy-stored shape (`layout_revs` keeps `cmini/1`
  // rows forever, LDB-F21/§6) -- a client reading old history still needs
  // it, so this route serves the adapter's own schema.json directly
  // rather than 404ing something with a real answer.
  if (id === "cmini/1") return c.json(cminiAdapter.schema, 200, { "Content-Type": "application/schema+json" });
  const mod = getFormat(id);
  if (mod === undefined) throw notFound(`no format '${id}'`, id);
  return c.json(mod.schema, 200, { "Content-Type": "application/schema+json" });
});
