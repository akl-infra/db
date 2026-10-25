// DynamoDB implementation of `HoldStore` (src/store/port.ts). Owner: P2 lane G
// (design/p2-p5-briefs.md).
import type { HoldStore } from "../port";
import { notImplemented } from "../d1/stub";
import type { DdbContext } from "./contracts";

export function ddbHoldStore(_ctx: DdbContext): HoldStore {
  return notImplemented<HoldStore>("G", "ddb/holds");
}
