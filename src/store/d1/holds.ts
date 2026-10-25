// D1 `HoldStore` and `CutoverStore` (src/store/port.ts). P1: no behaviour
// change, so every hold is granted and there is no cutover mode. The hold
// budget becomes real on both backends in P2, the cutover flag in P6
// (design/aws-port.md §3, §5.2).
import type { CutoverStore, HoldStore } from "../port";

export function d1HoldStore(_db: D1Database): HoldStore {
  return {
    async takeHold() {
      return true;
    },
    async releaseHold() {},
  };
}

export function d1CutoverStore(_db: D1Database): CutoverStore {
  return {
    async mode() {
      return null;
    },
  };
}
