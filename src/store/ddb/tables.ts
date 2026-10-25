// Table creation and deletion (design/aws-port.md §2.1): `pk`/`sk` strings,
// on-demand billing, no GSIs or LSIs, TTL on `ttl` for the ephemeral table.
// Used by the test harness, the dev server and (by name) the P4 template.
import {
  CreateTableCommand,
  DeleteTableCommand,
  DescribeTableCommand,
  UpdateTimeToLiveCommand,
} from "@aws-sdk/client-dynamodb";
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import type { DdbTables } from "./contracts";

// The document client shares the raw client's middleware stack, so raw
// commands go through it unchanged; its `send` is only typed for document commands.
type RawSend = (command: unknown) => Promise<any>;
const raw = (doc: DynamoDBDocumentClient): RawSend => doc.send.bind(doc) as unknown as RawSend;

function errName(e: unknown): string {
  return (e as { name?: string } | null)?.name ?? "";
}

async function createOne(send: RawSend, name: string, ttl: boolean): Promise<void> {
  try {
    await send(
      new CreateTableCommand({
        TableName: name,
        BillingMode: "PAY_PER_REQUEST",
        AttributeDefinitions: [
          { AttributeName: "pk", AttributeType: "S" },
          { AttributeName: "sk", AttributeType: "S" },
        ],
        KeySchema: [
          { AttributeName: "pk", KeyType: "HASH" },
          { AttributeName: "sk", KeyType: "RANGE" },
        ],
      }),
    );
  } catch (e) {
    if (errName(e) !== "ResourceInUseException") throw e;
  }
  for (;;) {
    const d = await send(new DescribeTableCommand({ TableName: name }));
    if (d.Table?.TableStatus === "ACTIVE") break;
    await new Promise((r) => setTimeout(r, 100));
  }
  if (ttl) {
    await send(
      new UpdateTimeToLiveCommand({ TableName: name, TimeToLiveSpecification: { AttributeName: "ttl", Enabled: true } }),
    ).catch((e) => {
      // Already enabled (a repeated createTables) is fine.
      if (!/already|ValidationException/i.test(`${errName(e)} ${(e as Error).message}`)) throw e;
    });
  }
}

export interface CreateTablesOptions {
  /** Enable TTL on the ephemeral table (default true). DynamoDB Local deletes expired items within a second, so test harnesses pass false; code must check expiry itself either way. */
  ttl?: boolean;
}

export async function createTables(doc: DynamoDBDocumentClient, tables: DdbTables, opts: CreateTablesOptions = {}): Promise<void> {
  const send = raw(doc);
  await createOne(send, tables.main, false);
  await createOne(send, tables.ephemeral, opts.ttl !== false);
}

export async function deleteTables(doc: DynamoDBDocumentClient, tables: DdbTables): Promise<void> {
  const send = raw(doc);
  for (const name of [tables.main, tables.ephemeral]) {
    try {
      await send(new DeleteTableCommand({ TableName: name }));
    } catch (e) {
      if (errName(e) !== "ResourceNotFoundException") throw e;
    }
  }
}
