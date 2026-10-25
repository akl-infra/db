// An observed DynamoDB document client (design/aws-port.md §5.2, the reverse direction): the same client, plus a
// note of every event item (pk `EV`) a committed TransactWrite put. It issues no extra request and changes no result.
// Events only ever commit through TransactWriteItems (runEventTx), so nothing else is watched.
import { TransactWriteCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { noteSeq } from "./recorder";

export function observeDdb(client: DynamoDBDocumentClient): DynamoDBDocumentClient {
  return new Proxy(client, {
    get(target, prop) {
      const v = Reflect.get(target, prop, target) as unknown;
      if (prop !== "send") return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
      return async (command: unknown, ...rest: unknown[]) => {
        const out = await (v as (c: unknown, ...r: unknown[]) => Promise<unknown>).call(target, command, ...rest);
        if (command instanceof TransactWriteCommand) {
          for (const it of command.input.TransactItems ?? []) {
            const item = it.Put?.Item as Record<string, unknown> | undefined;
            if (item?.pk !== "EV" || typeof item.sk !== "string") continue;
            const seq = Number(item.sk);
            if (Number.isSafeInteger(seq) && seq > 0) noteSeq(seq);
          }
        }
        return out;
      };
    },
  });
}
