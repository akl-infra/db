// GET /v1/changes -- the event feed (03 §5, 07 §6 S6). Thin wrapper over
// S4's `feed()`: parse/validate `since`/`limit`/`kinds`, ETag/304, done.
import { Hono } from "hono";
import type { Bindings } from "../env";
import { badRequest, notFound } from "../core/errors";
import { cachePut, conditional, etagFor, headSeq } from "../core/etag";
import { feed, type FeedFilter, type InfoKind, type WriteKind } from "../core/events";
import { byRef } from "../core/records";

const CACHE_CONTROL = "public, max-age=10";

// The complete phase-1+2 event vocabulary (03 §5): every `WriteKind`, every
// `InfoKind` (the six `admin.*` kinds, 09 §3 T3 + 10 C1, included -- the
// public changelog filters on them same as any other kind), plus the two
// like events (never rev-bumping, not in either type).
//
// A previous version of this list was a plain literal array pinned with
// `satisfies (WriteKind | InfoKind | "liked" | "unliked")[]` -- which only
// checks that every LISTED literal is a valid member of the union, never
// that every member of the union got listed; `admin.client_registered`/
// `admin.client_revoked` (10 C1's client-lane admin kinds) landed on
// `InfoKind` without ever being added here, silently. These two `Record<K,
// true>` objects are exhaustive instead: TypeScript refuses to compile if
// either type gains (or loses) a member without a matching key here --
// `tests/core/known-kinds.test.ts` also asserts every kind any events.ts
// writer function can actually append round-trips through KNOWN_KINDS, so
// a gap fails both at compile time and at test time.
const WRITE_KINDS_MAP: Record<WriteKind, true> = {
  created: true,
  updated: true,
  renamed: true,
  fingermap: true,
  transferred: true,
  deleted: true,
  restored: true,
  imported: true,
  upstream_deleted: true,
};
const INFO_KINDS_MAP: Record<InfoKind, true> = {
  upstream_changed: true,
  import_conflict: true,
  upstream_deleted: true, // deliberately in both maps -- see WriteKind/InfoKind's own header note (core/events.ts)
  "admin.added": true,
  "admin.removed": true,
  "admin.import_paused": true,
  "admin.import_resumed": true,
  "admin.client_registered": true,
  "admin.client_revoked": true,
  "admin.import_ticked": true,
  "admin.diff_ticked": true,
  "admin.nightly_ticked": true,
};
const LIKE_KINDS_MAP: Record<"liked" | "unliked", true> = { liked: true, unliked: true };

// Exported for X1 (12 §0.2): webhook `kinds` (routes/webhooks.ts) and the
// stream's `kinds` (routes/stream.ts) validate against this same list.
export const KNOWN_KINDS: (WriteKind | InfoKind | "liked" | "unliked")[] = [
  ...new Set([...Object.keys(WRITE_KINDS_MAP), ...Object.keys(INFO_KINDS_MAP), ...Object.keys(LIKE_KINDS_MAP)]),
] as (WriteKind | InfoKind | "liked" | "unliked")[];
const KNOWN_KINDS_SET = new Set<string>(KNOWN_KINDS);

// Exported: routes/stream.ts's `since`/`kinds` query params are parsed the
// same way `/v1/changes`' are (12 §2.2) -- one set of rules, one place.
export function parseSince(raw: string | undefined): number {
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

export function parseKinds(raw: string | undefined): string[] | undefined {
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

// X3 (12 §3 X3, §6.6): `layout=` (a `byRef` ref -- id or name, same rule
// `/v1/layouts/{ref}` uses) resolved to an id up front, so an unknown ref
// 404s before any feed read, and so the changelog page (which shares this
// exact resolution) can never disagree with `/v1/changes` about what
// `layout=` means -- that agreement is what makes LDB-H3 checkable.
// Exported for `routes/changelog.ts`.
export async function resolveLayoutFilter(db: Bindings["DB"], ref: string | undefined): Promise<string | undefined> {
  if (ref === undefined) return undefined;
  const rec = await byRef(db, ref);
  if (rec === null) throw notFound(`no layout '${ref}'`, ref);
  return rec.id;
}

export const changesRoute = new Hono<{ Bindings: Bindings }>();

changesRoute.get("/v1/changes", async (c) => {
  const db = c.env.DB;
  const since = parseSince(c.req.query("since"));
  const limit = parseLimit(c.req.query("limit"));
  const kinds = parseKinds(c.req.query("kinds"));
  const actor = c.req.query("actor");
  const layoutId = await resolveLayoutFilter(db, c.req.query("layout"));
  const filter: FeedFilter = { layoutId, actor };

  const seq = await headSeq(db);
  const etag = await etagFor(seq, { since, limit, kinds: kinds ?? null, layout: layoutId ?? null, actor: actor ?? null });
  const short = await conditional(c, etag, CACHE_CONTROL);
  if (short) return short;

  const { next, items } = await feed(db, since, limit, kinds, filter);
  const res = c.json({ next, items });
  res.headers.set("ETag", etag);
  res.headers.set("Cache-Control", CACHE_CONTROL);
  await cachePut(c, res.clone());
  return res;
});
