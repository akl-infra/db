// The one hand-authored sequence-diagram renderer both W1c diagrams share
// (AuthOwnership.tsx, TrustedClient.tsx) -- stroke-based, no fills besides
// `currentColor`/Circuit CSS variables (styles.css's `.akl-diagram-*`
// classes carry the actual colors, so both themes fall out for free). Takes
// a plain `SequenceModel` (sequence.ts) and draws lifelines, lane headers,
// arrows between lanes, and self-loops on one lane -- the same geometry
// `sequence.ts`'s `checkFit`/`checkLaneFit` validate against (SITE-33).
import type { Component } from "solid-js";
import { For } from "solid-js";
import type { SequenceModel, Step } from "./sequence.ts";
import { FONT_SIZE, HEADER_FONT_SIZE, LANE_HEADER_WIDTH, SELF_LOOP_W, availableWidth, fitTextLength } from "./sequence.ts";

interface Props {
  model: SequenceModel;
  ariaLabel: string;
  markerId: string;
}

const SELF_LOOP_H = 22;
const LANE_HEADER_H = 30;
const LANE_HEADER_Y = 8;

const SequenceDiagram: Component<Props> = (props) => {
  const laneById = () => new Map(props.model.lanes.map((l) => [l.id, l] as const));

  return (
    <svg viewBox={`0 0 ${props.model.width} ${props.model.height}`} role="img" aria-label={props.ariaLabel} class="akl-diagram">
      <defs>
        <marker id={props.markerId} viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto">
          <path d="M0 0 L10 5 L0 10 z" fill="currentColor" />
        </marker>
      </defs>

      <For each={props.model.lanes}>
        {(lane) => <line x1={lane.x} y1={LANE_HEADER_Y + LANE_HEADER_H} x2={lane.x} y2={props.model.height - 8} class="akl-diagram-lifeline" />}
      </For>

      <For each={props.model.steps}>
        {(step) => {
          if (step.kind === "self") {
            const lane = laneById().get(step.lane);
            if (lane === undefined) return null;
            const x0 = lane.x;
            const y0 = step.y;
            const path = `M ${x0} ${y0} h ${SELF_LOOP_W} v ${SELF_LOOP_H} h ${-SELF_LOOP_W}`;
            const avail = availableWidth(props.model, step);
            const tl = fitTextLength(step.label, avail, FONT_SIZE);
            return (
              <g>
                <path d={path} class="akl-diagram-arrow" marker-end={`url(#${props.markerId})`} fill="none" />
                <text x={x0 + SELF_LOOP_W + 10} y={y0 + SELF_LOOP_H / 2 + 4} class="akl-diagram-label" textLength={tl} lengthAdjust={tl === undefined ? undefined : "spacingAndGlyphs"}>
                  {step.label}
                </text>
              </g>
            );
          }
          const a = laneById().get(step.from);
          const b = laneById().get(step.to);
          if (a === undefined || b === undefined) return null;
          const avail = availableWidth(props.model, step);
          const tl = fitTextLength(step.label, avail, FONT_SIZE);
          const midX = (a.x + b.x) / 2;
          return (
            <g>
              <line x1={a.x} y1={step.y} x2={b.x} y2={step.y} class="akl-diagram-arrow" marker-end={`url(#${props.markerId})`} />
              <text x={midX} y={step.y - 8} text-anchor="middle" class="akl-diagram-label" textLength={tl} lengthAdjust={tl === undefined ? undefined : "spacingAndGlyphs"}>
                {step.label}
              </text>
            </g>
          );
        }}
      </For>

      {/* Lane headers drawn last, on top of the lifelines/arrows that start
          under them. */}
      <For each={props.model.lanes}>
        {(lane) => {
          const avail = LANE_HEADER_WIDTH - 20;
          const tl = fitTextLength(lane.label, avail, HEADER_FONT_SIZE);
          return (
            <g>
              <rect x={lane.x - LANE_HEADER_WIDTH / 2} y={LANE_HEADER_Y} width={LANE_HEADER_WIDTH} height={LANE_HEADER_H} rx={4} class="akl-diagram-box" />
              <text
                x={lane.x}
                y={LANE_HEADER_Y + LANE_HEADER_H / 2 + 4}
                text-anchor="middle"
                class="akl-diagram-label akl-diagram-label-strong"
                textLength={tl}
                lengthAdjust={tl === undefined ? undefined : "spacingAndGlyphs"}
              >
                {lane.label}
              </text>
            </g>
          );
        }}
      </For>
    </svg>
  );
};

export default SequenceDiagram;
export type { Step };
