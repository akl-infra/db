// RP5: the request-body validators are ajv standalone code generated at build time (scripts/build-validators.mjs) and both
// hosts import that one file. This proves (1) the committed file is what the schemas generate today, (2) nothing in src/
// imports or calls ajv, and (3) the generated validators and ajv's run-time compile of the same schemas accept and reject
// the same bodies with the same errors, and the parse functions answer the same 400s the old run-time-compiled code did.
import fs from "node:fs";
import path from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { ApiError, badRequest, formatRequired } from "../../src/core/errors";
import * as parsers from "../../src/routes/schemas";
import { SCHEMAS } from "../../src/routes/schema-defs";
import * as generated from "../../src/routes/validators.generated";
// @ts-expect-error the script is plain ESM without types
import { AJV_OPTIONS, OUT, generate } from "../../scripts/build-validators.mjs";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const NAMES = Object.keys(SCHEMAS) as (keyof typeof SCHEMAS)[];

const runtime = new Ajv2020(AJV_OPTIONS as never);
const compiled = Object.fromEntries(NAMES.map((n) => [n, runtime.compile(SCHEMAS[n] as never)])) as Record<string, ReturnType<typeof runtime.compile>>;
const gen = generated as unknown as Record<string, ((d: unknown) => boolean) & { errors?: unknown[] | null }>;

const SNOWFLAKE = "123456789012345678";

/** Hand-written bodies: the shapes the existing API tests send (valid and not), per schema. */
const CORPUS: Record<(typeof NAMES)[number], unknown[]> = {
  validateCreate: [{ name: "my-layout", format: "spark/1", payload: { keys: {} } }, { name: "x", format: "spark/1" }, { format: "spark/1", payload: {} }, { name: "x", format: "spark/1", payload: [] }, { name: 1, format: "a", payload: {} }, { name: "x", format: "a", payload: {}, owner: SNOWFLAKE }, { name: "x", format: "a", payload: {}, id: "01H", rev: 1, created_at: "now" }, {}],
  validateReplace: [{ format: "spark/1", payload: {} }, { payload: {} }, { format: "spark/1" }, { format: "spark/1", payload: null }, { format: "spark/1", payload: {}, name: "x" }],
  validateRestore: [{}, { name: "new-name" }, { name: 5 }, { name: "a", extra: 1 }, { nane: "typo" }],
  validateTransfer: [{ to: SNOWFLAKE }, { to: 5 }, {}, { to: "x", also: "y" }],
  validateAdminAdd: [{ user_id: SNOWFLAKE }, { user_id: SNOWFLAKE, note: "why" }, { user_id: "12345" }, { user_id: "1".repeat(21) }, { user_id: "1".repeat(17) }, { user_id: "1".repeat(20) }, { user_id: SNOWFLAKE + "\n" }, { user_id: "١٢٣٤٥٦٧٨٩٠١٢٣٤٥٦٧٨" }, { note: "x" }, { user_id: SNOWFLAKE, note: 1 }],
  validatePatch: [{ name: "n" }, { format: "spark/1", fingermap: { a: "L1" } }, { format: "spark/1", magic: { rules: [] } }, { alts: [] }, { combos: [{}] }, { fingermap: { a: 1 } }, { board: "ansi" }, {}, { name: 1 }, { alts: {} }, { magic: [] }],
  validateRegisterClient: [{ name: "bot", pubkey: "AAAA", owner_user_id: SNOWFLAKE, caps: "w:spark" }, { name: "", pubkey: "A", owner_user_id: SNOWFLAKE, caps: "x" }, { name: "b", pubkey: "A", owner_user_id: "nope", caps: "x" }, { name: "b", pubkey: "A", owner_user_id: SNOWFLAKE, caps: "x", discord_app_id: SNOWFLAKE }, { name: "b", pubkey: "A", owner_user_id: SNOWFLAKE }],
  validateBan: [{}, { reason: "spam" }, { reason: "x".repeat(500) }, { reason: "x".repeat(501) }, { reason: "😀".repeat(500) }, { reason: "😀".repeat(501) }, { reason: null }, { why: "x" }],
  validateAuthorRename: [{ name: "Ann" }, { name: "" }, { name: "x".repeat(64) }, { name: "x".repeat(65) }, { name: "😀".repeat(64) }, { name: "😀".repeat(65) }, {}, { name: "a", b: 1 }],
  validateLink: [{ url: "https://example.org/x" }, { url: 1 }, {}, { url: "https://a", also: 1 }],
  validateLinkReject: [{}, { reason: "no" }, { reason: "x".repeat(501) }, { reason: 5 }],
  validateComment: [{ body: "hello" }, { body: 5 }, { body: null }, {}, { body: "x", extra: true }],
  validateWpm: [{ layout: "my-layout", wpm: 100, proof: "https://example.org/p" }, { layout: "", wpm: 1, proof: "x" }, { layout: "a", wpm: "fast", proof: {} }, { layout: "a", wpm: 1 }, { layout: "a", wpm: 1, proof: "p", user_id: SNOWFLAKE }],
  validateWpmOnBehalf: [{ user_id: SNOWFLAKE, layout: "a", wpm: 90, proof: "https://x" }, { layout: "a", wpm: 90, proof: "https://x" }, { user_id: 5, layout: "a", wpm: 90, proof: "p" }],
  validateDiscordUsersRefresh: [{}, { limit: 5 }, { limit: "five" }, { limit: null }, { limits: 5 }],
  validateReviewApprove: [{}, { review_version: 0 }, { review_version: 3 }, { review_version: -1 }, { review_version: 1.5 }, { review_version: Number.MAX_SAFE_INTEGER }, { review_version: Number.MAX_SAFE_INTEGER + 2 }, { review_version: "1" }, { reason: "x" }],
  validateReviewReject: [{}, { review_version: 2, reason: "dup" }, { reason: "x".repeat(500) }, { reason: "x".repeat(501) }, { review_version: null }],
  validateReviewReopen: [{ status: "approved", review_version: 1 }, { status: "rejected", review_version: 0 }, { status: "pending", review_version: 1 }, { status: "approved" }, { review_version: 1 }, { status: "approved", review_version: 1, reason: "r" }],
  validateWpmDiscordMessage: [
    { guild_id: SNOWFLAKE, channel_id: SNOWFLAKE, message_id: SNOWFLAKE },
    { guild_id: null, channel_id: SNOWFLAKE, message_id: SNOWFLAKE },
    { guild_id: SNOWFLAKE, channel_id: SNOWFLAKE, message_id: SNOWFLAKE + "\n" },
    { guild_id: SNOWFLAKE, channel_id: "12", message_id: SNOWFLAKE },
    { guild_id: 5, channel_id: SNOWFLAKE, message_id: SNOWFLAKE },
    { channel_id: SNOWFLAKE, message_id: SNOWFLAKE },
  ],
};

// Values drawn from every kind the keywords look at: types, lengths (including astral characters), digit runs around the
// 17-20 snowflake bounds, the review_version range edges, the status enum.
const value: fc.Arbitrary<unknown> = fc.oneof(
  fc.string({ maxLength: 80 }),
  fc.string({ unit: "binary", maxLength: 70 }),
  fc.string({ unit: "grapheme", minLength: 60, maxLength: 70 }),
  fc.stringMatching(/^\d{14,23}$/),
  fc.stringMatching(/^\d{17,20}\n?$/),
  fc.constantFrom("approved", "rejected", "pending", "", "x".repeat(500), "x".repeat(501), "😀".repeat(64), "😀".repeat(65)),
  fc.constant(null),
  fc.boolean(),
  fc.integer({ min: -3, max: 5 }),
  fc.constantFrom(Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER + 2, 1.5, -0, 1e300),
  fc.double({ noNaN: true }),
  fc.array(fc.string({ maxLength: 4 }), { maxLength: 3 }),
  fc.dictionary(fc.string({ maxLength: 4 }), fc.string({ maxLength: 4 }), { maxKeys: 3 }),
);
const KEYS = [...new Set(NAMES.flatMap((n) => Object.keys((SCHEMAS[n] as { properties?: object }).properties ?? {})).concat(["owner", "id", "rev", "created_at", "board", "extra"]))];
const body = fc.dictionary(fc.constantFrom(...KEYS), value, { maxKeys: 6 });

function sameVerdict(name: string, data: unknown): void {
  const a = compiled[name]!(data);
  const b = gen[name]!(data);
  expect(b, `${name} ${JSON.stringify(data)}`).toBe(a);
  if (!a) {
    // the first error, key by key: the same keyword, place, parameters, text and schema path
    expect(gen[name]!.errors, `${name} errors for ${JSON.stringify(data)}`).toEqual(compiled[name]!.errors);
  } else {
    expect(gen[name]!.errors ?? null).toBeNull();
  }
}

describe("precompiled validators (RP5)", () => {
  it("[LDB-RP5] the committed validators.generated.ts is exactly what `npm run build:validators` produces from the schemas (a stale file fails here)", () => {
    expect(fs.readFileSync(OUT as string, "utf8")).toBe((generate as () => string)());
  });

  it("[LDB-RP5] nothing in src/ imports ajv or compiles a schema at run time: the Worker build and the Lambda bundle share one precompiled module", () => {
    const walk = (d: string): string[] => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : e.name.endsWith(".ts") ? [path.join(d, e.name)] : []));
    for (const f of walk(path.join(ROOT, "src"))) {
      const src = fs.readFileSync(f, "utf8");
      expect(src, f).not.toMatch(/from\s+["']ajv/);
      expect(src, f).not.toMatch(/\bnew Ajv|ajv\.compile\(/);
    }
    expect(fs.readFileSync(path.join(ROOT, "src/routes/validators.generated.ts"), "utf8")).not.toMatch(/\brequire\(|\bimport\b/);
    for (const n of NAMES) expect(typeof gen[n], n).toBe("function");
  });

  it("[LDB-RP5] every schema has a hand-written corpus of accepted and refused bodies, and both implementations agree on every one", () => {
    for (const n of NAMES) {
      const bodies = CORPUS[n];
      expect(bodies.length, n).toBeGreaterThan(2);
      const verdicts = bodies.map((b) => compiled[n]!(b));
      expect(new Set(verdicts).size, `${n} corpus has both accepted and refused bodies`).toBeGreaterThan(0);
      for (const b of bodies) sameVerdict(n, b);
    }
    // and the corpus is not all-refuse: at least one accepted body per schema
    for (const n of NAMES) expect(CORPUS[n].some((b) => compiled[n]!(b)), n).toBe(true);
    expect(NAMES.flatMap((n) => CORPUS[n].filter((b) => !compiled[n]!(b)))).not.toHaveLength(0);
  });

  it("[LDB-RP5] on generated bodies (random subsets of every schema's keys with values of every kind) the verdicts and the errors are identical", () => {
    for (const n of NAMES) {
      fc.assert(fc.property(body, (b) => (sameVerdict(n, b), true)), { numRuns: 300, seed: 5 });
    }
  });

  it("[LDB-RP5] generated bodies that are not objects at all (arrays, scalars, null) are judged the same", () => {
    for (const n of NAMES) fc.assert(fc.property(fc.jsonValue(), (b) => (sameVerdict(n, b), true)), { numRuns: 100, seed: 6 });
  });

  it("[LDB-RP5] the parse functions raise the same 400 (message, code, param) as the run-time-compiled implementation they replaced", () => {
    const refCheck = (name: string, data: unknown): unknown => {
      if (typeof data !== "object" || data === null || Array.isArray(data)) return badRequest("request body must be a JSON object", "/").body;
      const validate = compiled[name]!;
      if (validate(data)) return "ok";
      const err = validate.errors?.[0];
      if (err === undefined) return badRequest("invalid request body", "/").body;
      if (err.keyword === "required" && (err.params as { missingProperty: string }).missingProperty === "format") return formatRequired().body;
      const param = err.keyword === "additionalProperties" ? `${err.instancePath}/${(err.params as { additionalProperty: string }).additionalProperty}` : err.keyword === "required" ? `${err.instancePath}/${(err.params as { missingProperty: string }).missingProperty}` : err.instancePath === "" ? "/" : err.instancePath;
      return badRequest(runtime.errorsText([err], { dataVar: "body" }), param).body;
    };
    const parse: Record<string, (b: unknown) => unknown> = {
      validateCreate: parsers.parseCreateBody, validateReplace: parsers.parseReplaceBody, validateRestore: parsers.parseRestoreBody, validateTransfer: parsers.parseTransferBody,
      validateAdminAdd: parsers.parseAdminAddBody, validatePatch: parsers.parsePatchBody, validateRegisterClient: parsers.parseRegisterClientBody, validateBan: parsers.parseBanBody,
      validateAuthorRename: parsers.parseAuthorRenameBody, validateLink: parsers.parseLinkBody, validateLinkReject: parsers.parseLinkRejectBody, validateComment: parsers.parseCommentBody,
      validateWpm: parsers.parseWpmBody, validateWpmOnBehalf: parsers.parseWpmOnBehalfBody, validateDiscordUsersRefresh: parsers.parseDiscordUsersRefreshBody,
      validateReviewApprove: parsers.parseReviewApproveBody, validateReviewReject: parsers.parseReviewRejectBody, validateReviewReopen: parsers.parseReviewReopenBody,
      validateWpmDiscordMessage: parsers.parseWpmDiscordMessageBody,
    };
    expect(Object.keys(parse).sort()).toEqual([...NAMES].sort());
    const outcome = (fn: () => unknown): unknown => {
      try {
        fn();
        return "ok";
      } catch (e) {
        if (e instanceof ApiError) return e.body;
        throw e;
      }
    };
    const check = (n: string, b: unknown) => expect(outcome(() => parse[n]!(b)), `${n} ${JSON.stringify(b)}`).toEqual(refCheck(n, b));
    for (const n of NAMES) {
      for (const b of CORPUS[n]) check(n, b);
      for (const b of [null, [], 5, "x", true]) check(n, b);
      fc.assert(fc.property(body, (b) => (check(n, b), true)), { numRuns: 150, seed: 7 });
    }
  });
});
