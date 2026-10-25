// Numbered, idempotent data migrations for the DynamoDB store
// (migrations-ddb/NNNN_*.ts), recorded in the bookkeeping item
// `STATE/migrations` as `applied: { <id>: <iso time> }`. DynamoDB has no
// schema, so a migration is a data change: every one must be safe to run
// twice (two Lambdas may race to apply it), and additive -- it never deletes.
import { GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import type { CodecContext } from "./codec";
import { MIGRATIONS } from "../../../migrations-ddb";

export interface DdbMigration {
  /** `NNNN_snake_case`, the file name without `.ts`. */
  readonly id: string;
  readonly description: string;
  /** Idempotent. Gets the same context as the codec: the client, the tables and the blob store. */
  up(ctx: CodecContext): Promise<void>;
}

export const MIGRATIONS_KEY = { pk: "STATE", sk: "migrations" } as const;

const ID = /^\d{4}_[a-z0-9_]+$/;

/** Ids are `NNNN_name`, unique and strictly ascending. */
export function validateMigrations(list: readonly DdbMigration[]): void {
  let prev = "";
  for (const m of list) {
    if (!ID.test(m.id)) throw new Error(`migration id '${m.id}' is not NNNN_snake_case`);
    if (m.id <= prev) throw new Error(`migration '${m.id}' is not after '${prev}'`);
    prev = m.id;
  }
}

export async function appliedMigrations(ctx: CodecContext): Promise<Record<string, string>> {
  const r = await ctx.doc.send(new GetCommand({ TableName: ctx.tables.main, Key: MIGRATIONS_KEY, ConsistentRead: true }));
  return { ...((r.Item?.applied as Record<string, string> | undefined) ?? {}) };
}

export interface MigrateResult {
  ran: string[];
  skipped: string[];
}

/** Applies, in order, every migration not yet recorded. A migration that throws stops the run and is not recorded. */
export async function runMigrations(
  ctx: CodecContext,
  list: readonly DdbMigration[] = MIGRATIONS,
  now: () => string = () => new Date().toISOString(),
): Promise<MigrateResult> {
  validateMigrations(list);
  const applied = await appliedMigrations(ctx);
  const result: MigrateResult = { ran: [], skipped: [] };
  for (const m of list) {
    if (applied[m.id] !== undefined) {
      result.skipped.push(m.id);
      continue;
    }
    await m.up(ctx);
    await record(ctx, m.id, now());
    result.ran.push(m.id);
  }
  return result;
}

async function record(ctx: CodecContext, id: string, at: string): Promise<void> {
  // The map must exist before a nested SET can name a key in it.
  await ctx.doc.send(
    new UpdateCommand({
      TableName: ctx.tables.main,
      Key: MIGRATIONS_KEY,
      UpdateExpression: "SET applied = if_not_exists(applied, :empty)",
      ExpressionAttributeValues: { ":empty": {} },
    }),
  );
  try {
    await ctx.doc.send(
      new UpdateCommand({
        TableName: ctx.tables.main,
        Key: MIGRATIONS_KEY,
        UpdateExpression: "SET applied.#id = :at",
        ConditionExpression: "attribute_not_exists(applied.#id)",
        ExpressionAttributeNames: { "#id": id },
        ExpressionAttributeValues: { ":at": at },
      }),
    );
  } catch (e) {
    // Another runner recorded it first; the first record stands.
    if ((e as { name?: string }).name !== "ConditionalCheckFailedException") throw e;
  }
}
