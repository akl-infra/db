// DynamoDB implementation of `HeadStore` (src/store/port.ts). Owner: P2 lane G
// (design/p2-p5-briefs.md).
import type { HeadStore } from "../port";
import { notImplemented } from "../d1/stub";
import type { DdbContext } from "./contracts";

export function ddbHeadStore(_ctx: DdbContext): HeadStore {
  return notImplemented<HeadStore>("G", "ddb/head");
}
