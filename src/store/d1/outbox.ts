// D1 implementation of `OutboxStore` (src/store/port.ts). Owner: P1 agent D
// (design/p1-briefs.md). Move today's SQL here verbatim.
import type { OutboxStore } from "../port";
import { notImplemented } from "./stub";

export function d1OutboxStore(_db: D1Database): OutboxStore {
  return notImplemented<OutboxStore>("D", "outbox");
}
