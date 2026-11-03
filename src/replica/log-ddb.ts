// The DynamoDB commit log (design A): the DynamoDB JSON API over `fetch`,
// signed with SigV4 by aws4fetch (no AWS SDK). One table, string keys pk/sk:
//   HEAD/HEAD          { seq: N }                       the newest committed seq
//   LOG/<seq, 12 digits>  { unit, kind, body }          one entry; body = JSON of stmts/hash/name/at
//                         { unit, kind, spill, spillhash }  a body over 300,000 bytes lives in S3 (spill.ts); `ttl` marks expiry (retention)
// append = TransactWriteItems [Put LOG#n+1 if absent, Update HEAD seq = n+1 if seq = n (or absent)],
// with the unit id as ClientRequestToken so a retried 5xx cannot commit twice. head/read/get are
// ConsistentRead. The endpoint is configurable for DynamoDB Local.
import { AwsClient } from "aws4fetch";
import { sleep as realSleep } from "./timers";
import {
  AmbiguousAppendError,
  LogThrottledError,
  decodeBody,
  type CommitLog,
  type ExpirableLog,
  type LogEntry,
  type NewLogEntry,
} from "./log";
import type { ObjectStore } from "./objects";
import type { SnapRef, SnapshotState } from "./snapshot";
import { BodySpiller } from "./spill";

export interface DdbLogOptions {
  table: string;
  region?: string;
  /** e.g. http://127.0.0.1:18407 for DynamoDB Local. Default: the regional AWS endpoint. */
  endpoint?: string;
  /** The caller passes them (Lambda: the execution role's, from its environment; DynamoDB Local: any). Never read from the process environment here. */
  credentials: { accessKeyId: string; secretAccessKey: string; sessionToken?: string };
  /** Per-request timeout. Default 3000 ms (the study measured p95 of 5-35 ms in-region). */
  timeoutMs?: number;
  /** Bounded retries of throttling and 5xx. Default 4 (so 5 tries). */
  retries?: number;
  /** Test hooks. */
  /** Sends a signed request (default: the global fetch). Tests wrap it to drop answers or inject 5xx. */
  fetch?: (request: Request) => Promise<Response>;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  /** Where bodies over 300,000 bytes go (S3 in Lambda, memory in tests). Without it such an entry is refused (LogEntryTooLargeError). */
  blobs?: ObjectStore;
}

const SEQ_WIDTH = 12;
export const sk = (seq: number): string => String(seq).padStart(SEQ_WIDTH, "0");

export class DdbHttpError extends Error {
  constructor(readonly status: number, readonly type: string, message: string, readonly body: unknown) {
    super(message);
    this.name = "DdbHttpError";
  }
}

const THROTTLE_TYPES = ["ProvisionedThroughputExceededException", "ThrottlingException", "RequestLimitExceeded", "TransactionInProgressException"];

function shortType(type: string): string {
  const i = type.lastIndexOf("#");
  return i >= 0 ? type.slice(i + 1) : type;
}

export type AttrS = { S: string };
export type AttrN = { N: string };
export type Item = Record<string, AttrS | AttrN | undefined>;

/** The signed DynamoDB JSON API calls with bounded retries, shared by the commit log and the snapshot state (the lean signer: GetItem, Query, TransactWriteItems). */
export function createDdbCaller(opts: DdbLogOptions): {
  call(target: string, payload: unknown): Promise<Record<string, unknown>>;
  callRetrying(target: string, payload: unknown, retryTransport: boolean): Promise<Record<string, unknown>>;
} {
  const region = opts.region ?? "us-east-2";
  const endpoint = opts.endpoint ?? `https://dynamodb.${region}.amazonaws.com/`;
  const client = new AwsClient({ ...opts.credentials, service: "dynamodb", region });
  const timeoutMs = opts.timeoutMs ?? 3000;
  const retries = opts.retries ?? 4;
  const sleep = opts.sleep ?? realSleep;
  const random = opts.random ?? Math.random;
  const doFetch = opts.fetch;

  /** One signed call. Throws DdbHttpError for any non-2xx answer; a transport failure throws whatever fetch threw. */
  async function call(target: string, payload: unknown): Promise<Record<string, unknown>> {
    const init = {
      method: "POST",
      headers: { "content-type": "application/x-amz-json-1.0", "x-amz-target": `DynamoDB_20120810.${target}` },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs),
    };
    const res = doFetch === undefined ? await client.fetch(endpoint, init) : await doFetch(await client.sign(endpoint, init));
    const text = await res.text();
    let json: Record<string, unknown> = {};
    try {
      json = text === "" ? {} : (JSON.parse(text) as Record<string, unknown>);
    } catch {
      // a non-JSON 5xx body from a proxy
    }
    if (!res.ok) {
      const type = shortType(String(json.__type ?? json.code ?? `HTTP${res.status}`));
      throw new DdbHttpError(res.status, type, `${target}: ${type}: ${String(json.message ?? json.Message ?? text.slice(0, 200))}`, json);
    }
    return json;
  }

  const retryable = (e: unknown): boolean => e instanceof DdbHttpError && (e.status >= 500 || THROTTLE_TYPES.includes(e.type));

  /** call() with bounded retries of throttling and 5xx (and, for idempotent reads, transport errors). */
  async function callRetrying(target: string, payload: unknown, retryTransport: boolean): Promise<Record<string, unknown>> {
    let last: unknown;
    for (let i = 0; i <= retries; i++) {
      try {
        return await call(target, payload);
      } catch (e) {
        last = e;
        if (!retryable(e) && !(retryTransport && !(e instanceof DdbHttpError))) throw e;
        if (i < retries) await sleep(Math.floor(10 * 2 ** i * (0.5 + random())));
      }
    }
    if (last instanceof DdbHttpError) throw new LogThrottledError(`DynamoDB ${target} kept failing after ${retries + 1} tries: ${last.message}`, { cause: last });
    throw last;
  }

  return { call, callRetrying };
}

export function createDdbLog(opts: DdbLogOptions): CommitLog & ExpirableLog & { readonly table: string; readonly spiller: BodySpiller } {
  const { callRetrying } = createDdbCaller(opts);
  const spiller = new BodySpiller(opts.blobs);

  async function entryOf(item: Item): Promise<LogEntry> {
    const seq = Number((item.sk as AttrS).S);
    const unitId = (item.unit as AttrS).S;
    const json = await spiller.load({ body: (item.body as AttrS | undefined)?.S, spill: (item.spill as AttrS | undefined)?.S, hash: (item.spillhash as AttrS | undefined)?.S }, `commit log entry ${seq} (unit ${unitId})`);
    return { seq, unitId, kind: (item.kind as AttrS).S as LogEntry["kind"], ...decodeBody(json) };
  }

  return {
    table: opts.table,
    spiller,

    async head() {
      const out = await callRetrying("GetItem", { TableName: opts.table, Key: { pk: { S: "HEAD" }, sk: { S: "HEAD" } }, ConsistentRead: true }, true);
      const item = out.Item as Item | undefined;
      return item === undefined ? 0 : Number((item.seq as AttrN).N);
    },

    async get(seq) {
      const out = await callRetrying("GetItem", { TableName: opts.table, Key: { pk: { S: "LOG" }, sk: { S: sk(seq) } }, ConsistentRead: true }, true);
      const item = out.Item as Item | undefined;
      return item === undefined ? null : await entryOf(item);
    },

    async read(afterSeq, upTo) {
      if (upTo <= afterSeq) return [];
      const entries: LogEntry[] = [];
      let start: unknown;
      do {
        const out = await callRetrying(
          "Query",
          {
            TableName: opts.table,
            ConsistentRead: true,
            KeyConditionExpression: "pk = :pk AND sk BETWEEN :lo AND :hi",
            ExpressionAttributeValues: { ":pk": { S: "LOG" }, ":lo": { S: sk(afterSeq + 1) }, ":hi": { S: sk(upTo) } },
            ...(start === undefined ? {} : { ExclusiveStartKey: start }),
          },
          true,
        );
        entries.push(...(await Promise.all(((out.Items ?? []) as Item[]).map(entryOf))));
        start = out.LastEvaluatedKey;
      } while (start !== undefined);
      return entries;
    },

    async expire(afterSeq, upToSeq, atSec, max) {
      const seqs: number[] = [];
      let start: unknown;
      while (seqs.length < max && upToSeq > afterSeq) {
        const out = await callRetrying(
          "Query",
          {
            TableName: opts.table,
            ConsistentRead: true,
            KeyConditionExpression: "pk = :pk AND sk BETWEEN :lo AND :hi",
            ProjectionExpression: "sk",
            Limit: Math.min(max - seqs.length, 500),
            ExpressionAttributeValues: { ":pk": { S: "LOG" }, ":lo": { S: sk(afterSeq + 1) }, ":hi": { S: sk(upToSeq) } },
            ...(start === undefined ? {} : { ExclusiveStartKey: start }),
          },
          true,
        );
        for (const item of (out.Items ?? []) as Item[]) seqs.push(Number((item.sk as AttrS).S));
        start = out.LastEvaluatedKey;
        if (start === undefined) break;
      }
      // TransactWriteItems takes 100 actions; an Update that finds the item gone (already expired) must not fail the batch.
      for (let i = 0; i < seqs.length; i += 100) {
        await callRetrying(
          "TransactWriteItems",
          {
            TransactItems: seqs.slice(i, i + 100).map((seq) => ({
              Update: {
                TableName: opts.table,
                Key: { pk: { S: "LOG" }, sk: { S: sk(seq) } },
                UpdateExpression: "SET #t = :t",
                ConditionExpression: "attribute_exists(pk)",
                ExpressionAttributeNames: { "#t": "ttl" },
                ExpressionAttributeValues: { ":t": { N: String(atSec) } },
              },
            })),
          },
          false,
        );
      }
      // `seqs` ends where the scan ended: if it stopped for `max`, continue after the last; if it ran out, everything up to upToSeq is handled.
      const exhausted = start === undefined;
      return { marked: seqs.length, through: exhausted ? Math.max(upToSeq, afterSeq) : (seqs[seqs.length - 1] ?? afterSeq) };
    },

    async append(expectedHead, entry: NewLogEntry) {
      const stored = await spiller.store(entry);
      const next = expectedHead + 1;
      const payload = {
        // The unit id is the idempotency token: a retried 5xx whose first try committed answers success, not a conflict.
        ClientRequestToken: entry.unitId,
        TransactItems: [
          {
            Put: {
              TableName: opts.table,
              Item: {
                pk: { S: "LOG" },
                sk: { S: sk(next) },
                unit: { S: entry.unitId },
                kind: { S: entry.kind },
                ...(stored.spill === undefined ? { body: { S: stored.body } } : { spill: { S: stored.spill }, spillhash: { S: stored.hash } }),
              },
              ConditionExpression: "attribute_not_exists(pk)",
            },
          },
          {
            Update: {
              TableName: opts.table,
              Key: { pk: { S: "HEAD" }, sk: { S: "HEAD" } },
              UpdateExpression: "SET seq = :next",
              ConditionExpression: "attribute_not_exists(seq) OR seq = :cur",
              ExpressionAttributeValues: { ":next": { N: String(next) }, ":cur": { N: String(expectedHead) } },
            },
          },
        ],
      };
      try {
        // Throttling and 5xx retry (safe: the token makes a second commit impossible); transport errors do not, they are ambiguous.
        await callRetrying("TransactWriteItems", payload, false);
        return "ok";
      } catch (e) {
        if (e instanceof DdbHttpError) {
          if (e.type === "TransactionCanceledException") {
            const reasons = ((e.body as { CancellationReasons?: { Code?: string }[] }).CancellationReasons ?? []).map((r) => r.Code ?? "None");
            if (reasons.some((c) => c === "ConditionalCheckFailed" || c === "TransactionConflict")) return "conflict";
            if (reasons.some((c) => c === "ThrottlingError" || c === "ProvisionedThroughputExceeded")) throw new LogThrottledError(`DynamoDB append throttled: ${e.message}`, { cause: e });
            throw e;
          }
          if (e.type === "ConditionalCheckFailedException") return "conflict";
          // 5xx that survived the retries: the commit may have happened.
          if (e.status >= 500) throw new AmbiguousAppendError(`DynamoDB append: ${e.message}`, { cause: e });
          throw e;
        }
        if (e instanceof LogThrottledError) {
          // Retries exhausted on 5xx/throttle: a 5xx may have committed, a pure throttle cannot have.
          const cause = (e.cause as DdbHttpError | undefined)?.status ?? 0;
          if (cause >= 500) throw new AmbiguousAppendError(e.message, { cause: e });
          throw e;
        }
        // Socket error, DNS failure, abort/timeout: the request may have reached DynamoDB.
        throw new AmbiguousAppendError(`DynamoDB append: ${e instanceof Error ? e.message : String(e)}`, { cause: e });
      }
    },
  };
}

// ---- the snapshot state: SNAP/POINTER, SNAP/PREV, SNAP/DAILY#nn, SNAP/EXPIRED, in the same table as the log ----

function refItem(sk: string, ref: SnapRef): Item {
  return {
    pk: { S: "SNAP" },
    sk: { S: sk },
    seq: { N: String(ref.seq) },
    key: { S: ref.key },
    sha: { S: ref.sha256 },
    size: { N: String(ref.size) },
    csize: { N: String(ref.compressed) },
    migrations: { S: JSON.stringify(ref.migrations) },
    at: { S: ref.at },
    ...(ref.day !== undefined ? { day: { S: ref.day } } : {}),
    ...(ref.slot !== undefined ? { slot: { N: String(ref.slot) } } : {}),
  };
}

function refOf(item: Item): SnapRef {
  const day = (item.day as AttrS | undefined)?.S;
  const slot = (item.slot as AttrN | undefined)?.N;
  return {
    seq: Number((item.seq as AttrN).N),
    key: (item.key as AttrS).S,
    sha256: (item.sha as AttrS).S,
    size: Number((item.size as AttrN).N),
    compressed: Number((item.csize as AttrN).N),
    migrations: JSON.parse((item.migrations as AttrS).S) as string[],
    at: (item.at as AttrS).S,
    ...(day !== undefined ? { day } : {}),
    ...(slot !== undefined ? { slot: Number(slot) } : {}),
  };
}

const snapKey = (sk: string) => ({ pk: { S: "SNAP" }, sk: { S: sk } });
const conditionFailed = (e: unknown): boolean =>
  e instanceof DdbHttpError && (e.type === "ConditionalCheckFailedException" || (e.type === "TransactionCanceledException" && ((e.body as { CancellationReasons?: { Code?: string }[] }).CancellationReasons ?? []).some((r) => r.Code === "ConditionalCheckFailed" || r.Code === "TransactionConflict")));

/** The snapshot state over DynamoDB: strongly consistent reads, conditional writes (the pointer's seq only increases, RP1). */
export function createDdbSnapshotState(opts: DdbLogOptions): SnapshotState {
  const { callRetrying } = createDdbCaller(opts);
  const T = opts.table;

  async function getRef(sk: string): Promise<SnapRef | null> {
    const out = await callRetrying("GetItem", { TableName: T, Key: snapKey(sk), ConsistentRead: true }, true);
    return out.Item === undefined ? null : refOf(out.Item as Item);
  }

  return {
    pointer: () => getRef("POINTER"),
    previous: () => getRef("PREV"),

    async movePointer(ref) {
      for (let tries = 0; tries < 5; tries++) {
        const cur = await getRef("POINTER");
        if (cur !== null && cur.seq >= ref.seq) return "stale";
        // Compare-and-swap on the exact old seq, so PREV is always the pointer this write replaced (two writers cannot both claim it).
        const items: unknown[] = [
          {
            Put: {
              TableName: T,
              Item: refItem("POINTER", ref),
              ...(cur === null
                ? { ConditionExpression: "attribute_not_exists(pk)" }
                : { ConditionExpression: "seq = :old AND seq < :new", ExpressionAttributeValues: { ":old": { N: String(cur.seq) }, ":new": { N: String(ref.seq) } } }),
            },
          },
          ...(cur === null ? [] : [{ Put: { TableName: T, Item: refItem("PREV", cur) } }]),
        ];
        try {
          await callRetrying("TransactWriteItems", { TransactItems: items }, false);
          return "moved";
        } catch (e) {
          if (!conditionFailed(e)) throw e;
          // someone else moved it between our read and write: look again (maybe it is now ours, maybe past us)
          const now = await getRef("POINTER");
          if (now !== null && now.seq === ref.seq && now.sha256 === ref.sha256) return "moved";
        }
      }
      throw new Error("snapshot pointer: contention, gave up after 5 tries");
    },

    async dailies() {
      const out = await callRetrying(
        "Query",
        { TableName: T, ConsistentRead: true, KeyConditionExpression: "pk = :pk AND begins_with(sk, :p)", ExpressionAttributeValues: { ":pk": { S: "SNAP" }, ":p": { S: "DAILY#" } } },
        true,
      );
      return ((out.Items ?? []) as Item[]).map(refOf).sort((a, b) => a.seq - b.seq);
    },

    async putDaily(ref) {
      const slot = String(ref.slot ?? 0).padStart(2, "0");
      try {
        await callRetrying(
          "TransactWriteItems",
          { TransactItems: [{ Put: { TableName: T, Item: refItem(`DAILY#${slot}`, ref), ConditionExpression: "attribute_not_exists(pk) OR seq <= :new", ExpressionAttributeValues: { ":new": { N: String(ref.seq) } } } }] },
          false,
        );
        return "put";
      } catch (e) {
        if (conditionFailed(e)) return "stale";
        throw e;
      }
    },

    async expiredThrough() {
      const out = await callRetrying("GetItem", { TableName: T, Key: snapKey("EXPIRED"), ConsistentRead: true }, true);
      const item = out.Item as Item | undefined;
      return item === undefined ? 0 : Number((item.seq as AttrN).N);
    },

    async claimNightly(day, nowMs, leaseMs) {
      try {
        await callRetrying(
          "TransactWriteItems",
          {
            TransactItems: [
              {
                Put: {
                  TableName: T,
                  Item: { ...snapKey("NIGHTLY"), nday: { S: day }, nat: { N: String(nowMs) } },
                  ConditionExpression: "attribute_not_exists(pk) OR nday <> :day OR nat <= :expired",
                  ExpressionAttributeValues: { ":day": { S: day }, ":expired": { N: String(nowMs - leaseMs) } },
                },
              },
            ],
          },
          false,
        );
        return true;
      } catch (e) {
        if (conditionFailed(e)) return false;
        throw e;
      }
    },

    async setExpiredThrough(seq) {
      try {
        await callRetrying(
          "TransactWriteItems",
          { TransactItems: [{ Put: { TableName: T, Item: { ...snapKey("EXPIRED"), seq: { N: String(seq) } }, ConditionExpression: "attribute_not_exists(pk) OR seq < :new", ExpressionAttributeValues: { ":new": { N: String(seq) } } } }] },
          false,
        );
      } catch (e) {
        if (!conditionFailed(e)) throw e; // already at or past it: monotonic, nothing to do
      }
    },
  };
}

/** The table definition (for DynamoDB Local and for infra tests). */
export function logTableDefinition(table: string): Record<string, unknown> {
  return {
    TableName: table,
    AttributeDefinitions: [
      { AttributeName: "pk", AttributeType: "S" },
      { AttributeName: "sk", AttributeType: "S" },
    ],
    KeySchema: [
      { AttributeName: "pk", KeyType: "HASH" },
      { AttributeName: "sk", KeyType: "RANGE" },
    ],
    BillingMode: "PAY_PER_REQUEST",
  };
}

/** Create the log table; for DynamoDB Local in tests and the lab server (the CloudFormation template owns the real one). */
export async function createLogTable(o: { endpoint: string; table: string; region?: string; credentials: DdbLogOptions["credentials"] }): Promise<void> {
  const res = await tableCall(o, "CreateTable", logTableDefinition(o.table));
  if (!res.ok) throw new Error(`CreateTable ${o.table}: ${(await res.text()).slice(0, 300)}`);
}

/** Delete a table created by createLogTable (best effort). */
export async function dropLogTable(o: { endpoint: string; table: string; region?: string; credentials: DdbLogOptions["credentials"] }): Promise<void> {
  await (await tableCall(o, "DeleteTable", { TableName: o.table })).text();
}

function tableCall(o: { endpoint: string; region?: string; credentials: DdbLogOptions["credentials"] }, target: string, body: unknown): Promise<Response> {
  const client = new AwsClient({ ...o.credentials, service: "dynamodb", region: o.region ?? "us-east-2" });
  return client.fetch(o.endpoint, { method: "POST", headers: { "content-type": "application/x-amz-json-1.0", "x-amz-target": `DynamoDB_20120810.${target}` }, body: JSON.stringify(body) });
}
