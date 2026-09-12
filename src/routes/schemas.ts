// Per-route JSON Schemas for write bodies (09 §2.6): `additionalProperties:
// false`, `required` exact. A body naming `owner`, `id`, `rev`,
// `created_at`, or anything else outside a verb's own fields is refused
// with `400 bad_request` and a `param` naming it (a JSON pointer) -- not
// silently ignored (LDB-A7).
import Ajv2020, { type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";
import { badRequest, formatRequired } from "../core/errors";

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

// 20-spark.md §1 decision 9 (refined §8 R-L1): restore's body is
// OPTIONAL -- absent, `{}`, or `{name}`; any other key is `400
// bad_request` (LDB-A7's pattern, same as every other write schema).
// `name`'s own shape (`check_name`) is `core/write.ts`'s job, not this
// schema's -- same split every other body/edit-argument field uses.
const restoreSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    name: { type: "string" },
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

// 09 §3 T3: `user_id` must be a 17-20-digit Discord snowflake, ajv's own
// `pattern` keyword rather than a second check in core/admins.ts -- one
// place to fail a malformed id with the same 400 shape every other body
// error uses.
const adminAddSchema = {
  type: "object",
  additionalProperties: false,
  required: ["user_id"],
  properties: {
    user_id: { type: "string", pattern: "^\\d{17,20}$" },
    note: { type: "string" },
  },
} as const;

// PATCH (21-formats.md §2.2/§2.4): `{name}` (layout scope) OR `{format,
// <at least one of fingermap/board/magic>}` (that format's scope) -- never
// both (`400 mixed_patch`) or neither (`400 bad_request`/`format_required`).
// This schema only enforces "the right keys, the right JSON types"
// (`minProperties: 1`, `additionalProperties: false`); `core/write.ts`'s
// `classifyPatch` is where mixing/format-required is actually refused, so
// the error names the real reason rather than a generic shape mismatch.
// `board`/`magic` are validated as whole objects here; their format-
// specific shape is the job of the record's format `edits` + the
// pipeline's validate() re-run, not this schema.
const patchSchema = {
  type: "object",
  additionalProperties: false,
  minProperties: 1,
  properties: {
    name: { type: "string" },
    format: { type: "string" },
    fingermap: { type: "object", additionalProperties: { type: "string" } },
    board: { type: "object" },
    magic: { type: "object" },
  },
} as const;

// 10 C1: `POST /v1/admin/clients`. `pubkey`'s byte length (it must decode
// to exactly 32 bytes) is not a `pattern` ajv can express -- checked in
// `core/clients.ts` after this schema passes.
const registerClientSchema = {
  type: "object",
  additionalProperties: false,
  required: ["name", "pubkey", "owner_user_id", "caps"],
  properties: {
    name: { type: "string", minLength: 1 },
    pubkey: { type: "string" },
    owner_user_id: { type: "string", pattern: "^\\d{17,20}$" },
    caps: { type: "string", enum: ["act-as-user", "act-as-owner-only"] },
    discord_app_id: { type: "string" },
  },
} as const;

// X1 (12 §3): `POST /v1/webhooks`. `url`/`secret` shape checks (https-only,
// IP-literal host, length bounds) and the `kinds` ⊆ KNOWN_KINDS check live
// in `core/webhooks.ts`/`routes/webhooks.ts` respectively -- this schema is
// only "the right keys, the right JSON types" (LDB-A7's pattern).
const createWebhookSchema = {
  type: "object",
  additionalProperties: false,
  required: ["url", "secret"],
  properties: {
    url: { type: "string" },
    secret: { type: "string" },
    kinds: { type: "array", items: { type: "string" } },
    owner_filter: { type: "string" },
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

export interface RestoreBody {
  name?: string;
}

export interface AdminAddBody {
  user_id: string;
  note?: string;
}

export interface PatchBody {
  name?: string;
  format?: string;
  fingermap?: Record<string, string>;
  board?: object;
  magic?: object;
}

export interface RegisterClientBody {
  name: string;
  pubkey: string;
  owner_user_id: string;
  caps: string;
  discord_app_id?: string;
}

export interface CreateWebhookBody {
  url: string;
  secret: string;
  kinds?: string[];
  owner_filter?: string;
}

// X4 (12 §3 X4): `POST /v1/admin/drill`. `detail`'s <= 4 KB cap is checked
// in `routes/admin.ts` after this schema passes (a byte-length bound on a
// canonicalized object isn't a `pattern` ajv can express, same reasoning
// `registerClientSchema`'s own header note gives for `pubkey`).
const drillReportSchema = {
  type: "object",
  additionalProperties: false,
  required: ["ok"],
  properties: {
    ok: { type: "boolean" },
    detail: { type: "object" },
  },
} as const;

export interface DrillReportBody {
  ok: boolean;
  detail?: object;
}

const validateCreate = ajv.compile<CreateBody>(createSchema);
const validateReplace = ajv.compile<ReplaceBody>(replaceSchema);
const validateRestore = ajv.compile<RestoreBody>(restoreSchema);
const validateTransfer = ajv.compile<TransferBody>(transferSchema);
const validateAdminAdd = ajv.compile<AdminAddBody>(adminAddSchema);
const validatePatch = ajv.compile<PatchBody>(patchSchema);
const validateRegisterClient = ajv.compile<RegisterClientBody>(registerClientSchema);
const validateCreateWebhook = ajv.compile<CreateWebhookBody>(createWebhookSchema);
const validateDrillReport = ajv.compile<DrillReportBody>(drillReportSchema);

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
  // Coordinator review (M4, D4): a body missing `format` entirely (POST,
  // PUT) is `400 format_required`, the SAME dedicated code every other
  // format-required route answers -- not a generic `bad_request` naming
  // `/format` as just another missing property. PATCH's own `format` is
  // conditionally required (only when an edit key is present) and already
  // goes through `core/write.ts`'s `classifyPatch`, never this schema
  // check, so this only ever fires for POST/PUT's unconditionally
  // `required` list.
  if (err.keyword === "required" && (err.params as { missingProperty: string }).missingProperty === "format") {
    throw formatRequired();
  }
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

export function parseRestoreBody(body: unknown): RestoreBody {
  return checkBody(validateRestore, body);
}

export function parseAdminAddBody(body: unknown): AdminAddBody {
  return checkBody(validateAdminAdd, body);
}

export function parsePatchBody(body: unknown): PatchBody {
  return checkBody(validatePatch, body);
}

export function parseRegisterClientBody(body: unknown): RegisterClientBody {
  return checkBody(validateRegisterClient, body);
}

export function parseCreateWebhookBody(body: unknown): CreateWebhookBody {
  return checkBody(validateCreateWebhook, body);
}

export function parseDrillReportBody(body: unknown): DrillReportBody {
  return checkBody(validateDrillReport, body);
}
