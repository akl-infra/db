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
// FormatModules. cmini is an import source, not a format (decision 2) --
// its adapter lives at db/formats/adapters/cmini/, unregistered, and
// unreachable from `translate()` at all since 21-formats.md D5 deleted
// the `cmini/1` read path and its `adapter:cmini` alias.
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
  // 20-spark.md S5 (19 §4.1's directory contract, LDB-F18): the ONLY two
  // within-lineage converters a major ever ships. `up_N: <L>/<N-1> ->
  // <L>/<N>` (never held: a stored record's payload always fits its
  // lineage's later majors, R3's own reasoning run forwards) and
  // `down_N: <L>/<N> -> <L>/<N-1> | Held` (held whenever ANYTHING would be
  // lost -- never a documented-lossy projection, unlike a cross edge).
  // REQUIRED for `major(id) > 1` (checked at runtime by `chainViolations`,
  // not the type system -- TS has no way to make a field's presence depend
  // on a string literal parsed out of another field); optional (and
  // unused) at major 1, exactly like `held/1`'s test stub or today's real
  // `spark/1`/`mana2/1`.
  up?(p: Payload): Payload;
  down?(p: Payload): Payload | Held;
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

// -- 20-spark.md S5's chain (19-upcast.md round 2 §1/§4, renumbered here:
// its F16 -> LDB-F18, its F17 -> LDB-F19, its P11 -> LDB-P13, its D6 stays
// D6). A "lineage" is the `<name>` half of a format id (`spark/1`,
// `spark/2` would share one; `mana2/1` its own); "latest" is the highest
// MAJOR currently registered for it. `translate()` walks the chain
// directly now (21-formats.md D5/D12 deleted the legacy-normalize step
// that used to run first).

function splitId(id: string): { name: string; major: number } {
  const i = id.lastIndexOf("/");
  return i === -1 ? { name: id, major: NaN } : { name: id.slice(0, i), major: Number(id.slice(i + 1)) };
}

// lineage(id): the `<name>` half of a format id.
export function lineage(id: string): string {
  return splitId(id).name;
}

// The `<major>` half, as a number.
export function majorOf(id: string): number {
  return splitId(id).major;
}

// latestOf(name): the highest major registered for this lineage, or 0 if
// none is (an unregistered/unknown lineage name).
export function latestOf(name: string): number {
  let max = 0;
  for (const f of REGISTRY) {
    const s = splitId(f.id);
    if (s.name === name && s.major > max) max = s.major;
  }
  return max;
}

// The registered id of a lineage's latest major, or undefined if the
// lineage has no registered member at all.
export function latestId(name: string): string | undefined {
  const m = latestOf(name);
  return m > 0 ? `${name}/${m}` : undefined;
}

// chainViolations(mod): LDB-F18's own contract, checked at test time (and
// exercised through the stub lineage's own deliberately-broken variants so
// the check is proven to catch each missing piece, not just proven to pass
// on a conforming module): for `major(mod.id) > 1`, the previous major of
// the SAME lineage must be registered, and `up`/`down`/`edits` must all be
// exported. `to`/`from` may never name the module's OWN lineage (that's
// what `up`/`down` are for -- a lineage's cross edges only ever point at a
// DIFFERENT lineage).
export function chainViolations(mod: FormatModule): string[] {
  const errs: string[] = [];
  const { name, major } = splitId(mod.id);
  if (major > 1) {
    if (!byId.has(`${name}/${major - 1}`)) errs.push(`${mod.id}: lineage '${name}' has no registered ${name}/${major - 1}`);
    if (typeof mod.up !== "function") errs.push(`${mod.id}: missing 'up' (required for major > 1)`);
    if (typeof mod.down !== "function") errs.push(`${mod.id}: missing 'down' (required for major > 1)`);
    if (mod.edits === undefined) errs.push(`${mod.id}: missing 'edits' (required for major > 1)`);
  }
  for (const target of [...Object.keys(mod.to), ...Object.keys(mod.from)]) {
    if (lineage(target) === name) errs.push(`${mod.id}: 'to'/'from' names its own lineage ('${target}')`);
  }
  return errs;
}

// chainFn(name, fromMajor, toMajor): composes `up` (fromMajor < toMajor) or
// `down` (fromMajor > toMajor) steps one major at a time -- crossing
// several majors is several steps, never a single shortcut function
// (19 §1 decision 2). `down` short-circuits on the first held step (R3:
// held whenever ANYTHING would be lost); `up` never holds.
function chainFn(name: string, fromMajor: number, toMajor: number): (p: Payload) => Payload | Held {
  if (fromMajor === toMajor) return (p) => p;
  if (fromMajor < toMajor) {
    return (p: Payload) => {
      let cur = p;
      for (let m = fromMajor + 1; m <= toMajor; m++) {
        const mod = byId.get(`${name}/${m}`);
        if (!mod?.up) throw new Error(`registry: ${name}/${m} is missing 'up' (required for major > 1)`);
        cur = mod.up(cur);
      }
      return cur;
    };
  }
  return (p: Payload) => {
    let cur: Payload = p;
    for (let m = fromMajor; m > toMajor; m--) {
      const mod = byId.get(`${name}/${m}`);
      if (!mod?.down) throw new Error(`registry: ${name}/${m} is missing 'down' (required for major > 1)`);
      const result = mod.down(cur);
      if (isHeld(result)) return result;
      cur = result;
    }
    return cur;
  };
}

// path(from, to): the composed converter `translate()`/`walk()` run (19
// §4.2). Same lineage: the chain alone. Different lineages: chain `from`
// up/down to whichever major of its OWN lineage carries a registered cross
// edge (`to[...]`) reaching `to`'s lineage, cross it, then chain the
// landing major to `to`. When more than one major carries such an edge,
// the shortest total chain distance wins (19 §11 Q5's open tie-break,
// decided here since nothing has yet needed a second edge to disagree with
// it); a lineage with NO edge to the other at all answers a constant
// `held` function.
export function path(from: string, to: string): (p: Payload) => Payload | Held {
  const { name: lFrom, major: mFrom } = splitId(from);
  const { name: lTo, major: mTo } = splitId(to);
  if (lFrom === lTo) return chainFn(lFrom, mFrom, mTo);

  const edges: { atMajor: number; targetId: string; fn: (p: Payload) => Payload | Held }[] = [];
  for (let m = 1; m <= latestOf(lFrom); m++) {
    const mod = byId.get(`${lFrom}/${m}`);
    if (!mod) continue;
    for (const [targetId, fn] of Object.entries(mod.to)) {
      if (lineage(targetId) === lTo) edges.push({ atMajor: m, targetId, fn });
    }
  }
  if (edges.length === 0) {
    return () => ({ held: true, reason: `no cross edge from lineage '${lFrom}' to '${lTo}'` });
  }
  edges.sort((a, b) => {
    const da = Math.abs(mFrom - a.atMajor) + Math.abs(majorOf(a.targetId) - mTo);
    const db_ = Math.abs(mFrom - b.atMajor) + Math.abs(majorOf(b.targetId) - mTo);
    return da - db_;
  });
  const edge = edges[0]!;
  const preChain = chainFn(lFrom, mFrom, edge.atMajor);
  const postChain = chainFn(lTo, majorOf(edge.targetId), mTo);
  return (p: Payload) => {
    const pre = preChain(p);
    if (isHeld(pre)) return pre;
    const crossed = edge.fn(pre);
    if (isHeld(crossed)) return crossed;
    return postChain(crossed);
  };
}

// walk(from, to, payload): `path(from, to)(payload)` -- the plain
// call-and-run form most callers want.
export function walk(from: string, to: string, payload: Payload): Payload | Held {
  return path(from, to)(payload);
}

// hasEdge(from, to): STRUCTURAL reachability only -- `GET /v1/formats`'
// `can_translate_to` (19 §4.2's "declared translation", extended from a
// direct `to[...]` lookup to the full chain) uses this, never a real
// payload. True for any pair in the SAME lineage (the chain always exists
// structurally once LDB-F18's contract holds, whatever a specific
// payload's `down` might do at RUNTIME) or a different lineage with at
// least one registered cross edge between them, at any major.
export function hasEdge(from: string, to: string): boolean {
  const lFrom = lineage(from);
  const lTo = lineage(to);
  if (lFrom === lTo) return true;
  for (let m = 1; m <= latestOf(lFrom); m++) {
    const mod = byId.get(`${lFrom}/${m}`);
    if (!mod) continue;
    for (const targetId of Object.keys(mod.to)) {
      if (lineage(targetId) === lTo) return true;
    }
  }
  return false;
}

// -- 20-spark.md S1's shared vocabulary (§3) --

// resolveFormat(id): a native registered id resolves to itself (label ===
// id). 21-formats.md D5/D12: there are no more aliases -- `akl/1` and the
// `cmini/1` read path are both gone, so this is now a plain lookup;
// `label` stays part of the shape (rather than `resolveFormat` simply
// returning the module) because a future format may reintroduce a
// caller-visible distinction between "what was asked for" and "what
// resolved" (F2's `lw/1`, say), and every caller already reads `.module`/
// `.label` rather than the module directly.
export interface ResolvedFormat {
  module: FormatModule;
  label: string;
}

export function resolveFormat(id: string): ResolvedFormat | undefined {
  const direct = byId.get(id);
  return direct ? { module: direct, label: id } : undefined;
}

// Pure result: unlike the Worker-facing wrapper (db/src/formats/registry.ts)
// this never throws -- an unregistered `as` comes back as `{ unknown: true,
// known }` so a plain package consumer (the bot, anyone who only installs
// @akl/layout-formats) doesn't need to catch an ApiError it has never seen.
export type TranslateResult =
  | { payload: Payload }
  | { held: true; format: string; see?: string }
  | { unknown: true; known: string[] };

// translate(rec, as): 21-formats.md D5/D12 deleted every alias and the
// legacy-stored normalization (`LEGACY_STORED`/`storedAsSpark`) -- `rec`
// is always already shaped as its own registered `format` now, so this is
// a plain `resolveFormat` + `path()` walk. `held` bodies name the
// REQUESTED id verbatim, never the resolved target.
export function translate(rec: { format: string; payload: Payload }, as: string): TranslateResult {
  if (!byId.has(as)) {
    return { unknown: true, known: REGISTRY.map((f) => f.id) };
  }
  if (as === rec.format) return { payload: rec.payload };

  // 20-spark.md S5: walks `path()` (chain -> pinned cross edge -> chain)
  // instead of a single direct `to[...]` lookup -- with every lineage at
  // major 1 (spark/mana2 today) this reduces to exactly the old single-hop
  // behaviour, byte for byte; it only starts composing once a lineage ships
  // a second major.
  const result = walk(rec.format, as, rec.payload);
  if (isHeld(result)) return { held: true, format: as, see: rec.format };
  return { payload: result };
}
