// DynamoDB implementation of `LinkStore` (src/store/port.ts). Owner: P2 lane J
// (design/p2-p5-briefs.md).
import type { LinkStore } from "../port";
import { notImplemented } from "../d1/stub";
import type { DdbContext } from "./contracts";

export function ddbLinkStore(_ctx: DdbContext): LinkStore {
  return notImplemented<LinkStore>("J", "ddb/links");
}
