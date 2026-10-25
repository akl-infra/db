// DynamoDB implementation of `LayoutReadStore` (src/store/port.ts). Owner: P2 lane G
// (design/p2-p5-briefs.md).
import type { LayoutReadStore } from "../port";
import { notImplemented } from "../d1/stub";
import type { DdbContext } from "./contracts";

export function ddbLayoutReadStore(_ctx: DdbContext): LayoutReadStore {
  return notImplemented<LayoutReadStore>("G", "ddb/layouts");
}
