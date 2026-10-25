// D1 implementation of `LinkStore` (src/store/port.ts). Owner: P1 agent C
// (design/p1-briefs.md). Move today's SQL here verbatim.
import type { LinkStore } from "../port";
import { notImplemented } from "./stub";

export function d1LinkStore(_db: D1Database): LinkStore {
  return notImplemented<LinkStore>("C", "links");
}
