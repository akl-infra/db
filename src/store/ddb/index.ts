// The DynamoDB implementation of the storage port (src/store/port.ts): one
// factory per area, each owned by one P2 lane (design/p2-p5-briefs.md).
// FROZEN with src/store/ddb/contracts.ts.
import type { Store } from "../port";
import { ddbAdminStore } from "./admin";
import { ddbAuthStore } from "./auth";
import { createCatalog } from "./catalog";
import { ddbCommentStore } from "./comments";
import type { DdbContext } from "./contracts";
import { ddbCutoverStore } from "./cutover";
import { ddbDiscordStore } from "./discord";
import { ddbDiscordUserStore } from "./discord-users";
import { ddbDumpStore } from "./dump";
import { ddbEventStore } from "./events";
import { ddbHeadStore } from "./head";
import { ddbHoldStore } from "./holds";
import { ddbLayoutReadStore } from "./layouts";
import { ddbLinkStore } from "./links";
import { ddbModqueueStore } from "./modqueue";
import { ddbOutboxStore } from "./outbox";
import { ddbReviewStore } from "./review";
import { ddbStateStore } from "./state";
import { ddbWpmStore } from "./wpm";

export function createDdbStore(base: Omit<DdbContext, "catalog">): Store {
  const ctx: DdbContext = { ...base, catalog: createCatalog(base) };
  return {
    head: ddbHeadStore(ctx),
    state: ddbStateStore(ctx),
    layouts: ddbLayoutReadStore(ctx),
    events: ddbEventStore(ctx),
    holds: ddbHoldStore(ctx),
    cutover: ddbCutoverStore(ctx),
    auth: ddbAuthStore(ctx),
    admin: ddbAdminStore(ctx),
    links: ddbLinkStore(ctx),
    wpm: ddbWpmStore(ctx),
    discordUsers: ddbDiscordUserStore(ctx),
    comments: ddbCommentStore(ctx),
    review: ddbReviewStore(ctx),
    modqueue: ddbModqueueStore(ctx),
    discord: ddbDiscordStore(ctx),
    outbox: ddbOutboxStore(ctx),
    dump: ddbDumpStore(ctx),
  };
}
