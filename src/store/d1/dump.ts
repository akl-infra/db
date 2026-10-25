// D1 implementation of `DumpStore` (src/store/port.ts). Owner: P1 agent D
// (design/p1-briefs.md). Move today's SQL here verbatim.
import type { DumpStore } from "../port";
import { notImplemented } from "./stub";

export function d1DumpStore(_db: D1Database): DumpStore {
  return notImplemented<DumpStore>("D", "dump");
}
