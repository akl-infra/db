// Bounded, consistent reads of the event partitions (design/aws-port.md §2.4
// "No gaps on read"): callers read HEAD = h first and pass it as `hi`, so
// every event they can see was committed before the query began.
import { QueryCommand, type QueryCommandOutput } from "@aws-sdk/lib-dynamodb";
import { withRetry } from "./tx";
import type { Item } from "./contracts";
import type { DdbContext } from "./contracts";
import { padSeq } from "./keys";
import { consistentGet } from "./head";
import { HEAD_KEY } from "./keys";

export async function readHeadSeq(ctx: DdbContext): Promise<number> {
  return ((await consistentGet(ctx, HEAD_KEY))?.seq as number | undefined) ?? 0;
}

export interface EventQuery {
  /** `EV`, `EVL#<layout>`, `EVK#<kind>` or `EVA#<actor>`. */
  pk: string;
  /** First seq (inclusive). */
  lo: number;
  /** Last seq (inclusive): HEAD as read before the query. */
  hi: number;
  desc?: boolean;
  /** Server-side filter over the event attributes. */
  filter?: { expr: string; names?: Record<string, string>; values?: Record<string, unknown> };
  /** Items evaluated per request (before the filter). */
  pageSize?: number;
}

/** Items in key order, fetched page by page; stop iterating to stop reading. */
export async function* scanEvents(ctx: DdbContext, q: EventQuery): AsyncGenerator<Item> {
  if (q.hi < q.lo) return;
  let start: Record<string, unknown> | undefined;
  do {
    const r: QueryCommandOutput = await withRetry(() => ctx.doc.send(
      new QueryCommand({
        TableName: ctx.tables.main,
        KeyConditionExpression: "pk = :pk AND sk BETWEEN :lo AND :hi",
        ...(q.filter === undefined ? {} : { FilterExpression: q.filter.expr }),
        ExpressionAttributeNames: q.filter?.names,
        ExpressionAttributeValues: { ":pk": q.pk, ":lo": padSeq(q.lo), ":hi": padSeq(q.hi), ...q.filter?.values },
        ScanIndexForward: q.desc !== true,
        ConsistentRead: true,
        Limit: q.pageSize ?? 100,
        ExclusiveStartKey: start,
      }),
    ));
    for (const it of r.Items ?? []) yield it;
    start = r.LastEvaluatedKey;
  } while (start !== undefined);
}

export async function collectEvents(ctx: DdbContext, q: EventQuery, max = Infinity): Promise<Item[]> {
  const out: Item[] = [];
  if (max <= 0) return out;
  for await (const it of scanEvents(ctx, q)) {
    out.push(it);
    if (out.length >= max) break;
  }
  return out;
}
