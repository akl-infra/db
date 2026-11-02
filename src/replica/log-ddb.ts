// The DynamoDB commit log (design A): the DynamoDB JSON API over `fetch`,
// signed with SigV4 by aws4fetch (no AWS SDK). One table, string keys pk/sk:
//   HEAD/HEAD          { seq: N }                       the newest committed seq
//   LOG/<seq, 12 digits>  { unit, kind, body }          one entry; body = JSON of stmts/hash/name/at
// append = TransactWriteItems [Put LOG#n+1 if absent, Update HEAD seq = n+1 if seq = n (or absent)],
// with the unit id as ClientRequestToken so a retried 5xx cannot commit twice. head/read/get are
// ConsistentRead. The endpoint is configurable for DynamoDB Local.
import { AwsClient } from "aws4fetch";
import {
  AmbiguousAppendError,
  LogThrottledError,
  checkedBody,
  decodeBody,
  type CommitLog,
  type LogEntry,
  type NewLogEntry,
} from "./log";

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
}

const SEQ_WIDTH = 12;
const sk = (seq: number): string => String(seq).padStart(SEQ_WIDTH, "0");

class DdbHttpError extends Error {
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

type AttrS = { S: string };
type AttrN = { N: string };
type Item = Record<string, AttrS | AttrN | undefined>;

export function createDdbLog(opts: DdbLogOptions): CommitLog & { readonly table: string } {
  const region = opts.region ?? "us-east-2";
  const endpoint = opts.endpoint ?? `https://dynamodb.${region}.amazonaws.com/`;
  const client = new AwsClient({ ...opts.credentials, service: "dynamodb", region });
  const timeoutMs = opts.timeoutMs ?? 3000;
  const retries = opts.retries ?? 4;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
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

  function entryOf(item: Item): LogEntry {
    const seq = Number((item.sk as AttrS).S);
    return { seq, unitId: (item.unit as AttrS).S, kind: (item.kind as AttrS).S as LogEntry["kind"], ...decodeBody((item.body as AttrS).S) };
  }

  return {
    table: opts.table,

    async head() {
      const out = await callRetrying("GetItem", { TableName: opts.table, Key: { pk: { S: "HEAD" }, sk: { S: "HEAD" } }, ConsistentRead: true }, true);
      const item = out.Item as Item | undefined;
      return item === undefined ? 0 : Number((item.seq as AttrN).N);
    },

    async get(seq) {
      const out = await callRetrying("GetItem", { TableName: opts.table, Key: { pk: { S: "LOG" }, sk: { S: sk(seq) } }, ConsistentRead: true }, true);
      const item = out.Item as Item | undefined;
      return item === undefined ? null : entryOf(item);
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
        for (const item of (out.Items ?? []) as Item[]) entries.push(entryOf(item));
        start = out.LastEvaluatedKey;
      } while (start !== undefined);
      return entries;
    },

    async append(expectedHead, entry: NewLogEntry) {
      const body = checkedBody(entry);
      const next = expectedHead + 1;
      const payload = {
        // The unit id is the idempotency token: a retried 5xx whose first try committed answers success, not a conflict.
        ClientRequestToken: entry.unitId,
        TransactItems: [
          {
            Put: {
              TableName: opts.table,
              Item: { pk: { S: "LOG" }, sk: { S: sk(next) }, unit: { S: entry.unitId }, kind: { S: entry.kind }, body: { S: body } },
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
