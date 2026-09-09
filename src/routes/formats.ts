// GET /v1/formats, /v1/formats/{name}/{N}/schema.json (01 §4, 07 §6 S6).
// No ETag/304 here -- the registry only changes at deploy time, not from
// the event log, so there's nothing for a head-seq-keyed ETag to track.
import { Hono } from "hono";
import type { Bindings } from "../env";
import { notFound } from "../core/errors";
import { get as getFormat, list as listFormats } from "../formats/registry";

export const formatsRoute = new Hono<{ Bindings: Bindings }>();

formatsRoute.get("/v1/formats", (c) => {
  const body = listFormats().map((f) => ({
    id: f.id,
    owner: f.owner,
    description: f.description,
    can_translate_to: Object.keys(f.to),
  }));
  return c.json(body);
});

formatsRoute.get("/v1/formats/:name/:major/schema.json", (c) => {
  const id = `${c.req.param("name")}/${c.req.param("major")}`;
  const mod = getFormat(id);
  if (mod === undefined) throw notFound(`no format '${id}'`, id);
  return c.json(mod.schema, 200, { "Content-Type": "application/schema+json" });
});
