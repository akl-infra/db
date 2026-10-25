// DynamoDB `HoldStore` (src/store/port.ts). Owner: P2 lane G.
// P2 default: every hold is granted, exactly like D1. `{ realHolds: true }`
// builds the real budget (design/aws-port.md §3): one lease item
// `HOLD#<client>` and a per-UTC-day `ADD` on `RL#holds`, both in the
// ephemeral table and taken in one transaction.
import { DeleteCommand } from "@aws-sdk/lib-dynamodb";
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
  if (opts.realHolds !== true) {
    return {
      async takeHold() {
        return true;
      },
      async releaseHold() {},
    };
  }
  const budget = opts.dailyBudgetSeconds ?? 20_000;
  const lease = (clientId: string) => ({ pk: `HOLD#${clientId}`, sk: "LEASE" });
  return {
    async takeHold(clientId, seconds, now) {
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
                Item: { ...lease(clientId), expires, ttl: expires + 3600 },
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
    async releaseHold(clientId) {
      await withRetry(() => ctx.doc.send(new DeleteCommand({ TableName: ctx.tables.ephemeral, Key: lease(clientId) })));
    },
  };
}
