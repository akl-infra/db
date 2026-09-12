// The complete phase-1 error vocabulary (07 S6). Every body carries `error`
// and `message`; route handlers throw an ApiError and `index.ts`'s
// `app.onError` is the only place that turns one into a Response, so no
// body ever leaks a stack.
export interface ErrBody {
  error: string;
  message: string;
  [extra: string]: unknown;
}

export class ApiError extends Error {
  readonly status: number;
  readonly body: ErrBody;
  readonly headers?: Record<string, string>; // e.g. WWW-Authenticate, Retry-After (09 §2.1)
  constructor(status: number, body: ErrBody, headers?: Record<string, string>) {
    super(body.message);
    this.status = status;
    this.body = body;
    this.headers = headers;
  }
}

export function badRequest(message: string, param?: string): ApiError {
  return new ApiError(400, { error: "bad_request", message, ...(param !== undefined ? { param } : {}) });
}

export function unknownFormat(format: string, known: string[]): ApiError {
  return new ApiError(400, {
    error: "unknown_format",
    message: `unknown format '${format}'`,
    format,
    known,
  });
}

// 20-spark.md S2 (LDB-F16): a write naming a registered format whose
// `role` is `"output"` (mana2/1 today -- produced on read only, never
// stored). Distinct from `unknown_format` (the id isn't registered/
// reachable at all, e.g. `cmini/1` or a typo) -- this is "the format
// exists, but you may not write it."
export function formatNotWritable(format: string): ApiError {
  return new ApiError(400, {
    error: "format_not_writable",
    message: `format '${format}' cannot be written (it is produced on read only)`,
    format,
  });
}

export function notFound(message: string, ref?: string): ApiError {
  return new ApiError(404, { error: "not_found", message, ...(ref !== undefined ? { ref } : {}) });
}

// `holder` (09 §2.6, §3 T2) is attached by the write pipeline once it knows
// which live record is blocking the name -- `appendWrite`'s own pre-check
// throws this with no holder (it only knows the name clashed, not who
// holds it); `core/write.ts` catches that and re-throws with `holder` set.
export interface NameHolder {
  id: string;
  owner: string;
}

export function nameTaken(name: string, holder?: NameHolder): ApiError {
  return new ApiError(409, {
    error: "name_taken",
    message: `name '${name}' is already taken`,
    name,
    ...(holder !== undefined ? { holder } : {}),
  });
}

export function held(format: string, see?: string): ApiError {
  return new ApiError(409, {
    error: "held",
    message: `record cannot be translated to '${format}'`,
    held: true,
    format,
    ...(see !== undefined ? { see } : {}),
  });
}

// 20-spark.md S5 (19 §3 R1, LDB-P13): a write naming an older major of the
// record's own lineage, where the record's `latest`-only content is
// non-empty (`translate(record, format)` would itself answer `held`) --
// same body shape as `held` above (`held: true`, `format`, `see`), because
// it's the SAME underlying fact from the writer's side: "you could never
// have read this record whole in the major you're writing, so this would
// be a blind overwrite." `rev` is the record's current rev (for the same
// reason `stale` carries one -- the client can refetch it).
export function formatBehind(format: string, see: string, rev: number): ApiError {
  return new ApiError(409, {
    error: "format_behind",
    message: `this record uses ${see} features that ${format} cannot show; write it as ${see}, or PATCH the field you mean to change`,
    held: true,
    format,
    see,
    rev,
  });
}

export function internal(): ApiError {
  return new ApiError(500, { error: "internal", message: "internal error" });
}

// 21-formats.md §2.4 (D4: no default format). `?format=` absent on a route
// that needs one to answer/change a payload.
export function formatRequired(): ApiError {
  return new ApiError(400, { error: "format_required", message: "a 'format' parameter is required" });
}

// A registered format (stored or output) the layout does not have and
// cannot derive (no stored lineage reaches it, or it has no row of the
// lineage named). Distinct from `unknown_format` (the id itself isn't
// registered at all).
export function formatAbsent(format: string): ApiError {
  return new ApiError(404, { error: "format_absent", message: `this layout has no '${format}' format`, format });
}

// PUT with `If-None-Match: *` naming a lineage the layout already has.
export function formatExists(format: string): ApiError {
  return new ApiError(409, { error: "format_exists", message: `this layout already has a '${format}' format`, format });
}

// A PATCH body that mixes a layout-level field (`name`) with a format edit
// (`fingermap`/`board`/`magic`) -- each write has exactly one scope and one
// If-Match (21-formats.md §2.2).
export function mixedPatch(): ApiError {
  return new ApiError(400, { error: "mixed_patch", message: "a PATCH may change the layout's name, or one format's payload, never both at once" });
}

// 21-formats.md D13 L1/L2 (saltorbit, 2026-09-11): a like/unlike needs no
// version (L3 -- it can never collide with an edit), but it does have its
// own idempotency rule now: a repeat like, or an unlike with nothing to
// undo, fails loudly instead of silently no-opping, and changes nothing.
export function alreadyLiked(): ApiError {
  return new ApiError(409, { error: "already_liked", message: "you've already liked this layout" });
}
export function notLiked(): ApiError {
  return new ApiError(409, { error: "not_liked", message: "you haven't liked this layout" });
}

// The phase-2 user-lane errors (09 §2.1). `unauthorized` is no/malformed
// `Authorization`; `tokenInvalid` is Discord itself saying 401 (cached up to
// 60s, 09 §2.2). Both carry `WWW-Authenticate` -- the RFC 6750 way a client
// tells "no credentials" from "bad credentials" apart.
export function unauthorized(): ApiError {
  return new ApiError(401, { error: "unauthorized", message: "authentication required" }, { "WWW-Authenticate": "Bearer" });
}

// 20-spark.md S3s: also thrown (with a caller-supplied message) when
// Discord answers `GET /oauth2/@me` with a 200 that carries no `user` key
// -- a token that authenticates but was never granted the `identify`
// scope. Cached as a failure exactly like a real Discord 401 (`ok = 0`,
// `auth/discord.ts`'s `resolveBearer`) -- the DEFAULT keeps every existing
// call site's wording unchanged.
export function tokenInvalid(message: string = "the bearer token is invalid or expired"): ApiError {
  return new ApiError(401, { message, error: "token_invalid" }, { "WWW-Authenticate": 'Bearer error="invalid_token"' });
}

// Discord unreachable, erroring, or rate-limiting us -- never cached
// (09 §2.2). `retryAfter` is passed through verbatim when Discord sent one.
// 20-spark.md S3s (LDB-P15): `X-Client-Version` present but not <= 64
// chars of `[A-Za-z0-9._+/:-]` -- `auth/actor.ts`'s `parseClientVersion`,
// run once in `requireActorOnWrites` for every non-GET/HEAD/OPTIONS
// request. An absent header is `null` (never this error); this header
// never influences `Actor.source_client`.
export function invalidClientVersion(raw: string): ApiError {
  return new ApiError(400, {
    error: "invalid_client_version",
    message: `invalid 'X-Client-Version' header '${raw}' (expected <= 64 chars of [A-Za-z0-9._+/:-])`,
  });
}

export function identityUnavailable(retryAfter?: string): ApiError {
  return new ApiError(
    503,
    { error: "identity_unavailable", message: "could not verify identity with Discord" },
    retryAfter !== undefined ? { "Retry-After": retryAfter } : undefined,
  );
}

export function notOwner(name: string, owner: string): ApiError {
  return new ApiError(403, { error: "not_owner", message: `you don't own a layout named '${name}'`, owner });
}

export function notAdmin(): ApiError {
  return new ApiError(403, { error: "not_admin", message: "admin only" });
}

// The phase-2 write errors (09 §2.6, §3 T2).
export function invalidName(name: string, message: string): ApiError {
  return new ApiError(400, { error: "invalid_name", message, name });
}

// `record` is the current record (with payload, `toWire`'d) at the moment
// of the conflict -- from the pre-check (09 §2.3 point 1) or from a re-read
// after a lost race (point 2), the winner's record either way. `lastWrite`
// is that record's latest rev-bumping event (`06 §2.6`'s "2 h ago, via the
// bot" footer).
export interface LastWrite {
  seq: number;
  at: string;
  actor: string;
  via: string;
  kind: string;
  admin: boolean;
}

// saltorbit's rule (2026-09-09, LDB-P2): no client may write to an existing
// record without naming the version it saw. Distinct from a malformed
// `If-Match` (`bad_request`, ifmatch.ts's own `parseIfMatch`) and from a
// mismatched one (`stale`, 409) -- this is the header being missing
// entirely on `PUT`/`PATCH`/`DELETE`/`transfer`. `POST /v1/layouts`
// (creation), likes and the import path are unaffected -- there's no prior
// version to name.
export function ifMatchRequired(): ApiError {
  return new ApiError(400, {
    error: "if_match_required",
    message: "an 'If-Match' header naming the record's current rev is required",
  });
}

// 21-formats.md §2.3: carries the write's own `scope` ("layout" or a
// lineage), that scope's CURRENT rev, and the current record -- the
// layout-level fields and `formats` always, plus `format`/`payload` when
// the scope is a format (the caller builds `record` accordingly).
// `lastWrite` is `null` in exactly one case (coordinator review, LOW,
// third batch): an exhausted retry on a format ADD (`If-None-Match: *`)
// that never actually lands -- there is no prior rev-bumping event for a
// format scope that has never been written at all, so there is genuinely
// no "last write" to report, never a 500 from trying to find one anyway.
export function stale(scope: string, rev: number, record: Record<string, unknown>, lastWrite: LastWrite | null): ApiError {
  return new ApiError(409, {
    error: "stale",
    message: `'${scope}' is at rev ${rev}, not the version you edited`,
    scope,
    rev,
    record,
    last_write: lastWrite,
  });
}

// 09 §3 T3: removing an admin would leave fewer than two rows. `count` is
// the current admin count at the moment of refusal -- the DELETE statement
// that produced this refusal never ran (LDB-A6: count-and-delete is one
// statement, so a refusal means zero rows changed), so `count` is still
// accurate to read fresh right after.
export function lastAdmins(count: number): ApiError {
  return new ApiError(409, {
    error: "last_admins",
    message: "removing this admin would leave fewer than 2 admins",
    count,
  });
}

// A PATCH verb the record's format has no `edits` entry for (T4), or its
// edit returned an error for this payload.
export function unsupportedForFormat(format: string, verb: string): ApiError {
  return new ApiError(400, {
    error: "unsupported_for_format",
    message: `'${verb}' is not supported for format '${format}'`,
    format,
    verb,
  });
}

// The client lane (02 §3, 10 C1): src/auth/client.ts's `verifyClientRequest`
// throws exactly these six, in the order its steps run. Every 401 here
// carries `WWW-Authenticate: Bearer` too -- a client that fell into the
// wrong lane (or sent a malformed one) sees the same hint a bearer-lane
// caller would.
export function badSignature(): ApiError {
  return new ApiError(
    401,
    { error: "bad_signature", message: "the client signature is missing or invalid" },
    { "WWW-Authenticate": "Bearer" },
  );
}

export function unknownClient(): ApiError {
  return new ApiError(401, { error: "unknown_client", message: "unknown client" }, { "WWW-Authenticate": "Bearer" });
}

export function clientRevoked(): ApiError {
  return new ApiError(
    401,
    { error: "client_revoked", message: "this client has been revoked" },
    { "WWW-Authenticate": "Bearer" },
  );
}

export function staleTimestamp(skew: number): ApiError {
  return new ApiError(
    401,
    { error: "stale_timestamp", message: "request timestamp is outside the accepted window", skew },
    { "WWW-Authenticate": "Bearer" },
  );
}

export function replay(): ApiError {
  return new ApiError(401, { error: "replay", message: "nonce already used" }, { "WWW-Authenticate": "Bearer" });
}

export function actorNotAllowed(actor: string, owner: string): ApiError {
  return new ApiError(403, {
    error: "actor_not_allowed",
    message: "this client may not act as this user",
    actor,
    owner,
  });
}

// X1 (12 §2.1, §2.3): a 6th webhook subscription for one owner.
export function tooManyWebhooks(limit: number): ApiError {
  return new ApiError(409, {
    error: "too_many_webhooks",
    message: `at most ${limit} webhooks per user`,
    limit,
  });
}

// X1 (12 §2.2, §2.3): the stream is Paid-plan only and self-reports this
// when `STREAM_MAX_MS` is configured to `0` (the Free-plan setting).
export function streamUnavailable(): ApiError {
  return new ApiError(503, { error: "stream_unavailable", message: "the change stream is not available on this deployment" });
}

// X4 follow-up: `POST /v1/admin/import/tick` refuses to run a manual tick
// while the import is paused (`admin.import_paused`, `core/admins.ts`) --
// the paused switch means "don't touch upstream", and a manual kick is
// exactly that, so it's refused the same way a write against a stale rev
// is: loudly, not silently turned into a no-op the caller has to notice by
// its own empty summary.
export function importPaused(): ApiError {
  return new ApiError(409, { error: "import_paused", message: "the cmini import is paused (POST /v1/admin/import/resume first)" });
}

// The write rate limit (09 §2.5; 10 C1 D8 adds `scope` for the second,
// per-client counter). `core/ratelimit.ts`'s `take()` is the one place that
// counts; this is only the body/headers shape.
export function rateLimited(limit: number, windowSeconds: number, retryAfter: number, scope: "actor" | "client"): ApiError {
  return new ApiError(
    429,
    {
      error: "rate_limited",
      message: `rate limit exceeded: ${limit} writes per ${windowSeconds}s`,
      limit,
      window_seconds: windowSeconds,
      retry_after: retryAfter,
      scope,
    },
    { "Retry-After": String(retryAfter) },
  );
}
