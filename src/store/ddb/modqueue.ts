// DynamoDB implementation of `ModqueueStore` (src/store/port.ts). Owner: P2 lane K
// (design/p2-p5-briefs.md).
import type { ModqueueStore } from "../port";
import { notImplemented } from "../d1/stub";
import type { DdbContext } from "./contracts";

export function ddbModqueueStore(_ctx: DdbContext): ModqueueStore {
  return notImplemented<ModqueueStore>("K", "ddb/modqueue");
}
