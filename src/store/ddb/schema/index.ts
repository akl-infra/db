// Every lane's slice of the item model; together they cover every
// `D1TableName` exactly once (tests/ddb/schema-coverage.test.ts, lane N).
// FROZEN with src/store/ddb/contracts.ts.
import type { LaneSchema } from "../contracts";
import { authSchema } from "./auth";
import { communitySchema } from "./community";
import { coreSchema } from "./core";
import { discordSchema } from "./discord";

export const SCHEMAS: readonly LaneSchema[] = [coreSchema, authSchema, communitySchema, discordSchema];
