// The pure format registry (07 S2; moved out of src/formats/registry.ts by
// 12 §3 X5 item 1 so it ships inside @akl/layout-formats -- db/formats/
// itself is the package, and this module is the one place its three
// format modules are imported together). Every payload shape the service
// knows how to store and read is a directory under db/formats/<name>/
// <major>/ (01 §4) whose index.ts exports exactly the `FormatModule`
// contract below.
//
// Self-contained like every format module (07 §5): no import of
// src/core/errors.ts or anything else under src/ -- a packaged consumer
// (the bot, or anyone else who only installs @akl/layout-formats) never
// sees the Worker's ApiError machinery. `db/src/formats/registry.ts`
// re-exports this module for the Worker's own routes and adds the one
// thing that DOES need core/errors.ts: turning an `unknown` translate
// result into a thrown ApiError.
import * as cmini1 from "./cmini/1/index.ts";
import * as akl1 from "./akl/1/index.ts";
import * as mana2_1 from "./mana2/1/index.ts";

// A row of a format's lowering: what an analyzer/emulator reads regardless
// of which idiom shape produced it (01 §3).
export interface Row {
  inputs: string;
  output: string;
  type?: string;
}

// { ok: false } never throws -- `error` is a ready-to-return error body
// (07 §5).
export type ValidationResult =
  | { ok: true }
  | { ok: false; error: { error: string; message: string; [extra: string]: unknown } };

// Returned by a format's own `to[<format>]` when translating *this payload*
// is impossible (a per-payload decision an advanced format may make; cmini/1
// and akl/1 in phase 1 never do -- 01 §4). Distinct from the registry-level
// "unknown" below, which is "this format isn't registered at all".
export interface Held {
  held: true;
  reason?: string;
}

// A format's payload shape is its own business; the registry only moves it
// around untyped.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Payload = any;

// A structural twin of src/core/errors.ts's `ErrBody` -- every format
// module (and this registry) defines its own copy rather than importing
// the Worker's, so the package built from this directory never depends on
// src/ (07 §5's rule, extended to the registry itself by X5).
export interface ErrBody {
  error: string;
  message: string;
  [extra: string]: unknown;
}

// The optional PATCH slot (09 §2.6, §3 T4): each function is pure (never
// mutates `p`, structured-clones before changing anything) and total (never
// throws) -- an edit that cannot be applied answers `{ error }` instead. A
// format missing an entry entirely (cmini/1 has no `setMagic`: 03 §3, an
// owner moves to akl/1 with a PUT first) means that PATCH verb is refused
// with `unsupported_for_format` before the edit is ever called.
export type EditResult = Payload | { error: ErrBody };
export interface FormatEdits {
  // char -> finger; every named char must already be one of `p.keys`
  // (else `{error: {error: "invalid_payload", path: "/keys/<c>"}}`);
  // partial maps are fine. A bad finger word is left to the pipeline's
  // validate() re-run, not checked here.
  setFingermap?(p: Payload, map: Record<string, string>): EditResult;
  // `board` arrives shaped as akl/1's board object (01 §2) -- the API's
  // one board vocabulary regardless of the record's own format.
  setBoard?(p: Payload, board: unknown): EditResult;
  // `magic` arrives shaped as akl/1's magic object (01 §2).
  setMagic?(p: Payload, magic: unknown): EditResult;
}

export interface FormatModule {
  id: string;
  // `GET /v1/formats` (07 §6 S6). Hardcoded per-module exports rather than
  // parsed out of OWNERS/README.md at build time: those files are prose for
  // human reviewers (04 §2), and a text scraper over them is a second,
  // fragile way for owner/description to drift from what a module actually
  // says about itself. A plain exported constant is typechecked and can
  // never disagree with its own module.
  owner: string;
  description: string;
  schema: object;
  validate(p: unknown): ValidationResult;
  lower(p: Payload): Row[] | null;
  to: Record<string, (p: Payload) => Payload | Held>;
  from: Record<string, (p: Payload) => Payload>;
  hasMagic(p: Payload): boolean;
  edits?: FormatEdits;
}

let REGISTRY: FormatModule[] = [cmini1 as unknown as FormatModule, akl1 as unknown as FormatModule, mana2_1 as unknown as FormatModule];

let byId = new Map<string, FormatModule>(REGISTRY.map((f) => [f.id, f]));

export function list(): FormatModule[] {
  return [...REGISTRY];
}

export function get(id: string): FormatModule | undefined {
  return byId.get(id);
}

// Test-only escape hatch (07 §6 S6's held.test.ts): registers an extra
// format module for the lifetime of one test -- e.g. a bare `held/1` stub
// with no `to` at all, to exercise "translatable to nothing" without
// touching the real cmini/1 or akl/1 modules. `REGISTRY`/`byId` are one
// module-level singleton per test file (vitest-pool-workers isolates
// storage per file, not per `it`, 07 §2), so this returns an unregister
// function callers MUST run in `afterEach`/`afterAll` or the stub leaks
// into every other test in the same file.
export function registerForTest(mod: FormatModule): () => void {
  REGISTRY = [...REGISTRY, mod];
  byId = new Map(REGISTRY.map((f) => [f.id, f]));
  return () => {
    REGISTRY = REGISTRY.filter((f) => f !== mod);
    byId = new Map(REGISTRY.map((f) => [f.id, f]));
  };
}

function isHeld(v: unknown): v is Held {
  return typeof v === "object" && v !== null && (v as { held?: unknown }).held === true;
}

// Pure result: unlike the Worker-facing wrapper (db/src/formats/registry.ts)
// this never throws -- an unregistered `as` comes back as `{ unknown: true,
// known }` so a plain package consumer (the bot, anyone who only installs
// @akl/layout-formats) doesn't need to catch an ApiError it has never seen.
export type TranslateResult =
  | { payload: Payload }
  | { held: true; format: string; see?: string }
  | { unknown: true; known: string[] };

// translate(rec, as): identity when `as` is the record's own format; else the
// record's format's `to[as]`; `held` when that translation doesn't exist (the
// format pair isn't wired, or -- for an advanced format -- this payload can't
// make the trip); `unknown` when `as` itself isn't a registered format.
export function translate(rec: { format: string; payload: Payload }, as: string): TranslateResult {
  if (!byId.has(as)) {
    return { unknown: true, known: REGISTRY.map((f) => f.id) };
  }
  if (as === rec.format) return { payload: rec.payload };

  const source = byId.get(rec.format);
  const fn = source?.to[as];
  if (!fn) return { held: true, format: as, see: rec.format };

  const result = fn(rec.payload);
  if (isHeld(result)) return { held: true, format: as, see: rec.format };
  return { payload: result };
}
