import type { Component } from "solid-js";
import { For, createMemo } from "solid-js";
import type { SparkPayload } from "../lib/types.ts";

interface BoardProps {
  payload: SparkPayload;
}

interface Cell {
  ch: string;
  row: number;
  col: number;
  finger: string;
}

/** Renders a spark/1 payload's `keys` (+ `free`) as a CSS grid -- the one
 * visual "hero" moment on the layout page (design/akldb-site/01-plan.md §5:
 * "board rendered from the spark/1 payload as a CSS grid"). No stats, no
 * finger-usage coloring -- S4, the site does no analysis. */
const Board: Component<BoardProps> = (props) => {
  const cells = createMemo<Cell[]>(() => {
    const out: Cell[] = [];
    const keys = props.payload.keys ?? {};
    for (const ch of Object.keys(keys)) {
      const pos = keys[ch]!;
      out.push({ ch, row: pos.row, col: pos.col, finger: pos.finger });
    }
    return out;
  });

  const dims = createMemo(() => {
    let maxRow = 0;
    let maxCol = 0;
    for (const c of cells()) {
      maxRow = Math.max(maxRow, c.row);
      maxCol = Math.max(maxCol, c.col);
    }
    for (const f of props.payload.free ?? []) {
      maxRow = Math.max(maxRow, f.row);
      maxCol = Math.max(maxCol, f.col);
    }
    return { rows: maxRow + 1, cols: maxCol + 1 };
  });

  return (
    <div
      class="akl-board"
      style={{
        "grid-template-rows": `repeat(${dims().rows}, 1fr)`,
        "grid-template-columns": `repeat(${dims().cols}, 1fr)`,
      }}
    >
      <For each={cells()}>
        {(cell) => (
          <div
            class="akl-board-key"
            data-finger={cell.finger}
            style={{ "grid-row": String(cell.row + 1), "grid-column": String(cell.col + 1) }}
          >
            {cell.ch}
          </div>
        )}
      </For>
    </div>
  );
};

export default Board;
