// D1 implementation of `AdminStore` (src/store/port.ts). Owner: P1 agent B
// (design/p1-briefs.md). Move today's SQL here verbatim.
import type { AdminStore } from "../port";
import { notImplemented } from "./stub";

export function d1AdminStore(_db: D1Database): AdminStore {
  return notImplemented<AdminStore>("B", "admin");
}
