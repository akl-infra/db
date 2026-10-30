// DynamoDB `HoldStore` (src/store/port.ts). Owner: P2 lane G.
// Real since lane U (LDB-CUT1..CUT5), matching the D1 store: `{ realHolds: false }`
// grants every hold (tests). The budget (design/aws-port.md §3) is one lease item
// `HOLD#<client>` and a per-UTC-day `ADD` on `RL#holds`, both in the
// ephemeral table and taken in one transaction.
import { DeleteCommand, GetCommand } from "@aws-sdk/lib-dynamodb";
import type { HoldStore } from "../port";
import { TxConditionFailed, type DdbContext } from "./contracts";
import { runTx, withRetry } from "./tx";

export interface HoldOptions {
  realHolds?: boolean;
  /** Hold-seconds per UTC day (design §3 default). */
  dailyBudgetSeconds?: number;
}

const LEASE_SLACK_SECONDS = 5;

export function ddbHoldStore(ctx: DdbContext, opts: HoldOptions = {}): HoldStore {
  if (opts.realHolds === false) {
    return {
      async takeHold() {
        return true;
      },
      async releaseHold() {},
    };
  }
  const defaultBudget = opts.dailyBudgetSeconds ?? 20_000;
  const lease = (clientId: string) => ({ pk: `HOLD#${clientId}`, sk: "LEASE" });
  return {
    async takeHold(clientId, seconds, now, budgetSeconds) {
      const budget = budgetSeconds ?? defaultBudget;
      const nowMs = Date.parse(now());
      const nowS = Math.floor(nowMs / 1000);
      const day = new Date(nowMs).toISOString().slice(0, 10);
      const s = Math.ceil(seconds);
      const expires = nowS + s + LEASE_SLACK_SECONDS;
      try {
        await runTx(ctx, [
          {
            tag: "lease",
            item: {
              Put: {
                TableName: ctx.tables.ephemeral,
                Item: { ...lease(clientId), expires, ttl: expires + 3600, s, day },
                ConditionExpression: "attribute_not_exists(pk) OR expires < :now",
                ExpressionAttributeValues: { ":now": nowS },
              },
            },
          },
          {
            tag: "budget",
            item: {
              Update: {
                TableName: ctx.tables.ephemeral,
                Key: { pk: "RL#holds", sk: day },
                UpdateExpression: "ADD n :s SET #ttl = :ttl",
                ConditionExpression: "attribute_not_exists(n) OR n <= :room",
                ExpressionAttributeNames: { "#ttl": "ttl" },
                ExpressionAttributeValues: { ":s": s, ":room": budget - s, ":ttl": nowS + 3 * 86400 },
              },
            },
          },
        ]);
        return true;
      } catch (e) {
        if (e instanceof TxConditionFailed) return false;
        throw e;
      }
    },
    async releaseHold(clientId, heldSeconds) {
      // Refund the reservation's unused seconds to the day it was taken from, and drop the lease, in one transaction.
      const got = await withRetry(() => ctx.doc.send(new GetCommand({ TableName: ctx.tables.ephemeral, Key: lease(clientId), ConsistentRead: true })));
      const item = got.Item as { s?: number; day?: string } | undefined;
      const refund = item?.s !== undefined && item.day !== undefined ? Math.max(0, item.s - Math.max(0, Math.ceil(heldSeconds))) : 0;
      if (refund > 0) {
        try {
          await runTx(ctx, [
            { tag: "lease", item: { Delete: { TableName: ctx.tables.ephemeral, Key: lease(clientId), ConditionExpression: "attribute_exists(pk)" } } },
            {
              tag: "refund",
              item: {
                Update: {
                  TableName: ctx.tables.ephemeral,
                  Key: { pk: "RL#holds", sk: item!.day! },
                  UpdateExpression: "ADD n :r",
                  ConditionExpression: "n >= :refund",
                  ExpressionAttributeValues: { ":r": -refund, ":refund": refund },
                },
              },
            },
          ]);
          return;
        } catch (e) {
          if (!(e instanceof TxConditionFailed)) throw e;
        }
      }
      await withRetry(() => ctx.doc.send(new DeleteCommand({ TableName: ctx.tables.ephemeral, Key: lease(clientId) })));
    },
  };
}
