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

// 10 C1: the client-lane admin routes -- same GET-only pattern as
// admin-admins above (T6's sweep hasn't reached these yet -- a future PR
// adds their own A-group + write-verb rows to T6_CASES). `me/200-signed`
// proves the `signed` step works end to end over a real live route.
import adminClientsOk from "./admin-clients/200.json" with { type: "json" };
import adminClientsForbidden from "./admin-clients/403.json" with { type: "json" };
import adminClientsUnauthorized from "./admin-clients/401.json" with { type: "json" };
import me200Signed from "./me/200-signed.json" with { type: "json" };
import adminClientsPost201 from "./admin-clients/post-201.json" with { type: "json" };
import adminClientsPost400BadRequest from "./admin-clients/post-400-bad_request.json" with { type: "json" };
import adminClientsPost401TokenInvalid from "./admin-clients/post-401-token_invalid.json" with { type: "json" };
import adminClientsPost401Unauthorized from "./admin-clients/post-401-unauthorized.json" with { type: "json" };
import adminClientsPost403NotAdmin from "./admin-clients/post-403-not_admin.json" with { type: "json" };
import adminClientsPost429 from "./admin-clients/post-429.json" with { type: "json" };
import adminClientsPost503IdentityUnavailable from "./admin-clients/post-503-identity_unavailable.json" with { type: "json" };
import adminClientsDelete200 from "./admin-clients/delete-200.json" with { type: "json" };
import adminClientsDelete401TokenInvalid from "./admin-clients/delete-401-token_invalid.json" with { type: "json" };
import adminClientsDelete401Unauthorized from "./admin-clients/delete-401-unauthorized.json" with { type: "json" };
import adminClientsDelete403NotAdmin from "./admin-clients/delete-403-not_admin.json" with { type: "json" };
import adminClientsDelete404 from "./admin-clients/delete-404.json" with { type: "json" };
import adminClientsDelete429 from "./admin-clients/delete-429.json" with { type: "json" };
import adminClientsDelete503IdentityUnavailable from "./admin-clients/delete-503-identity_unavailable.json" with { type: "json" };
import adminClientsGet401TokenInvalid from "./admin-clients/get-401-token_invalid.json" with { type: "json" };
import adminClientsGet503IdentityUnavailable from "./admin-clients/get-503-identity_unavailable.json" with { type: "json" };

// T5's likes and write rate limit.
import layoutsLikePutOk from "./layouts-like/put-200.json" with { type: "json" };
import layoutsLikeDeleteOk from "./layouts-like/delete-200.json" with { type: "json" };
import layoutsLikeQwerty from "./layouts-like/put-400-qwerty.json" with { type: "json" };
import ratelimit429 from "./ratelimit/429.json" with { type: "json" };

// T6 (09 §3 T6, §4): the full (method, route, status[, code]) sweep. Every
// route the phase-2 error vocabulary reaches (09 §2.1) gets its own
// A-group (401 unauthorized / 401 token_invalid / 503 identity_unavailable)
// and, for every write route, its own 429 -- plus each route's own
// bad_request/invalid_payload/unknown_format/not_owner/not_found/stale/
// name_taken/last_admins rows per 09 §4. `T6_CASES` (below `kase()`) is
// spread into `CASES` after the T2-T5 cases above, so none of THEIR
// pinned literals (`put-409-stale`'s `last_write.seq`, e.g.) shift.
import me200 from "./me/200.json" with { type: "json" };
import me401TokenInvalid from "./me/401-token_invalid.json" with { type: "json" };
import me503IdentityUnavailable from "./me/503-identity_unavailable.json" with { type: "json" };
import layoutsWriteDelete400BadRequest from "./layouts-write/delete-400-bad_request.json" with { type: "json" };
import layoutsWriteDelete401TokenInvalid from "./layouts-write/delete-401-token_invalid.json" with { type: "json" };
import layoutsWriteDelete401Unauthorized from "./layouts-write/delete-401-unauthorized.json" with { type: "json" };
import layoutsWriteDelete403NotOwner from "./layouts-write/delete-403-not_owner.json" with { type: "json" };
import layoutsWriteDelete404 from "./layouts-write/delete-404.json" with { type: "json" };
import layoutsWriteDelete409Stale from "./layouts-write/delete-409-stale.json" with { type: "json" };
import layoutsWriteDelete429 from "./layouts-write/delete-429.json" with { type: "json" };
import layoutsWriteDelete503IdentityUnavailable from "./layouts-write/delete-503-identity_unavailable.json" with { type: "json" };
import layoutsWritePatch200Renamed from "./layouts-write/patch-200-renamed.json" with { type: "json" };
import layoutsWritePatch200Updated from "./layouts-write/patch-200-updated.json" with { type: "json" };
import layoutsWritePatch400InvalidName from "./layouts-write/patch-400-invalid_name.json" with { type: "json" };
import layoutsWritePatch400InvalidPayload from "./layouts-write/patch-400-invalid_payload.json" with { type: "json" };
import layoutsWritePatch401TokenInvalid from "./layouts-write/patch-401-token_invalid.json" with { type: "json" };
import layoutsWritePatch401Unauthorized from "./layouts-write/patch-401-unauthorized.json" with { type: "json" };
import layoutsWritePatch403NotOwner from "./layouts-write/patch-403-not_owner.json" with { type: "json" };
import layoutsWritePatch404 from "./layouts-write/patch-404.json" with { type: "json" };
import layoutsWritePatch409NameTaken from "./layouts-write/patch-409-name_taken.json" with { type: "json" };
import layoutsWritePatch409Stale from "./layouts-write/patch-409-stale.json" with { type: "json" };
import layoutsWritePatch429 from "./layouts-write/patch-429.json" with { type: "json" };
import layoutsWritePatch503IdentityUnavailable from "./layouts-write/patch-503-identity_unavailable.json" with { type: "json" };
import layoutsWritePost400BadRequest from "./layouts-write/post-400-bad_request.json" with { type: "json" };
import layoutsWritePost400InvalidPayload from "./layouts-write/post-400-invalid_payload.json" with { type: "json" };
import layoutsWritePost400UnknownFormat from "./layouts-write/post-400-unknown_format.json" with { type: "json" };
import layoutsWritePost401TokenInvalid from "./layouts-write/post-401-token_invalid.json" with { type: "json" };
import layoutsWritePost401Unauthorized from "./layouts-write/post-401-unauthorized.json" with { type: "json" };
import layoutsWritePost503IdentityUnavailable from "./layouts-write/post-503-identity_unavailable.json" with { type: "json" };
import layoutsWritePut400BadRequest from "./layouts-write/put-400-bad_request.json" with { type: "json" };
import layoutsWritePut400InvalidPayload from "./layouts-write/put-400-invalid_payload.json" with { type: "json" };
import layoutsWritePut400UnknownFormat from "./layouts-write/put-400-unknown_format.json" with { type: "json" };
import layoutsWritePut401TokenInvalid from "./layouts-write/put-401-token_invalid.json" with { type: "json" };
import layoutsWritePut401Unauthorized from "./layouts-write/put-401-unauthorized.json" with { type: "json" };
import layoutsWritePut403NotOwner from "./layouts-write/put-403-not_owner.json" with { type: "json" };
import layoutsWritePut404 from "./layouts-write/put-404.json" with { type: "json" };
import layoutsWritePut429 from "./layouts-write/put-429.json" with { type: "json" };
import layoutsWritePut503IdentityUnavailable from "./layouts-write/put-503-identity_unavailable.json" with { type: "json" };
import layoutsWriteRestore401TokenInvalid from "./layouts-write/restore-401-token_invalid.json" with { type: "json" };
import layoutsWriteRestore401Unauthorized from "./layouts-write/restore-401-unauthorized.json" with { type: "json" };
import layoutsWriteRestore403NotOwner from "./layouts-write/restore-403-not_owner.json" with { type: "json" };
import layoutsWriteRestore404 from "./layouts-write/restore-404.json" with { type: "json" };
import layoutsWriteRestore409NameTaken from "./layouts-write/restore-409-name_taken.json" with { type: "json" };
import layoutsWriteRestore429 from "./layouts-write/restore-429.json" with { type: "json" };
import layoutsWriteRestore503IdentityUnavailable from "./layouts-write/restore-503-identity_unavailable.json" with { type: "json" };
import layoutsWriteTransfer400BadRequest from "./layouts-write/transfer-400-bad_request.json" with { type: "json" };
import layoutsWriteTransfer401TokenInvalid from "./layouts-write/transfer-401-token_invalid.json" with { type: "json" };
import layoutsWriteTransfer401Unauthorized from "./layouts-write/transfer-401-unauthorized.json" with { type: "json" };
import layoutsWriteTransfer403NotOwner from "./layouts-write/transfer-403-not_owner.json" with { type: "json" };
import layoutsWriteTransfer404 from "./layouts-write/transfer-404.json" with { type: "json" };
import layoutsWriteTransfer429 from "./layouts-write/transfer-429.json" with { type: "json" };
import layoutsWriteTransfer503IdentityUnavailable from "./layouts-write/transfer-503-identity_unavailable.json" with { type: "json" };
import layoutsLikeDelete400Qwerty from "./layouts-like/delete-400-qwerty.json" with { type: "json" };
import layoutsLikeDelete401TokenInvalid from "./layouts-like/delete-401-token_invalid.json" with { type: "json" };
import layoutsLikeDelete401Unauthorized from "./layouts-like/delete-401-unauthorized.json" with { type: "json" };
import layoutsLikeDelete404 from "./layouts-like/delete-404.json" with { type: "json" };
import layoutsLikeDelete429 from "./layouts-like/delete-429.json" with { type: "json" };
import layoutsLikeDelete503IdentityUnavailable from "./layouts-like/delete-503-identity_unavailable.json" with { type: "json" };
import layoutsLikePut401TokenInvalid from "./layouts-like/put-401-token_invalid.json" with { type: "json" };
import layoutsLikePut401Unauthorized from "./layouts-like/put-401-unauthorized.json" with { type: "json" };
import layoutsLikePut404 from "./layouts-like/put-404.json" with { type: "json" };
import layoutsLikePut429 from "./layouts-like/put-429.json" with { type: "json" };
import layoutsLikePut503IdentityUnavailable from "./layouts-like/put-503-identity_unavailable.json" with { type: "json" };
import adminAdminsDelete401TokenInvalid from "./admin-admins/delete-401-token_invalid.json" with { type: "json" };
import adminAdminsDelete401Unauthorized from "./admin-admins/delete-401-unauthorized.json" with { type: "json" };
import adminAdminsDelete429 from "./admin-admins/delete-429.json" with { type: "json" };
import adminAdminsDelete503IdentityUnavailable from "./admin-admins/delete-503-identity_unavailable.json" with { type: "json" };
import adminAdminsGet401TokenInvalid from "./admin-admins/get-401-token_invalid.json" with { type: "json" };
import adminAdminsGet503IdentityUnavailable from "./admin-admins/get-503-identity_unavailable.json" with { type: "json" };
import adminAdminsPost401TokenInvalid from "./admin-admins/post-401-token_invalid.json" with { type: "json" };
import adminAdminsPost401Unauthorized from "./admin-admins/post-401-unauthorized.json" with { type: "json" };
import adminAdminsPost429 from "./admin-admins/post-429.json" with { type: "json" };
import adminAdminsPost503IdentityUnavailable from "./admin-admins/post-503-identity_unavailable.json" with { type: "json" };
import adminAdminsDelete409LastAdmins from "./admin-admins/delete-409-last_admins.json" with { type: "json" };
import adminAdminsPost201 from "./admin-admins/post-201.json" with { type: "json" };
import adminAdminsPost200Idempotent from "./admin-admins/post-200-idempotent.json" with { type: "json" };
import adminAdminsDelete200 from "./admin-admins/delete-200.json" with { type: "json" };
import adminAdminsDelete404 from "./admin-admins/delete-404.json" with { type: "json" };
import adminAdminsPost400BadRequest from "./admin-admins/post-400-bad_request.json" with { type: "json" };
import adminAdminsPost403NotAdmin from "./admin-admins/post-403-not_admin.json" with { type: "json" };
import adminAdminsDelete403NotAdmin from "./admin-admins/delete-403-not_admin.json" with { type: "json" };
import adminImportPause200 from "./admin-import/pause-200.json" with { type: "json" };
import adminImportPause401TokenInvalid from "./admin-import/pause-401-token_invalid.json" with { type: "json" };
import adminImportPause401Unauthorized from "./admin-import/pause-401-unauthorized.json" with { type: "json" };
import adminImportPause403NotAdmin from "./admin-import/pause-403-not_admin.json" with { type: "json" };
import adminImportPause429 from "./admin-import/pause-429.json" with { type: "json" };
import adminImportPause503IdentityUnavailable from "./admin-import/pause-503-identity_unavailable.json" with { type: "json" };
import adminImportResume200 from "./admin-import/resume-200.json" with { type: "json" };
import adminImportResume401TokenInvalid from "./admin-import/resume-401-token_invalid.json" with { type: "json" };
import adminImportResume401Unauthorized from "./admin-import/resume-401-unauthorized.json" with { type: "json" };
import adminImportResume403NotAdmin from "./admin-import/resume-403-not_admin.json" with { type: "json" };
import adminImportResume429 from "./admin-import/resume-429.json" with { type: "json" };
import adminImportResume503IdentityUnavailable from "./admin-import/resume-503-identity_unavailable.json" with { type: "json" };

// X1 (12 §3 X1, §4): webhooks + the SSE stream.
import webhooksPost201 from "./webhooks/post-201.json" with { type: "json" };
import webhooksPost401Unauthorized from "./webhooks/post-401-unauthorized.json" with { type: "json" };
import webhooksPost401TokenInvalid from "./webhooks/post-401-token_invalid.json" with { type: "json" };
import webhooksPost503IdentityUnavailable from "./webhooks/post-503-identity_unavailable.json" with { type: "json" };
import webhooksPost400BadRequestUrl from "./webhooks/post-400-bad_request-url.json" with { type: "json" };
import webhooksPost400BadRequestSecret from "./webhooks/post-400-bad_request-secret.json" with { type: "json" };
import webhooksPost400BadRequestKinds from "./webhooks/post-400-bad_request-kinds.json" with { type: "json" };
import webhooksPost400BadRequestOwnerFilter from "./webhooks/post-400-bad_request-owner_filter.json" with { type: "json" };
import webhooksPost409TooManyWebhooks from "./webhooks/post-409-too_many_webhooks.json" with { type: "json" };
import webhooksPost429 from "./webhooks/post-429.json" with { type: "json" };
import webhooksGet200 from "./webhooks/get-200.json" with { type: "json" };
import webhooksGet401Unauthorized from "./webhooks/get-401-unauthorized.json" with { type: "json" };
import webhooksGet401TokenInvalid from "./webhooks/get-401-token_invalid.json" with { type: "json" };
import webhooksGet503IdentityUnavailable from "./webhooks/get-503-identity_unavailable.json" with { type: "json" };
import webhooksGet403NotAdmin from "./webhooks/get-403-not_admin.json" with { type: "json" };
import webhooksDelete200 from "./webhooks/delete-200.json" with { type: "json" };
import webhooksDelete401Unauthorized from "./webhooks/delete-401-unauthorized.json" with { type: "json" };
import webhooksDelete401TokenInvalid from "./webhooks/delete-401-token_invalid.json" with { type: "json" };
import webhooksDelete503IdentityUnavailable from "./webhooks/delete-503-identity_unavailable.json" with { type: "json" };
import webhooksDelete404 from "./webhooks/delete-404.json" with { type: "json" };
import webhooksDelete429 from "./webhooks/delete-429.json" with { type: "json" };

import changesStream200 from "./changes-stream/200.json" with { type: "json" };
import changesStream400BadRequest from "./changes-stream/400-bad_request.json" with { type: "json" };
import changesStream503StreamUnavailable from "./changes-stream/503-stream_unavailable.json" with { type: "json" };

// A single request as `runRequest` fires it -- shared by the main
// (asserted) request and, for a write case, its `setup` steps (fired first
// and discarded: e.g. the first of two POSTs that produces a name clash).
export interface ConformanceStep {
  method: string;
  path: string;
  bearer?: string; // Authorization: Bearer <bearer> (09 §3 T2's write routes)
  // 10 C1: sign this request on the client lane instead of a bearer --
  // `actor` is the asserted Discord user id; the five X-Akl-* headers are
  // computed at fire time (tests/api/support.ts's fireConformanceStep) with
  // the conformance seed's well-known client (CONFORMANCE_CLIENT_ID, the
  // vectors' k1 key) -- mutually exclusive with `bearer`.
  signed?: { actor: string };
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
  // T6: true iff the case's bearer needs `conformance.test.ts`'s
  // `ensureWriteFixtures()` (the stubbed FakeDiscord + the T2-T5 write
  // fixtures) to resolve -- i.e. every case whose request carries a
  // `bearer` naming one of `seedWriteFixtures`'s tokens, plus any case that
  // addresses a record `seedWriteFixtures` creates. Drives two things: (1)
  // `conformance.test.ts`'s own describe loop, which triggers
  // `ensureWriteFixtures()` before such a case instead of a hand-listed set
  // of id prefixes (the previous mechanism -- prefixes can't distinguish
  // "me/401", which needs no Discord stub, from a later "me/200" that
  // does, without breaking the ordering `meta/200`/`authors-list/200`'s
  // pinned counts depend on, 07 §6 S6); (2) `tests/rehost.test.ts`'s
  // replay set, which excludes every `needsSeed` case for the same reason
  // it always has (no FakeDiscord stub, no write fixtures, there).
  needsSeed?: boolean;
}

function kase(id: string, routeTemplate: string, data: unknown, needsSeed?: boolean): ConformanceCase {
  const d = data as { request: ConformanceRequest; response: ConformanceResponse };
  return { id, routeTemplate, request: d.request, response: d.response, ...(needsSeed ? { needsSeed: true } : {}) };
}

// T6 (09 §3 T6, §4): the (method, route, status[, code]) sweep, grouped by
// route in the same order the imports above declare them. The
// admin-admins mutating cases (409 last_admins, the two add cases, the
// delete cases) are hand-ordered at the end of that group so the admins
// table starts at exactly one row (the 409 case) before anything else
// changes its count -- moving one of those six without preserving that
// order breaks the 409 case's `count: 1` literal.
export const T6_CASES: ConformanceCase[] = [
  kase("me/200", "/v1/me", me200, true),
  kase("me/401-token_invalid", "/v1/me", me401TokenInvalid, true),
  kase("me/503-identity_unavailable", "/v1/me", me503IdentityUnavailable, true),
  kase("layouts-write/delete-400-bad_request", "/v1/layouts/:ref", layoutsWriteDelete400BadRequest, true),
  kase("layouts-write/delete-401-token_invalid", "/v1/layouts/:ref", layoutsWriteDelete401TokenInvalid, true),
  kase("layouts-write/delete-401-unauthorized", "/v1/layouts/:ref", layoutsWriteDelete401Unauthorized, true),
  kase("layouts-write/delete-403-not_owner", "/v1/layouts/:ref", layoutsWriteDelete403NotOwner, true),
  kase("layouts-write/delete-404", "/v1/layouts/:ref", layoutsWriteDelete404, true),
  kase("layouts-write/delete-409-stale", "/v1/layouts/:ref", layoutsWriteDelete409Stale, true),
  kase("layouts-write/delete-429", "/v1/layouts/:ref", layoutsWriteDelete429, true),
  kase("layouts-write/delete-503-identity_unavailable", "/v1/layouts/:ref", layoutsWriteDelete503IdentityUnavailable, true),
  kase("layouts-write/patch-200-renamed", "/v1/layouts/:ref", layoutsWritePatch200Renamed, true),
  kase("layouts-write/patch-200-updated", "/v1/layouts/:ref", layoutsWritePatch200Updated, true),
  kase("layouts-write/patch-400-invalid_name", "/v1/layouts/:ref", layoutsWritePatch400InvalidName, true),
  kase("layouts-write/patch-400-invalid_payload", "/v1/layouts/:ref", layoutsWritePatch400InvalidPayload, true),
  kase("layouts-write/patch-401-token_invalid", "/v1/layouts/:ref", layoutsWritePatch401TokenInvalid, true),
  kase("layouts-write/patch-401-unauthorized", "/v1/layouts/:ref", layoutsWritePatch401Unauthorized, true),
  kase("layouts-write/patch-403-not_owner", "/v1/layouts/:ref", layoutsWritePatch403NotOwner, true),
  kase("layouts-write/patch-404", "/v1/layouts/:ref", layoutsWritePatch404, true),
  kase("layouts-write/patch-409-name_taken", "/v1/layouts/:ref", layoutsWritePatch409NameTaken, true),
  kase("layouts-write/patch-409-stale", "/v1/layouts/:ref", layoutsWritePatch409Stale, true),
  kase("layouts-write/patch-429", "/v1/layouts/:ref", layoutsWritePatch429, true),
  kase("layouts-write/patch-503-identity_unavailable", "/v1/layouts/:ref", layoutsWritePatch503IdentityUnavailable, true),
  kase("layouts-write/post-400-bad_request", "/v1/layouts", layoutsWritePost400BadRequest, true),
  kase("layouts-write/post-400-invalid_payload", "/v1/layouts", layoutsWritePost400InvalidPayload, true),
  kase("layouts-write/post-400-unknown_format", "/v1/layouts", layoutsWritePost400UnknownFormat, true),
  kase("layouts-write/post-401-token_invalid", "/v1/layouts", layoutsWritePost401TokenInvalid, true),
  kase("layouts-write/post-401-unauthorized", "/v1/layouts", layoutsWritePost401Unauthorized, true),
  kase("layouts-write/post-503-identity_unavailable", "/v1/layouts", layoutsWritePost503IdentityUnavailable, true),
  kase("layouts-write/put-400-bad_request", "/v1/layouts/:ref", layoutsWritePut400BadRequest, true),
  kase("layouts-write/put-400-invalid_payload", "/v1/layouts/:ref", layoutsWritePut400InvalidPayload, true),
  kase("layouts-write/put-400-unknown_format", "/v1/layouts/:ref", layoutsWritePut400UnknownFormat, true),
  kase("layouts-write/put-401-token_invalid", "/v1/layouts/:ref", layoutsWritePut401TokenInvalid, true),
  kase("layouts-write/put-401-unauthorized", "/v1/layouts/:ref", layoutsWritePut401Unauthorized, true),
  kase("layouts-write/put-403-not_owner", "/v1/layouts/:ref", layoutsWritePut403NotOwner, true),
  kase("layouts-write/put-404", "/v1/layouts/:ref", layoutsWritePut404, true),
  kase("layouts-write/put-429", "/v1/layouts/:ref", layoutsWritePut429, true),
  kase("layouts-write/put-503-identity_unavailable", "/v1/layouts/:ref", layoutsWritePut503IdentityUnavailable, true),
  kase("layouts-write/restore-401-token_invalid", "/v1/layouts/:ref/restore", layoutsWriteRestore401TokenInvalid, true),
  kase("layouts-write/restore-401-unauthorized", "/v1/layouts/:ref/restore", layoutsWriteRestore401Unauthorized, true),
  kase("layouts-write/restore-403-not_owner", "/v1/layouts/:ref/restore", layoutsWriteRestore403NotOwner, true),
  kase("layouts-write/restore-404", "/v1/layouts/:ref/restore", layoutsWriteRestore404, true),
  kase("layouts-write/restore-409-name_taken", "/v1/layouts/:ref/restore", layoutsWriteRestore409NameTaken, true),
  kase("layouts-write/restore-429", "/v1/layouts/:ref/restore", layoutsWriteRestore429, true),
  kase("layouts-write/restore-503-identity_unavailable", "/v1/layouts/:ref/restore", layoutsWriteRestore503IdentityUnavailable, true),
  kase("layouts-write/transfer-400-bad_request", "/v1/layouts/:ref/transfer", layoutsWriteTransfer400BadRequest, true),
  kase("layouts-write/transfer-401-token_invalid", "/v1/layouts/:ref/transfer", layoutsWriteTransfer401TokenInvalid, true),
  kase("layouts-write/transfer-401-unauthorized", "/v1/layouts/:ref/transfer", layoutsWriteTransfer401Unauthorized, true),
  kase("layouts-write/transfer-403-not_owner", "/v1/layouts/:ref/transfer", layoutsWriteTransfer403NotOwner, true),
  kase("layouts-write/transfer-404", "/v1/layouts/:ref/transfer", layoutsWriteTransfer404, true),
  kase("layouts-write/transfer-429", "/v1/layouts/:ref/transfer", layoutsWriteTransfer429, true),
  kase("layouts-write/transfer-503-identity_unavailable", "/v1/layouts/:ref/transfer", layoutsWriteTransfer503IdentityUnavailable, true),
  kase("layouts-like/delete-400-qwerty", "/v1/layouts/:ref/like", layoutsLikeDelete400Qwerty, true),
  kase("layouts-like/delete-401-token_invalid", "/v1/layouts/:ref/like", layoutsLikeDelete401TokenInvalid, true),
  kase("layouts-like/delete-401-unauthorized", "/v1/layouts/:ref/like", layoutsLikeDelete401Unauthorized, true),
  kase("layouts-like/delete-404", "/v1/layouts/:ref/like", layoutsLikeDelete404, true),
  kase("layouts-like/delete-429", "/v1/layouts/:ref/like", layoutsLikeDelete429, true),
  kase("layouts-like/delete-503-identity_unavailable", "/v1/layouts/:ref/like", layoutsLikeDelete503IdentityUnavailable, true),
  kase("layouts-like/put-401-token_invalid", "/v1/layouts/:ref/like", layoutsLikePut401TokenInvalid, true),
  kase("layouts-like/put-401-unauthorized", "/v1/layouts/:ref/like", layoutsLikePut401Unauthorized, true),
  kase("layouts-like/put-404", "/v1/layouts/:ref/like", layoutsLikePut404, true),
  kase("layouts-like/put-429", "/v1/layouts/:ref/like", layoutsLikePut429, true),
  kase("layouts-like/put-503-identity_unavailable", "/v1/layouts/:ref/like", layoutsLikePut503IdentityUnavailable, true),
  kase("admin-admins/delete-401-token_invalid", "/v1/admin/admins/:user_id", adminAdminsDelete401TokenInvalid, true),
  kase("admin-admins/delete-401-unauthorized", "/v1/admin/admins/:user_id", adminAdminsDelete401Unauthorized, true),
  kase("admin-admins/delete-429", "/v1/admin/admins/:user_id", adminAdminsDelete429, true),
  kase("admin-admins/delete-503-identity_unavailable", "/v1/admin/admins/:user_id", adminAdminsDelete503IdentityUnavailable, true),
  kase("admin-admins/get-401-token_invalid", "/v1/admin/admins", adminAdminsGet401TokenInvalid, true),
  kase("admin-admins/get-503-identity_unavailable", "/v1/admin/admins", adminAdminsGet503IdentityUnavailable, true),
  kase("admin-admins/post-401-token_invalid", "/v1/admin/admins", adminAdminsPost401TokenInvalid, true),
  kase("admin-admins/post-401-unauthorized", "/v1/admin/admins", adminAdminsPost401Unauthorized, true),
  kase("admin-admins/post-429", "/v1/admin/admins", adminAdminsPost429, true),
  kase("admin-admins/post-503-identity_unavailable", "/v1/admin/admins", adminAdminsPost503IdentityUnavailable, true),
  // Hand-ordered from here (see the block comment above T6_CASES): the
  // admins table is exactly {bootstrap} until this line runs.
  kase("admin-admins/delete-409-last_admins", "/v1/admin/admins/:user_id", adminAdminsDelete409LastAdmins, true),
  kase("admin-admins/post-201", "/v1/admin/admins", adminAdminsPost201, true),
  kase("admin-admins/post-200-idempotent", "/v1/admin/admins", adminAdminsPost200Idempotent, true),
  kase("admin-admins/delete-200", "/v1/admin/admins/:user_id", adminAdminsDelete200, true),
  kase("admin-admins/delete-404", "/v1/admin/admins/:user_id", adminAdminsDelete404, true),
  kase("admin-admins/post-400-bad_request", "/v1/admin/admins", adminAdminsPost400BadRequest, true),
  kase("admin-admins/post-403-not_admin", "/v1/admin/admins", adminAdminsPost403NotAdmin, true),
  kase("admin-admins/delete-403-not_admin", "/v1/admin/admins/:user_id", adminAdminsDelete403NotAdmin, true),
  kase("admin-import/pause-200", "/v1/admin/import/pause", adminImportPause200, true),
  kase("admin-import/pause-401-token_invalid", "/v1/admin/import/pause", adminImportPause401TokenInvalid, true),
  kase("admin-import/pause-401-unauthorized", "/v1/admin/import/pause", adminImportPause401Unauthorized, true),
  kase("admin-import/pause-403-not_admin", "/v1/admin/import/pause", adminImportPause403NotAdmin, true),
  kase("admin-import/pause-429", "/v1/admin/import/pause", adminImportPause429, true),
  kase("admin-import/pause-503-identity_unavailable", "/v1/admin/import/pause", adminImportPause503IdentityUnavailable, true),
  kase("admin-import/resume-200", "/v1/admin/import/resume", adminImportResume200, true),
  kase("admin-import/resume-401-token_invalid", "/v1/admin/import/resume", adminImportResume401TokenInvalid, true),
  kase("admin-import/resume-401-unauthorized", "/v1/admin/import/resume", adminImportResume401Unauthorized, true),
  kase("admin-import/resume-403-not_admin", "/v1/admin/import/resume", adminImportResume403NotAdmin, true),
  kase("admin-import/resume-429", "/v1/admin/import/resume", adminImportResume429, true),
  kase("admin-import/resume-503-identity_unavailable", "/v1/admin/import/resume", adminImportResume503IdentityUnavailable, true),

  // 10 C1: the client-lane admin routes' own A-group + write-verb rows,
  // following T6's shape (no 409 -- client ids are freshly minted ULIDs,
  // no name-uniqueness surface to collide on; POST is not idempotent, so
  // no 200-idempotent case either).
  kase("admin-clients/get-401-token_invalid", "/v1/admin/clients", adminClientsGet401TokenInvalid, true),
  kase("admin-clients/get-503-identity_unavailable", "/v1/admin/clients", adminClientsGet503IdentityUnavailable, true),
  kase("admin-clients/post-401-token_invalid", "/v1/admin/clients", adminClientsPost401TokenInvalid, true),
  kase("admin-clients/post-401-unauthorized", "/v1/admin/clients", adminClientsPost401Unauthorized, true),
  kase("admin-clients/post-403-not_admin", "/v1/admin/clients", adminClientsPost403NotAdmin, true),
  kase("admin-clients/post-429", "/v1/admin/clients", adminClientsPost429, true),
  kase("admin-clients/post-503-identity_unavailable", "/v1/admin/clients", adminClientsPost503IdentityUnavailable, true),
  kase("admin-clients/post-400-bad_request", "/v1/admin/clients", adminClientsPost400BadRequest, true),
  kase("admin-clients/post-201", "/v1/admin/clients", adminClientsPost201, true),
  kase("admin-clients/delete-401-token_invalid", "/v1/admin/clients/:id", adminClientsDelete401TokenInvalid, true),
  kase("admin-clients/delete-401-unauthorized", "/v1/admin/clients/:id", adminClientsDelete401Unauthorized, true),
  kase("admin-clients/delete-403-not_admin", "/v1/admin/clients/:id", adminClientsDelete403NotAdmin, true),
  kase("admin-clients/delete-404", "/v1/admin/clients/:id", adminClientsDelete404, true),
  kase("admin-clients/delete-429", "/v1/admin/clients/:id", adminClientsDelete429, true),
  kase("admin-clients/delete-503-identity_unavailable", "/v1/admin/clients/:id", adminClientsDelete503IdentityUnavailable, true),
  kase("admin-clients/delete-200", "/v1/admin/clients/:id", adminClientsDelete200, true),

  // X1 (12 §3 X1, §4). Ordered so `webhooks/get-200`'s own dedicated setup
  // (a fresh actor, `conformance-other-token`) runs before
  // `webhooks/post-409-too_many_webhooks` fills a DIFFERENT actor's cap --
  // neither shares a webhook count with the other or with `post-201`'s
  // CONFORMANCE_OWNER row.
  kase("webhooks/post-201", "/v1/webhooks", webhooksPost201, true),
  kase("webhooks/post-401-unauthorized", "/v1/webhooks", webhooksPost401Unauthorized, true),
  kase("webhooks/post-401-token_invalid", "/v1/webhooks", webhooksPost401TokenInvalid, true),
  kase("webhooks/post-503-identity_unavailable", "/v1/webhooks", webhooksPost503IdentityUnavailable, true),
  kase("webhooks/post-400-bad_request-url", "/v1/webhooks", webhooksPost400BadRequestUrl, true),
  kase("webhooks/post-400-bad_request-secret", "/v1/webhooks", webhooksPost400BadRequestSecret, true),
  kase("webhooks/post-400-bad_request-kinds", "/v1/webhooks", webhooksPost400BadRequestKinds, true),
  kase("webhooks/post-400-bad_request-owner_filter", "/v1/webhooks", webhooksPost400BadRequestOwnerFilter, true),
  kase("webhooks/post-429", "/v1/webhooks", webhooksPost429, true),
  kase("webhooks/get-200", "/v1/webhooks", webhooksGet200, true),
  kase("webhooks/get-401-unauthorized", "/v1/webhooks", webhooksGet401Unauthorized, true),
  kase("webhooks/get-401-token_invalid", "/v1/webhooks", webhooksGet401TokenInvalid, true),
  kase("webhooks/get-503-identity_unavailable", "/v1/webhooks", webhooksGet503IdentityUnavailable, true),
  kase("webhooks/get-403-not_admin", "/v1/webhooks", webhooksGet403NotAdmin, true),
  kase("webhooks/post-409-too_many_webhooks", "/v1/webhooks", webhooksPost409TooManyWebhooks, true),
  kase("webhooks/delete-401-unauthorized", "/v1/webhooks/:id", webhooksDelete401Unauthorized, true),
  kase("webhooks/delete-401-token_invalid", "/v1/webhooks/:id", webhooksDelete401TokenInvalid, true),
  kase("webhooks/delete-503-identity_unavailable", "/v1/webhooks/:id", webhooksDelete503IdentityUnavailable, true),
  kase("webhooks/delete-404", "/v1/webhooks/:id", webhooksDelete404, true),
  kase("webhooks/delete-429", "/v1/webhooks/:id", webhooksDelete429, true),
  kase("webhooks/delete-200", "/v1/webhooks/:id", webhooksDelete200, true),

  kase("changes-stream/400-bad_request", "/v1/changes/stream", changesStream400BadRequest),
];

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

  kase("layouts-write/post-201", "/v1/layouts", layoutsWritePostOk, true),
  kase("layouts-write/post-400-invalid_name", "/v1/layouts", layoutsWritePostInvalidName, true),
  kase("layouts-write/post-409-name_taken", "/v1/layouts", layoutsWritePostNameTaken, true),
  kase("layouts-write/put-200", "/v1/layouts/:ref", layoutsWritePutOk, true),
  kase("layouts-write/put-409-stale", "/v1/layouts/:ref", layoutsWritePutStale, true),
  kase("layouts-write/delete-200", "/v1/layouts/:ref", layoutsWriteDeleteOk, true),
  kase("layouts-write/restore-200", "/v1/layouts/:ref/restore", layoutsWriteRestoreOk, true),
  kase("layouts-write/restore-400-not_deleted", "/v1/layouts/:ref/restore", layoutsWriteRestoreNotDeleted, true),
  kase("layouts-write/transfer-200", "/v1/layouts/:ref/transfer", layoutsWriteTransferOk, true),

  kase("admin-admins/200", "/v1/admin/admins", adminAdminsOk, true),
  kase("admin-admins/403", "/v1/admin/admins", adminAdminsForbidden, true),
  kase("admin-admins/401", "/v1/admin/admins", adminAdminsUnauthorized, true),

  // 10 C1: same GET-only shape as admin-admins above.
  kase("admin-clients/200", "/v1/admin/clients", adminClientsOk, true),
  kase("admin-clients/403", "/v1/admin/clients", adminClientsForbidden, true),
  kase("admin-clients/401", "/v1/admin/clients", adminClientsUnauthorized, true),

  kase("me/200-signed", "/v1/me", me200Signed, true),

  // T4: each case creates its own record via its own `request.setup` (see
  // conformance.test.ts's seedWriteFixtures comment) -- no shared seed, no
  // ordering dependency between these three.
  kase("layouts-write/patch-400-bad_request", "/v1/layouts/:ref", layoutsWritePatchBadRequest, true),
  kase("layouts-write/patch-400-unsupported_for_format", "/v1/layouts/:ref", layoutsWritePatchUnsupported, true),
  kase("layouts-write/patch-200", "/v1/layouts/:ref", layoutsWritePatchOk, true),

  kase("layouts-like/put-200", "/v1/layouts/:ref/like", layoutsLikePutOk, true),
  kase("layouts-like/delete-200", "/v1/layouts/:ref/like", layoutsLikeDeleteOk, true),
  kase("layouts-like/put-400-qwerty", "/v1/layouts/:ref/like", layoutsLikeQwerty, true),

  kase("ratelimit/429", "/v1/layouts", ratelimit429, true),

  // X1: the stream's 200 (headers + first-frame shape only, no body
  // comparison -- an open SSE response can't be byte-pinned) and its
  // Free-plan 503 (conformance.test.ts's own `it()` loop toggles
  // `STREAM_MAX_MS` around this one case's id, see there).
  kase("changes-stream/200", "/v1/changes/stream", changesStream200),
  kase("changes-stream/503-stream_unavailable", "/v1/changes/stream", changesStream503StreamUnavailable),

  ...T6_CASES,
];
