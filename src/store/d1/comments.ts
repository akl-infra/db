// D1 implementation of `CommentStore` (src/store/port.ts). Owner: P1 agent C
// (design/p1-briefs.md). Move today's SQL here verbatim.
import type { CommentStore } from "../port";
import { notImplemented } from "./stub";

export function d1CommentStore(_db: D1Database): CommentStore {
  return notImplemented<CommentStore>("C", "comments");
}
