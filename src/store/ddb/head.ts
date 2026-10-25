// DynamoDB implementation of `HeadStore` (src/store/port.ts). Owner: P2 lane G
// (design/p2-p5-briefs.md; design/aws-port.md §2.6).
import { BatchGetCommand, GetCommand, QueryCommand, type BatchGetCommandOutput, type QueryCommandOutput } from "@aws-sdk/lib-dynamodb";
import type { AuthorsHead, Head } from "../../core/etag";
import type { HeadStore } from "../port";
import type { DdbContext } from "./contracts";
import { HEAD_KEY, stateKey } from "./keys";

/** `authors_head` (lane I writes it; design §2.3 pins the key). */
const AUTHORS_HEAD_KEY = { pk: "META", sk: "AUTHORS" };

export async function consistentGet(ctx: DdbContext, key: { pk: string; sk: string }): Promise<Record<string, any> | undefined> {
  const r = await ctx.doc.send(new GetCommand({ TableName: ctx.tables.main, Key: key, ConsistentRead: true }));
  return r.Item;
}

/** One consistent BatchGetItem (or several, over 100 keys); returns items by `pk/sk`. */
export async function consistentBatchGet(ctx: DdbContext, keys: readonly { pk: string; sk: string }[]): Promise<Map<string, Record<string, any>>> {
  const out = new Map<string, Record<string, any>>();
  for (let i = 0; i < keys.length; i += 100) {
    let pending: { pk: string; sk: string }[] | undefined = keys.slice(i, i + 100).map((k) => ({ pk: k.pk, sk: k.sk }));
    while (pending !== undefined && pending.length > 0) {
      const r: BatchGetCommandOutput = await ctx.doc.send(
        new BatchGetCommand({ RequestItems: { [ctx.tables.main]: { Keys: pending, ConsistentRead: true } } }),
      );
      for (const it of r.Responses?.[ctx.tables.main] ?? []) out.set(`${it.pk}\u0000${it.sk}`, it);
      const un = r.UnprocessedKeys?.[ctx.tables.main]?.Keys as { pk: string; sk: string }[] | undefined;
      pending = un;
    }
  }
  return out;
}

export const itemAt = (m: Map<string, Record<string, any>>, k: { pk: string; sk: string }) => m.get(`${k.pk}\u0000${k.sk}`);

export function ddbHeadStore(ctx: DdbContext): HeadStore {
  return {
    // One consistent BatchGetItem of HEAD, authors_head and the state keys.
    async readHead(stateKeys: readonly string[] = [], deletesSinceIso?: string): Promise<Head> {
      const keys = [HEAD_KEY, AUTHORS_HEAD_KEY, ...stateKeys.map(stateKey)];
      const got = await consistentBatchGet(ctx, keys);
      let deletes24h = 0;
      if (deletesSinceIso !== undefined) {
        let start: Record<string, unknown> | undefined;
        do {
          const q: QueryCommandOutput = await ctx.doc.send(
            new QueryCommand({
              TableName: ctx.tables.main,
              KeyConditionExpression: "pk = :p",
              FilterExpression: "#at >= :s AND attribute_type(rev, :n)",
              ExpressionAttributeNames: { "#at": "at" },
              ExpressionAttributeValues: { ":p": "EVK#upstream_deleted", ":s": deletesSinceIso, ":n": "N" },
              Select: "COUNT",
              ConsistentRead: true,
              ExclusiveStartKey: start,
            }),
          );
          deletes24h += q.Count ?? 0;
          start = q.LastEvaluatedKey;
        } while (start !== undefined);
      }
      const ah = itemAt(got, AUTHORS_HEAD_KEY);
      return {
        seq: itemAt(got, HEAD_KEY)?.seq ?? 0,
        authors: { version: ah?.version ?? 0, modifiedAt: ah?.modified_at ?? null },
        state: stateKeys.map((k) => itemAt(got, stateKey(k))?.value ?? null),
        deletes24h,
      };
    },

    async headSeq() {
      return (await consistentGet(ctx, HEAD_KEY))?.seq ?? 0;
    },

    async authorsHead(): Promise<AuthorsHead> {
      const ah = await consistentGet(ctx, AUTHORS_HEAD_KEY);
      return { version: ah?.version ?? 0, modifiedAt: ah?.modified_at ?? null };
    },

    async metaCounts() {
      // HEAD first: the catalog is then at least as new as the counts it sits beside.
      const [head, authors] = await Promise.all([consistentGet(ctx, HEAD_KEY), consistentGet(ctx, AUTHORS_HEAD_KEY)]);
      const view = await ctx.catalog.current();
      let modified: string | null = null;
      for (const { layout } of view.layouts.values()) {
        if (!layout.deleted && (modified === null || layout.modified_at > modified)) modified = layout.modified_at;
      }
      return {
        layoutCount: head?.live ?? 0,
        layoutsModifiedAt: modified,
        authorCount: authors?.count ?? 0,
        revisionAt: head?.max_at ?? null,
      };
    },
  };
}
