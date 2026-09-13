// spark/1 -- the one stored format (design/layout-db/20-spark.md §1 decision
// 1; was `akl/1`, renamed byte-for-byte -- the payload shape is unchanged).
// cmini's `keys` map, the board geometry #261/23-geometry.md introduced, the
// magic-rules authoring shape, and a raw-rule escape hatch (21-formats.md
// D10 dropped the free-form `x` field -- there is no cmini export left to
// round-trip through it, and nothing else ever used it). Self-contained
// (07 §5): no import of src/formats/registry.ts, and every local import
// carries an explicit `.ts` extension so scripts/goldens.mjs can resolve
// this module with plain Node ESM (see that script's own comment).
//
// design/layout-db/23-geometry.md (round 3, "boards and thumbs explicit"):
// `board` is now one required word (ansi/iso/ortho/colstag, §4.1) instead of
// an object with stagger amounts and a cmini hint -- physical coordinates,
// the hand split and the named-fingering classification are ALL pure
// functions of `(board, keys)` now, exported by ./geometry.ts (LDB-F30: one
// definition, no second port inside this format package). `TB` is gone from
// `Position.finger` (§4.2): a thumb key's label IS its physical hand,
// nothing left to disambiguate.
//
// `fromCmini` (the cmini IMPORT) lives at
// `db/formats/adapters/cmini/translate.ts` (20-spark.md S1): cmini is an
// import source now, not a registered format, so the conversion lives with
// the adapter, not here. `toCmini` (the export) was deleted entirely by
// 21-formats.md D5. This format still exports the pure board-word helper
// used to (`cminiBoardWord`, was the private `deriveCminiWord`) -- kept
// because `bot/`'s own board-word reads still call it directly (see that
// module's callers).
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import rawSchema from "./schema.json" with { type: "json" };
import {
  computeRows,
  findCollision,
  resolveRows,
  isSingleChar,
  validateMagicSemantics,
  type AdaptiveSwap,
  type ChiralKey,
  type MagicIntent,
  type MagicKey,
  type RawRule,
} from "./magic.ts";
import { classifyFingering, type Board, type Key } from "./geometry.ts";
// mana2/1's OWN translate.ts is the one place spark/1 <-> mana2/1 is
// implemented (12-implementation-phase5.md §2.5) -- this reciprocal
// registration just re-exports those two functions under spark/1's own
// `to`/`from` maps, the same "one implementation, two registrations"
// pattern this format used for `fromCmini`/`toCmini` before they moved to
// the adapter. No runtime import cycle: mana2/1/translate.ts imports only
// TYPES from this file (erased at compile time), and its one VALUE import
// from this format (`computeRows`) comes from ./magic.ts, not this file.
import { toSpark as mana2ToSpark, fromSpark as mana2FromSpark } from "../../mana2/1/translate.ts";
import type { Payload as Mana2Payload } from "../../mana2/1/index.ts";

export const id: `${string}/${number}` = "spark/1";
// `GET /v1/formats` (07 §6 S6; registry.ts's FormatModule comment explains
// why this is a plain export rather than parsed from OWNERS/README.md).
export const owner = "DB (+ akl.gg)";
export const description =
  "The one stored format: cmini's keys map, #261's board geometry, an authoring shape for magic rules, and a raw-rule escape hatch. What akl.gg writes and most clients read.";
export const schema: object = rawSchema;
export const role: "stored" | "output" = "stored";

// A plain (row, col, finger) position -- magic.ts's own vocabulary (a
// char-keyed lookup map), kept as the shape that module still takes. Built
// on demand from `Payload.keys` by `charMap()` below; never stored directly
// any more (23-geometry.md's duplicate-characters follow-up: `Payload.keys`
// itself is now an ARRAY of entries, not a char-keyed record, since the
// same character may legitimately sit on more than one physical position).
export interface Position {
  row: number;
  col: number;
  finger: string;
}

export type { Board, Key };
export type { MagicIntent, MagicKey, ChiralKey, AdaptiveSwap, RawRule };
// Re-exported for clients (the bot, LDB-F30: one definition of every
// geometric fact) -- purely additive.
export { KINDS, STAGGER_BY_KIND, coords, handSplit, handSplitRows, classifyFingering, gridIndent, FINGERING_REFS } from "./geometry.ts";
export type { NamedFingering, Fingering } from "./geometry.ts";

// keys: one entry per PHYSICAL position -- `char` absent means a free
// position (the old separate `free` array is gone, folded in here). The
// same `char` may repeat across several entries (duplicate letters, e.g. a
// mirrored 'y' on both hands); every char a magic construct NAMES must be
// unique among these entries (`validateMagicKeysUnique` below,
// `magic_needs_unique_key`) since magic addresses a layout by character, not
// by position -- a plain, magic-unreferenced duplicate has no such
// requirement.
export interface Payload {
  keys: Key[];
  board: Board;
  magic?: MagicIntent;
}

export interface Row {
  inputs: string;
  output: string;
  type?: string;
}

export interface ErrBody {
  error: string;
  message: string;
  [extra: string]: unknown;
}

export type ValidationResult = { ok: true } | { ok: false; error: ErrBody };

// LDB-F35 (design/layout-db/22-spark-spec.md §6): `export const schema`
// above is `rawSchema` verbatim -- what `GET /v1/formats/spark/1/
// schema.json` serves, byte-identical to schema.json on disk, pinned by
// `tests/conformance/formats-schema/200.json`. The validator itself
// compiles a separate, never-exported CLONE with ajv's `discriminator`
// keyword added to `magicDefault` (so `chiralValue`, its `$ref`, gets it
// too) -- a hint that changes WHICH oneOf branch ajv reports an error
// from, never which payloads validate (every discriminator branch here
// was already `type: "object"`; `additionalProperties: false` and each
// branch's own `required`/`const` on `kind` already made the branches
// mutually exclusive) or what the served schema document says. Keeping
// this out of schema.json means this row costs no WIRE_VERSION bump and
// touches no conformance fixture -- a client vendoring or diffing the
// served schema sees no change at all.
function withDiscriminatorHint(s: typeof rawSchema): object {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- schema.json's shape isn't typed; this only ever runs once, over $defs.magicDefault
  const clone = structuredClone(s) as any;
  const magicDefault = clone.$defs.magicDefault;
  magicDefault.type = "object";
  magicDefault.discriminator = { propertyName: "kind" };
  return clone;
}
const validationSchema = withDiscriminatorHint(rawSchema);

// Two compiled validators off `validationSchema`, not one. `ajvValidate`
// (allErrors: false) is the fast path every write pays for -- unchanged
// from before this row, still one pass, still stops at the first schema
// violation, so a VALID payload (the common case) costs exactly what it
// always did. `ajvValidateAll` (allErrors: true) only ever runs after
// `ajvValidate` has already failed (the rarer, off-happy-path case): it
// re-validates the same payload to collect every branch's errors, which
// `pickMostSpecificError` below needs to tell an incidental union-branch
// artifact from the real fault. `discriminator: true` (both instances)
// makes ajv resolve `magicDefault`'s `kind`-tagged union to the ONE branch
// `kind` names and validate only that branch -- most of what used to need
// `pickMostSpecificError`'s branch-grouping logic at all, for exactly the
// union that motivated this row (chiralKey.same/opposite's own `| null`
// union has no discriminant to give ajv -- one side is a bare `null` type
// -- so it still goes through the general picker below).
const ajv = new Ajv2020({ allErrors: false, strict: true, discriminator: true });
addFormats(ajv);
const ajvValidate = ajv.compile(validationSchema);

const ajvAll = new Ajv2020({ allErrors: true, strict: true, discriminator: true });
addFormats(ajvAll);
const ajvValidateAll = ajvAll.compile(validationSchema);

// LDB-F35: ajv error keywords that only ever record union bookkeeping --
// "this data didn't match exactly one/any branch" -- never the reason a
// branch itself failed. Always noise, on every union, discriminated or
// not (a non-discriminated oneOf, e.g. chiralKey.same|opposite's `| null`,
// still emits one of these once none of its branches match).
const UNION_BOOKKEEPING_KEYWORDS = new Set(["oneOf", "anyOf", "if", "then"]);

// Keyword specificity, most to least, for breaking a same-depth tie
// between two surviving candidates (rare: it takes two genuinely
// independent faults at the same instancePath depth, e.g. a payload
// mutation-tested by mutations.test.ts's generated matrix landing two
// leaf changes at once, which the matrix itself never does, or a
// non-discriminated union like chiralKey.same|opposite failing on both a
// content error AND the sibling `null` branch's own type mismatch).
// type/const/enum/format-ish keywords name the value itself; additionalProperties
// and required name a shape gap one level up and, by construction, are
// exactly the keywords a wrong union branch produces incidentally -- kept
// last so a genuine required/additionalProperties fault on the RIGHT
// branch (nothing more specific to prefer over it) still wins on depth
// alone against nothing, but never displaces a same-depth, more specific
// sibling.
const KEYWORD_RANK: Record<string, number> = {
  type: 0,
  const: 0,
  enum: 0,
  format: 1,
  pattern: 1,
  minLength: 1,
  maxLength: 1,
  minimum: 1,
  maximum: 1,
  minItems: 1,
  maxItems: 1,
  discriminator: 1,
  required: 2,
  additionalProperties: 3,
};

function keywordRank(keyword: string): number {
  return KEYWORD_RANK[keyword] ?? 1;
}

// `instancePath` depth as "how many '/'-separated segments" -- not a
// structural JSON depth (a pointer segment can itself contain an escaped
// "/"), just a total order deep enough to tell "/magic/magic_keys/0/default"
// (a container) from "/magic/magic_keys/0/default/char" (its own field)
// apart, which is all `pickMostSpecificError` needs it for.
function pointerDepth(instancePath: string): number {
  return instancePath.split("/").length;
}

// The schemaPath prefix identifying which union BRANCH (not just which
// union) an error belongs to -- "#/.../oneOf/1/properties/char/type" ->
// "#/.../oneOf/1" -- so errors from the same branch group together
// regardless of which of that branch's own keywords produced them.
function branchKeyOf(schemaPath: string): string | null {
  const m = /^(.*\/(?:oneOf|anyOf)\/\d+)(?:\/|$)/.exec(schemaPath);
  return m ? m[1]! : null;
}

// [LDB-F35] Most-specific-error selection over a FULL ajv error list
// (`allErrors: true`): a `oneOf`/`anyOf` with no matching branch reports
// one error per branch it tried plus a bookkeeping "must match exactly
// one/any schema" error -- `errors[0]` (the old behaviour) is whichever
// branch ajv happened to evaluate first, not necessarily the branch the
// author meant to satisfy. This groups errors by the union branch they
// came from (`branchKeyOf`), drops any branch whose OWN discriminating
// field failed a `const`/`enum` check (that branch was never a candidate
// -- its other errors, e.g. an incidental `additionalProperties`, are
// noise from evaluating a schema the payload was never trying to match),
// drops the bookkeeping keywords outright, and returns the deepest
// `instancePath` left (ties broken by `keywordRank`, then by the error's
// own position in ajv's array -- deterministic for a fixed schema and ajv
// version, independent of `allErrors`' internal branch-evaluation order,
// per LDB-F37).
function pickMostSpecificError(errors: import("ajv").ErrorObject[]): import("ajv").ErrorObject {
  const branches = new Map<string, import("ajv").ErrorObject[]>();
  for (const e of errors) {
    const bk = branchKeyOf(e.schemaPath);
    if (bk === null) continue;
    const group = branches.get(bk);
    if (group) group.push(e);
    else branches.set(bk, [e]);
  }
  const wrongBranches = new Set<string>();
  for (const [bk, group] of branches) {
    if (group.some((e) => e.keyword === "const" || e.keyword === "enum")) wrongBranches.add(bk);
  }

  function candidatesOf(pool: import("ajv").ErrorObject[]): import("ajv").ErrorObject[] {
    return pool.filter((e) => {
      if (UNION_BOOKKEEPING_KEYWORDS.has(e.keyword)) return false;
      const bk = branchKeyOf(e.schemaPath);
      return bk === null || !wrongBranches.has(bk);
    });
  }

  // Fall back in stages so this never returns nothing: first the errors
  // that survive both filters; if every error belonged to a wrong branch
  // (a `kind` naming neither branch at all), fall back to every
  // non-bookkeeping error; if even that is empty (only bookkeeping
  // errors, which shouldn't happen but `errors` is untrusted input from
  // ajv's own runtime), fall back to the raw list.
  const candidates = candidatesOf(errors);
  const pool = candidates.length > 0 ? candidates : errors.filter((e) => !UNION_BOOKKEEPING_KEYWORDS.has(e.keyword));
  const finalPool = pool.length > 0 ? pool : errors;

  let best = finalPool[0]!;
  let bestIndex = errors.indexOf(best);
  for (let i = 1; i < finalPool.length; i++) {
    const e = finalPool[i]!;
    const eDepth = pointerDepth(e.instancePath);
    const bestDepth = pointerDepth(best.instancePath);
    const eIndex = errors.indexOf(e);
    const better =
      eDepth > bestDepth ||
      (eDepth === bestDepth && keywordRank(e.keyword) < keywordRank(best.keyword)) ||
      (eDepth === bestDepth && keywordRank(e.keyword) === keywordRank(best.keyword) && eIndex < bestIndex);
    if (better) {
      best = e;
      bestIndex = eIndex;
    }
  }
  return best;
}

interface DupPosition {
  row: number;
  col: number;
  paths: [string, string];
}

// No two entries share (row, col) -- the same CHARACTER may repeat (a
// duplicate letter), but never at the same physical position twice.
function findDuplicatePosition(p: Payload): DupPosition | null {
  const firstPath = new Map<string, string>();
  for (let i = 0; i < p.keys.length; i++) {
    const pos = p.keys[i]!;
    const key = `${pos.row},${pos.col}`;
    const path = `/keys/${i}`;
    const prior = firstPath.get(key);
    if (prior !== undefined) return { row: pos.row, col: pos.col, paths: [prior, path] };
    firstPath.set(key, path);
  }
  return null;
}

// charMap: `Payload.keys`' char-bearing entries, projected onto magic.ts's
// own char-keyed vocabulary (`Record<string, Position>`) -- the "primary"
// occurrence of a duplicate char is the FIRST ENTRY FOR IT IN LIST ORDER
// (design/layout-db/24-spark-wire-review.md finding 5: `keys` is an
// ORDERED list and its array order is never resorted/canonicalised). The
// SAME rule `db/formats/mana2/1/translate.ts`'s `fromSpark` uses to pick
// the one "analysed" occurrence of a repeated letter (one canonical rule,
// not two). Irrelevant for any char a magic construct actually names --
// `validateMagicKeysUnique` below refuses those unless they're already
// unique, so there is only ever one occurrence to pick for them.
function charMap(keys: Key[]): Record<string, Position> {
  const out: Record<string, Position> = {};
  for (const k of keys) {
    if (k.char === undefined) continue;
    if (!(k.char in out)) out[k.char] = { row: k.row, col: k.col, finger: k.finger };
  }
  return out;
}

// handOfFinger: magic.ts's own `handOf` reduced to the finger-prefix rule
// alone (L*/R*, thumbs included -- `LT`/`RT` DO count as a hand here, same
// as magic.ts) -- needed here (not imported) only to detect a duplicate
// char whose entries span BOTH hands, below.
function handOfFinger(finger: string): "L" | "R" | null {
  return finger.startsWith("L") ? "L" : finger.startsWith("R") ? "R" : null;
}

// design/layout-db/24-spark-wire-review.md finding 5: a duplicate char
// whose entries span BOTH hands is ambiguous for any chiral key's scaffold
// (which needs ONE hand per char, LDB-F15) -- collected here so
// `validateChiralHandAmbiguity` can refuse it unless every chiral key that
// would otherwise enumerate it excepts it.
function bothHandsChars(keys: Key[]): Set<string> {
  const hands = new Map<string, Set<"L" | "R">>();
  for (const k of keys) {
    if (k.char === undefined) continue;
    const h = handOfFinger(k.finger);
    if (h === null) continue;
    (hands.get(k.char) ?? hands.set(k.char, new Set()).get(k.char)!).add(h);
  }
  const out = new Set<string>();
  for (const [ch, set] of hands) if (set.size > 1) out.add(ch);
  return out;
}

// A both-hands duplicate char is refused for a given chiral key unless
// EITHER that key excepts it OR a raw `rules[]` row already covers the
// exact (char, chiral key) pair (design/layout-db/24-spark-wire-review.md
// round 2's resolution item 4: chiral keys have no `rules[]` of their own,
// so "covered by a rule" can only mean the raw escape hatch names the same
// `inputs` the scaffold would have produced -- the author has already
// pinned down what this ambiguous pair does, nothing left to guess) --
// otherwise that key's scaffold has no well-defined hand to compare against
// for this char (magic.ts's `computeRows` would otherwise silently use
// whichever occurrence `charMap` happens to pick as "primary", hiding the
// ambiguity rather than surfacing it).
function validateChiralHandAmbiguity(p: Payload): ErrBody | null {
  const chiralKeys = p.magic?.chiral_keys ?? [];
  if (chiralKeys.length === 0) return null;
  const ambiguous = bothHandsChars(p.keys);
  if (ambiguous.size === 0) return null;
  const rawInputs = new Set((p.magic?.rules ?? []).map((r) => r.inputs));
  for (const ck of chiralKeys) {
    const exceptSet = new Set(ck.except ?? []);
    for (const ch of ambiguous) {
      if (exceptSet.has(ch) || rawInputs.has(ch + ck.key)) continue;
      return {
        error: "magic_needs_unique_key",
        message: `${JSON.stringify(ch)} is on both hands; add it to chiral_keys[].except, cover ${JSON.stringify(ch + ck.key)} with a raw rule, or give it a unique position`,
        path: "/keys",
      };
    }
  }
  return null;
}

function rowWidth(keys: Key[], row: number): number {
  let width = 0;
  for (const p of keys) if (p.row === row) width = Math.max(width, p.col + 1);
  return width;
}

// design/layout-db/23-geometry.md's duplicate-characters follow-up: every
// char a magic construct NAMES (a magic/chiral key's own char, an adaptive
// swap's trigger or either swap member, a magic key rule's `after`, any
// `except[]` entry) must be unique among `keys`' char-bearing entries --
// magic addresses a layout by character, so a named char with more than one
// physical occurrence is genuinely ambiguous. `400 magic_needs_unique_key`
// (LDB-F33), naming the char.
function collectMagicChars(m: MagicIntent): Set<string> {
  const out = new Set<string>();
  for (const mk of m.magic_keys ?? []) {
    if (typeof mk.key === "string") out.add(mk.key);
    for (const r of mk.rules ?? []) if (typeof r.after === "string") out.add(r.after);
    for (const c of mk.except ?? []) if (typeof c === "string") out.add(c);
  }
  for (const ck of m.chiral_keys ?? []) {
    if (typeof ck.key === "string") out.add(ck.key);
    for (const c of ck.except ?? []) if (typeof c === "string") out.add(c);
  }
  for (const sw of m.adaptive_swaps ?? []) {
    if (typeof sw.trigger === "string") out.add(sw.trigger);
    for (const c of sw.swap ?? []) if (typeof c === "string") out.add(c);
  }
  return out;
}

function validateMagicKeysUnique(p: Payload): ErrBody | null {
  if (p.magic === undefined) return null;
  const counts = new Map<string, number>();
  for (const k of p.keys) {
    if (k.char === undefined) continue;
    counts.set(k.char, (counts.get(k.char) ?? 0) + 1);
  }
  for (const ch of collectMagicChars(p.magic)) {
    if ((counts.get(ch) ?? 0) > 1) {
      return {
        error: "magic_needs_unique_key",
        message: `magic names ${JSON.stringify(ch)}, which appears on more than one position -- a magic-referenced character must be unique`,
        path: "/keys",
      };
    }
  }
  return null;
}

// design/layout-db/23-geometry.md §4.4: board-geometry checks, run after the
// schema and the duplicate-position check, in the doc's own order (2-3;
// rule 1, "board is one of the four words", is the schema's `enum` job
// already). Rule 4 ("angle/nokwts/meteorite needs board: ansi") is NOT
// enforced here (design/layout-db/24-spark-wire-review.md finding 10, the
// coordinator's amendment): `classifyFingering` is a derived, read-time
// label, never a write-time refusal -- the BOT enforces "angle only on
// ansi" for its own `fingers!`/`board!` verbs instead. `classifyFingering`
// stays exported for that (and for the site/pipeline).
function validateGeometry(p: Payload): ErrBody | null {
  // design/layout-db/24-spark-wire-review.md finding 11 (F11, identity): a
  // space (" ") is refused as a `char` -- pending #333's declared space
  // thumb, spark/1 has no idiom for a space KEY yet (only mana2's `space`
  // token, which becomes a free position on import instead, see
  // `db/formats/mana2/1/translate.ts`).
  for (let i = 0; i < p.keys.length; i++) {
    if (p.keys[i]!.char === " ") {
      return { error: "invalid_payload", message: "a space (' ') is not a valid key character (pending #333)", path: `/keys/${i}` };
    }
  }

  // §4.4-2: on iso, row 2 may be at most one column wider than rows 0-1 --
  // never an error for EQUAL or NARROWER, and never checked on any other
  // board (only iso has an extra key that can widen row 2 at all, §4.1).
  if (p.board === "iso") {
    const base = Math.max(rowWidth(p.keys, 0), rowWidth(p.keys, 1));
    const w2 = rowWidth(p.keys, 2);
    if (base > 0 && w2 > base + 1) {
      return {
        error: "invalid_payload",
        message: `iso row 2 is ${w2} column(s) wide, more than one wider than rows 0-1 (${base})`,
        path: "/keys",
      };
    }
  }

  // §4.4-3: a thumb key (LT/RT) never sits on a finger row (0-2) -- the 22
  // number-row layouts put a NON-thumb key on row 3, so row 3+ stays
  // otherwise unrestricted (§4.2: "any row >= 3").
  for (let i = 0; i < p.keys.length; i++) {
    const pos = p.keys[i]!;
    if ((pos.finger === "LT" || pos.finger === "RT") && pos.row <= 2) {
      return {
        error: "invalid_payload",
        message: `finger '${pos.finger}' is a thumb -- it can't sit on row ${pos.row} (rows 0-2 are finger rows)`,
        path: `/keys/${i}`,
      };
    }
  }

  return null;
}

// validate: schema -> the ported validateRuleSet rules + 01 §2.1's additions
// (positions, board, magic referencing real keys, `except` single code
// points) -> the lower()/collision check (07 §5). Never throws. 21-formats
// .md D10 dropped the free-form `x` field (and its byte-cap check,
// `validateX`/`canonicalBytes`, that used to run here) -- the schema's
// `additionalProperties: false` now refuses a payload that carries one.
export function validate(p: unknown): ValidationResult {
  if (!ajvValidate(p)) {
    // [LDB-F35] The fast (allErrors: false) pass already told us the
    // payload is invalid; re-run the allErrors:true validator on the SAME
    // payload only now, off the happy path, to see every branch's errors
    // and pick the most specific one -- `ajvValidate.errors?.[0]` alone
    // (the old behaviour) was whichever error ajv's single-error mode
    // happened to stop on, not necessarily the one naming the real fault
    // inside a `oneOf`/`anyOf` union.
    ajvValidateAll(p);
    const errs = ajvValidateAll.errors ?? ajvValidate.errors ?? [];
    const err = errs.length > 0 ? pickMostSpecificError(errs) : undefined;
    return {
      ok: false,
      error: {
        error: "invalid_payload",
        message: err ? (ajv.errorsText([err], { dataVar: "payload" }) as string) : "invalid spark/1 payload",
        path: err?.instancePath || "/",
      },
    };
  }

  const payload = p as unknown as Payload;

  const dupPos = findDuplicatePosition(payload);
  if (dupPos) {
    return {
      ok: false,
      error: {
        error: "invalid_payload",
        message: `duplicate position row ${dupPos.row} col ${dupPos.col} (${dupPos.paths[0]}, ${dupPos.paths[1]})`,
        path: dupPos.paths[1],
      },
    };
  }

  const geometryErr = validateGeometry(payload);
  if (geometryErr) return { ok: false, error: geometryErr };

  const uniqueErr = validateMagicKeysUnique(payload);
  if (uniqueErr) return { ok: false, error: uniqueErr };

  const chiralErr = validateChiralHandAmbiguity(payload);
  if (chiralErr) return { ok: false, error: chiralErr };

  const keys = charMap(payload.keys);
  const magicErr = validateMagicSemantics(payload.magic, keys);
  if (magicErr) return { ok: false, error: { error: magicErr.code ?? "invalid_payload", message: magicErr.message, path: magicErr.path } };

  const rows = computeRows(payload.magic, keys);
  const collision = findCollision(rows);
  if (collision) {
    return {
      ok: false,
      error: {
        error: "magic_collision",
        message: collision.message,
        inputs: collision.inputs,
        from: collision.from,
        path: collision.path,
        ...(collision.hint ? { hint: collision.hint } : {}),
      },
    };
  }

  return { ok: true };
}

// `lower` renamed `compileMagic` (20-spark.md S1): `lower` left the
// `FormatModule` contract entirely (registry.ts's `role` replaces it), so
// every format's own compile step is now just a named export, not a
// registry-dispatched method. Logic byte-identical to the old `lower()`.
export function compileMagic(p: Payload): Row[] {
  return resolveRows(computeRows(p.magic, charMap(p.keys))).map(({ inputs, output, type }) => ({ inputs, output, type }));
}

export function hasMagic(p: Payload): boolean {
  return compileMagic(p).length > 0;
}

// design/layout-db/23-geometry.md §4.6: `board` is one word now, no
// object/hint to carry a distinct cmini spelling through -- ansi and iso
// both render as cmini's one word for "row-staggered" ("stagger"; cmini's
// vocabulary can't tell ansi from iso, or "stagger" from the old "angle"
// board word, apart at all -- the angle MOD is a fingering now, not a board
// word, §4.3); ortho and colstag both render as "ortho" (colstag's per-
// column shape has no cmini analogue). "mini"/"angle" are never produced
// any more (they were cmini-only spellings for what is now just "ortho"/
// "ansi" -- §4.6's word table). Was the private `deriveCminiWord` in
// translate.ts before fromCmini moved to the adapter (20-spark.md S1);
// stayed exported after `toCmini` (the adapter's own caller) was deleted
// entirely (21-formats.md D5) because `bot/`'s own board-word reads
// (`cache/cells.ts`, `cache/provenance.ts`) call it directly -- kept
// through this slice for the same reason (bot's own rewrite is a later
// slice, order-of-work step 2).
export function cminiBoardWord(board: Board): "stagger" | "ortho" {
  return board === "ansi" || board === "iso" ? "stagger" : "ortho";
}

// spark/1 -> mana2/1 never holds (12 §2.5's held cases are all in the
// mana2 -> spark direction). spark's `to` never listed `cmini/1` (20-spark
// .md S1): cmini was always reached through the unregistered adapter, and
// 21-formats.md D5 deleted that read path entirely -- there is no cmini
// export left at all now.
export const to: Record<string, (p: Payload) => Mana2Payload> = {
  "mana2/1": mana2FromSpark,
};
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const from: Record<string, (p: any) => any> = {
  "mana2/1": mana2ToSpark, // can return `{held:true,...}` -- `from` is never called by registry.ts's translate(), see the import comment above
};

// Re-exported so isSingleChar-shaped call sites elsewhere in this format
// (fixtures, magic.ts) don't need a second import path.
export { isSingleChar };

// registry.ts's optional PATCH slot (09 §3 T4) -- see edits.ts.
export { edits } from "./edits.ts";
