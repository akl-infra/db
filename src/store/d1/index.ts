// The D1 implementation of the storage port (src/store/port.ts): one factory
// per area, each in its own file and owned by one P1 agent
// (design/p1-briefs.md). This file is frozen with the port.
import type { Store } from "../port";
import { d1AdminStore } from "./admin";
import { d1AuthStore } from "./auth";
import { d1CommentStore } from "./comments";
import { d1DiscordStore } from "./discord";
import { d1DumpStore } from "./dump";
import { d1EventStore } from "./events";
import { d1HeadStore } from "./head";
import { d1CutoverStore, d1HoldStore } from "./holds";
import { d1LayoutReadStore } from "./layouts";
import { d1LinkStore } from "./links";
import { d1ModqueueStore } from "./modqueue";
import { d1OutboxStore } from "./outbox";
import { d1ReviewStore } from "./review";
import { d1StateStore } from "./state";
import { d1WpmStore } from "./wpm";

const D1_HANDLE = Symbol("akldb.d1");

export function createD1Store(db: D1Database): Store {
  const store: Store & { [D1_HANDLE]: D1Database } = {
    head: d1HeadStore(db),
    state: d1StateStore(db),
    layouts: d1LayoutReadStore(db),
    events: d1EventStore(db),
    holds: d1HoldStore(db),
    cutover: d1CutoverStore(db),
    auth: d1AuthStore(db),
    admin: d1AdminStore(db),
    links: d1LinkStore(db),
    wpm: d1WpmStore(db),
    comments: d1CommentStore(db),
    review: d1ReviewStore(db),
    modqueue: d1ModqueueStore(db),
    discord: d1DiscordStore(db),
    outbox: d1OutboxStore(db),
    dump: d1DumpStore(db),
    [D1_HANDLE]: db,
  };
  return store;
}

/** The D1 database behind a store made by `createD1Store`, else undefined (P1 transition only, src/store/arg.ts). */
export function d1HandleOf(store: Store): D1Database | undefined {
  return (store as Partial<Record<typeof D1_HANDLE, D1Database>>)[D1_HANDLE];
}
