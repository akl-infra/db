// DynamoDB implementation of `CutoverStore` (src/store/port.ts). Owner: P2 lane G
// (design/p2-p5-briefs.md).
import type { CutoverStore } from "../port";
import { notImplemented } from "../d1/stub";
import type { DdbContext } from "./contracts";

export function ddbCutoverStore(_ctx: DdbContext): CutoverStore {
  return notImplemented<CutoverStore>("G", "ddb/cutover");
}
