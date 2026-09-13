// The HTTP API's own version -- design/layout-db/25-api-versioning.md
// "Policy". Deliberately distinct from a stored FORMAT's own major
// (`spark/1`, `mana2/1` -- `21-formats.md`/`22-spark-spec.md` §0, LDB-F6/
// F18/F19): that versioning covers one PAYLOAD shape a record's `formats`
// map carries; this one covers the ENVELOPE and route surface every
// response (of any format) rides in. The two change independently -- a
// new `spark/2` needs no `/v2`, and a `/v2` would carry whichever format
// majors still validate.
//
// **The promise `/v1` makes**: only additive changes land under it -- a
// new optional field, a new route, a new enum value somewhere the docs
// already say to tolerate an unknown one (adoption.md §7's reader
// obligations: ignore unknown fields, PATCH instead of PUT if you don't
// understand every field). A removal, a rename, or a meaning change under
// an unchanged shape (24-spark-wire-review.md finding 8's own example, one
// level up: the finger `LT` meaning change) is a NEW major, `/v2`,
// registered beside `/v1` -- never edited in place. No `/v2` exists yet;
// nothing here builds one, this module just states the rule the contract
// test (`tests/contract/contract.test.ts`, LDB-V4/V5) enforces against it.
import { WIRE_VERSION } from "./etag";

export const API_MAJOR = 1;

// The minor is `WIRE_VERSION` itself (etag.ts) -- see the comment on that
// constant for why this file does not define a second counter. Every
// `/v1` wire-shape change already has to bump `WIRE_VERSION` (LDB-R1) so a
// pre-deploy `If-None-Match`/edge-cached body can't keep serving the old
// shape; reusing it as the public minor means there is exactly one place
// a shape-changing PR touches, and the ETag already invalidates itself on
// every bump this API_MINOR reports moving.
export const API_MINOR = WIRE_VERSION;

export function apiVersionString(): string {
  return `${API_MAJOR}.${API_MINOR}`;
}

// Carried on EVERY response, success or error (`src/index.ts`'s global
// middleware + `onError`) -- `X-AKLDB-API`, not a generic `X-API-Version`,
// so a client juggling several APIs (akl-db plus, say, Discord's own) can
// never mistake whose version it just read (LDB-V2).
export const API_VERSION_HEADER = "X-AKLDB-API";

// Rebuilds a Response with the version header set, preserving status,
// headers and body (including a streamed body -- the dump routes never
// buffer their gzip body, and re-wrapping a `ReadableStream` reference
// doesn't consume it). Never mutates `res.headers` in place: a Response
// that came back from `caches.default.match()` can have read-only headers
// in some runtimes, and every response here -- fresh, cached, or a raw 304
// built by `core/etag.ts`'s `conditional()` -- must go through the same
// path so the header is never present on some responses and absent on
// others depending on which internal branch produced them.
export function withApiVersionHeader(res: Response): Response {
  const headers = new Headers(res.headers);
  headers.set(API_VERSION_HEADER, apiVersionString());
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

// -- Deprecation (policy (e)) --------------------------------------------
//
// A registered route may be marked deprecated with a minimum notice period
// before its `sunset` date; nothing is deprecated today (`DEPRECATIONS` is
// empty), so no live response carries these headers yet -- the mechanism
// exists so the FIRST deprecation doesn't also have to invent it under
// time pressure. `MIN_DEPRECATION_NOTICE_DAYS` is normative: a deprecation
// entry whose `sunset` is closer than that to its `since` is a bug, caught
// by `tests/core/version.test.ts`'s own property/matrix, not just prose.
export const MIN_DEPRECATION_NOTICE_DAYS = 90;

export interface RouteDeprecation {
  // Exact `METHOD PATH` as the route pattern appears in `app.routes` (a
  // `:param` segment literal, e.g. `"GET /v1/layouts/:ref"`) -- matched
  // against `c.req.method + " " + c.req.routePath`, never the resolved
  // path, so one entry covers every concrete ref.
  route: string;
  since: string; // ISO date the deprecation was announced
  sunset: string; // ISO date after which the route may be removed
  message: string; // carried nowhere on the wire; for the changelog/docs
}

// Empty on purpose (2026-09-13): nothing is deprecated. Add an entry here,
// a `db/CHANGELOG-API.md` line, and a `db/docs/adoption.md` mention
// (sign-off required, same as any adoption.md edit) to deprecate a route.
export const DEPRECATIONS: readonly RouteDeprecation[] = [];

function toHttpDate(iso: string): string {
  return new Date(iso).toUTCString();
}

// Pure (no Hono `Context`) so it's unit-testable without a live router --
// `withApiVersionHeader`'s caller in `src/index.ts` is the one live call
// site. Returns `{}` (no headers) for a route with no matching entry.
export function deprecationHeadersFor(method: string, routePath: string, deprecations: readonly RouteDeprecation[] = DEPRECATIONS): Record<string, string> {
  const key = `${method.toUpperCase()} ${routePath}`;
  const entry = deprecations.find((d) => d.route === key);
  if (entry === undefined) return {};
  return { Deprecation: toHttpDate(entry.since), Sunset: toHttpDate(entry.sunset) };
}
