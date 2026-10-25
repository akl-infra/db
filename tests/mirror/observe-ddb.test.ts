// [LDB-MIR12] The reverse direction's observed DynamoDB client (src/mirror/observe-ddb.ts): a committed TransactWrite
// that puts event items (pk `EV`) hands their seqs to the recorder, a refused one hands none, and every result and
// error passes through unchanged.
import { TransactWriteCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { describe, expect, it } from "vitest";
import { observeDdb } from "../../src/mirror/observe-ddb";
import { recordingStore } from "../../src/mirror/recorder";
import type { TeeCall } from "../../src/mirror/record";
import type { Store } from "../../src/store/port";

function tx(...items: Array<Record<string, unknown>>): TransactWriteCommand {
  return new TransactWriteCommand({ TransactItems: items.map((Item) => ({ Put: { TableName: "t", Item } })) });
}

describe("the observed DynamoDB client", () => {
  it("[LDB-MIR12] notes the seq of every committed EV put, none for a refused transaction, and changes nothing", async () => {
    const sent: unknown[] = [];
    let refuse = false;
    const fake = {
      region: "us-east-2",
      async send(cmd: unknown) {
        sent.push(cmd);
        if (refuse) throw Object.assign(new Error("cancelled"), { name: "TransactionCanceledException" });
        return { ok: sent.length };
      },
    };
    const observed = observeDdb(fake as unknown as DynamoDBDocumentClient);
    const calls: TeeCall[] = [];
    // A stand-in store: the recorder wraps `state.put` and the client call inside it is observed.
    const store = recordingStore(
      {
        state: {
          async put(key: string) {
            return (observed as unknown as { send(c: unknown): Promise<unknown> }).send(
              key === "events"
                ? tx({ pk: "EV", sk: "000000000041" }, { pk: "EVL#a", sk: "000000000041" }, { pk: "EV", sk: "000000000042" }, { pk: "L#a", sk: "META" })
                : tx({ pk: "L#a", sk: "META" }),
            );
          },
        },
      } as unknown as Store,
      (c) => calls.push(c),
    );
    await expect(store.state.put("events", "")).resolves.toEqual({ ok: 1 });
    await store.state.put("no-events", "");
    refuse = true;
    await expect(store.state.put("events", "")).rejects.toMatchObject({ name: "TransactionCanceledException" });
    expect(calls.map((c) => c.seqs)).toEqual([[41, 42], [], []]);
    expect(sent).toHaveLength(3);
    expect((observed as unknown as { region: string }).region).toBe("us-east-2");
  });
});
