// The mirror queue on DynamoDB (design/aws-port.md §5.2; lane Z): items in the EPHEMERAL table under pk `MQ#<direction>`
// (lane O's template: "writes batches into the ephemeral table under MQ#<direction>"). The codec's classifiers ignore this pk
// (it matches no lane schema), so exportRows and the wipe in importRows leave the queue alone. Queue items carry no `ttl`
// (the applier removes them) except the dedupe markers, which expire after a week.
import { DeleteCommand, GetCommand, PutCommand, QueryCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { createHash } from "node:crypto";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import type { BlobStore } from "../platform/port";
import type { Direction } from "./apply";
import { QueueConflict, type Kv } from "./queue";

/** An item's body above this many bytes goes to the blob store (a DynamoDB item holds 400 KB, attributes included). */
export const SPILL_BYTES = 250_000;
const BLOB_PREFIX = "\u0000blob:";

export interface DdbKvOptions {
  doc: DynamoDBDocumentClient;
  /** The ephemeral table's name. */
  table: string;
  direction: Direction;
  /** For oversized records. */
  blobs: BlobStore;
  nowMs?(): number;
  sleep?(ms: number): Promise<void>;
}

async function readAll(o: { body: ReadableStream<Uint8Array> }): Promise<string> {
  return new TextDecoder().decode(new Uint8Array(await new Response(o.body).arrayBuffer()));
}

export function ddbKv(o: DdbKvOptions): Kv {
  const pk = `MQ#${o.direction}`;
  const nowMs = o.nowMs ?? (() => Date.now());
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const send = <T>(cmd: unknown): Promise<T> => (o.doc as unknown as { send(c: unknown): Promise<T> }).send(cmd);

  const stored = async (body: string): Promise<string> => {
    if (Buffer.byteLength(body) <= SPILL_BYTES) return body;
    const key = `mirror/queue/${o.direction}/${createHash("sha256").update(body).digest("hex")}.json`;
    await o.blobs.put(key, body, "application/json");
    return BLOB_PREFIX + key;
  };
  const resolve = async (body: string): Promise<string> => {
    if (!body.startsWith(BLOB_PREFIX)) return body;
    const blob = await o.blobs.get(body.slice(BLOB_PREFIX.length));
    if (blob === null) throw new Error(`mirror queue: spilled record ${body.slice(BLOB_PREFIX.length)} is missing`);
    return readAll(blob);
  };

  return {
    async putBatch(items, markerSk, markerTtlSec) {
      const spilled = await Promise.all(items.map(async (i) => ({ sk: i.sk, body: await stored(i.body) })));
      const tx = [
        { Put: { TableName: o.table, Item: { pk, sk: markerSk, body: "1", ttl: Math.floor(nowMs() / 1000) + markerTtlSec }, ConditionExpression: "attribute_not_exists(pk)" } },
        ...spilled.map((i) => ({
          Put: {
            TableName: o.table,
            Item: { pk, sk: i.sk, body: i.body },
            ...(i.sk.startsWith("E#") ? { ConditionExpression: "attribute_not_exists(pk)" } : {}),
          },
        })),
      ];
      for (let attempt = 0; ; attempt++) {
        try {
          await send(new TransactWriteCommand({ TransactItems: tx }));
          return "ok";
        } catch (e) {
          const err = e as { name?: string; CancellationReasons?: { Code?: string }[] };
          if (err.name !== "TransactionCanceledException") throw e;
          const reasons = err.CancellationReasons ?? [];
          if (reasons[0]?.Code === "ConditionalCheckFailed") return "duplicate";
          const clash = reasons.findIndex((r, idx) => idx > 0 && r.Code === "ConditionalCheckFailed");
          if (clash > 0) throw new QueueConflict(spilled[clash - 1]!.sk);
          if (reasons.some((r) => r.Code === "TransactionConflict" || r.Code === "ThrottlingError") && attempt < 6) {
            await sleep(20 * 2 ** attempt * (0.5 + Math.random()));
            continue;
          }
          throw e;
        }
      }
    },
    async list(prefix, limit) {
      const r = await send<{ Items?: { sk: string; body: string }[] }>(
        new QueryCommand({
          TableName: o.table,
          KeyConditionExpression: "pk = :p AND begins_with(sk, :s)",
          ExpressionAttributeValues: { ":p": pk, ":s": prefix },
          Limit: limit,
          ConsistentRead: true,
        }),
      );
      return Promise.all((r.Items ?? []).map(async (i) => ({ sk: i.sk, body: await resolve(i.body) })));
    },
    async first(prefix) {
      return (await this.list(prefix, 1))[0] ?? null;
    },
    async get(sk) {
      const r = await send<{ Item?: { body: string } }>(new GetCommand({ TableName: o.table, Key: { pk, sk }, ConsistentRead: true }));
      return r.Item === undefined ? null : resolve(r.Item.body);
    },
    async put(sk, body) {
      await send(new PutCommand({ TableName: o.table, Item: { pk, sk, body: await stored(body) } }));
    },
    async delete(sk) {
      await send(new DeleteCommand({ TableName: o.table, Key: { pk, sk } }));
    },
    async cas(sk, expected, next) {
      try {
        await send(
          new PutCommand({
            TableName: o.table,
            Item: { pk, sk, body: next },
            ...(expected === null
              ? { ConditionExpression: "attribute_not_exists(pk)" }
              : { ConditionExpression: "#b = :e", ExpressionAttributeNames: { "#b": "body" }, ExpressionAttributeValues: { ":e": expected } }),
          }),
        );
        return true;
      } catch (e) {
        if ((e as { name?: string }).name === "ConditionalCheckFailedException") return false;
        throw e;
      }
    },
  };
}
