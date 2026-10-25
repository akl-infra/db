// DynamoDB implementation of `ReviewStore` (src/store/port.ts). Owner: P2 lane J
// (design/p2-p5-briefs.md).
import type { ReviewStore } from "../port";
import { notImplemented } from "../d1/stub";
import type { DdbContext } from "./contracts";

export function ddbReviewStore(_ctx: DdbContext): ReviewStore {
  return notImplemented<ReviewStore>("J", "ddb/review");
}
