// A no-op data migration: sets `schema_version` on the migrations bookkeeping
// item. It changes no row and no derived item, so a rollout that runs it
// proves the migration machinery (design/aws-port.md G6) without touching
// data. Idempotent: running it twice leaves the same item.
import { UpdateCommand } from "@aws-sdk/lib-dynamodb";
import type { DdbMigration } from "../src/store/ddb/migrate";

export const migration: DdbMigration = {
  id: "0001_noop_version_bump",
  description: "Set STATE/migrations.schema_version to 1 (touches no row).",
  async up(ctx) {
    await ctx.doc.send(
      new UpdateCommand({
        TableName: ctx.tables.main,
        Key: { pk: "STATE", sk: "migrations" }, // = MIGRATIONS_KEY; not imported, so migrate.ts and this file stay acyclic
        UpdateExpression: "SET schema_version = :v",
        ExpressionAttributeValues: { ":v": 1 },
      }),
    );
  },
};
