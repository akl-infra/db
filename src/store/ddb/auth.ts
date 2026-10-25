// DynamoDB implementation of `AuthStore` (src/store/port.ts). Owner: P2 lane I
// (design/p2-p5-briefs.md; design/aws-port.md §2.2 R1-R6, §2.3, §2.8).
//
// Eventual reads (ConsistentRead false, design §8.5): `client`, `authorName`,
// `rolesOf` and `authCache`; the author upsert's own reads and everything
// else are strong. Nonces, the auth cache, rate-limit windows and
// idempotency rows live in the ephemeral table; TTL only collects them, and
// the prunes below are best-effort scans that make `pruneX` observable like
// D1's DELETEs.
import { BatchGetCommand, BatchWriteCommand, DeleteCommand, GetCommand, PutCommand, QueryCommand, ScanCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { internal } from "../../core/errors";
import type { AuthCacheRow, AuthStore } from "../port";
import { TxConditionFailed, type DdbContext, type Item, type TxItem } from "./contracts";
import {
  adminKey, authCacheKey, authorKey, AUTHORS_HEAD_KEY, AUTHORS_PK, banKey, clientKey, epochSeconds, idempotencyKey, IDEMPOTENCY_TTL_SECONDS,
  nonceKey, NONCE_TTL_SECONDS, rateLimitKey, RATELIMIT_TTL_SECONDS, ttlFor,
} from "./keys-auth";
import type { Key } from "./keys";
import { byteLength, SPILL_BYTES } from "./payload";
import { gunzipText, gzipText } from "./schema/auth";
import { runTx, txTuning } from "./tx";

// ---------------------------------------------------------------------------
// Shared with admin.ts
// ---------------------------------------------------------------------------

const MAX_ATTEMPTS = 8;
const BACKOFF_MS = [15, 40, 90, 180, 350, 700];
const TRANSIENT = new Set([
  "TransactionConflictException",
  "TransactionInProgressException",
  "ThrottlingException",
  "ProvisionedThroughputExceededException",
  "RequestLimitExceeded",
  "InternalServerError",
  "ServiceUnavailable",
]);

const errName = (e: unknown): string => (e as { name?: string } | null)?.name ?? "";
export const isConditionFailed = (e: unknown): boolean => errName(e) === "ConditionalCheckFailedException";

/** Retries a single-item call on throttles, conflicts and server errors (the fault wrapper injects them above the SDK); anything else throws at once. */
export async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (!TRANSIENT.has(errName(e))) throw e;
      if (attempt + 1 >= MAX_ATTEMPTS) {
        console.error(`DDB_RETRY_EXHAUSTED ${errName(e)}: gave up after ${MAX_ATTEMPTS} attempts`);
        throw internal();
      }
      const base = BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)]!;
      await txTuning.sleep(base * (0.5 + txTuning.random()));
    }
  }
}

export async function getItem(ctx: DdbContext, table: string, key: Key, consistent: boolean): Promise<Item | undefined> {
  const r = await withRetry(() => ctx.doc.send(new GetCommand({ TableName: table, Key: key, ConsistentRead: consistent })));
  return r.Item as Item | undefined;
}

/** Every item of one partition (optionally an sk prefix), consistent or not, all pages. */
export async function queryPartition(ctx: DdbContext, table: string, pk: string, consistent: boolean): Promise<Item[]> {
  const out: Item[] = [];
  let start: Record<string, unknown> | undefined;
  do {
    const r = await withRetry(() =>
      ctx.doc.send(
        new QueryCommand({
          TableName: table,
          KeyConditionExpression: "pk = :p",
          ExpressionAttributeValues: { ":p": pk },
          ConsistentRead: consistent,
          ExclusiveStartKey: start,
        }),
      ),
    );
    out.push(...((r.Items ?? []) as Item[]));
    start = r.LastEvaluatedKey;
  } while (start !== undefined);
  return out;
}

/** SQLite BINARY order for text: UTF-8 byte order, which is code point order. */
export function cmpBinary(a: string, b: string): number {
  const x = Array.from(a);
  const y = Array.from(b);
  const n = Math.min(x.length, y.length);
  for (let i = 0; i < n; i++) {
    const d = x[i]!.codePointAt(0)! - y[i]!.codePointAt(0)!;
    if (d !== 0) return d;
  }
  return x.length - y.length;
}

export async function getAuthor(ctx: DdbContext, userId: string, consistent: boolean): Promise<Item | undefined> {
  return getItem(ctx, ctx.tables.main, authorKey(userId), consistent);
}

/** The `META/AUTHORS` bump of the authors_head triggers: version + 1 and modified_at, plus count + 1 on an insert. */
export function authorsHeadBump(ctx: DdbContext, modifiedAt: string, inserted: boolean): { tag: string; item: TxItem } {
  return {
    tag: "authors_head",
    item: {
      Update: {
        TableName: ctx.tables.main,
        Key: AUTHORS_HEAD_KEY,
        UpdateExpression: inserted ? "SET modified_at = :m ADD version :one, #c :one" : "SET modified_at = :m ADD version :one",
        ...(inserted ? { ExpressionAttributeNames: { "#c": "count" } } : {}),
        ExpressionAttributeValues: { ":m": modifiedAt, ":one": 1 },
      },
    },
  };
}

// ---------------------------------------------------------------------------

type Reasons = Record<string, unknown>;

/** Deletes the given keys of one table, 25 per BatchWriteItem, resubmitting unprocessed ones. */
export async function batchDelete(ctx: DdbContext, table: string, keys: readonly Key[]): Promise<void> {
  for (let i = 0; i < keys.length; i += 25) {
    let pending: Reasons[] = keys.slice(i, i + 25).map((k) => ({ DeleteRequest: { Key: k } }));
    for (let round = 0; pending.length > 0; round++) {
      if (round >= MAX_ATTEMPTS) throw internal();
      const r = await withRetry(() => ctx.doc.send(new BatchWriteCommand({ RequestItems: { [table]: pending as never } })));
      pending = (r.UnprocessedItems?.[table] ?? []) as Reasons[];
      if (pending.length > 0) await txTuning.sleep(15 * (round + 1));
    }
  }
}

/** Scans the ephemeral table for one pk prefix (consistent) and deletes every item `doomed` selects. */
async function pruneEphemeral(ctx: DdbContext, prefix: string, projection: string[], doomed: (it: Item) => boolean, filter?: { expr: string; values: Record<string, unknown> }): Promise<void> {
  const keys: Key[] = [];
  let start: Record<string, unknown> | undefined;
  do {
    const r = await withRetry(() =>
      ctx.doc.send(
        new ScanCommand({
          TableName: ctx.tables.ephemeral,
          FilterExpression: `begins_with(pk, :pre)${filter === undefined ? "" : ` AND ${filter.expr}`}`,
          ExpressionAttributeNames: Object.fromEntries(projection.map((p) => [`#${p}`, p])),
          ExpressionAttributeValues: { ":pre": prefix, ...(filter?.values ?? {}) },
          ProjectionExpression: projection.map((p) => `#${p}`).join(", "),
          ConsistentRead: true,
          ExclusiveStartKey: start,
        }),
      ),
    );
    for (const it of (r.Items ?? []) as Item[]) if (doomed(it)) keys.push({ pk: it.pk as string, sk: it.sk as string });
    start = r.LastEvaluatedKey;
  } while (start !== undefined);
  await batchDelete(ctx, ctx.tables.ephemeral, keys);
}

/**
 * Put unless a live row is there. An expired-but-present row (real DynamoDB
 * deletes up to 48 h late) counts as absent: its `ttl` is compared with
 * `nowSeconds`, the caller's own clock (the time the request carries).
 */
async function conditionalPut(ctx: DdbContext, table: string, item: Item, nowSeconds: number | null): Promise<boolean> {
  try {
    await withRetry(() =>
      ctx.doc.send(
        new PutCommand({
          TableName: table,
          Item: item,
          ...(nowSeconds === null
            ? { ConditionExpression: "attribute_not_exists(pk)" }
            : {
                ConditionExpression: "attribute_not_exists(pk) OR #ttl < :now",
                ExpressionAttributeNames: { "#ttl": "ttl" },
                ExpressionAttributeValues: { ":now": nowSeconds },
              }),
        }),
      ),
    );
    return true;
  } catch (e) {
    if (isConditionFailed(e)) return false;
    throw e;
  }
}

export function ddbAuthStore(ctx: DdbContext): AuthStore {
  const { main, ephemeral } = ctx.tables;

  const cachePut = (item: Item): TxItem => ({ Put: { TableName: ephemeral, Item: item } });

  function cacheItem(tokenHash: string, f: { user_id: string | null; name: string | null; app_id: string | null; ok: number; expires_at: string }): Item {
    const t = ttlFor(epochSeconds(f.expires_at));
    return { ...authCacheKey(tokenHash), token_hash: tokenHash, ...f, ...(t === null ? {} : { ttl: t }) };
  }

  /** Insert or refresh the stale author the client lane just authenticated; returns the stored name. */
  async function touchAuthor(userId: string, at: string, staleBefore: string): Promise<string | null> {
    let known = await getAuthor(ctx, userId, false);
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const stale = known === undefined || known.last_seen_at == null || (known.last_seen_at as string) < staleBefore;
      if (!stale) return known!.name as string;
      if (known === undefined) {
        try {
          await runTx(ctx, [
            {
              tag: "author",
              item: {
                Put: {
                  TableName: main,
                  Item: { ...authorKey(userId), user_id: userId, name: userId, first_seen_at: at, last_seen_at: at, name_source: "client" },
                  ConditionExpression: "attribute_not_exists(pk)",
                },
              },
            },
            authorsHeadBump(ctx, at, true),
          ]);
          return userId;
        } catch (e) {
          if (!(e instanceof TxConditionFailed)) throw e;
          known = await getAuthor(ctx, userId, true);
          continue;
        }
      }
      try {
        const r = await withRetry(() =>
          ctx.doc.send(
            new UpdateCommand({
              TableName: main,
              Key: authorKey(userId),
              UpdateExpression: "SET last_seen_at = :at",
              ConditionExpression: "attribute_exists(pk) AND (attribute_not_exists(last_seen_at) OR last_seen_at < :stale)",
              ExpressionAttributeValues: { ":at": at, ":stale": staleBefore },
              ReturnValues: "ALL_NEW",
            }),
          ),
        );
        return (r.Attributes?.name as string | undefined) ?? known.name as string;
      } catch (e) {
        if (!isConditionFailed(e)) throw e;
        known = await getAuthor(ctx, userId, true);
      }
    }
    throw internal();
  }

  /** Prune helper: ISO timestamps compare as strings, exactly as D1's `at < ?`. */
  const pruneBefore = (prefix: string, attr: string, before: string) =>
    pruneEphemeral(ctx, prefix, ["pk", "sk", attr], (it) => typeof it[attr] === "string" && (it[attr] as string) < before, { expr: `#${attr} < :before`, values: { ":before": before } });

  return {
    async client(id) {
      const it = await getItem(ctx, main, clientKey(id), false);
      if (it === undefined) return null;
      return { id: it.id as string, pubkey: it.pubkey as string, owner_user_id: it.owner_user_id as string, caps: it.caps as string, status: it.status as never };
    },

    async insertNonce(clientId, nonce, at) {
      const e = epochSeconds(at);
      const t = ttlFor(e === null ? null : e + NONCE_TTL_SECONDS);
      return conditionalPut(ctx, ephemeral, {
        ...nonceKey(clientId, nonce),
        client_id: clientId,
        nonce,
        at,
        ...(t === null ? {} : { ttl: t }),
      }, e);
    },

    async pruneNonces(beforeIso) {
      await pruneBefore("N#", "at", beforeIso);
    },

    touchClientAuthor: touchAuthor,

    async authCache(tokenHash) {
      const it = await getItem(ctx, ephemeral, authCacheKey(tokenHash), false);
      if (it === undefined) return null;
      return {
        user_id: (it.user_id as string | null) ?? null,
        name: (it.name as string | null) ?? null,
        app_id: (it.app_id as string | null) ?? null,
        ok: it.ok as number,
        expires_at: it.expires_at as string,
      } satisfies AuthCacheRow;
    },

    async cacheAuthFailure(tokenHash, expiresAt) {
      const item = cacheItem(tokenHash, { user_id: null, name: null, app_id: null, ok: 0, expires_at: expiresAt });
      await withRetry(() => ctx.doc.send(new PutCommand({ TableName: ephemeral, Item: item })));
    },

    async cacheAuthSuccess(r) {
      const cache = cachePut(cacheItem(r.tokenHash, { user_id: r.userId, name: r.name, app_id: r.appId, ok: 1, expires_at: r.expiresAt }));
      for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        const cur = await getAuthor(ctx, r.userId, true);
        const items: { tag: string; item: TxItem }[] = [{ tag: "cache", item: cache }];
        if (cur === undefined) {
          items.push(
            {
              tag: "author",
              item: {
                Put: {
                  TableName: main,
                  Item: { ...authorKey(r.userId), user_id: r.userId, name: r.name, first_seen_at: r.at, last_seen_at: r.at, name_source: "user" },
                  ConditionExpression: "attribute_not_exists(pk)",
                },
              },
            },
            authorsHeadBump(ctx, r.at, true),
          );
        } else if (cur.name_source === "admin") {
          // An admin-set name is stickier than a sign-in (§4.3, LDB-MD4): only last_seen_at moves.
          items.push({
            tag: "author",
            item: {
              Update: {
                TableName: main,
                Key: authorKey(r.userId),
                UpdateExpression: "SET last_seen_at = :at",
                ConditionExpression: "name_source = :admin",
                ExpressionAttributeValues: { ":at": r.at, ":admin": "admin" },
              },
            },
          });
        } else {
          items.push({
            tag: "author",
            item: {
              Update: {
                TableName: main,
                Key: authorKey(r.userId),
                UpdateExpression: "SET #n = :n, name_source = :user, last_seen_at = :at",
                ConditionExpression: "name_source <> :admin AND #n = :old",
                ExpressionAttributeNames: { "#n": "name" },
                ExpressionAttributeValues: { ":n": r.name, ":user": "user", ":at": r.at, ":admin": "admin", ":old": cur.name },
              },
            },
          });
          if (cur.name !== r.name) items.push(authorsHeadBump(ctx, r.at, false));
        }
        try {
          await runTx(ctx, items);
          return;
        } catch (e) {
          if (!(e instanceof TxConditionFailed)) throw e;
        }
      }
      throw internal();
    },

    async pruneAuthCache(nowIso) {
      await pruneBefore("AC#", "expires_at", nowIso);
    },

    async rolesOf(userId) {
      const keys = [adminKey(userId), banKey(userId)];
      let pending: Key[] = keys;
      const found = new Set<string>();
      for (let round = 0; pending.length > 0; round++) {
        if (round >= MAX_ATTEMPTS) throw internal();
        const todo = pending;
        const r = await withRetry(() => ctx.doc.send(new BatchGetCommand({ RequestItems: { [main]: { Keys: todo, ConsistentRead: false } } })));
        for (const it of (r.Responses?.[main] ?? []) as Item[]) found.add(it.pk as string);
        pending = (r.UnprocessedKeys?.[main]?.Keys ?? []) as Key[];
        if (pending.length > 0) await txTuning.sleep(15 * (round + 1));
      }
      return { admin: found.has("ADMINS"), banned: found.has("BANS") };
    },

    async authorName(userId) {
      const it = await getAuthor(ctx, userId, false);
      return it === undefined ? null : (it.name as string);
    },

    async authors(order) {
      const rows = (await queryPartition(ctx, main, AUTHORS_PK, true)).map((it) => ({ user_id: it.user_id as string, name: it.name as string }));
      return rows.sort(order === "name" ? (a, b) => cmpBinary(a.name, b.name) || cmpBinary(a.user_id, b.user_id) : (a, b) => cmpBinary(a.user_id, b.user_id));
    },

    async author(userId) {
      const it = await getAuthor(ctx, userId, true);
      return it === undefined ? null : { user_id: it.user_id as string, name: it.name as string };
    },

    async hitWindow(key, windowStart) {
      const r = await withRetry(() =>
        ctx.doc.send(
          new UpdateCommand({
            TableName: ephemeral,
            Key: rateLimitKey(key, windowStart),
            UpdateExpression: "SET #ttl = :ttl ADD n :one",
            ExpressionAttributeNames: { "#ttl": "ttl" },
            ExpressionAttributeValues: { ":ttl": ttlFor(windowStart + RATELIMIT_TTL_SECONDS), ":one": 1 },
            ReturnValues: "UPDATED_NEW",
          }),
        ),
      );
      const n = r.Attributes?.n;
      if (typeof n !== "number") throw new Error("ratelimit.take: upsert returned no row");
      return { n, window_start: windowStart };
    },

    async pruneRateLimits(beforeWindowStart) {
      // Lane G's budget items carry no window_start attribute; the window is the sk.
      await pruneEphemeral(ctx, "RL#", ["pk", "sk"], (it) => it.pk !== "RL#holds" && Number(it.sk) < beforeWindowStart);
    },

    async getIdempotency(scope, key) {
      const it = await getItem(ctx, ephemeral, idempotencyKey(scope, key), true);
      if (it === undefined) return null;
      return {
        scope: it.scope as string,
        key: it.key as string,
        method: it.method as string,
        path: it.path as string,
        request_hash: it.request_hash as string,
        status: it.status as number,
        response_body: it.response_gz === undefined ? (it.response_body as string) : await gunzipText(it.response_gz as Uint8Array),
        at: it.at as string,
      };
    },

    async reserveIdempotency(row) {
      const e = epochSeconds(row.at);
      const t = ttlFor(e === null ? null : e + IDEMPOTENCY_TTL_SECONDS);
      return conditionalPut(ctx, ephemeral, {
        ...idempotencyKey(row.scope, row.key),
        scope: row.scope,
        key: row.key,
        method: row.method,
        path: row.path,
        request_hash: row.request_hash,
        status: 0,
        response_body: "",
        at: row.at,
        ...(t === null ? {} : { ttl: t }),
      }, e);
    },

    async takeOverIdempotency(row) {
      const e = epochSeconds(row.at);
      const t = ttlFor(e === null ? null : e + IDEMPOTENCY_TTL_SECONDS);
      try {
        await withRetry(() =>
          ctx.doc.send(
            new UpdateCommand({
              TableName: ephemeral,
              Key: idempotencyKey(row.scope, row.key),
              UpdateExpression: `SET #m = :m, #p = :p, request_hash = :h, #s = :zero, response_body = :empty, #at = :at${t === null ? "" : ", #ttl = :ttl"} REMOVE response_gz`,
              ConditionExpression: "attribute_exists(pk) AND #at = :expected",
              ExpressionAttributeNames: { "#m": "method", "#p": "path", "#s": "status", "#at": "at", ...(t === null ? {} : { "#ttl": "ttl" }) },
              ExpressionAttributeValues: {
                ":m": row.method, ":p": row.path, ":h": row.request_hash, ":zero": 0, ":empty": "", ":at": row.at, ":expected": row.expectedAt,
                ...(t === null ? {} : { ":ttl": t }),
              },
            }),
          ),
        );
        return true;
      } catch (e) {
        if (isConditionFailed(e)) return false;
        throw e;
      }
    },

    async completeIdempotency(scope, key, status, responseBody, at) {
      const e = epochSeconds(at);
      const t = ttlFor(e === null ? null : e + IDEMPOTENCY_TTL_SECONDS);
      const big = byteLength(responseBody) > SPILL_BYTES;
      const gz = big ? await gzipText(responseBody) : undefined;
      try {
        await withRetry(() =>
          ctx.doc.send(
            new UpdateCommand({
              TableName: ephemeral,
              Key: idempotencyKey(scope, key),
              UpdateExpression: `SET #s = :s, ${big ? "response_gz = :gz" : "response_body = :b"}, #at = :at${t === null ? "" : ", #ttl = :ttl"} REMOVE ${big ? "response_body" : "response_gz"}`,
              // D1's UPDATE of a row that is not there changes nothing; without this an Update would create a partial item.
              ConditionExpression: "attribute_exists(pk)",
              ExpressionAttributeNames: { "#s": "status", "#at": "at", ...(t === null ? {} : { "#ttl": "ttl" }) },
              ExpressionAttributeValues: {
                ":s": status, ":at": at,
                ...(big ? { ":gz": gz } : { ":b": responseBody }),
                ...(t === null ? {} : { ":ttl": t }),
              },
            }),
          ),
        );
      } catch (e) {
        if (!isConditionFailed(e)) throw e;
      }
    },

    async deleteIdempotency(scope, key) {
      await withRetry(() => ctx.doc.send(new DeleteCommand({ TableName: ephemeral, Key: idempotencyKey(scope, key) })));
    },

    async pruneIdempotency(beforeIso) {
      await pruneBefore("IDEM#", "at", beforeIso);
    },
  };
}
