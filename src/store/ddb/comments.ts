// DynamoDB implementation of `CommentStore` (src/store/port.ts). Owner: P2 lane J
// (design/p2-p5-briefs.md).
import type { CommentStore } from "../port";
import { notImplemented } from "../d1/stub";
import type { DdbContext } from "./contracts";

export function ddbCommentStore(_ctx: DdbContext): CommentStore {
  return notImplemented<CommentStore>("J", "ddb/comments");
}
