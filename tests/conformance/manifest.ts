// The conformance case manifest (07 §6 S6): every `tests/conformance/
// <route>/<case>.json` fixture, statically imported. NOT read via `fs` at
// runtime -- `node:fs` inside a workers-project test file sees that test
// file's own module graph, not the host filesystem (tests/import/
// fake-upstream.ts's comment explains why; the same constraint applies
// here), so the case set is a hand-maintained list of imports rather than
// a directory glob. `tests/api/conformance.test.ts` cross-checks this list
// against the live route table (`app.routes`) and the error vocabulary
// (`core/errors.ts`) so an uncovered route or status still fails loudly.
import metaOk from "./meta/200.json" with { type: "json" };
import me401 from "./me/401.json" with { type: "json" };
import meta304 from "./meta/304.json" with { type: "json" };

import layoutsListOk from "./layouts-list/200.json" with { type: "json" };
import layoutsListBadLimit from "./layouts-list/400-bad_request.json" with { type: "json" };
import layoutsListBadFormat from "./layouts-list/400-unknown_format.json" with { type: "json" };
import layoutsList304 from "./layouts-list/304.json" with { type: "json" };

import layoutsDetailOk from "./layouts-detail/200.json" with { type: "json" };
import layoutsDetailOkCmini from "./layouts-detail/200-cmini.json" with { type: "json" };
import layoutsDetail404 from "./layouts-detail/404.json" with { type: "json" };
import layoutsDetailBadFormat from "./layouts-detail/400-unknown_format.json" with { type: "json" };

import layoutsLikesOk from "./layouts-likes/200.json" with { type: "json" };
import layoutsLikes404 from "./layouts-likes/404.json" with { type: "json" };

import layoutsHistoryOk from "./layouts-history/200.json" with { type: "json" };
import layoutsHistory404 from "./layouts-history/404.json" with { type: "json" };

import layoutsRevOk from "./layouts-rev/200.json" with { type: "json" };
import layoutsRev404 from "./layouts-rev/404.json" with { type: "json" };
import layoutsRevBadN from "./layouts-rev/400-bad_request.json" with { type: "json" };
import layoutsRevBadFormat from "./layouts-rev/400-unknown_format.json" with { type: "json" };

import authorsListOk from "./authors-list/200.json" with { type: "json" };
import authorsList304 from "./authors-list/304.json" with { type: "json" };
import authorsDetailOk from "./authors-detail/200.json" with { type: "json" };
import authorsDetail404 from "./authors-detail/404.json" with { type: "json" };

import formatsListOk from "./formats-list/200.json" with { type: "json" };
import formatsSchemaOk from "./formats-schema/200.json" with { type: "json" };
import formatsSchema404 from "./formats-schema/404.json" with { type: "json" };

import changesOk from "./changes/200.json" with { type: "json" };
import changes304 from "./changes/304.json" with { type: "json" };
import changesBadSince from "./changes/400-bad_request-since.json" with { type: "json" };
import changesBadKinds from "./changes/400-bad_request-kinds.json" with { type: "json" };

export interface ConformanceRequest {
  method: string;
  path: string;
  // First GET the same path with no conditional header to learn the live
  // ETag, then replay with `If-None-Match` set to it (03 §5's ETag is
  // derived from the live event-log head, so no fixed fixture value would
  // stay correct across seeds).
  ifNoneMatchSelf?: boolean;
}

export interface ConformanceResponse {
  status: number;
  headers?: Record<string, string>; // exact-match subset, case-insensitive names
  body?: unknown; // compared via canonical(normalizeIds(...)); absent for 304s
}

export interface ConformanceCase {
  id: string;
  // Hono's own path-template spelling (":param", not "{param}") -- must
  // match a live entry in `app.routes` (checked by conformance.test.ts).
  routeTemplate: string;
  request: ConformanceRequest;
  response: ConformanceResponse;
}

function kase(id: string, routeTemplate: string, data: unknown): ConformanceCase {
  const d = data as { request: ConformanceRequest; response: ConformanceResponse };
  return { id, routeTemplate, request: d.request, response: d.response };
}

export const CASES: ConformanceCase[] = [
  kase("meta/200", "/v1/meta", metaOk),
  kase("meta/304", "/v1/meta", meta304),
  kase("me/401", "/v1/me", me401),

  kase("layouts-list/200", "/v1/layouts", layoutsListOk),
  kase("layouts-list/400-bad_request", "/v1/layouts", layoutsListBadLimit),
  kase("layouts-list/400-unknown_format", "/v1/layouts", layoutsListBadFormat),
  kase("layouts-list/304", "/v1/layouts", layoutsList304),

  kase("layouts-detail/200", "/v1/layouts/:ref", layoutsDetailOk),
  kase("layouts-detail/200-cmini", "/v1/layouts/:ref", layoutsDetailOkCmini),
  kase("layouts-detail/404", "/v1/layouts/:ref", layoutsDetail404),
  kase("layouts-detail/400-unknown_format", "/v1/layouts/:ref", layoutsDetailBadFormat),

  kase("layouts-likes/200", "/v1/layouts/:ref/likes", layoutsLikesOk),
  kase("layouts-likes/404", "/v1/layouts/:ref/likes", layoutsLikes404),

  kase("layouts-history/200", "/v1/layouts/:ref/history", layoutsHistoryOk),
  kase("layouts-history/404", "/v1/layouts/:ref/history", layoutsHistory404),

  kase("layouts-rev/200", "/v1/layouts/:ref/rev/:n", layoutsRevOk),
  kase("layouts-rev/404", "/v1/layouts/:ref/rev/:n", layoutsRev404),
  kase("layouts-rev/400-bad_request", "/v1/layouts/:ref/rev/:n", layoutsRevBadN),
  kase("layouts-rev/400-unknown_format", "/v1/layouts/:ref/rev/:n", layoutsRevBadFormat),

  kase("authors-list/200", "/v1/authors", authorsListOk),
  kase("authors-list/304", "/v1/authors", authorsList304),
  kase("authors-detail/200", "/v1/authors/:user_id", authorsDetailOk),
  kase("authors-detail/404", "/v1/authors/:user_id", authorsDetail404),

  kase("formats-list/200", "/v1/formats", formatsListOk),
  kase("formats-schema/200", "/v1/formats/:name/:major/schema.json", formatsSchemaOk),
  kase("formats-schema/404", "/v1/formats/:name/:major/schema.json", formatsSchema404),

  kase("changes/200", "/v1/changes", changesOk),
  kase("changes/304", "/v1/changes", changes304),
  kase("changes/400-bad_request-since", "/v1/changes", changesBadSince),
  kase("changes/400-bad_request-kinds", "/v1/changes", changesBadKinds),
];
