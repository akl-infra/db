// D1 implementation of `EventStore` (src/store/port.ts). Owner: P1 agent A
// (design/p1-briefs.md). Move today's SQL here verbatim.
import type { EventStore } from "../port";
import { notImplemented } from "./stub";

export function d1EventStore(_db: D1Database): EventStore {
  return notImplemented<EventStore>("A", "events");
}
