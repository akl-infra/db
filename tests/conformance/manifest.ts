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

import dump404 from "./dump/404.json" with { type: "json" };
import dumpLatest404 from "./dump-latest/404.json" with { type: "json" };
import dumpKey404 from "./dump-key/404.json" with { type: "json" };
import dumpMonthly404 from "./dump-monthly/404.json" with { type: "json" };

// 09 §3 T2's write verbs. Not yet cross-checked by the REQUIRED enumeration
// below (that rebuild -- a (method, status) sweep over every verb, T3-T5's
// admin/PATCH/like routes included -- is T6's), but these ARE exercised by
// the "conformance fixtures" describe loop like any other case.
import layoutsWritePostOk from "./layouts-write/post-201.json" with { type: "json" };
import layoutsWritePostInvalidName from "./layouts-write/post-400-invalid_name.json" with { type: "json" };
import layoutsWritePostNameTaken from "./layouts-write/post-409-name_taken.json" with { type: "json" };
import layoutsWritePutOk from "./layouts-write/put-200.json" with { type: "json" };
import layoutsWritePutStale from "./layouts-write/put-409-stale.json" with { type: "json" };
import layoutsWriteDeleteOk from "./layouts-write/delete-200.json" with { type: "json" };
import layoutsWriteRestoreOk from "./layouts-write/restore-200.json" with { type: "json" };
import layoutsWriteRestoreNotDeleted from "./layouts-write/restore-400-not_deleted.json" with { type: "json" };
import layoutsWriteTransferOk from "./layouts-write/transfer-200.json" with { type: "json" };
// T4's PATCH cases (09 §3 T4, §4): a 2xx, an `unsupported_for_format`, and
// one `bad_request` -- following the same "not yet cross-checked by
// REQUIRED, but exercised by the conformance loop like any other case"
// note above (T6's sweep is what adds PATCH to REQUIRED).
import layoutsWritePatchOk from "./layouts-write/patch-200.json" with { type: "json" };
import layoutsWritePatchUnsupported from "./layouts-write/patch-400-unsupported_for_format.json" with { type: "json" };
import layoutsWritePatchBadRequest from "./layouts-write/patch-400-bad_request.json" with { type: "json" };

// 09 §3 T3's admin routes. Only `GET /v1/admin/admins` is REQUIRED-enumerated
// below (the enumeration stays GET-only until T6's sweep, 09 §4) -- these
// three cases are what satisfies that requirement.
import adminAdminsOk from "./admin-admins/200.json" with { type: "json" };
import adminAdminsForbidden from "./admin-admins/403.json" with { type: "json" };
import adminAdminsUnauthorized from "./admin-admins/401.json" with { type: "json" };

// A single request as `runRequest` fires it -- shared by the main
// (asserted) request and, for a write case, its `setup` steps (fired first
// and discarded: e.g. the first of two POSTs that produces a name clash).
export interface ConformanceStep {
  method: string;
  path: string;
  bearer?: string; // Authorization: Bearer <bearer> (09 §3 T2's write routes)
  body?: unknown; // JSON.stringify'd, Content-Type set
  headers?: Record<string, string>; // e.g. If-Match -- merged in on top of bearer/Content-Type
}

export interface ConformanceRequest extends ConformanceStep {
  // First GET the same path with no conditional header to learn the live
  // ETag, then replay with `If-None-Match` set to it (03 §5's ETag is
  // derived from the live event-log head, so no fixed fixture value would
  // stay correct across seeds).
  ifNoneMatchSelf?: boolean;
  // Fired in order before the asserted request, responses discarded --
  // e.g. a first POST that must land so the second one collides on the
  // name, or a first PUT whose rev the asserted one is now stale against.
  setup?: ConformanceStep[];
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

  // No dump exists in the conformance seed (`seedUpstream100()` runs only
  // the cmini import tick, never the `0 3 * * *` dump cron) -- every dump
  // route 404s deterministically (07 §6 S7).
  kase("dump/404", "/v1/dump", dump404),
  kase("dump-latest/404", "/v1/dump/latest.json", dumpLatest404),
  kase("dump-key/404", "/v1/dump/:key", dumpKey404),
  kase("dump-monthly/404", "/v1/dump/monthly/:key", dumpMonthly404),

  kase("layouts-write/post-201", "/v1/layouts", layoutsWritePostOk),
  kase("layouts-write/post-400-invalid_name", "/v1/layouts", layoutsWritePostInvalidName),
  kase("layouts-write/post-409-name_taken", "/v1/layouts", layoutsWritePostNameTaken),
  kase("layouts-write/put-200", "/v1/layouts/:ref", layoutsWritePutOk),
  kase("layouts-write/put-409-stale", "/v1/layouts/:ref", layoutsWritePutStale),
  kase("layouts-write/delete-200", "/v1/layouts/:ref", layoutsWriteDeleteOk),
  kase("layouts-write/restore-200", "/v1/layouts/:ref/restore", layoutsWriteRestoreOk),
  kase("layouts-write/restore-400-not_deleted", "/v1/layouts/:ref/restore", layoutsWriteRestoreNotDeleted),
  kase("layouts-write/transfer-200", "/v1/layouts/:ref/transfer", layoutsWriteTransferOk),

  kase("admin-admins/200", "/v1/admin/admins", adminAdminsOk),
  kase("admin-admins/403", "/v1/admin/admins", adminAdminsForbidden),
  kase("admin-admins/401", "/v1/admin/admins", adminAdminsUnauthorized),

  // T4: each case creates its own record via its own `request.setup` (see
  // conformance.test.ts's seedWriteFixtures comment) -- no shared seed, no
  // ordering dependency between these three.
  kase("layouts-write/patch-400-bad_request", "/v1/layouts/:ref", layoutsWritePatchBadRequest),
  kase("layouts-write/patch-400-unsupported_for_format", "/v1/layouts/:ref", layoutsWritePatchUnsupported),
  kase("layouts-write/patch-200", "/v1/layouts/:ref", layoutsWritePatchOk),
];
