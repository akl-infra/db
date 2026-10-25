// DynamoDB implementation of `DumpStore` (src/store/port.ts). Owner: P2 lane K
// (design/p2-p5-briefs.md).
import type { DumpStore } from "../port";
import { notImplemented } from "../d1/stub";
import type { DdbContext } from "./contracts";

export function ddbDumpStore(_ctx: DdbContext): DumpStore {
  return notImplemented<DumpStore>("K", "ddb/dump");
}
