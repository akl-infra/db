// The row codec (design/aws-port.md §4.1 `codec`): D1-shaped rows <-> DynamoDB
// items, as the pure composition of the four lanes' `LaneSchema`s, plus the
// consistent export, the bulk import and the dump -> rows mapping built on it.
// Lane N owns this file; the lanes own their `toItems`/`fromItems`/`tableOf`.
//
// Items that are not rows: `STATE/<anything without a string `key`>` is
// bookkeeping (STATE/migrations, STATE/cutover), not an `import_state` row.
// Export, import and the checker leave those alone (`isNonRowItem`).
import { BatchWriteCommand, GetCommand, PutCommand, QueryCommand, ScanCommand } from "@aws-sdk/lib-dynamodb";
import type { Dump } from "../../dump/write";
import type { D1Row, D1TableName, DdbContext, Item, LaneSchema, RowsByTable } from "./contracts";
import { invalidateAllCatalogs } from "./catalog";
import { HEAD_KEY } from "./keys";
import { putPayload } from "./payload";
import { SCHEMAS } from "./schema";
import { inlineIdempotencyBodies } from "./schema/auth";
import { inlinePayloads, payloadBlobs } from "./schema/core";

/** What the codec needs of a context: no catalog (the codec runs under the catalog's own scans too). */
export type CodecContext = Pick<DdbContext, "doc" | "tables" | "blobs">;

export interface D1TableSpec {
  /** D1's primary key columns, in order (migrations/*.sql, read with `pragma table_info`). */
  readonly pk: readonly string[];
  readonly columns: readonly string[];
  /** NOT NULL (or PRIMARY KEY) columns with no default: an insert must give them. */
  readonly required: readonly string[];
  readonly defaults: Readonly<Record<string, string | number>>;
}

/**
 * Every D1 table's shape, so the DynamoDB `TestStore` can fill defaults, order
 * by primary key and refuse what SQLite would refuse. tests/ddb/schema-coverage.test.ts
 * regenerates this from migrations/ and fails on any drift.
 */
export const D1_TABLES: Readonly<Record<D1TableName, D1TableSpec>> = {
  admins: {
    pk: ["user_id"],
    columns: ["user_id","added_by","added_at","note"],
    required: ["user_id","added_at"],
    defaults: {  },
  },
  auth_cache: {
    pk: ["token_hash"],
    columns: ["token_hash","user_id","name","ok","expires_at","app_id"],
    required: ["token_hash","ok","expires_at"],
    defaults: {  },
  },
  authors: {
    pk: ["user_id"],
    columns: ["user_id","name","first_seen_at","last_seen_at","name_source"],
    required: ["user_id","name","first_seen_at","last_seen_at"],
    defaults: { name_source: "import" },
  },
  authors_head: {
    pk: ["id"],
    columns: ["id","version","modified_at","count"],
    required: ["id","version"],
    defaults: { count: 0 },
  },
  bans: {
    pk: ["user_id"],
    columns: ["user_id","by","at","reason"],
    required: ["user_id","by","at"],
    defaults: {  },
  },
  clients: {
    pk: ["id"],
    columns: ["id","name","pubkey","owner_user_id","caps","discord_app_id","status","created_at","revoked_at"],
    required: ["id","name","pubkey","owner_user_id","caps","status","created_at"],
    defaults: {  },
  },
  comment_likes: {
    pk: ["layout_id","author_id","user_id"],
    columns: ["layout_id","author_id","user_id","via","created_at"],
    required: ["layout_id","author_id","user_id","via","created_at"],
    defaults: {  },
  },
  discord_deny_modals: {
    pk: ["modal_id"],
    columns: ["modal_id","initial_interaction_id","actor_id","kind","submission_id","channel_id","message_id","guild_id","created_at","expires_at","consumed_at","consumed_interaction_id","expected_review_version"],
    required: ["modal_id","initial_interaction_id","actor_id","kind","submission_id","channel_id","message_id","guild_id","created_at","expires_at"],
    defaults: { expected_review_version: 0 },
  },
  discord_pending_actions: {
    pk: ["interaction_id"],
    columns: ["interaction_id","application_id","token","actor_id","actor_name","kind","action","submission_id","reason","channel_id","message_id","guild_id","created_at","expires_at","state","lease_until","lease_token","attempts","result","expected_review_version","response_mode"],
    required: ["interaction_id","application_id","token","actor_id","actor_name","kind","action","submission_id","channel_id","message_id","guild_id","created_at","expires_at"],
    defaults: { state: "pending", attempts: 0, expected_review_version: 0, response_mode: "reply" },
  },
  discord_rejection_dm_outbox: {
    pk: ["delivery_key"],
    columns: ["delivery_key","event_seq","kind","submission_id","layout_id","recipient_id","nonce","status","attempts","next_attempt_at","lease_token","lease_until","ambiguous_message_attempt_at","dm_channel_id","discord_message_id","last_error_class","created_at","updated_at","sent_at","review_version","decision"],
    required: ["delivery_key","event_seq","kind","submission_id","layout_id","recipient_id","nonce","next_attempt_at","created_at","updated_at"],
    defaults: { status: "pending", attempts: 0, review_version: 0, decision: "rejection" },
  },
  discord_reopen_actions: {
    pk: ["interaction_id"],
    columns: ["interaction_id","application_id","token","actor_id","actor_name","kind","action","submission_id","reason","expected_review_version","expected_status","channel_id","message_id","guild_id","created_at","expires_at","state","lease_until","lease_token","attempts","result","response_mode"],
    required: ["interaction_id","application_id","token","actor_id","actor_name","kind","action","submission_id","expected_status","channel_id","message_id","guild_id","created_at","expires_at"],
    defaults: { expected_review_version: 0, state: "pending", attempts: 0, response_mode: "reply" },
  },
  discord_reopen_confirmations: {
    pk: ["confirmation_id"],
    columns: ["confirmation_id","initial_interaction_id","actor_id","kind","submission_id","channel_id","message_id","guild_id","expected_status","expected_review_version","created_at","expires_at","consumed_at","consumed_interaction_id"],
    required: ["confirmation_id","initial_interaction_id","actor_id","kind","submission_id","channel_id","message_id","guild_id","expected_status","expected_review_version","created_at","expires_at"],
    defaults: {  },
  },
  events: {
    pk: ["seq"],
    columns: ["seq","at","kind","layout_id","name","owner","format","rev","actor","via","admin","detail_json","before_json","after_json","source_client","source_version"],
    required: ["seq","at","kind","actor","via"],
    defaults: { admin: 0 },
  },
  idempotency: {
    pk: ["scope","key"],
    columns: ["scope","key","method","path","request_hash","status","response_body","at"],
    required: ["scope","key","method","path","request_hash","status","response_body","at"],
    defaults: {  },
  },
  import_map: {
    pk: ["upstream_id"],
    columns: ["upstream_id","layout_id","upstream_name","upstream_modified_at"],
    required: ["upstream_id","layout_id"],
    defaults: {  },
  },
  import_state: {
    pk: ["key"],
    columns: ["key","value"],
    required: ["key","value"],
    defaults: {  },
  },
  layout_comments: {
    pk: ["id"],
    columns: ["id","layout_id","user_id","body","via","submitted_at","status","decided_by","decided_at","reason","review_version"],
    required: ["id","layout_id","user_id","via","submitted_at"],
    defaults: { status: "pending", review_version: 0 },
  },
  layout_formats: {
    pk: ["layout_id","lineage"],
    columns: ["layout_id","lineage","format","rev","created_at","modified_at","payload_json","has_magic","source_client","source_version","has_alts","has_combos"],
    required: ["layout_id","lineage","format","rev","created_at","modified_at","payload_json"],
    defaults: { has_magic: 0, has_alts: 0, has_combos: 0 },
  },
  layout_revs: {
    pk: ["layout_id","n"],
    columns: ["layout_id","n","lineage","rev","event_seq","format","payload_json"],
    required: ["layout_id","n","rev","event_seq"],
    defaults: {  },
  },
  layouts: {
    pk: ["id"],
    columns: ["id","name","owner","n","layout_rev","created_at","modified_at","deleted","like_count","upstream_source","upstream_id","upstream_state","source_client","source_version","link","like_adjust"],
    required: ["id","name","owner","n","layout_rev","created_at","modified_at"],
    defaults: { deleted: 0, like_count: 0, like_adjust: 0 },
  },
  layouts_head: {
    pk: ["id"],
    columns: ["id","live"],
    required: ["id","live"],
    defaults: {  },
  },
  likes: {
    pk: ["layout_id","user_id"],
    columns: ["layout_id","user_id","at","via"],
    required: ["layout_id","user_id","at"],
    defaults: { via: "import:cmini" },
  },
  link_submissions: {
    pk: ["id"],
    columns: ["id","layout_id","url","submitted_by","submitted_at","status","decided_by","decided_at","reason","notified_at"],
    required: ["id","layout_id","url","submitted_by","submitted_at"],
    defaults: { status: "pending" },
  },
  moderation_review_history: {
    pk: ["id"],
    columns: ["id","kind","submission_id","action","actor","at","reason","review_version"],
    required: ["id","kind","submission_id","action","actor","at","review_version"],
    defaults: {  },
  },
  modqueue_delivery_gate: {
    pk: ["id"],
    columns: ["id","lease_token","lease_until","retry_at"],
    required: ["id"],
    defaults: { lease_until: 0, retry_at: 0 },
  },
  modqueue_notifications: {
    pk: ["kind","submission_id"],
    columns: ["kind","submission_id","message_id","shown_status","failed_attempts","message_format","transport","channel_id","reconcile_lease_token","reconcile_lease_until","shown_review_version","shown_source_message_url"],
    required: ["kind","submission_id","message_id","shown_status"],
    defaults: { failed_attempts: 0, message_format: "text", transport: "legacy_webhook", shown_review_version: 0 },
  },
  nonces: {
    pk: ["client_id","nonce"],
    columns: ["client_id","nonce","at"],
    required: ["client_id","nonce","at"],
    defaults: {  },
  },
  ratelimit: {
    pk: ["key"],
    columns: ["key","window_start","n"],
    required: ["key","window_start","n"],
    defaults: {  },
  },
  wpm_submissions: {
    pk: ["id"],
    columns: ["id","layout_id","user_id","wpm","proof","submitted_by","via","submitted_at","status","decided_by","decided_at","reason","notified_at","review_version","source_message_url"],
    required: ["id","layout_id","user_id","wpm","proof","submitted_by","via","submitted_at"],
    defaults: { status: "pending", review_version: 0 },
  },
};

/**
 * Sort order of a table's rows. D1's key for `ratelimit` is `key` alone (one
 * window per key); DynamoDB keeps one item per window, so rows sort by both.
 */
const SORT_KEYS: Partial<Record<D1TableName, readonly string[]>> = { ratelimit: ["key", "window_start"] };

export const ALL_TABLES = Object.keys(D1_TABLES) as D1TableName[];

// ---------------------------------------------------------------------------
// Ordering and equality
// ---------------------------------------------------------------------------

const enc = new TextEncoder();

/** SQLite's order for the values rows hold: NULL < numbers < text (BINARY collation = UTF-8 bytes). */
export function compareValues(a: unknown, b: unknown): number {
  const rank = (v: unknown): number => (v === null || v === undefined ? 0 : typeof v === "number" ? 1 : 2);
  const ra = rank(a);
  const rb = rank(b);
  if (ra !== rb) return ra - rb;
  if (ra === 0) return 0;
  if (ra === 1) return (a as number) - (b as number);
  const x = enc.encode(String(a));
  const y = enc.encode(String(b));
  const n = Math.min(x.length, y.length);
  for (let i = 0; i < n; i++) if (x[i] !== y[i]) return x[i]! - y[i]!;
  return x.length - y.length;
}

export function compareRows(a: D1Row, b: D1Row, columns: readonly string[]): number {
  for (const c of columns) {
    const d = compareValues(a[c], b[c]);
    if (d !== 0) return d;
  }
  return 0;
}

export function sortKeysOf(table: D1TableName): readonly string[] {
  return SORT_KEYS[table] ?? D1_TABLES[table].pk;
}

export function sortRows(table: D1TableName, rows: readonly D1Row[]): D1Row[] {
  const cols = sortKeysOf(table);
  return [...rows].sort((a, b) => compareRows(a, b, cols));
}

/** A stable string for an item or row: sorted keys, `undefined` dropped, bytes as hex, sets sorted. */
export function canonicalString(v: unknown): string {
  return JSON.stringify(canon(v));
}

function canon(v: unknown): unknown {
  if (v === undefined) return undefined;
  if (v === null || typeof v !== "object") return typeof v === "bigint" ? `${v}n` : v;
  if (v instanceof Uint8Array) return { $bytes: Buffer.from(v).toString("hex") };
  if (v instanceof Set) return { $set: [...v].map(canon).sort((a, b) => compareValues(JSON.stringify(a), JSON.stringify(b))) };
  if (Array.isArray(v)) return v.map((x) => canon(x) ?? null);
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(v).sort()) {
    const c = canon((v as Record<string, unknown>)[k]);
    if (c !== undefined) out[k] = c;
  }
  return out;
}

export const itemKey = (i: Item): string => `${String(i.pk)}\u0000${String(i.sk)}`;

// ---------------------------------------------------------------------------
// Lane classification
// ---------------------------------------------------------------------------

/** `STATE/...` items without a string `key` are bookkeeping, never `import_state` rows. */
export function isNonRowItem(item: Item): boolean {
  return item.pk === "STATE" && typeof item.key !== "string";
}

function safeTableOf(schema: LaneSchema, item: Item): D1TableName | null {
  try {
    return schema.tableOf(item);
  } catch (e) {
    // A lane whose schema has not landed yet owns nothing (removed at merge).
    if (/not implemented yet/.test((e as Error).message)) return null;
    throw e;
  }
}

/** The lane and D1 table an item belongs to, or null (a derived item still names the table it derives from). */
export function classify(item: Item): { schema: LaneSchema; table: D1TableName } | null {
  if (isNonRowItem(item)) return null;
  for (const schema of SCHEMAS) {
    const table = safeTableOf(schema, item);
    if (table !== null) return { schema, table };
  }
  return null;
}

/** The D1 table an item of any lane belongs to (what fault injection asks). */
export function tableOfItem(item: Item): D1TableName | null {
  return classify(item)?.table ?? null;
}

export function schemaOfTable(table: D1TableName): LaneSchema {
  const s = SCHEMAS.find((x) => x.tables.includes(table));
  if (s === undefined) throw new Error(`no lane schema covers table '${table}'`);
  return s;
}

// ---------------------------------------------------------------------------
// rows <-> items (pure)
// ---------------------------------------------------------------------------

export interface ItemSet {
  main: Item[];
  ephemeral: Item[];
}

/**
 * Every item the rows imply. A lane none of whose tables is named in `rows`
 * contributes nothing; a table not named is "not part of this call", never
 * "empty". Two items with one key are a bug in a lane (or two live layouts
 * with one folded name) and throw.
 */
export function rowsToItems(rows: RowsByTable): ItemSet {
  for (const t of Object.keys(rows)) {
    if (!(t in D1_TABLES)) throw new Error(`rowsToItems: unknown table '${t}'`);
  }
  const out: ItemSet = { main: [], ephemeral: [] };
  for (const schema of SCHEMAS) {
    const sub: RowsByTable = {};
    let any = false;
    for (const t of schema.tables) {
      if (rows[t] !== undefined) {
        sub[t] = rows[t];
        any = true;
      }
    }
    if (!any) continue;
    const r = schema.toItems(sub);
    out.main.push(...r.main);
    out.ephemeral.push(...r.ephemeral);
  }
  for (const list of [out.main, out.ephemeral]) {
    const seen = new Set<string>();
    for (const i of list) {
      const k = itemKey(i);
      if (seen.has(k)) throw new Error(`rowsToItems: two rows imply item ${String(i.pk)} / ${String(i.sk)}`);
      seen.add(k);
    }
  }
  return out;
}

/** The inverse: each lane reads its own primary items. Every table is present in the result, rows ordered by primary key. */
export function itemsToRows(items: { main: readonly Item[]; ephemeral: readonly Item[] }): RowsByTable {
  const byLane = new Map<LaneSchema, ItemSet>();
  for (const [which, list] of [["main", items.main], ["ephemeral", items.ephemeral]] as const) {
    for (const item of list) {
      const c = classify(item);
      if (c === null) continue;
      const set = byLane.get(c.schema) ?? { main: [], ephemeral: [] };
      set[which].push(item);
      byLane.set(c.schema, set);
    }
  }
  const out: RowsByTable = {};
  for (const t of ALL_TABLES) out[t] = [];
  for (const [schema, set] of byLane) {
    const rows = schema.fromItems(set);
    for (const t of schema.tables) out[t] = rows[t] ?? [];
  }
  for (const t of ALL_TABLES) out[t] = sortRows(t, out[t]!);
  return out;
}

// ---------------------------------------------------------------------------
// Retrying calls
// ---------------------------------------------------------------------------

const RETRYABLE = new Set([
  "TransactionConflictException", "ProvisionedThroughputExceededException", "ThrottlingException", "InternalServerError",
  "RequestLimitExceeded", "LimitExceededException",
]);

/** Test seam: the sleep between retries. */
export const codecTuning = { sleep: (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms)) };

/**
 * One document-client call, retried (backoff 15, 40, 90, 180, 350, 700 ms, at
 * most 8 attempts) on conflicts, throttles and 5xx. Every codec call is
 * idempotent (reads, whole-item puts and deletes), so a retry is safe.
 */
export async function send<T>(ctx: CodecContext, cmd: unknown): Promise<T> {
  const delays = [15, 40, 90, 180, 350, 700, 700];
  for (let attempt = 0; ; attempt++) {
    try {
      return (await (ctx.doc as unknown as { send(c: unknown): Promise<T> }).send(cmd)) as T;
    } catch (e) {
      if (!RETRYABLE.has((e as { name?: string }).name ?? "") || attempt >= delays.length) throw e;
      await codecTuning.sleep(delays[attempt]! * (0.5 + Math.random()));
    }
  }
}

// ---------------------------------------------------------------------------
// The table scans
// ---------------------------------------------------------------------------

async function scanTable(ctx: CodecContext, table: string): Promise<Item[]> {
  const out: Item[] = [];
  let start: Record<string, unknown> | undefined;
  do {
    const r = await send<{ Items?: Record<string, unknown>[]; LastEvaluatedKey?: Record<string, unknown> }>(ctx, new ScanCommand({ TableName: table, ConsistentRead: true, ExclusiveStartKey: start }));
    out.push(...((r.Items ?? []) as Item[]));
    start = r.LastEvaluatedKey;
  } while (start !== undefined);
  return out;
}

/** A consistent scan of both tables, bookkeeping items dropped, payload refs still in place (what is stored). */
export async function scanItems(ctx: CodecContext): Promise<ItemSet> {
  const [main, ephemeral] = await Promise.all([scanTable(ctx, ctx.tables.main), scanTable(ctx, ctx.tables.ephemeral)]);
  return { main: main.filter((i) => !isNonRowItem(i)), ephemeral: ephemeral.filter((i) => !isNonRowItem(i)) };
}

/**
 * Every D1 table's rows, read from a consistent scan of both tables, spilled
 * payloads put back, ordered by primary key.
 */
export async function exportRows(ctx: CodecContext): Promise<RowsByTable> {
  return rowsFromScan(ctx, await scanItems(ctx));
}

/** `exportRows` over a scan already in hand. */
export async function rowsFromScan(ctx: CodecContext, items: ItemSet): Promise<RowsByTable> {
  const rows = itemsToRows({ main: await inlinePayloads(ctx.blobs, items.main), ephemeral: await inlineIdempotencyBodies(items.ephemeral) });
  // D1 always holds its two single-row head tables (migrations 0007, 0034); a store with no HEAD item yet reads as their initial rows.
  if (rows.layouts_head!.length === 0) rows.layouts_head = [{ id: 1, live: 0 }];
  if (rows.authors_head!.length === 0) rows.authors_head = [{ id: 1, version: 0, modified_at: null, count: 0 }];
  return rows;
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

export interface ImportOptions {
  /**
   * `restoreSql`'s semantics (src/store/d1/dump.ts): first delete every item of the tables D1's restore empties
   * (`RESTORE_WIPED_TABLES`), then import. The head tables and idempotency/delivery-gate rows are left alone,
   * as D1 leaves them; the imported head rows overwrite the heads.
   */
  replace?: boolean;
  /** Skip the empty-store check (a harness writing into a store it just seeded). */
  allowNonEmpty?: boolean;
}

/** The event seq HEAD holds (0 for an empty store). */
export async function storedSeq(ctx: CodecContext): Promise<number> {
  const head = await send<{ Item?: Record<string, unknown> }>(ctx, new GetCommand({ TableName: ctx.tables.main, Key: HEAD_KEY, ConsistentRead: true }));
  return typeof head.Item?.seq === "number" ? head.Item.seq : 0;
}

/** True when the main table holds layouts or events (the primary data a restore must not merge into). */
export async function hasPrimaryData(ctx: CodecContext): Promise<boolean> {
  if ((await storedSeq(ctx)) > 0) return true;
  const cat = await send<{ Items?: unknown[] }>(ctx, new QueryCommand({
    TableName: ctx.tables.main,
    KeyConditionExpression: "pk = :p",
    ExpressionAttributeValues: { ":p": "CAT" },
    Limit: 1,
    ConsistentRead: true,
  }));
  return (cat.Items?.length ?? 0) > 0;
}

const BATCH = 25;


/** How many BatchWriteItem calls run at once. Order does not matter: the requests of one call touch distinct keys. */
const BATCH_PARALLEL = 8;

async function writeChunk(ctx: CodecContext, table: string, chunk: readonly Record<string, unknown>[]): Promise<void> {
  let pending = [...chunk];
  for (let attempt = 0; pending.length > 0; attempt++) {
    if (attempt >= 12) throw new Error(`BatchWriteItem on ${table}: ${pending.length} item(s) still unprocessed after ${attempt} tries`);
    if (attempt > 0) await new Promise((r) => setTimeout(r, Math.min(25 * 2 ** attempt, 1000)));
    const res = await send<{ UnprocessedItems?: Record<string, Record<string, unknown>[]> }>(ctx, new BatchWriteCommand({ RequestItems: { [table]: pending as never } }));
    pending = res.UnprocessedItems?.[table] ?? [];
  }
}

/** BatchWriteItem in chunks of 25 (a few at a time), retrying unprocessed items with a short backoff. The caller must not repeat a key. */
export async function batchWrite(ctx: CodecContext, table: string, requests: readonly Record<string, unknown>[]): Promise<void> {
  const chunks: Record<string, unknown>[][] = [];
  for (let i = 0; i < requests.length; i += BATCH) chunks.push(requests.slice(i, i + BATCH));
  for (let i = 0; i < chunks.length; i += BATCH_PARALLEL) {
    await Promise.all(chunks.slice(i, i + BATCH_PARALLEL).map((c) => writeChunk(ctx, table, c)));
  }
}

/** TABLE_ORDER_DELETE of src/store/d1/dump.ts: what a D1 restore empties. */
export const RESTORE_WIPED_TABLES: ReadonlySet<D1TableName> = new Set<D1TableName>([
  "events", "modqueue_notifications", "moderation_review_history", "discord_rejection_dm_outbox", "discord_pending_actions", "discord_deny_modals",
  "discord_reopen_actions", "discord_reopen_confirmations", "layout_revs", "layout_formats", "likes", "link_submissions", "wpm_submissions",
  "comment_likes", "layout_comments", "import_map", "layouts", "authors", "admins", "import_state", "clients", "bans", "auth_cache", "ratelimit", "nonces",
]);

async function wipeForRestore(ctx: CodecContext): Promise<void> {
  const items = await scanItems(ctx);
  for (const [list, table] of [[items.main, ctx.tables.main], [items.ephemeral, ctx.tables.ephemeral]] as const) {
    const doomed = list.filter((i) => {
      const c = classify(i);
      return c !== null && RESTORE_WIPED_TABLES.has(c.table);
    });
    await batchWrite(ctx, table, doomed.map((i) => ({ DeleteRequest: { Key: { pk: i.pk, sk: i.sk } } })));
  }
}

/**
 * Writes the items the rows imply: spilled payload blobs first, then
 * BatchWriteItem chunks. For an empty store (restore, migration, tests): it
 * refuses a store that already holds layouts or events.
 */
export async function importRows(ctx: CodecContext, rows: RowsByTable, opts: ImportOptions = {}): Promise<void> {
  const items = rowsToItems(rows);
  if (opts.replace === true) await wipeForRestore(ctx);
  else if (opts.allowNonEmpty !== true && (await hasPrimaryData(ctx))) {
    throw new Error("importRows: the store already holds layouts or events; import is for an empty store");
  }
  for (const json of payloadBlobs(rows).values()) await putPayload(ctx.blobs, json);
  await batchWrite(ctx, ctx.tables.main, items.main.map((Item) => ({ PutRequest: { Item } })));
  await batchWrite(ctx, ctx.tables.ephemeral, items.ephemeral.map((Item) => ({ PutRequest: { Item } })));
  // Rows arrived with no events: a warm catalog (a Lambda that outlives a restore) would keep serving the old view.
  invalidateAllCatalogs();
}

// ---------------------------------------------------------------------------
// Dump -> rows (what `rehost --target ddb` and `DumpStore.restore` import)
// ---------------------------------------------------------------------------

/** A row with every column of `table`: given values, else the column default, else null. Unknown columns are dropped. */
export function completeRow(table: D1TableName, row: Record<string, unknown>): D1Row {
  const spec = D1_TABLES[table];
  const out: D1Row = {};
  for (const c of spec.columns) out[c] = row[c] ?? spec.defaults[c] ?? null;
  return out;
}

/**
 * The rows `restoreSql` (src/store/d1/dump.ts) would leave in D1 for a dump,
 * same defaults and fallbacks: `like_adjust` 0, absent `has_alts` 0, absent
 * likes `via` 'import:cmini'... The dump carries no nonces, rate limits, auth
 * cache, idempotency, moderation or Discord rows, so none are returned.
 * `layouts_head.live` and `authors_head` are what D1's triggers leave.
 */
export function dumpToRows(dump: Dump): RowsByTable {
  const fill = (table: D1TableName, list: readonly object[] | undefined, patch?: (r: Record<string, unknown>) => Record<string, unknown>): D1Row[] =>
    (list ?? []).map((r) => completeRow(table, patch ? patch(r as Record<string, unknown>) : (r as Record<string, unknown>)));
  const layouts = fill("layouts", dump.records, (r) => ({ ...r, like_adjust: 0 }));
  const authors = fill("authors", dump.authors);
  const stateRows = fill("import_state", dump.import_state);
  return sortAll({
    layouts,
    layout_formats: fill("layout_formats", dump.layout_formats),
    layout_revs: fill("layout_revs", dump.layout_revs),
    likes: fill("likes", dump.likes),
    events: fill("events", dump.events),
    layouts_head: [{ id: 1, live: layouts.filter((l) => l.deleted === 0).length }],
    import_state: stateRows,
    import_map: fill("import_map", dump.import_map),
    authors,
    authors_head: [{ id: 1, version: dump.meta.authors_version ?? 0, modified_at: dump.meta.authors_modified_at ?? null, count: authors.length }],
    admins: fill("admins", dump.admins),
    bans: fill("bans", dump.bans),
    clients: fill("clients", dump.clients),
    link_submissions: fill("link_submissions", dump.link_submissions),
    wpm_submissions: fill("wpm_submissions", dump.wpm_submissions),
    layout_comments: fill("layout_comments", dump.layout_comments),
    comment_likes: fill("comment_likes", dump.comment_likes),
  });
}

function sortAll(rows: RowsByTable): RowsByTable {
  const out: RowsByTable = {};
  for (const t of Object.keys(rows) as D1TableName[]) out[t] = sortRows(t, rows[t] ?? []);
  return out;
}

// ---------------------------------------------------------------------------
// Rows the D1 migrations seed
// ---------------------------------------------------------------------------

/**
 * What migrations/*.sql insert: 0001's bootstrap admin, 0007/0035's
 * `authors_head`, 0034's `layouts_head`, 0033's delivery-gate row. A DynamoDB
 * store a test (or the lab) starts from must hold them too.
 */
export function bootstrapRows(): RowsByTable {
  return {
    admins: [{ user_id: "184412255822020608", added_by: null, added_at: "2026-09-08T00:00:00Z", note: "bootstrap: deeroh" }],
    authors_head: [{ id: 1, version: 0, modified_at: null, count: 0 }],
    events: [], // with layouts_head, makes HEAD {seq: 0, live: 0}
    layouts_head: [{ id: 1, live: 0 }],
    modqueue_delivery_gate: [completeRow("modqueue_delivery_gate", { id: 1 })],
  };
}

/**
 * Writes `bootstrapRows()` where absent (conditional puts, so it is safe to
 * repeat and never overwrites a counter that has moved). A lane whose schema
 * has not landed is skipped.
 */
export async function seedBootstrap(ctx: CodecContext): Promise<void> {
  const rows = bootstrapRows();
  for (const schema of SCHEMAS) {
    const sub: RowsByTable = {};
    for (const t of schema.tables) if (rows[t] !== undefined) sub[t] = rows[t];
    if (Object.keys(sub).length === 0) continue;
    let items: ItemSet;
    try {
      items = rowsToItems(sub);
    } catch (e) {
      if (/not implemented yet/.test((e as Error).message)) continue;
      throw e;
    }
    for (const [list, table] of [[items.main, ctx.tables.main], [items.ephemeral, ctx.tables.ephemeral]] as const) {
      for (const Item of list) {
        try {
          await send(ctx, new PutCommand({ TableName: table, Item, ConditionExpression: "attribute_not_exists(pk)" }));
        } catch (e) {
          if ((e as { name?: string }).name !== "ConditionalCheckFailedException") throw e;
        }
      }
    }
  }
}
