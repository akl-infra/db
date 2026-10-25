// D1 implementation of `ReviewStore` (src/store/port.ts). Owner: P1 agent C
// (design/p1-briefs.md). Move today's SQL here verbatim.
import type { ReviewStore } from "../port";
import { notImplemented } from "./stub";

export function d1ReviewStore(_db: D1Database): ReviewStore {
  return notImplemented<ReviewStore>("C", "review");
}
