// D1 implementation of `AuthStore` (src/store/port.ts). Owner: P1 agent B
// (design/p1-briefs.md). Move today's SQL here verbatim.
import type { AuthStore } from "../port";
import { notImplemented } from "./stub";

export function d1AuthStore(_db: D1Database): AuthStore {
  return notImplemented<AuthStore>("B", "auth");
}
