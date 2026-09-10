// The pure format registry (07 S2; moved out of src/formats/registry.ts by
// 12 §3 X5 item 1 so it ships inside @akl/layout-formats -- db/formats/
// itself is the package, and this module is the one place its format
// modules are imported together). Every payload shape the service knows
// how to store and read is a directory under db/formats/<name>/<major>/
// (01 §4) whose index.ts exports exactly the `FormatModule` contract
// below.
//
// spark/1 is the one stored format (design/layout-db/20-spark.md §1
// decision 1, S1): `spark/1` and `mana2/1` are the only registered
// FormatModules now. cmini is an import source, not a format (decision
// 2) -- its adapter lives at db/formats/adapters/cmini/, unregistered,
// reached only through `ALIASES`'s `adapter:cmini` target below.
//
// Self-contained like every format module (07 §5): no import of
// src/core/errors.ts or anything else under src/ -- a packaged consumer
// (the bot, or anyone else who only installs @akl/layout-formats) never
// sees the Worker's ApiError machinery. `db/src/formats/registry.ts`
// re-exports this module for the Worker's own routes and adds the one
// thing that DOES need core/errors.ts: turning an `unknown` translate
// result into a thrown ApiError.
import * as spark1 from "./spark/1/index.ts";
import * as mana2_1 from "./mana2/1/index.ts";
import { fromCmini, toCmini } from "./adapters/cmini/translate.ts";

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
// is impossible (a per-payload decision an advanced format may make; spark
// and mana2 in phase 1 never do for each other -- 01 §4). Distinct from the
// registry-level "unknown" below, which is "this format isn't registered
// at all".
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
// format missing an entry entirely (the cmini adapter has no `setMagic`: 03
// §3, an owner moves to spark/1 with a PUT first) means that PATCH verb is
// refused with `unsupported_for_format` before the edit is ever called.
export type EditResult = Payload | { error: ErrBody };
export interface FormatEdits {
  // char -> finger; every named char must already be one of `p.keys`
  // (else `{error: {error: "invalid_payload", path: "/keys/<c>"}}`);
  // partial maps are fine. A bad finger word is left to the pipeline's
  // validate() re-run, not checked here.
  setFingermap?(p: Payload, map: Record<string, string>): EditResult;
  // `board` arrives shaped as spark/1's board object (01 §2) -- the API's
  // one board vocabulary regardless of the record's own format.
  setBoard?(p: Payload, board: unknown): EditResult;
  // `magic` arrives shaped as spark/1's magic object (01 §2).
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
  // 20-spark.md S1: replaces the old registry-level `lower()` slot, which
  // left the `FormatModule` contract entirely -- a format's own compile
  // step (spark's `compileMagic`, mana2's `lower`) is now just a plain
  // named export, never dispatched generically through the registry.
  // `"stored"`: a write may store this format (spark/1 today).
  // `"output"`: produced on read only, never stored (mana2/1) -- a write
  // naming it is `400 format_not_writable` (S2).
  role: "stored" | "output";
  validate(p: unknown): ValidationResult;
  to: Record<string, (p: Payload) => Payload | Held>;
  from: Record<string, (p: Payload) => Payload>;
  hasMagic(p: Payload): boolean;
  edits?: FormatEdits;
}

let REGISTRY: FormatModule[] = [spark1 as unknown as FormatModule, mana2_1 as unknown as FormatModule];

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
// touching the real registered formats. `REGISTRY`/`byId` are one
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

// -- 20-spark.md S1's shared vocabulary (§3) --

// Every transitional alias (§1 decision 12): `target` is the registered id
// (or the special adapter target below) a request in this alias actually
// resolves to; `relabel` says whether the wire `format` field follows the
// request instead of staying native (only `akl/1`, since the deployed bot
// still branches on `format === 'akl/1'` -- the relabel rule itself is a
// Worker-layer (S2) concern, this table just marks which alias needs it);
// `write` says whether a write naming this alias is accepted (`akl/1`,
// stored as `spark/1` byte-identical) or refused (`cmini/1`, S2).
// `"adapter:cmini"` is not a registered format id -- it names the cmini
// adapter's `toCmini` projection (db/formats/adapters/cmini/translate.ts),
// reachable only from a `spark/1`-shaped payload, never a chain step
// (§5's `lineage()` never lists it).
export interface AliasEntry {
  target: string;
  relabel: boolean;
  write: "store" | "refuse";
}

export const ALIASES: Record<string, AliasEntry> = {
  "akl/1": { target: "spark/1", relabel: true, write: "store" },
  "cmini/1": { target: "adapter:cmini", relabel: false, write: "refuse" },
};

export interface ResolvedFormat {
  module: FormatModule;
  label: string;
}

// resolveFormat(id): a native registered id resolves to itself (label ===
// id); an alias whose target is a registered id resolves to that module,
// labelled with the ALIAS (so a caller can echo what was actually asked
// for); `cmini/1` resolves to `undefined` here -- its target is the
// adapter, not a `FormatModule` this registry owns, so only `translate()`
// (which knows the adapter projection) and the Worker's own temporary
// `LEGACY_WRITABLE` shim (db/src/formats/registry.ts, S1 only) handle it.
export function resolveFormat(id: string): ResolvedFormat | undefined {
  const direct = byId.get(id);
  if (direct) return { module: direct, label: id };
  const alias = ALIASES[id];
  if (alias && byId.has(alias.target)) return { module: byId.get(alias.target)!, label: id };
  return undefined;
}

// LEGACY_STORED: every format a `layouts`/`layout_revs` row can carry as
// its OWN stored `format` column value that is no longer `spark/<latest>`
// -- today, the two pre-spark ids. `storedAsSpark` is the ONE conversion
// used by every read of such a row (this file's own `translate()` below,
// forever for `layout_revs`; `layouts` too until S4's migration converts
// every live row) and by every write that carries a legacy record's
// payload forward (S2/S3b/S4) -- nothing else converts a stored legacy
// payload (LDB-F21).
export const LEGACY_STORED: Record<string, (p: Payload) => Payload> = {
  "akl/1": (p) => p, // byte-identical: akl/1 and spark/1 are the same payload shape
  "cmini/1": fromCmini,
};

export function storedAsSpark(format: string, payload: Payload): { format: "spark/1"; payload: Payload } {
  const conv = LEGACY_STORED[format];
  return { format: "spark/1", payload: conv ? conv(payload) : payload };
}

// Pure result: unlike the Worker-facing wrapper (db/src/formats/registry.ts)
// this never throws -- an unregistered `as` comes back as `{ unknown: true,
// known }` so a plain package consumer (the bot, anyone who only installs
// @akl/layout-formats) doesn't need to catch an ApiError it has never seen.
export type TranslateResult =
  | { payload: Payload }
  | { held: true; format: string; see?: string }
  | { unknown: true; known: string[] };

// translate(rec, as): first normalizes `rec` through `storedAsSpark` when
// `rec.format` is a legacy-stored id (every read of a legacy row goes
// through this, even when `as` names that SAME legacy id back -- there is
// no raw-identity shortcut for a legacy format, LDB-F21: the row reads
// exactly as its `storedAsSpark` twin on every route). Then resolves `as`
// through `ALIASES` (`cmini/1` -> the adapter's `toCmini`, reachable only
// from a `spark/1`-shaped payload; `akl/1` -> `spark/1`). `held` bodies
// name the REQUESTED id verbatim (e.g. `format: "akl/1"`), never the
// resolved target -- `as` is used as-is in every `held`/`unknown` body
// below.
export function translate(rec: { format: string; payload: Payload }, as: string): TranslateResult {
  const normRec = rec.format in LEGACY_STORED ? storedAsSpark(rec.format, rec.payload) : rec;

  const alias = ALIASES[as];
  if (alias?.target === "adapter:cmini") {
    if (normRec.format !== "spark/1") return { held: true, format: as, see: normRec.format };
    return { payload: toCmini(normRec.payload) };
  }

  const resolvedAs = alias ? alias.target : as;
  if (!byId.has(resolvedAs)) {
    return { unknown: true, known: REGISTRY.map((f) => f.id) };
  }
  if (resolvedAs === normRec.format) return { payload: normRec.payload };

  const source = byId.get(normRec.format);
  const fn = source?.to[resolvedAs];
  if (!fn) return { held: true, format: as, see: normRec.format };

  const result = fn(normRec.payload);
  if (isHeld(result)) return { held: true, format: as, see: normRec.format };
  return { payload: result };
}
