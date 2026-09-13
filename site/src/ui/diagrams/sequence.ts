// Shared, framework-agnostic sequence-diagram data model for the two W1c
// diagrams (AuthOwnership.tsx, TrustedClient.tsx -- design/akldb-site's Docs
// overhaul). Kept separate from the Solid rendering (SequenceDiagram.tsx) so
// SITE-33's own text-fit check can run as a plain vitest test against the
// data, with no DOM/Solid runtime involved.
//
// Every label renders in var(--font-body) (IBM Plex Mono, monospace) --
// `MONO_ADVANCE` is that font's own advance width as a fraction of its
// em-square, deliberately rounded UP from IBM Plex Mono's real ~0.6 so this
// check never passes a label Chrome would actually clip (cross-checked
// against the real rendered page in Chrome per the W1c brief -- see
// AuthOwnership.tsx/TrustedClient.tsx's own header comments for the
// measured result).

export interface Lane {
  id: string;
  label: string;
  x: number;
}

export type Step =
  | { kind: "arrow"; from: string; to: string; y: number; label: string }
  | { kind: "self"; lane: string; y: number; label: string };

export interface SequenceModel {
  width: number;
  height: number;
  laneTop: number;
  lanes: Lane[];
  steps: Step[];
}

export const FONT_SIZE = 12;
export const HEADER_FONT_SIZE = FONT_SIZE;
export const MONO_ADVANCE = 0.64;
// A label may be squeezed via `textLength` down to this fraction of its own
// natural width and no further -- past that point the fix is a shorter
// label, never a harder squeeze (the W1c brief's own rule).
export const MAX_SQUEEZE = 0.82;

export function textNaturalWidth(text: string, fontSize: number = FONT_SIZE): number {
  return text.length * fontSize * MONO_ADVANCE;
}

// The loop a "self" step draws to the right of its own lifeline -- see
// SequenceDiagram.tsx's SELF_LOOP_W/SELF_LOOP_H, kept in sync with this
// constant.
export const SELF_LOOP_W = 74;

/** The horizontal span available to a step's own label -- lane geometry
 * only, no left/right padding (the renderer subtracts its own). What
 * SITE-33's test checks every label against.
 *
 * A "self" step's label runs from its own lane's loop rightward to the
 * diagram's own right edge -- NOT a fixed run, because a lane close to the
 * right edge (e.g. the second-to-last of four) genuinely has less room
 * than one further left. `model.lanes[0].x` doubles as the left margin
 * (lane 0 is placed exactly there, `buildSequenceModel`), and the same
 * margin is reserved symmetrically on the right, so `model.width - that`
 * is the real usable right edge -- this was the exact bug the W1c Chrome
 * measurement caught (a self-note on a non-last lane overflowing straight
 * past the SVG's own viewBox, not just crowding a neighboring lifeline). */
export function availableWidth(model: SequenceModel, step: Step): number {
  if (step.kind === "self") {
    const laneById = new Map(model.lanes.map((l) => [l.id, l] as const));
    const lane = laneById.get(step.lane);
    if (lane === undefined) throw new Error(`availableWidth: self step names an unknown lane ("${step.lane}")`);
    const margin = model.lanes[0]?.x ?? 0;
    const rightEdge = model.width - margin;
    return Math.max(0, rightEdge - (lane.x + SELF_LOOP_W));
  }
  const laneById = new Map(model.lanes.map((l) => [l.id, l] as const));
  const a = laneById.get(step.from);
  const b = laneById.get(step.to);
  if (a === undefined || b === undefined) {
    throw new Error(`availableWidth: arrow step names an unknown lane ("${step.from}" -> "${step.to}")`);
  }
  return Math.abs(b.x - a.x);
}

/** `undefined` = render at natural width; otherwise the `textLength` the
 * renderer should set (SVG `lengthAdjust="spacingAndGlyphs"`). Throws if
 * even `MAX_SQUEEZE` can't make the label fit `avail` -- SITE-33 fails
 * loudly on a label that's simply too long, rather than silently over
 * squeezing it into illegibility. */
export function fitTextLength(text: string, avail: number, fontSize: number = FONT_SIZE): number | undefined {
  const natural = textNaturalWidth(text, fontSize);
  if (natural <= avail) return undefined;
  if (avail < natural * MAX_SQUEEZE) {
    throw new Error(
      `fitTextLength: "${text}" needs to squeeze to ${Math.round((avail / natural) * 100)}% of its natural width to fit ${Math.round(avail)}px ` +
        `(natural ${Math.round(natural)}px) -- shorten the label instead of squeezing past ${Math.round(MAX_SQUEEZE * 100)}%`,
    );
  }
  return avail;
}

export interface LaneInput {
  id: string;
  label: string;
}
export type StepInput = Omit<Extract<Step, { kind: "arrow" }>, "y"> | Omit<Extract<Step, { kind: "self" }>, "y">;

export interface BuildOptions {
  laneWidth?: number;
  marginX?: number;
  laneTop?: number;
  rowHeight?: number;
  marginBottom?: number;
}

const DEFAULTS: Required<BuildOptions> = {
  laneWidth: 250,
  marginX: 120,
  laneTop: 54,
  rowHeight: 50,
  marginBottom: 24,
};

/** Lays out lanes left-to-right at an even pitch and steps top-to-bottom at
 * an even row height -- the whole geometry a diagram needs, computed once
 * from just "which lanes, which steps, in order" so AuthOwnership.tsx/
 * TrustedClient.tsx only ever state the sequence itself. */
export function buildSequenceModel(lanes: LaneInput[], steps: StepInput[], opts: BuildOptions = {}): SequenceModel {
  const o = { ...DEFAULTS, ...opts };
  const builtLanes: Lane[] = lanes.map((l, i) => ({ id: l.id, label: l.label, x: o.marginX + i * o.laneWidth }));
  const builtSteps: Step[] = steps.map((s, i) => ({ ...s, y: o.laneTop + (i + 1) * o.rowHeight }) as Step);
  const width = o.marginX * 2 + Math.max(0, lanes.length - 1) * o.laneWidth;
  const height = o.laneTop + (steps.length + 1) * o.rowHeight + o.marginBottom;
  return { width, height, laneTop: o.laneTop, lanes: builtLanes, steps: builtSteps };
}

/** Every step's label, its available width, and (if needed) its squeezed
 * `textLength` -- what SITE-33's own unit test iterates to prove no label
 * on either diagram ever needs more than `MAX_SQUEEZE` compression. */
export function checkFit(model: SequenceModel): { step: Step; avail: number; textLength: number | undefined }[] {
  return model.steps.map((step) => {
    const avail = availableWidth(model, step);
    return { step, avail, textLength: fitTextLength(step.label, avail) };
  });
}

// The lane header box SequenceDiagram.tsx draws above each lifeline --
// exported so SITE-33's test checks lane labels the same way it checks
// step labels, against the exact width the renderer itself uses.
export const LANE_HEADER_WIDTH = 190;
const LANE_HEADER_PADDING = 20;

export function checkLaneFit(model: SequenceModel): { lane: Lane; avail: number; textLength: number | undefined }[] {
  const avail = LANE_HEADER_WIDTH - LANE_HEADER_PADDING;
  return model.lanes.map((lane) => ({ lane, avail, textLength: fitTextLength(lane.label, avail, HEADER_FONT_SIZE) }));
}
