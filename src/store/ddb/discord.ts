// DynamoDB implementation of `DiscordStore` (src/store/port.ts). Owner: P2 lane K
// (design/p2-p5-briefs.md).
import type { DiscordStore } from "../port";
import { notImplemented } from "../d1/stub";
import type { DdbContext } from "./contracts";

export function ddbDiscordStore(_ctx: DdbContext): DiscordStore {
  return notImplemented<DiscordStore>("K", "ddb/discord");
}
