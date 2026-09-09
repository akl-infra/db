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

export function nameTaken(name: string): ApiError {
  return new ApiError(409, {
    error: "name_taken",
    message: `name '${name}' is already taken`,
    name,
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
