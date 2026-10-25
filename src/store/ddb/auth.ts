// DynamoDB implementation of `AuthStore` (src/store/port.ts). Owner: P2 lane I
// (design/p2-p5-briefs.md).
import type { AuthStore } from "../port";
import { notImplemented } from "../d1/stub";
import type { DdbContext } from "./contracts";

export function ddbAuthStore(_ctx: DdbContext): AuthStore {
  return notImplemented<AuthStore>("I", "ddb/auth");
}
