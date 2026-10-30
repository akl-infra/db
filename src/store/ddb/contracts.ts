// Cross-lane contracts for the DynamoDB store (design/aws-port.md §2,
// design/p2-p5-briefs.md). FROZEN at P2 start, like src/store/port.ts: lanes
// implement these, they do not change them. A change goes through the main
// session as its own commit.
import type { DynamoDBDocumentClient, TransactWriteCommandInput } from "@aws-sdk/lib-dynamodb";
import type { EventDbRow } from "../../core/events";
import type { FormatRow, LayoutRow } from "../../core/records";
import type { BlobStore } from "../../platform/port";

/** The two tables (design §2.1). Names are per deployment; tests use one pair per test file. */
export interface DdbTables {
  main: string;
  ephemeral: string;
}

/** Everything a DynamoDB area implementation needs. Built by `createDdbStore` (src/store/ddb/index.ts). */
export interface DdbContext {
  readonly doc: DynamoDBDocumentClient;
  readonly tables: DdbTables;
  /** Replica snapshots and payload spill (design §2.3, §2.7). */
  readonly blobs: BlobStore;
  /** The catalog read model (lane H). */
  readonly catalog: Catalog;
}

export type TxItem = NonNullable<TransactWriteCommandInput["TransactItems"]>[number];

/** One event to append: an `events` row without its seq (runEventTx assigns it). */
export type EventInput = Omit<EventDbRow, "seq">;

/**
 * The builder `runEventTx` hands to its callback (design §2.4). The callback
 * may run several times (HEAD contention renumbers and rebuilds), so it must
 * be a pure function of `head` plus what it read before calling runEventTx.
 */
export interface EventTxBuilder {
  /** HEAD as read (consistently) for this attempt. */
  readonly head: { readonly seq: number; readonly live: number; readonly maxAt: string | null };
  /** Append one event (plus its EVL/EVK/EVA mirrors); returns the seq it gets in this attempt. */
  event(e: EventInput): number;
  /** Add one more write to the same transaction. `tag` names it in `TxConditionFailed.tags`. */
  item(tag: string, i: TxItem): void;
  /** Move `layouts_head.live` (HEAD.live) by `delta` in the same transaction. */
  addLive(delta: number): void;
}

/** A transaction was cancelled by a condition on one or more tagged items (never HEAD's own: runEventTx retries that). */
export class TxConditionFailed extends Error {
  constructor(readonly tags: readonly string[]) {
    super(`transaction condition failed: ${tags.join(", ")}`);
    this.name = "TxConditionFailed";
  }
}

/**
 * Appends events gap-free (design §2.4): reads HEAD, builds, commits with
 * HEAD's `seq = :expected` condition, and on a HEAD-only condition failure or
 * TransactionConflict re-reads HEAD and rebuilds (backoff 15, 40, 90, 180,
 * 350, 700 ms x 0.5-1.5, at most 8 attempts; exhausted = `internal()` 500 and
 * an `EVENTTX_EXHAUSTED` log line). A failed condition on any other item
 * throws `TxConditionFailed` with its tags at once, never retried.
 */
export type RunEventTx = (ctx: DdbContext, build: (b: EventTxBuilder) => void | Promise<void>) => Promise<{ seqs: number[] }>;

/** A transaction with no event (author upserts, leases, claims). Conflicts and throttles retried as above; conditions throw `TxConditionFailed`. */
export type RunTx = (ctx: DdbContext, items: readonly { tag: string; item: TxItem }[]) => Promise<void>;

/** One layout as the catalog holds it: the CAT item decoded, payloads included, likers ascending. */
export interface CatalogLayout {
  readonly layout: LayoutRow;
  readonly formats: ReadonlyMap<string, FormatRow>;
  readonly likers: readonly string[];
}

/** An exact snapshot of every layout at one HEAD seq (design §2.7). */
export interface CatalogView {
  readonly seq: number;
  readonly layouts: ReadonlyMap<string, CatalogLayout>;
}

/** The per-container catalog read model (lane H). */
export interface Catalog {
  /** The exact snapshot at the HEAD seq current when called (>= any seq the caller read before). */
  current(): Promise<CatalogView>;
  /** Write the S3/blob snapshot if HEAD moved since the stored one (jobs, every 5 min); returns its seq. */
  writeSnapshot(): Promise<{ seq: number; written: boolean }>;
  /** Rebuild from a full consistent scan, bypassing the snapshot (nightly proof, tests). */
  rebuildFromScan(): Promise<CatalogView>;
  /** Drop the cached view after writes that bypass the event log (restore, import, raw test inserts): the next `current()` rebuilds from a consistent scan. */
  invalidate(): void;
}

// ---------------------------------------------------------------------------
// The item model as data: D1 rows <-> DynamoDB items (design §2.3, §4.1 `codec`)
// ---------------------------------------------------------------------------

/** Every D1 table the codec carries (migrations/*.sql minus SQLite's own). */
export type D1TableName =
  | "layouts" | "layout_formats" | "layout_revs" | "likes" | "events" | "layouts_head" | "import_state" | "import_map"
  | "authors" | "authors_head" | "discord_users" | "discord_users_head" | "admins" | "bans" | "clients" | "nonces" | "auth_cache" | "ratelimit" | "idempotency"
  | "link_submissions" | "wpm_submissions" | "layout_comments" | "comment_likes" | "moderation_review_history"
  | "modqueue_notifications" | "modqueue_delivery_gate" | "discord_pending_actions" | "discord_reopen_actions"
  | "discord_deny_modals" | "discord_reopen_confirmations" | "discord_rejection_dm_outbox";

/** A D1 row as `SELECT *` returns it (0/1 booleans, JSON columns as strings, NULL as null). */
export type D1Row = Record<string, unknown>;
export type RowsByTable = Partial<Record<D1TableName, D1Row[]>>;
export type Item = Record<string, unknown>;

/**
 * One lane's slice of the item model. `toItems` turns that lane's tables'
 * rows into every item they imply -- entities, mirrors, index items, claims,
 * counters -- deterministically. `fromItems` reads back exactly those rows
 * from the lane's primary items (derived items are regenerated, never read).
 * The codec's round-trip property: fromItems(toItems(rows)) equals rows
 * under canonical(), row order by primary key.
 */
export interface LaneSchema {
  readonly lane: "G" | "I" | "J" | "K";
  readonly tables: readonly D1TableName[];
  toItems(rows: RowsByTable): { main: Item[]; ephemeral: Item[] };
  fromItems(items: { main: readonly Item[]; ephemeral: readonly Item[] }): RowsByTable;
  /** The D1 table an item of this lane belongs to (entity or derived), or null if not this lane's. Used by fault injection and the index checker. */
  tableOf(item: Item): D1TableName | null;
}
