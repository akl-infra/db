// DynamoDB implementation of `AdminStore` (src/store/port.ts). Owner: P2 lane I
// (design/p2-p5-briefs.md).
import type { AdminStore } from "../port";
import { notImplemented } from "../d1/stub";
import type { DdbContext } from "./contracts";

export function ddbAdminStore(_ctx: DdbContext): AdminStore {
  return notImplemented<AdminStore>("I", "ddb/admin");
}
