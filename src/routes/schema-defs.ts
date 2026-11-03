// The JSON Schemas for write bodies (09 §2.6), as plain data: `additionalProperties: false`, `required` exact. No ajv is
// imported here. `schemas.ts` validates with the build-time-generated validators (validators.generated.ts, RP5), and
// `scripts/build-validators.mjs` regenerates them from the `SCHEMAS` map at the bottom of this file.
//
// (Moved verbatim from schemas.ts; the comments on each schema stay with it.)

export const createSchema = {
  type: "object",
  additionalProperties: false,
  required: ["name", "format", "payload"],
  properties: {
    name: { type: "string" },
    format: { type: "string" },
    payload: { type: "object" },
  },
} as const;

export const replaceSchema = {
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
export const restoreSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    name: { type: "string" },
  },
} as const;

export const transferSchema = {
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
export const adminAddSchema = {
  type: "object",
  additionalProperties: false,
  required: ["user_id"],
  properties: {
    user_id: { type: "string", pattern: "^\\d{17,20}$" },
    note: { type: "string" },
  },
} as const;

// PATCH (21-formats.md §2.2/§2.4): `{name}` (layout scope) OR `{format,
// <at least one of fingermap/magic>}` (that format's scope) -- never both
// (`400 mixed_patch`) or neither (`400 bad_request`/`format_required`).
// This schema only enforces "the right keys, the right JSON types"
// (`minProperties: 1`, `additionalProperties: false`); `core/write.ts`'s
// `classifyPatch` is where mixing/format-required is actually refused, so
// the error names the real reason rather than a generic shape mismatch.
// `magic` is validated as a whole VALUE here; its format-specific shape is
// the job of the record's format `edits` + the pipeline's validate()
// re-run, not this schema. `board` is no longer a key at all (design/
// layout-db/26-no-board.md: spark/1 has no board field) -- a body naming
// it fails `additionalProperties` like any other unknown key.
export const patchSchema = {
  type: "object",
  additionalProperties: false,
  minProperties: 1,
  properties: {
    name: { type: "string" },
    format: { type: "string" },
    fingermap: { type: "object", additionalProperties: { type: "string" } },
    magic: { type: "object" },
    // design/alts/07-format.md: `alts`/`combos` arrive as the WHOLE array
    // (spark/1's own top-level shape) -- validated as a whole value here
    // (loosely, like `magic`), the record shape itself is the format's own
    // edits + the pipeline's validate() re-run.
    alts: { type: "array" },
    combos: { type: "array" },
  },
} as const;

// 10 C1: `POST /v1/admin/clients`. `pubkey`'s byte length (it must decode
// to exactly 32 bytes) is not a `pattern` ajv can express -- checked in
// `core/clients.ts` after this schema passes. `caps` (LEDGER.md L4: a
// comma-separated set, exactly one scope cap plus any extra caps) is
// likewise just "a string" here -- its real membership check is
// `core/clients.ts`'s `validateCaps`, same deferred-validation pattern as
// `pubkey`'s byte length.
// L5 moderation (§4.1): `PUT /v1/admin/bans/:user_id`.
export const banSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    reason: { type: "string", maxLength: 500 },
  },
} as const;

// §4.3: `PUT /v1/admin/authors/:user_id`.
export const authorRenameSchema = {
  type: "object",
  additionalProperties: false,
  required: ["name"],
  properties: {
    name: { type: "string", minLength: 1, maxLength: 64 },
  },
} as const;

// §4.4: `PUT /v1/layouts/:ref/link`. `url`'s deep shape (https:, no
// credentials, length) is `core/links.ts`'s `validateLinkUrl` job -- this
// schema only enforces "a string is present", same deferred-validation
// split `pubkey`/`caps` already use above.
export const linkSchema = {
  type: "object",
  additionalProperties: false,
  required: ["url"],
  properties: {
    url: { type: "string" },
  },
} as const;

// docs/decisions/28-wpm-records.md: `POST /v1/wpm`. `wpm`/`proof` are
// deliberately untyped here -- their deep shape (integer 1..1000, an
// absolute http(s) URL) is `core/wpm.ts`'s `invalid_wpm`/`invalid_proof`
// job, so every route shares one set of refusals.
export const wpmSchema = {
  type: "object",
  additionalProperties: false,
  required: ["layout", "wpm", "proof"],
  properties: {
    layout: { type: "string", minLength: 1 },
    wpm: {},
    proof: {},
  },
} as const;

// `POST /v1/admin/wpm`: the same, plus whose speed it is.
export const wpmOnBehalfSchema = {
  type: "object",
  additionalProperties: false,
  required: ["user_id", "layout", "wpm", "proof"],
  properties: {
    user_id: { type: "string" },
    layout: { type: "string", minLength: 1 },
    wpm: {},
    proof: {},
  },
} as const;

// docs/decisions/29-layout-comments.md: `PUT /v1/layouts/:ref/comment`.
// `body` is deliberately untyped here -- its deep shape (a string of 1..2000
// code points after normalization) is `core/comments.ts`'s `invalid_comment`
// job, the one validator every route shares.
export const commentSchema = {
  type: "object",
  additionalProperties: false,
  required: ["body"],
  properties: {
    body: {},
  },
} as const;

// §4.4: `POST /v1/admin/link-queue/:id/reject`.
export const linkRejectSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    reason: { type: "string", maxLength: 500 },
  },
} as const;

export const registerClientSchema = {
  type: "object",
  additionalProperties: false,
  required: ["name", "pubkey", "owner_user_id", "caps"],
  properties: {
    name: { type: "string", minLength: 1 },
    pubkey: { type: "string" },
    owner_user_id: { type: "string", pattern: "^\\d{17,20}$" },
    caps: { type: "string" },
    discord_app_id: { type: "string" },
  },
} as const;

// ---- the schemas that used to be written inline where they were compiled ----

// `POST /v1/admin/discord-users/refresh`: `limit` is validated in core/discord-users.ts.
export const discordUsersRefreshSchema = {
  type: "object", additionalProperties: false, properties: { limit: {} },
} as const;

const reviewVersionSchema = { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER } as const;
export const reviewApproveSchema = {
  type: "object", additionalProperties: false, properties: { review_version: reviewVersionSchema },
} as const;
export const reviewRejectSchema = {
  type: "object", additionalProperties: false, properties: { review_version: reviewVersionSchema, reason: { type: "string", maxLength: 500 } },
} as const;
export const reviewReopenSchema = {
  type: "object", additionalProperties: false, required: ["status", "review_version"],
  properties: { status: { type: "string", enum: ["approved", "rejected", "superseded"] }, review_version: reviewVersionSchema },
} as const;

// Absolute end assertion also rejects a trailing newline (JavaScript `$` does not).
export const wpmDiscordMessageSchema = {
  type: "object",
  additionalProperties: false,
  required: ["guild_id", "channel_id", "message_id"],
  properties: {
    guild_id: { type: ["string", "null"], pattern: "^[0-9]{17,20}(?![\\s\\S])" },
    channel_id: { type: "string", pattern: "^[0-9]{17,20}(?![\\s\\S])" },
    message_id: { type: "string", pattern: "^[0-9]{17,20}(?![\\s\\S])" },
  },
} as const;

/**
 * Every body schema, by the name of its validator in validators.generated.ts. `scripts/build-validators.mjs` compiles this
 * map at build time (ajv standalone) and tests/platform/validators.test.ts compiles it at run time to prove the generated
 * validators behave identically (RP5). Nothing at run time compiles a schema.
 */
export const SCHEMAS = {
  validateCreate: createSchema,
  validateReplace: replaceSchema,
  validateRestore: restoreSchema,
  validateTransfer: transferSchema,
  validateAdminAdd: adminAddSchema,
  validatePatch: patchSchema,
  validateRegisterClient: registerClientSchema,
  validateBan: banSchema,
  validateAuthorRename: authorRenameSchema,
  validateLink: linkSchema,
  validateLinkReject: linkRejectSchema,
  validateComment: commentSchema,
  validateWpm: wpmSchema,
  validateWpmOnBehalf: wpmOnBehalfSchema,
  validateDiscordUsersRefresh: discordUsersRefreshSchema,
  validateReviewApprove: reviewApproveSchema,
  validateReviewReject: reviewRejectSchema,
  validateReviewReopen: reviewReopenSchema,
  validateWpmDiscordMessage: wpmDiscordMessageSchema,
} as const;
