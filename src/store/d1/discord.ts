// D1 implementation of `DiscordStore` (src/store/port.ts). Owner: P1 agent D
// (design/p1-briefs.md). Move today's SQL here verbatim.
import type { DiscordStore } from "../port";
import { notImplemented } from "./stub";

export function d1DiscordStore(_db: D1Database): DiscordStore {
  return notImplemented<DiscordStore>("D", "discord");
}
