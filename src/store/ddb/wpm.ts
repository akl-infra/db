// DynamoDB implementation of `WpmStore` (src/store/port.ts). Owner: P2 lane J
// (design/p2-p5-briefs.md).
import type { WpmStore } from "../port";
import { notImplemented } from "../d1/stub";
import type { DdbContext } from "./contracts";

export function ddbWpmStore(_ctx: DdbContext): WpmStore {
  return notImplemented<WpmStore>("J", "ddb/wpm");
}
