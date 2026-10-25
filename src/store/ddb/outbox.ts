// DynamoDB implementation of `OutboxStore` (src/store/port.ts). Owner: P2 lane K
// (design/p2-p5-briefs.md).
import type { OutboxStore } from "../port";
import { notImplemented } from "../d1/stub";
import type { DdbContext } from "./contracts";

export function ddbOutboxStore(_ctx: DdbContext): OutboxStore {
  return notImplemented<OutboxStore>("K", "ddb/outbox");
}
