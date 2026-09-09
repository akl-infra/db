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
  constructor(status: number, body: ErrBody) {
    super(body.message);
    this.status = status;
    this.body = body;
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
