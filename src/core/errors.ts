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

export function internal(): ApiError {
  return new ApiError(500, { error: "internal", message: "internal error" });
}

// The phase-2 user-lane errors (09 §2.1). `unauthorized` is no/malformed
// `Authorization`; `tokenInvalid` is Discord itself saying 401 (cached up to
// 60s, 09 §2.2). Both carry `WWW-Authenticate` -- the RFC 6750 way a client
// tells "no credentials" from "bad credentials" apart.
export function unauthorized(): ApiError {
  return new ApiError(401, { error: "unauthorized", message: "authentication required" }, { "WWW-Authenticate": "Bearer" });
}

export function tokenInvalid(): ApiError {
  return new ApiError(
    401,
    { error: "token_invalid", message: "the bearer token is invalid or expired" },
    { "WWW-Authenticate": 'Bearer error="invalid_token"' },
  );
}

// Discord unreachable, erroring, or rate-limiting us -- never cached
// (09 §2.2). `retryAfter` is passed through verbatim when Discord sent one.
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

export function stale(record: Record<string, unknown> & { rev: number }, lastWrite: LastWrite): ApiError {
  return new ApiError(409, {
    error: "stale",
    message: `record is at rev ${record.rev}, not the version you edited`,
    rev: record.rev,
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

// The write rate limit (09 §2.5, T5): 429, `Retry-After` header, and the
// same three fields in the body so a client can back off without parsing
// the header separately.
export function rateLimited(limit: number, windowSeconds: number, retryAfter: number): ApiError {
  return new ApiError(
    429,
    {
      error: "rate_limited",
      message: `rate limit exceeded: ${limit} writes per ${windowSeconds}s`,
      limit,
      window_seconds: windowSeconds,
      retry_after: retryAfter,
    },
    { "Retry-After": String(retryAfter) },
  );
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
