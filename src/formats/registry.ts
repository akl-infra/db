// The format registry (07 S2): every payload shape the service knows how to
// store and read. A format is a directory under db/formats/<name>/<major>/
// (01 §4) whose index.ts exports exactly the contract below; this module is
// the only place those modules are imported, so adding a format is "import
// it here" plus its own PR (04 §2).
import { unknownFormat } from "../core/errors";
import * as cmini1 from "../../formats/cmini/1/index";
import * as akl1 from "../../formats/akl/1/index";

// A row of a format's lowering: what an analyzer/emulator reads regardless
// of which idiom shape produced it (01 §3).
export interface Row {
  inputs: string;
  output: string;
  type?: string;
}

// { ok: false } never throws -- `error` is a ready-to-return ErrBody (07 §5).
export type ValidationResult =
  | { ok: true }
  | { ok: false; error: { error: string; message: string; [extra: string]: unknown } };

// Returned by a format's own `to[<format>]` when translating *this payload*
// is impossible (a per-payload decision an advanced format may make; cmini/1
// and akl/1 in phase 1 never do -- 01 §4). Distinct from the registry-level
// "held" below, which is "this format pair isn't wired up at all".
export interface Held {
  held: true;
  reason?: string;
}

// A format's payload shape is its own business; the registry only moves it
// around untyped.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Payload = any;

export interface FormatModule {
  id: string;
  schema: object;
  validate(p: unknown): ValidationResult;
  lower(p: Payload): Row[] | null;
  to: Record<string, (p: Payload) => Payload | Held>;
  from: Record<string, (p: Payload) => Payload>;
  hasMagic(p: Payload): boolean;
}

const REGISTRY: FormatModule[] = [cmini1 as unknown as FormatModule, akl1 as unknown as FormatModule];

const byId = new Map<string, FormatModule>(REGISTRY.map((f) => [f.id, f]));

export function list(): FormatModule[] {
  return [...REGISTRY];
}

export function get(id: string): FormatModule | undefined {
  return byId.get(id);
}

function isHeld(v: unknown): v is Held {
  return typeof v === "object" && v !== null && (v as { held?: unknown }).held === true;
}

export type TranslateResult = { payload: Payload } | { held: true; format: string; see?: string };

// translate(rec, as): identity when `as` is the record's own format; else the
// record's format's `to[as]`; `held` when that translation doesn't exist (the
// format pair isn't wired, or -- for an advanced format -- this payload can't
// make the trip). Unknown `as` (not a registered format at all) is a 400,
// thrown as an ApiError so route handlers can let it bubble to `app.onError`.
export function translate(rec: { format: string; payload: Payload }, as: string): TranslateResult {
  if (!byId.has(as)) {
    throw unknownFormat(
      as,
      REGISTRY.map((f) => f.id),
    );
  }
  if (as === rec.format) return { payload: rec.payload };

  const source = byId.get(rec.format);
  const fn = source?.to[as];
  if (!fn) return { held: true, format: as, see: rec.format };

  const result = fn(rec.payload);
  if (isHeld(result)) return { held: true, format: as, see: rec.format };
  return { payload: result };
}
