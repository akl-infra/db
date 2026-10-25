// D1 implementation of `LayoutReadStore` (src/store/port.ts). Owner: P1 agent A
// (design/p1-briefs.md). Move today's SQL here verbatim.
import type { LayoutReadStore } from "../port";
import { notImplemented } from "./stub";

export function d1LayoutReadStore(_db: D1Database): LayoutReadStore {
  return notImplemented<LayoutReadStore>("A", "layouts");
}
