// D1 implementation of `HeadStore` (src/store/port.ts). Owner: P1 agent A
// (design/p1-briefs.md). Move today's SQL here verbatim.
import type { HeadStore } from "../port";
import { notImplemented } from "./stub";

export function d1HeadStore(_db: D1Database): HeadStore {
  return notImplemented<HeadStore>("A", "head");
}
