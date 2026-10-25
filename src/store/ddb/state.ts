// DynamoDB implementation of `StateStore` (src/store/port.ts): `import_state`
// as STATE/<key> items. Owner: P2 lane G.
import { DeleteCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { withRetry } from "./tx";
import type { StateStore } from "../port";
import type { DdbContext } from "./contracts";
import { consistentBatchGet, consistentGet, itemAt } from "./head";
import { stateKey } from "./keys";

export function ddbStateStore(ctx: DdbContext): StateStore {
  return {
    async get(key) {
      return (await consistentGet(ctx, stateKey(key)))?.value ?? null;
    },
    async getMany(keys) {
      const out = new Map<string, string>();
      if (keys.length === 0) return out;
      const got = await consistentBatchGet(ctx, [...new Set(keys)].map(stateKey));
      for (const k of keys) {
        const it = itemAt(got, stateKey(k));
        if (it !== undefined) out.set(k, it.value);
      }
      return out;
    },
    async put(key, value) {
      await withRetry(() => ctx.doc.send(new PutCommand({ TableName: ctx.tables.main, Item: { ...stateKey(key), key, value } })));
    },
    async delete(key) {
      await withRetry(() => ctx.doc.send(new DeleteCommand({ TableName: ctx.tables.main, Key: stateKey(key) })));
    },
  };
}
