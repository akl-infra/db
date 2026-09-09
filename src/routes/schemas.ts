// Per-route JSON Schemas for write bodies (09 §2.6): `additionalProperties:
// false`, `required` exact. A body naming `owner`, `id`, `rev`,
// `created_at`, or anything else outside a verb's own fields is refused
// with `400 bad_request` and a `param` naming it (a JSON pointer) -- not
// silently ignored (LDB-A7).
import Ajv2020, { type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";
import { badRequest } from "../core/errors";

const ajv = new Ajv2020({ allErrors: false, strict: true });

const createSchema = {
  type: "object",
  additionalProperties: false,
  required: ["name", "format", "payload"],
  properties: {
    name: { type: "string" },
    format: { type: "string" },
    payload: { type: "object" },
  },
} as const;

const replaceSchema = {
  type: "object",
  additionalProperties: false,
  required: ["format", "payload"],
  properties: {
    format: { type: "string" },
    payload: { type: "object" },
  },
} as const;

const transferSchema = {
  type: "object",
  additionalProperties: false,
  required: ["to"],
  properties: {
    to: { type: "string" },
  },
} as const;

export interface CreateBody {
  name: string;
  format: string;
  payload: object;
}

export interface ReplaceBody {
  format: string;
  payload: object;
}

export interface TransferBody {
  to: string;
}

const validateCreate = ajv.compile<CreateBody>(createSchema);
const validateReplace = ajv.compile<ReplaceBody>(replaceSchema);
const validateTransfer = ajv.compile<TransferBody>(transferSchema);

// ajv reports an extra/missing key at the PARENT's instancePath with the
// key name in `params`, not as part of the path itself -- this stitches
// the two back into one JSON pointer (`/owner`, `/name`, ...) so every 400
// here reads the same way `core/write.ts`'s other `param`s do.
function paramFor(err: ErrorObject): string {
  if (err.keyword === "additionalProperties") {
    return `${err.instancePath}/${(err.params as { additionalProperty: string }).additionalProperty}`;
  }
  if (err.keyword === "required") {
    return `${err.instancePath}/${(err.params as { missingProperty: string }).missingProperty}`;
  }
  return err.instancePath === "" ? "/" : err.instancePath;
}

function checkBody<T>(validate: ValidateFunction<T>, body: unknown): T {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw badRequest("request body must be a JSON object", "/");
  }
  if (validate(body)) return body;
  const err = validate.errors?.[0];
  if (err === undefined) throw badRequest("invalid request body", "/");
  throw badRequest(ajv.errorsText([err], { dataVar: "body" }), paramFor(err));
}

export function parseCreateBody(body: unknown): CreateBody {
  return checkBody(validateCreate, body);
}

export function parseReplaceBody(body: unknown): ReplaceBody {
  return checkBody(validateReplace, body);
}

export function parseTransferBody(body: unknown): TransferBody {
  return checkBody(validateTransfer, body);
}
