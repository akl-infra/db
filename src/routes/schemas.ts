// Per-route JSON Schemas for write bodies (09 §2.6): `additionalProperties:
// false`, `required` exact. A body naming `owner`, `id`, `rev`,
// `created_at`, or anything else outside a verb's own fields is refused
// with `400 bad_request` and a `param` naming it (a JSON pointer) -- not
// silently ignored (LDB-A7).
//
// The schemas themselves are data in schema-defs.ts; the validators here are the ajv standalone code generated from them at
// build time (validators.generated.ts, `npm run build:validators`; RP5). Nothing compiles a schema at module load any more
// (that was 84% of the bundle's 68-88 ms import on the Mac), and ajv itself is not imported at run time.
import { badRequest, formatRequired } from "../core/errors";
import * as generated from "./validators.generated";

/** The slice of ajv's ErrorObject this file reads. */
interface ErrorObject {
  keyword: string;
  instancePath: string;
  message?: string;
  params: Record<string, unknown>;
}
type ValidateFunction<T> = ((data: unknown) => data is T) & { errors?: ErrorObject[] | null };

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
  magic?: object;
  alts?: unknown[];
  combos?: unknown[];
}

export interface RegisterClientBody {
  name: string;
  pubkey: string;
  owner_user_id: string;
  caps: string;
  discord_app_id?: string;
}

export interface BanBody {
  reason?: string;
}

export interface AuthorRenameBody {
  name: string;
}

export interface LinkBody {
  url: string;
}

export interface WpmBody {
  layout: string;
  wpm: unknown;
  proof: unknown;
}

export interface WpmOnBehalfBody extends WpmBody {
  user_id: string;
}

export interface CommentBody {
  body: unknown;
}

export interface LinkRejectBody {
  reason?: string;
}


const v = generated as unknown as Record<string, ValidateFunction<never>>;
const validateCreate = v.validateCreate as ValidateFunction<CreateBody>;
const validateReplace = v.validateReplace as ValidateFunction<ReplaceBody>;
const validateRestore = v.validateRestore as ValidateFunction<RestoreBody>;
const validateTransfer = v.validateTransfer as ValidateFunction<TransferBody>;
const validateAdminAdd = v.validateAdminAdd as ValidateFunction<AdminAddBody>;
const validatePatch = v.validatePatch as ValidateFunction<PatchBody>;
const validateRegisterClient = v.validateRegisterClient as ValidateFunction<RegisterClientBody>;
const validateBan = v.validateBan as ValidateFunction<BanBody>;
const validateAuthorRename = v.validateAuthorRename as ValidateFunction<AuthorRenameBody>;
const validateLink = v.validateLink as ValidateFunction<LinkBody>;
const validateLinkReject = v.validateLinkReject as ValidateFunction<LinkRejectBody>;
const validateComment = v.validateComment as ValidateFunction<CommentBody>;
const validateWpm = v.validateWpm as ValidateFunction<WpmBody>;
const validateWpmOnBehalf = v.validateWpmOnBehalf as ValidateFunction<WpmOnBehalfBody>;
const validateDiscordUsersRefresh = v.validateDiscordUsersRefresh as ValidateFunction<{ limit?: unknown }>;
const validateReviewApprove = v.validateReviewApprove as ValidateFunction<ReviewDecisionBody>;
const validateReviewReject = v.validateReviewReject as ValidateFunction<ReviewDecisionBody>;
const validateReviewReopen = v.validateReviewReopen as ValidateFunction<{ status: "approved" | "rejected" | "superseded"; review_version: number }>;
const validateWpmDiscordMessage = v.validateWpmDiscordMessage as ValidateFunction<WpmDiscordMessageBody>;

/** ajv's own errorsText for one error (`body/name must be string`), without importing ajv. */
const errorText = (e: ErrorObject): string => `body${e.instancePath} ${e.message}`;

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
  throw badRequest(errorText(err), paramFor(err));
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

export function parseBanBody(body: unknown): BanBody {
  return checkBody(validateBan, body);
}

export function parseAuthorRenameBody(body: unknown): AuthorRenameBody {
  return checkBody(validateAuthorRename, body);
}

export function parseLinkBody(body: unknown): LinkBody {
  return checkBody(validateLink, body);
}

export function parseLinkRejectBody(body: unknown): LinkRejectBody {
  return checkBody(validateLinkReject, body);
}

export const parseDiscordUsersRefreshBody = (body: unknown) => checkBody(validateDiscordUsersRefresh, body);

export function parseWpmBody(body: unknown): WpmBody {
  return checkBody(validateWpm, body);
}

export function parseWpmOnBehalfBody(body: unknown): WpmOnBehalfBody {
  return checkBody(validateWpmOnBehalf, body);
}

export function parseCommentBody(body: unknown): CommentBody {
  return checkBody(validateComment, body);
}

export interface ReviewDecisionBody { review_version?: number; reason?: string }
export const parseReviewApproveBody = (body: unknown) => checkBody(validateReviewApprove, body);
export const parseReviewRejectBody = (body: unknown) => checkBody(validateReviewReject, body);
export const parseReviewReopenBody = (body: unknown) => checkBody(validateReviewReopen, body);

export interface WpmDiscordMessageBody {
  guild_id: string | null;
  channel_id: string;
  message_id: string;
}
export function parseWpmDiscordMessageBody(body: unknown): WpmDiscordMessageBody {
  return checkBody(validateWpmDiscordMessage, body);
}
