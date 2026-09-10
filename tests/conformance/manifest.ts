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

// X3 (12 §3 X3, §6.6): `layout=`/`actor=` on `/v1/changes`, and the
// changelog page (12 §4's own new route).
import changesOkLayout from "./changes/200-layout.json" with { type: "json" };
import changesOkActor from "./changes/200-actor.json" with { type: "json" };
import changes404 from "./changes/404.json" with { type: "json" };
import changelogOk from "./changelog/200.json" with { type: "json" };
import changelog304 from "./changelog/304.json" with { type: "json" };
import changelogBadRequest from "./changelog/400-bad_request.json" with { type: "json" };
import changelog404 from "./changelog/404.json" with { type: "json" };

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
// [LDB-P2] saltorbit's rule (2026-09-09): no If-Match at all on an existing
// record -> 400 if_match_required, refused before any read or mutation.
import layoutsWriteDelete400IfMatchRequired from "./layouts-write/delete-400-if_match_required.json" with { type: "json" };
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
import layoutsWritePatch400IfMatchRequired from "./layouts-write/patch-400-if_match_required.json" with { type: "json" };
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
import layoutsWritePut400IfMatchRequired from "./layouts-write/put-400-if_match_required.json" with { type: "json" };
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
import layoutsWriteTransfer400IfMatchRequired from "./layouts-write/transfer-400-if_match_required.json" with { type: "json" };
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

// X4 (12 §3 X4, §4): the diff cron's `last_*` on /v1/meta is covered by
// the extended meta/200 case above; these are the two new admin routes.
import adminDrillPost200 from "./admin-drill/post-200.json" with { type: "json" };
import adminDrillPost400BadRequest from "./admin-drill/post-400-bad_request.json" with { type: "json" };
import adminDrillPost401TokenInvalid from "./admin-drill/post-401-token_invalid.json" with { type: "json" };
import adminDrillPost401Unauthorized from "./admin-drill/post-401-unauthorized.json" with { type: "json" };
import adminDrillPost403NotAdmin from "./admin-drill/post-403-not_admin.json" with { type: "json" };
import adminDrillPost429 from "./admin-drill/post-429.json" with { type: "json" };
import adminDrillPost503IdentityUnavailable from "./admin-drill/post-503-identity_unavailable.json" with { type: "json" };
import adminHealth200 from "./admin-health/200.json" with { type: "json" };
import adminHealth401Unauthorized from "./admin-health/401-unauthorized.json" with { type: "json" };
import adminHealth401TokenInvalid from "./admin-health/401-token_invalid.json" with { type: "json" };
import adminHealth403NotAdmin from "./admin-health/403-not_admin.json" with { type: "json" };
import adminHealth503IdentityUnavailable from "./admin-health/503-identity_unavailable.json" with { type: "json" };

// X4 follow-up: manual triggers for the '*/5' import cron and the '0 4'
// diff cron.
import adminImportTick200 from "./admin-import/tick-200.json" with { type: "json" };
import adminImportTick401TokenInvalid from "./admin-import/tick-401-token_invalid.json" with { type: "json" };
import adminImportTick401Unauthorized from "./admin-import/tick-401-unauthorized.json" with { type: "json" };
import adminImportTick403NotAdmin from "./admin-import/tick-403-not_admin.json" with { type: "json" };
import adminImportTick409ImportPaused from "./admin-import/tick-409-import_paused.json" with { type: "json" };
import adminImportTick429 from "./admin-import/tick-429.json" with { type: "json" };
import adminImportTick503IdentityUnavailable from "./admin-import/tick-503-identity_unavailable.json" with { type: "json" };

// M1 (LDB-I10, design/layout-db/17-magic-ownership.md §4): the one-time
// cmini-magic strip pass, same shape as admin-import/tick above.
import adminImportStripCminiMagic200 from "./admin-import/strip-cmini-magic-200.json" with { type: "json" };
import adminImportStripCminiMagic401TokenInvalid from "./admin-import/strip-cmini-magic-401-token_invalid.json" with { type: "json" };
import adminImportStripCminiMagic401Unauthorized from "./admin-import/strip-cmini-magic-401-unauthorized.json" with { type: "json" };
import adminImportStripCminiMagic403NotAdmin from "./admin-import/strip-cmini-magic-403-not_admin.json" with { type: "json" };
import adminImportStripCminiMagic409ImportPaused from "./admin-import/strip-cmini-magic-409-import_paused.json" with { type: "json" };
import adminImportStripCminiMagic429 from "./admin-import/strip-cmini-magic-429.json" with { type: "json" };
import adminImportStripCminiMagic503IdentityUnavailable from "./admin-import/strip-cmini-magic-503-identity_unavailable.json" with { type: "json" };

import adminDiffTick200 from "./admin-diff/tick-200.json" with { type: "json" };
import adminDiffTick401TokenInvalid from "./admin-diff/tick-401-token_invalid.json" with { type: "json" };
import adminDiffTick401Unauthorized from "./admin-diff/tick-401-unauthorized.json" with { type: "json" };
import adminDiffTick403NotAdmin from "./admin-diff/tick-403-not_admin.json" with { type: "json" };
import adminDiffTick429 from "./admin-diff/tick-429.json" with { type: "json" };
import adminDiffTick503IdentityUnavailable from "./admin-diff/tick-503-identity_unavailable.json" with { type: "json" };

// X4 follow-up 3: the manual nightly-job-set trigger (the three prunes +
// the R2 dump, `core/nightly.ts`'s `runNightly`) -- same shape as
// admin-import/tick and admin-diff/tick above, no "paused" state.
import adminNightlyTick200 from "./admin-nightly/tick-200.json" with { type: "json" };
import adminNightlyTick401TokenInvalid from "./admin-nightly/tick-401-token_invalid.json" with { type: "json" };
import adminNightlyTick401Unauthorized from "./admin-nightly/tick-401-unauthorized.json" with { type: "json" };
import adminNightlyTick403NotAdmin from "./admin-nightly/tick-403-not_admin.json" with { type: "json" };
import adminNightlyTick429 from "./admin-nightly/tick-429.json" with { type: "json" };
import adminNightlyTick503IdentityUnavailable from "./admin-nightly/tick-503-identity_unavailable.json" with { type: "json" };

// LDB-A4 follow-up: the client lane's own five 401 codes (bad_signature,
// unknown_client, client_revoked, stale_timestamp, replay), swept over
// every A-group route (10 C1, 09 §2.1) -- generated by
// scripts/gen-client-lane-sweep.mjs, one fixture template stamped per
// route x code rather than hand-written.
import clMeBadSignature from "./me/401-bad_signature.json" with { type: "json" };
import clMeUnknownClient from "./me/401-unknown_client.json" with { type: "json" };
import clMeClientRevoked from "./me/401-client_revoked.json" with { type: "json" };
import clMeStaleTimestamp from "./me/401-stale_timestamp.json" with { type: "json" };
import clMeReplay from "./me/401-replay.json" with { type: "json" };
import clLayoutsWritePostBadSignature from "./layouts-write/post-401-bad_signature.json" with { type: "json" };
import clLayoutsWritePostUnknownClient from "./layouts-write/post-401-unknown_client.json" with { type: "json" };
import clLayoutsWritePostClientRevoked from "./layouts-write/post-401-client_revoked.json" with { type: "json" };
import clLayoutsWritePostStaleTimestamp from "./layouts-write/post-401-stale_timestamp.json" with { type: "json" };
import clLayoutsWritePostReplay from "./layouts-write/post-401-replay.json" with { type: "json" };
import clLayoutsWritePutBadSignature from "./layouts-write/put-401-bad_signature.json" with { type: "json" };
import clLayoutsWritePutUnknownClient from "./layouts-write/put-401-unknown_client.json" with { type: "json" };
import clLayoutsWritePutClientRevoked from "./layouts-write/put-401-client_revoked.json" with { type: "json" };
import clLayoutsWritePutStaleTimestamp from "./layouts-write/put-401-stale_timestamp.json" with { type: "json" };
import clLayoutsWritePutReplay from "./layouts-write/put-401-replay.json" with { type: "json" };
import clLayoutsWritePatchBadSignature from "./layouts-write/patch-401-bad_signature.json" with { type: "json" };
import clLayoutsWritePatchUnknownClient from "./layouts-write/patch-401-unknown_client.json" with { type: "json" };
import clLayoutsWritePatchClientRevoked from "./layouts-write/patch-401-client_revoked.json" with { type: "json" };
import clLayoutsWritePatchStaleTimestamp from "./layouts-write/patch-401-stale_timestamp.json" with { type: "json" };
import clLayoutsWritePatchReplay from "./layouts-write/patch-401-replay.json" with { type: "json" };
import clLayoutsWriteDeleteBadSignature from "./layouts-write/delete-401-bad_signature.json" with { type: "json" };
import clLayoutsWriteDeleteUnknownClient from "./layouts-write/delete-401-unknown_client.json" with { type: "json" };
import clLayoutsWriteDeleteClientRevoked from "./layouts-write/delete-401-client_revoked.json" with { type: "json" };
import clLayoutsWriteDeleteStaleTimestamp from "./layouts-write/delete-401-stale_timestamp.json" with { type: "json" };
import clLayoutsWriteDeleteReplay from "./layouts-write/delete-401-replay.json" with { type: "json" };
import clLayoutsWriteRestoreBadSignature from "./layouts-write/restore-401-bad_signature.json" with { type: "json" };
import clLayoutsWriteRestoreUnknownClient from "./layouts-write/restore-401-unknown_client.json" with { type: "json" };
import clLayoutsWriteRestoreClientRevoked from "./layouts-write/restore-401-client_revoked.json" with { type: "json" };
import clLayoutsWriteRestoreStaleTimestamp from "./layouts-write/restore-401-stale_timestamp.json" with { type: "json" };
import clLayoutsWriteRestoreReplay from "./layouts-write/restore-401-replay.json" with { type: "json" };
import clLayoutsWriteTransferBadSignature from "./layouts-write/transfer-401-bad_signature.json" with { type: "json" };
import clLayoutsWriteTransferUnknownClient from "./layouts-write/transfer-401-unknown_client.json" with { type: "json" };
import clLayoutsWriteTransferClientRevoked from "./layouts-write/transfer-401-client_revoked.json" with { type: "json" };
import clLayoutsWriteTransferStaleTimestamp from "./layouts-write/transfer-401-stale_timestamp.json" with { type: "json" };
import clLayoutsWriteTransferReplay from "./layouts-write/transfer-401-replay.json" with { type: "json" };
import clLayoutsLikePutBadSignature from "./layouts-like/put-401-bad_signature.json" with { type: "json" };
import clLayoutsLikePutUnknownClient from "./layouts-like/put-401-unknown_client.json" with { type: "json" };
import clLayoutsLikePutClientRevoked from "./layouts-like/put-401-client_revoked.json" with { type: "json" };
import clLayoutsLikePutStaleTimestamp from "./layouts-like/put-401-stale_timestamp.json" with { type: "json" };
import clLayoutsLikePutReplay from "./layouts-like/put-401-replay.json" with { type: "json" };
import clLayoutsLikeDeleteBadSignature from "./layouts-like/delete-401-bad_signature.json" with { type: "json" };
import clLayoutsLikeDeleteUnknownClient from "./layouts-like/delete-401-unknown_client.json" with { type: "json" };
import clLayoutsLikeDeleteClientRevoked from "./layouts-like/delete-401-client_revoked.json" with { type: "json" };
import clLayoutsLikeDeleteStaleTimestamp from "./layouts-like/delete-401-stale_timestamp.json" with { type: "json" };
import clLayoutsLikeDeleteReplay from "./layouts-like/delete-401-replay.json" with { type: "json" };
import clAdminAdminsGetBadSignature from "./admin-admins/get-401-bad_signature.json" with { type: "json" };
import clAdminAdminsGetUnknownClient from "./admin-admins/get-401-unknown_client.json" with { type: "json" };
import clAdminAdminsGetClientRevoked from "./admin-admins/get-401-client_revoked.json" with { type: "json" };
import clAdminAdminsGetStaleTimestamp from "./admin-admins/get-401-stale_timestamp.json" with { type: "json" };
import clAdminAdminsGetReplay from "./admin-admins/get-401-replay.json" with { type: "json" };
import clAdminAdminsPostBadSignature from "./admin-admins/post-401-bad_signature.json" with { type: "json" };
import clAdminAdminsPostUnknownClient from "./admin-admins/post-401-unknown_client.json" with { type: "json" };
import clAdminAdminsPostClientRevoked from "./admin-admins/post-401-client_revoked.json" with { type: "json" };
import clAdminAdminsPostStaleTimestamp from "./admin-admins/post-401-stale_timestamp.json" with { type: "json" };
import clAdminAdminsPostReplay from "./admin-admins/post-401-replay.json" with { type: "json" };
import clAdminAdminsDeleteBadSignature from "./admin-admins/delete-401-bad_signature.json" with { type: "json" };
import clAdminAdminsDeleteUnknownClient from "./admin-admins/delete-401-unknown_client.json" with { type: "json" };
import clAdminAdminsDeleteClientRevoked from "./admin-admins/delete-401-client_revoked.json" with { type: "json" };
import clAdminAdminsDeleteStaleTimestamp from "./admin-admins/delete-401-stale_timestamp.json" with { type: "json" };
import clAdminAdminsDeleteReplay from "./admin-admins/delete-401-replay.json" with { type: "json" };
import clAdminImportPauseBadSignature from "./admin-import/pause-401-bad_signature.json" with { type: "json" };
import clAdminImportPauseUnknownClient from "./admin-import/pause-401-unknown_client.json" with { type: "json" };
import clAdminImportPauseClientRevoked from "./admin-import/pause-401-client_revoked.json" with { type: "json" };
import clAdminImportPauseStaleTimestamp from "./admin-import/pause-401-stale_timestamp.json" with { type: "json" };
import clAdminImportPauseReplay from "./admin-import/pause-401-replay.json" with { type: "json" };
import clAdminImportResumeBadSignature from "./admin-import/resume-401-bad_signature.json" with { type: "json" };
import clAdminImportResumeUnknownClient from "./admin-import/resume-401-unknown_client.json" with { type: "json" };
import clAdminImportResumeClientRevoked from "./admin-import/resume-401-client_revoked.json" with { type: "json" };
import clAdminImportResumeStaleTimestamp from "./admin-import/resume-401-stale_timestamp.json" with { type: "json" };
import clAdminImportResumeReplay from "./admin-import/resume-401-replay.json" with { type: "json" };
import clAdminImportTickBadSignature from "./admin-import/tick-401-bad_signature.json" with { type: "json" };
import clAdminImportTickUnknownClient from "./admin-import/tick-401-unknown_client.json" with { type: "json" };
import clAdminImportTickClientRevoked from "./admin-import/tick-401-client_revoked.json" with { type: "json" };
import clAdminImportTickStaleTimestamp from "./admin-import/tick-401-stale_timestamp.json" with { type: "json" };
import clAdminImportTickReplay from "./admin-import/tick-401-replay.json" with { type: "json" };
import clAdminDiffTickBadSignature from "./admin-diff/tick-401-bad_signature.json" with { type: "json" };
import clAdminDiffTickUnknownClient from "./admin-diff/tick-401-unknown_client.json" with { type: "json" };
import clAdminDiffTickClientRevoked from "./admin-diff/tick-401-client_revoked.json" with { type: "json" };
import clAdminDiffTickStaleTimestamp from "./admin-diff/tick-401-stale_timestamp.json" with { type: "json" };
import clAdminDiffTickReplay from "./admin-diff/tick-401-replay.json" with { type: "json" };
import clAdminNightlyTickBadSignature from "./admin-nightly/tick-401-bad_signature.json" with { type: "json" };
import clAdminNightlyTickUnknownClient from "./admin-nightly/tick-401-unknown_client.json" with { type: "json" };
import clAdminNightlyTickClientRevoked from "./admin-nightly/tick-401-client_revoked.json" with { type: "json" };
import clAdminNightlyTickStaleTimestamp from "./admin-nightly/tick-401-stale_timestamp.json" with { type: "json" };
import clAdminNightlyTickReplay from "./admin-nightly/tick-401-replay.json" with { type: "json" };
import clAdminClientsGetBadSignature from "./admin-clients/get-401-bad_signature.json" with { type: "json" };
import clAdminClientsGetUnknownClient from "./admin-clients/get-401-unknown_client.json" with { type: "json" };
import clAdminClientsGetClientRevoked from "./admin-clients/get-401-client_revoked.json" with { type: "json" };
import clAdminClientsGetStaleTimestamp from "./admin-clients/get-401-stale_timestamp.json" with { type: "json" };
import clAdminClientsGetReplay from "./admin-clients/get-401-replay.json" with { type: "json" };
import clAdminClientsPostBadSignature from "./admin-clients/post-401-bad_signature.json" with { type: "json" };
import clAdminClientsPostUnknownClient from "./admin-clients/post-401-unknown_client.json" with { type: "json" };
import clAdminClientsPostClientRevoked from "./admin-clients/post-401-client_revoked.json" with { type: "json" };
import clAdminClientsPostStaleTimestamp from "./admin-clients/post-401-stale_timestamp.json" with { type: "json" };
import clAdminClientsPostReplay from "./admin-clients/post-401-replay.json" with { type: "json" };
import clAdminClientsDeleteBadSignature from "./admin-clients/delete-401-bad_signature.json" with { type: "json" };
import clAdminClientsDeleteUnknownClient from "./admin-clients/delete-401-unknown_client.json" with { type: "json" };
import clAdminClientsDeleteClientRevoked from "./admin-clients/delete-401-client_revoked.json" with { type: "json" };
import clAdminClientsDeleteStaleTimestamp from "./admin-clients/delete-401-stale_timestamp.json" with { type: "json" };
import clAdminClientsDeleteReplay from "./admin-clients/delete-401-replay.json" with { type: "json" };
import clWebhooksPostBadSignature from "./webhooks/post-401-bad_signature.json" with { type: "json" };
import clWebhooksPostUnknownClient from "./webhooks/post-401-unknown_client.json" with { type: "json" };
import clWebhooksPostClientRevoked from "./webhooks/post-401-client_revoked.json" with { type: "json" };
import clWebhooksPostStaleTimestamp from "./webhooks/post-401-stale_timestamp.json" with { type: "json" };
import clWebhooksPostReplay from "./webhooks/post-401-replay.json" with { type: "json" };
import clWebhooksGetBadSignature from "./webhooks/get-401-bad_signature.json" with { type: "json" };
import clWebhooksGetUnknownClient from "./webhooks/get-401-unknown_client.json" with { type: "json" };
import clWebhooksGetClientRevoked from "./webhooks/get-401-client_revoked.json" with { type: "json" };
import clWebhooksGetStaleTimestamp from "./webhooks/get-401-stale_timestamp.json" with { type: "json" };
import clWebhooksGetReplay from "./webhooks/get-401-replay.json" with { type: "json" };
import clWebhooksDeleteBadSignature from "./webhooks/delete-401-bad_signature.json" with { type: "json" };
import clWebhooksDeleteUnknownClient from "./webhooks/delete-401-unknown_client.json" with { type: "json" };
import clWebhooksDeleteClientRevoked from "./webhooks/delete-401-client_revoked.json" with { type: "json" };
import clWebhooksDeleteStaleTimestamp from "./webhooks/delete-401-stale_timestamp.json" with { type: "json" };
import clWebhooksDeleteReplay from "./webhooks/delete-401-replay.json" with { type: "json" };
import clAdminDrillPostBadSignature from "./admin-drill/post-401-bad_signature.json" with { type: "json" };
import clAdminDrillPostUnknownClient from "./admin-drill/post-401-unknown_client.json" with { type: "json" };
import clAdminDrillPostClientRevoked from "./admin-drill/post-401-client_revoked.json" with { type: "json" };
import clAdminDrillPostStaleTimestamp from "./admin-drill/post-401-stale_timestamp.json" with { type: "json" };
import clAdminDrillPostReplay from "./admin-drill/post-401-replay.json" with { type: "json" };
import clAdminHealthBadSignature from "./admin-health/401-bad_signature.json" with { type: "json" };
import clAdminHealthUnknownClient from "./admin-health/401-unknown_client.json" with { type: "json" };
import clAdminHealthClientRevoked from "./admin-health/401-client_revoked.json" with { type: "json" };
import clAdminHealthStaleTimestamp from "./admin-health/401-stale_timestamp.json" with { type: "json" };
import clAdminHealthReplay from "./admin-health/401-replay.json" with { type: "json" };
// M1: appended at the end (scripts/gen-client-lane-sweep.mjs's own ROUTES
// comment) -- a new A-group route's five client-lane 401 cases always join
// here, never inserted alongside an earlier route.
import clAdminImportStripCminiMagicBadSignature from "./admin-import/strip-cmini-magic-401-bad_signature.json" with { type: "json" };
import clAdminImportStripCminiMagicUnknownClient from "./admin-import/strip-cmini-magic-401-unknown_client.json" with { type: "json" };
import clAdminImportStripCminiMagicClientRevoked from "./admin-import/strip-cmini-magic-401-client_revoked.json" with { type: "json" };
import clAdminImportStripCminiMagicStaleTimestamp from "./admin-import/strip-cmini-magic-401-stale_timestamp.json" with { type: "json" };
import clAdminImportStripCminiMagicReplay from "./admin-import/strip-cmini-magic-401-replay.json" with { type: "json" };

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
  // vectors' k1 key) -- mutually exclusive with `bearer`. `nonce` (LDB-A4
  // follow-up), when given, is a base64url 16-byte value forwarded verbatim
  // to `signHeaders` instead of a fresh random one -- the ONLY way a
  // `replay` fixture can share one nonce between its `setup` step and the
  // asserted one while still signing with a real, freshly-timestamped
  // request each run (a frozen signature would eventually fail on
  // `stale_timestamp` instead, since the auth clock is always
  // `systemClock`, never `TEST_CLOCK` -- see CLIENT_LANE_CASES' own comment
  // below).
  signed?: { actor: string; nonce?: string };
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
  // LDB-A4 follow-up: top-level keys stripped from the ACTUAL response body
  // before the byte-exact compare -- for a field that is genuinely
  // non-deterministic per request and can never be pinned as a fixture
  // literal. The one real case of this in the whole suite: client-lane
  // `stale_timestamp`'s `skew` (`staleTimestamp()`, src/core/errors.ts) is
  // `now - <the fixture's frozen timestamp>`, computed against the real
  // wall clock (never `TEST_CLOCK` -- see ConformanceStep.signed's own
  // comment), so it grows every day the fixture exists. `error`/`message`
  // on these same cases stay byte-exact in `body` -- this is never a way to
  // avoid pinning something a fixture COULD pin.
  omitBodyKeys?: string[];
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
  // [LDB-P2] saltorbit's rule (2026-09-09): no If-Match at all -> 400 if_match_required.
  kase("layouts-write/delete-400-if_match_required", "/v1/layouts/:ref", layoutsWriteDelete400IfMatchRequired, true),
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
  // [LDB-P2] saltorbit's rule (2026-09-09): no If-Match at all -> 400 if_match_required.
  kase("layouts-write/patch-400-if_match_required", "/v1/layouts/:ref", layoutsWritePatch400IfMatchRequired, true),
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
  // [LDB-P2] saltorbit's rule (2026-09-09): no If-Match at all -> 400 if_match_required.
  kase("layouts-write/put-400-if_match_required", "/v1/layouts/:ref", layoutsWritePut400IfMatchRequired, true),
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
  // [LDB-P2] saltorbit's rule (2026-09-09): no If-Match at all -> 400
  // if_match_required. Transfer's presence-only check (no rev matching,
  // core/write.ts's own comment on `transferLayout`).
  kase("layouts-write/transfer-400-if_match_required", "/v1/layouts/:ref/transfer", layoutsWriteTransfer400IfMatchRequired, true),
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

  // X4 (12 §3 X4, §4). `admin-health` is hand-ordered BEFORE `admin-drill`:
  // its own `200` case asserts `{last_diff: null, last_drill: null}`, true
  // only until `admin-drill/post-200` below (the one case in this suite
  // that calls `recordDrill`) runs -- the same "count starts at a known
  // value" reasoning `admin-admins/delete-409-last_admins`'s own block
  // comment gives.
  kase("admin-health/401-unauthorized", "/v1/admin/health", adminHealth401Unauthorized, true),
  kase("admin-health/401-token_invalid", "/v1/admin/health", adminHealth401TokenInvalid, true),
  kase("admin-health/503-identity_unavailable", "/v1/admin/health", adminHealth503IdentityUnavailable, true),
  kase("admin-health/403-not_admin", "/v1/admin/health", adminHealth403NotAdmin, true),
  kase("admin-health/200", "/v1/admin/health", adminHealth200, true),

  // Same shape as admin-import/pause-* -- one admin-only POST route, no
  // idempotent-200/201 or 409 case (a drill report is neither a create nor
  // a named-resource write).
  kase("admin-drill/post-401-unauthorized", "/v1/admin/drill", adminDrillPost401Unauthorized, true),
  kase("admin-drill/post-401-token_invalid", "/v1/admin/drill", adminDrillPost401TokenInvalid, true),
  kase("admin-drill/post-503-identity_unavailable", "/v1/admin/drill", adminDrillPost503IdentityUnavailable, true),
  kase("admin-drill/post-403-not_admin", "/v1/admin/drill", adminDrillPost403NotAdmin, true),
  kase("admin-drill/post-429", "/v1/admin/drill", adminDrillPost429, true),
  kase("admin-drill/post-400-bad_request", "/v1/admin/drill", adminDrillPost400BadRequest, true),
  kase("admin-drill/post-200", "/v1/admin/drill", adminDrillPost200, true),

  // X4 follow-up: manual cron triggers. `admin-import/tick-200` runs
  // BEFORE `tick-409-import_paused` (its own `setup` pauses the import,
  // and nothing after this point needs it unpaused again -- same
  // hand-ordering reasoning admin-admins/delete-409-last_admins's own
  // block comment gives).
  kase("admin-import/tick-401-unauthorized", "/v1/admin/import/tick", adminImportTick401Unauthorized, true),
  kase("admin-import/tick-401-token_invalid", "/v1/admin/import/tick", adminImportTick401TokenInvalid, true),
  kase("admin-import/tick-503-identity_unavailable", "/v1/admin/import/tick", adminImportTick503IdentityUnavailable, true),
  kase("admin-import/tick-403-not_admin", "/v1/admin/import/tick", adminImportTick403NotAdmin, true),
  kase("admin-import/tick-429", "/v1/admin/import/tick", adminImportTick429, true),
  kase("admin-import/tick-200", "/v1/admin/import/tick", adminImportTick200, true),

  // M1: strip-cmini-magic's own 200 MUST run here -- before either tick's
  // or its own 409-import_paused case pauses the import for the rest of
  // this file's run (no case anywhere after this point un-pauses it
  // again, same reasoning admin-import/tick-200's own ordering comment
  // above gives).
  kase("admin-import/strip-cmini-magic-401-unauthorized", "/v1/admin/import/strip-cmini-magic", adminImportStripCminiMagic401Unauthorized, true),
  kase("admin-import/strip-cmini-magic-401-token_invalid", "/v1/admin/import/strip-cmini-magic", adminImportStripCminiMagic401TokenInvalid, true),
  kase("admin-import/strip-cmini-magic-503-identity_unavailable", "/v1/admin/import/strip-cmini-magic", adminImportStripCminiMagic503IdentityUnavailable, true),
  kase("admin-import/strip-cmini-magic-403-not_admin", "/v1/admin/import/strip-cmini-magic", adminImportStripCminiMagic403NotAdmin, true),
  kase("admin-import/strip-cmini-magic-429", "/v1/admin/import/strip-cmini-magic", adminImportStripCminiMagic429, true),
  kase("admin-import/strip-cmini-magic-200", "/v1/admin/import/strip-cmini-magic", adminImportStripCminiMagic200, true),
  kase("admin-import/strip-cmini-magic-409-import_paused", "/v1/admin/import/strip-cmini-magic", adminImportStripCminiMagic409ImportPaused, true),

  kase("admin-import/tick-409-import_paused", "/v1/admin/import/tick", adminImportTick409ImportPaused, true),

  kase("admin-diff/tick-401-unauthorized", "/v1/admin/diff/tick", adminDiffTick401Unauthorized, true),
  kase("admin-diff/tick-401-token_invalid", "/v1/admin/diff/tick", adminDiffTick401TokenInvalid, true),
  kase("admin-diff/tick-503-identity_unavailable", "/v1/admin/diff/tick", adminDiffTick503IdentityUnavailable, true),
  kase("admin-diff/tick-403-not_admin", "/v1/admin/diff/tick", adminDiffTick403NotAdmin, true),
  kase("admin-diff/tick-429", "/v1/admin/diff/tick", adminDiffTick429, true),
  kase("admin-diff/tick-200", "/v1/admin/diff/tick", adminDiffTick200, true),

  // X4 follow-up 3: the manual nightly-job-set trigger.
  kase("admin-nightly/tick-401-unauthorized", "/v1/admin/nightly/tick", adminNightlyTick401Unauthorized, true),
  kase("admin-nightly/tick-401-token_invalid", "/v1/admin/nightly/tick", adminNightlyTick401TokenInvalid, true),
  kase("admin-nightly/tick-503-identity_unavailable", "/v1/admin/nightly/tick", adminNightlyTick503IdentityUnavailable, true),
  kase("admin-nightly/tick-403-not_admin", "/v1/admin/nightly/tick", adminNightlyTick403NotAdmin, true),
  kase("admin-nightly/tick-429", "/v1/admin/nightly/tick", adminNightlyTick429, true),
  kase("admin-nightly/tick-200", "/v1/admin/nightly/tick", adminNightlyTick200, true),
];

// LDB-A4 follow-up: the client lane's own five 401 codes, swept over
// every route in the A-group (REQUIRED's shared 401/401/503 auth rows,
// conformance.test.ts). `bad_signature`/`unknown_client`/`client_revoked`/
// `stale_timestamp` fail inside `verifyClientRequest` before any DB
// write (steps 1-3, src/auth/client.ts) -- fully static headers, no
// per-run drift. `replay` alone needs a live signature (a frozen one
// would eventually fail on `stale_timestamp` instead, since the auth
// clock is always `systemClock`, never `TEST_CLOCK`) -- its `setup` step
// signs a harmless `GET /v1/me` with the SAME nonce (nonces are keyed
// only by (client_id, nonce), never by route) so consuming it can never
// have a side effect on the route actually under test.
export const CLIENT_LANE_CASES: ConformanceCase[] = [
  kase("me/401-bad_signature", "/v1/me", clMeBadSignature, true),
  kase("me/401-unknown_client", "/v1/me", clMeUnknownClient, true),
  kase("me/401-client_revoked", "/v1/me", clMeClientRevoked, true),
  kase("me/401-stale_timestamp", "/v1/me", clMeStaleTimestamp, true),
  kase("me/401-replay", "/v1/me", clMeReplay, true),
  kase("layouts-write/post-401-bad_signature", "/v1/layouts", clLayoutsWritePostBadSignature, true),
  kase("layouts-write/post-401-unknown_client", "/v1/layouts", clLayoutsWritePostUnknownClient, true),
  kase("layouts-write/post-401-client_revoked", "/v1/layouts", clLayoutsWritePostClientRevoked, true),
  kase("layouts-write/post-401-stale_timestamp", "/v1/layouts", clLayoutsWritePostStaleTimestamp, true),
  kase("layouts-write/post-401-replay", "/v1/layouts", clLayoutsWritePostReplay, true),
  kase("layouts-write/put-401-bad_signature", "/v1/layouts/:ref", clLayoutsWritePutBadSignature, true),
  kase("layouts-write/put-401-unknown_client", "/v1/layouts/:ref", clLayoutsWritePutUnknownClient, true),
  kase("layouts-write/put-401-client_revoked", "/v1/layouts/:ref", clLayoutsWritePutClientRevoked, true),
  kase("layouts-write/put-401-stale_timestamp", "/v1/layouts/:ref", clLayoutsWritePutStaleTimestamp, true),
  kase("layouts-write/put-401-replay", "/v1/layouts/:ref", clLayoutsWritePutReplay, true),
  kase("layouts-write/patch-401-bad_signature", "/v1/layouts/:ref", clLayoutsWritePatchBadSignature, true),
  kase("layouts-write/patch-401-unknown_client", "/v1/layouts/:ref", clLayoutsWritePatchUnknownClient, true),
  kase("layouts-write/patch-401-client_revoked", "/v1/layouts/:ref", clLayoutsWritePatchClientRevoked, true),
  kase("layouts-write/patch-401-stale_timestamp", "/v1/layouts/:ref", clLayoutsWritePatchStaleTimestamp, true),
  kase("layouts-write/patch-401-replay", "/v1/layouts/:ref", clLayoutsWritePatchReplay, true),
  kase("layouts-write/delete-401-bad_signature", "/v1/layouts/:ref", clLayoutsWriteDeleteBadSignature, true),
  kase("layouts-write/delete-401-unknown_client", "/v1/layouts/:ref", clLayoutsWriteDeleteUnknownClient, true),
  kase("layouts-write/delete-401-client_revoked", "/v1/layouts/:ref", clLayoutsWriteDeleteClientRevoked, true),
  kase("layouts-write/delete-401-stale_timestamp", "/v1/layouts/:ref", clLayoutsWriteDeleteStaleTimestamp, true),
  kase("layouts-write/delete-401-replay", "/v1/layouts/:ref", clLayoutsWriteDeleteReplay, true),
  kase("layouts-write/restore-401-bad_signature", "/v1/layouts/:ref/restore", clLayoutsWriteRestoreBadSignature, true),
  kase("layouts-write/restore-401-unknown_client", "/v1/layouts/:ref/restore", clLayoutsWriteRestoreUnknownClient, true),
  kase("layouts-write/restore-401-client_revoked", "/v1/layouts/:ref/restore", clLayoutsWriteRestoreClientRevoked, true),
  kase("layouts-write/restore-401-stale_timestamp", "/v1/layouts/:ref/restore", clLayoutsWriteRestoreStaleTimestamp, true),
  kase("layouts-write/restore-401-replay", "/v1/layouts/:ref/restore", clLayoutsWriteRestoreReplay, true),
  kase("layouts-write/transfer-401-bad_signature", "/v1/layouts/:ref/transfer", clLayoutsWriteTransferBadSignature, true),
  kase("layouts-write/transfer-401-unknown_client", "/v1/layouts/:ref/transfer", clLayoutsWriteTransferUnknownClient, true),
  kase("layouts-write/transfer-401-client_revoked", "/v1/layouts/:ref/transfer", clLayoutsWriteTransferClientRevoked, true),
  kase("layouts-write/transfer-401-stale_timestamp", "/v1/layouts/:ref/transfer", clLayoutsWriteTransferStaleTimestamp, true),
  kase("layouts-write/transfer-401-replay", "/v1/layouts/:ref/transfer", clLayoutsWriteTransferReplay, true),
  kase("layouts-like/put-401-bad_signature", "/v1/layouts/:ref/like", clLayoutsLikePutBadSignature, true),
  kase("layouts-like/put-401-unknown_client", "/v1/layouts/:ref/like", clLayoutsLikePutUnknownClient, true),
  kase("layouts-like/put-401-client_revoked", "/v1/layouts/:ref/like", clLayoutsLikePutClientRevoked, true),
  kase("layouts-like/put-401-stale_timestamp", "/v1/layouts/:ref/like", clLayoutsLikePutStaleTimestamp, true),
  kase("layouts-like/put-401-replay", "/v1/layouts/:ref/like", clLayoutsLikePutReplay, true),
  kase("layouts-like/delete-401-bad_signature", "/v1/layouts/:ref/like", clLayoutsLikeDeleteBadSignature, true),
  kase("layouts-like/delete-401-unknown_client", "/v1/layouts/:ref/like", clLayoutsLikeDeleteUnknownClient, true),
  kase("layouts-like/delete-401-client_revoked", "/v1/layouts/:ref/like", clLayoutsLikeDeleteClientRevoked, true),
  kase("layouts-like/delete-401-stale_timestamp", "/v1/layouts/:ref/like", clLayoutsLikeDeleteStaleTimestamp, true),
  kase("layouts-like/delete-401-replay", "/v1/layouts/:ref/like", clLayoutsLikeDeleteReplay, true),
  kase("admin-admins/get-401-bad_signature", "/v1/admin/admins", clAdminAdminsGetBadSignature, true),
  kase("admin-admins/get-401-unknown_client", "/v1/admin/admins", clAdminAdminsGetUnknownClient, true),
  kase("admin-admins/get-401-client_revoked", "/v1/admin/admins", clAdminAdminsGetClientRevoked, true),
  kase("admin-admins/get-401-stale_timestamp", "/v1/admin/admins", clAdminAdminsGetStaleTimestamp, true),
  kase("admin-admins/get-401-replay", "/v1/admin/admins", clAdminAdminsGetReplay, true),
  kase("admin-admins/post-401-bad_signature", "/v1/admin/admins", clAdminAdminsPostBadSignature, true),
  kase("admin-admins/post-401-unknown_client", "/v1/admin/admins", clAdminAdminsPostUnknownClient, true),
  kase("admin-admins/post-401-client_revoked", "/v1/admin/admins", clAdminAdminsPostClientRevoked, true),
  kase("admin-admins/post-401-stale_timestamp", "/v1/admin/admins", clAdminAdminsPostStaleTimestamp, true),
  kase("admin-admins/post-401-replay", "/v1/admin/admins", clAdminAdminsPostReplay, true),
  kase("admin-admins/delete-401-bad_signature", "/v1/admin/admins/:user_id", clAdminAdminsDeleteBadSignature, true),
  kase("admin-admins/delete-401-unknown_client", "/v1/admin/admins/:user_id", clAdminAdminsDeleteUnknownClient, true),
  kase("admin-admins/delete-401-client_revoked", "/v1/admin/admins/:user_id", clAdminAdminsDeleteClientRevoked, true),
  kase("admin-admins/delete-401-stale_timestamp", "/v1/admin/admins/:user_id", clAdminAdminsDeleteStaleTimestamp, true),
  kase("admin-admins/delete-401-replay", "/v1/admin/admins/:user_id", clAdminAdminsDeleteReplay, true),
  kase("admin-import/pause-401-bad_signature", "/v1/admin/import/pause", clAdminImportPauseBadSignature, true),
  kase("admin-import/pause-401-unknown_client", "/v1/admin/import/pause", clAdminImportPauseUnknownClient, true),
  kase("admin-import/pause-401-client_revoked", "/v1/admin/import/pause", clAdminImportPauseClientRevoked, true),
  kase("admin-import/pause-401-stale_timestamp", "/v1/admin/import/pause", clAdminImportPauseStaleTimestamp, true),
  kase("admin-import/pause-401-replay", "/v1/admin/import/pause", clAdminImportPauseReplay, true),
  kase("admin-import/resume-401-bad_signature", "/v1/admin/import/resume", clAdminImportResumeBadSignature, true),
  kase("admin-import/resume-401-unknown_client", "/v1/admin/import/resume", clAdminImportResumeUnknownClient, true),
  kase("admin-import/resume-401-client_revoked", "/v1/admin/import/resume", clAdminImportResumeClientRevoked, true),
  kase("admin-import/resume-401-stale_timestamp", "/v1/admin/import/resume", clAdminImportResumeStaleTimestamp, true),
  kase("admin-import/resume-401-replay", "/v1/admin/import/resume", clAdminImportResumeReplay, true),
  kase("admin-import/tick-401-bad_signature", "/v1/admin/import/tick", clAdminImportTickBadSignature, true),
  kase("admin-import/tick-401-unknown_client", "/v1/admin/import/tick", clAdminImportTickUnknownClient, true),
  kase("admin-import/tick-401-client_revoked", "/v1/admin/import/tick", clAdminImportTickClientRevoked, true),
  kase("admin-import/tick-401-stale_timestamp", "/v1/admin/import/tick", clAdminImportTickStaleTimestamp, true),
  kase("admin-import/tick-401-replay", "/v1/admin/import/tick", clAdminImportTickReplay, true),
  kase("admin-diff/tick-401-bad_signature", "/v1/admin/diff/tick", clAdminDiffTickBadSignature, true),
  kase("admin-diff/tick-401-unknown_client", "/v1/admin/diff/tick", clAdminDiffTickUnknownClient, true),
  kase("admin-diff/tick-401-client_revoked", "/v1/admin/diff/tick", clAdminDiffTickClientRevoked, true),
  kase("admin-diff/tick-401-stale_timestamp", "/v1/admin/diff/tick", clAdminDiffTickStaleTimestamp, true),
  kase("admin-diff/tick-401-replay", "/v1/admin/diff/tick", clAdminDiffTickReplay, true),
  kase("admin-nightly/tick-401-bad_signature", "/v1/admin/nightly/tick", clAdminNightlyTickBadSignature, true),
  kase("admin-nightly/tick-401-unknown_client", "/v1/admin/nightly/tick", clAdminNightlyTickUnknownClient, true),
  kase("admin-nightly/tick-401-client_revoked", "/v1/admin/nightly/tick", clAdminNightlyTickClientRevoked, true),
  kase("admin-nightly/tick-401-stale_timestamp", "/v1/admin/nightly/tick", clAdminNightlyTickStaleTimestamp, true),
  kase("admin-nightly/tick-401-replay", "/v1/admin/nightly/tick", clAdminNightlyTickReplay, true),
  kase("admin-clients/get-401-bad_signature", "/v1/admin/clients", clAdminClientsGetBadSignature, true),
  kase("admin-clients/get-401-unknown_client", "/v1/admin/clients", clAdminClientsGetUnknownClient, true),
  kase("admin-clients/get-401-client_revoked", "/v1/admin/clients", clAdminClientsGetClientRevoked, true),
  kase("admin-clients/get-401-stale_timestamp", "/v1/admin/clients", clAdminClientsGetStaleTimestamp, true),
  kase("admin-clients/get-401-replay", "/v1/admin/clients", clAdminClientsGetReplay, true),
  kase("admin-clients/post-401-bad_signature", "/v1/admin/clients", clAdminClientsPostBadSignature, true),
  kase("admin-clients/post-401-unknown_client", "/v1/admin/clients", clAdminClientsPostUnknownClient, true),
  kase("admin-clients/post-401-client_revoked", "/v1/admin/clients", clAdminClientsPostClientRevoked, true),
  kase("admin-clients/post-401-stale_timestamp", "/v1/admin/clients", clAdminClientsPostStaleTimestamp, true),
  kase("admin-clients/post-401-replay", "/v1/admin/clients", clAdminClientsPostReplay, true),
  kase("admin-clients/delete-401-bad_signature", "/v1/admin/clients/:id", clAdminClientsDeleteBadSignature, true),
  kase("admin-clients/delete-401-unknown_client", "/v1/admin/clients/:id", clAdminClientsDeleteUnknownClient, true),
  kase("admin-clients/delete-401-client_revoked", "/v1/admin/clients/:id", clAdminClientsDeleteClientRevoked, true),
  kase("admin-clients/delete-401-stale_timestamp", "/v1/admin/clients/:id", clAdminClientsDeleteStaleTimestamp, true),
  kase("admin-clients/delete-401-replay", "/v1/admin/clients/:id", clAdminClientsDeleteReplay, true),
  kase("webhooks/post-401-bad_signature", "/v1/webhooks", clWebhooksPostBadSignature, true),
  kase("webhooks/post-401-unknown_client", "/v1/webhooks", clWebhooksPostUnknownClient, true),
  kase("webhooks/post-401-client_revoked", "/v1/webhooks", clWebhooksPostClientRevoked, true),
  kase("webhooks/post-401-stale_timestamp", "/v1/webhooks", clWebhooksPostStaleTimestamp, true),
  kase("webhooks/post-401-replay", "/v1/webhooks", clWebhooksPostReplay, true),
  kase("webhooks/get-401-bad_signature", "/v1/webhooks", clWebhooksGetBadSignature, true),
  kase("webhooks/get-401-unknown_client", "/v1/webhooks", clWebhooksGetUnknownClient, true),
  kase("webhooks/get-401-client_revoked", "/v1/webhooks", clWebhooksGetClientRevoked, true),
  kase("webhooks/get-401-stale_timestamp", "/v1/webhooks", clWebhooksGetStaleTimestamp, true),
  kase("webhooks/get-401-replay", "/v1/webhooks", clWebhooksGetReplay, true),
  kase("webhooks/delete-401-bad_signature", "/v1/webhooks/:id", clWebhooksDeleteBadSignature, true),
  kase("webhooks/delete-401-unknown_client", "/v1/webhooks/:id", clWebhooksDeleteUnknownClient, true),
  kase("webhooks/delete-401-client_revoked", "/v1/webhooks/:id", clWebhooksDeleteClientRevoked, true),
  kase("webhooks/delete-401-stale_timestamp", "/v1/webhooks/:id", clWebhooksDeleteStaleTimestamp, true),
  kase("webhooks/delete-401-replay", "/v1/webhooks/:id", clWebhooksDeleteReplay, true),
  kase("admin-drill/post-401-bad_signature", "/v1/admin/drill", clAdminDrillPostBadSignature, true),
  kase("admin-drill/post-401-unknown_client", "/v1/admin/drill", clAdminDrillPostUnknownClient, true),
  kase("admin-drill/post-401-client_revoked", "/v1/admin/drill", clAdminDrillPostClientRevoked, true),
  kase("admin-drill/post-401-stale_timestamp", "/v1/admin/drill", clAdminDrillPostStaleTimestamp, true),
  kase("admin-drill/post-401-replay", "/v1/admin/drill", clAdminDrillPostReplay, true),
  kase("admin-health/401-bad_signature", "/v1/admin/health", clAdminHealthBadSignature, true),
  kase("admin-health/401-unknown_client", "/v1/admin/health", clAdminHealthUnknownClient, true),
  kase("admin-health/401-client_revoked", "/v1/admin/health", clAdminHealthClientRevoked, true),
  kase("admin-health/401-stale_timestamp", "/v1/admin/health", clAdminHealthStaleTimestamp, true),
  kase("admin-health/401-replay", "/v1/admin/health", clAdminHealthReplay, true),
  kase("admin-import/strip-cmini-magic-401-bad_signature", "/v1/admin/import/strip-cmini-magic", clAdminImportStripCminiMagicBadSignature, true),
  kase("admin-import/strip-cmini-magic-401-unknown_client", "/v1/admin/import/strip-cmini-magic", clAdminImportStripCminiMagicUnknownClient, true),
  kase("admin-import/strip-cmini-magic-401-client_revoked", "/v1/admin/import/strip-cmini-magic", clAdminImportStripCminiMagicClientRevoked, true),
  kase("admin-import/strip-cmini-magic-401-stale_timestamp", "/v1/admin/import/strip-cmini-magic", clAdminImportStripCminiMagicStaleTimestamp, true),
  kase("admin-import/strip-cmini-magic-401-replay", "/v1/admin/import/strip-cmini-magic", clAdminImportStripCminiMagicReplay, true),
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
  kase("changes/200-layout", "/v1/changes", changesOkLayout),
  kase("changes/200-actor", "/v1/changes", changesOkActor),
  kase("changes/404", "/v1/changes", changes404),

  kase("changelog/200", "/admin/changelog", changelogOk),
  kase("changelog/304", "/admin/changelog", changelog304),
  kase("changelog/400-bad_request", "/admin/changelog", changelogBadRequest),
  kase("changelog/404", "/admin/changelog", changelog404),

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

  ...CLIENT_LANE_CASES,
];
