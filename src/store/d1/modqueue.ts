// D1 implementation of `ModqueueStore` (src/store/port.ts). Owner: P1 agent D
// (design/p1-briefs.md). Move today's SQL here verbatim.
import type { ModqueueStore } from "../port";
import { notImplemented } from "./stub";

export function d1ModqueueStore(_db: D1Database): ModqueueStore {
  return notImplemented<ModqueueStore>("D", "modqueue");
}
