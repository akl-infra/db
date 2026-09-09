// GET /v1/changes -- the event feed (03 §5, 07 §6 S6). Thin wrapper over
// S4's `feed()`: parse/validate `since`/`limit`/`kinds`, ETag/304, done.
import { Hono } from "hono";
import type { Bindings } from "../env";
import { badRequest } from "../core/errors";
import { cachePut, conditional, etagFor, headSeq } from "../core/etag";
import { feed, type InfoKind, type WriteKind } from "../core/events";

const CACHE_CONTROL = "public, max-age=10";

// The complete phase-1+2 event vocabulary (03 §5): every `WriteKind`, every
// `InfoKind` (the four `admin.*` kinds, 09 §3 T3, included -- the public
// changelog filters on them same as any other kind), plus the two like
// events (never rev-bumping, not in either type). Kept as a literal array
// (types vanish at runtime) but pinned against both types with `satisfies`
// so an added kind can't go stale here unnoticed.
const KNOWN_KINDS = [
  "created",
  "updated",
  "renamed",
  "fingermap",
  "transferred",
  "deleted",
  "restored",
  "imported",
  "upstream_deleted",
  "upstream_changed",
  "import_conflict",
  "admin.added",
  "admin.removed",
  "admin.import_paused",
  "admin.import_resumed",
  "liked",
  "unliked",
] satisfies (WriteKind | InfoKind | "liked" | "unliked")[];
const KNOWN_KINDS_SET = new Set<string>(KNOWN_KINDS);

function parseSince(raw: string | undefined): number {
  if (raw === undefined) return 0;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) throw badRequest(`invalid 'since' (expected a non-negative integer seq)`, "since");
  return n;
}

function parseLimit(raw: string | undefined): number {
  if (raw === undefined) return 100;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) throw badRequest(`invalid 'limit' (expected a positive integer)`, "limit");
  return Math.min(n, 1000);
}

function parseKinds(raw: string | undefined): string[] | undefined {
  if (raw === undefined) return undefined;
  const kinds = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  for (const k of kinds) {
    if (!KNOWN_KINDS_SET.has(k)) throw badRequest(`unknown kind '${k}'`, "kinds");
  }
  return kinds;
}

export const changesRoute = new Hono<{ Bindings: Bindings }>();

changesRoute.get("/v1/changes", async (c) => {
  const db = c.env.DB;
  const since = parseSince(c.req.query("since"));
  const limit = parseLimit(c.req.query("limit"));
  const kinds = parseKinds(c.req.query("kinds"));

  const seq = await headSeq(db);
  const etag = await etagFor(seq, { since, limit, kinds: kinds ?? null });
  const short = await conditional(c, etag, CACHE_CONTROL);
  if (short) return short;

  const { next, items } = await feed(db, since, limit, kinds);
  const res = c.json({ next, items });
  res.headers.set("ETag", etag);
  res.headers.set("Cache-Control", CACHE_CONTROL);
  await cachePut(c, res.clone());
  return res;
});
