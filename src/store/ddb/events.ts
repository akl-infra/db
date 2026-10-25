// DynamoDB implementation of `EventStore` (src/store/port.ts). Owner: P2 lane G
// (design/p2-p5-briefs.md).
import type { EventStore } from "../port";
import { notImplemented } from "../d1/stub";
import type { DdbContext } from "./contracts";

export function ddbEventStore(_ctx: DdbContext): EventStore {
  return notImplemented<EventStore>("G", "ddb/events");
}
