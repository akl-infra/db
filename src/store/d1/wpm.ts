// D1 implementation of `WpmStore` (src/store/port.ts). Owner: P1 agent C
// (design/p1-briefs.md). Move today's SQL here verbatim.
import type { WpmStore } from "../port";
import { notImplemented } from "./stub";

export function d1WpmStore(_db: D1Database): WpmStore {
  return notImplemented<WpmStore>("C", "wpm");
}
