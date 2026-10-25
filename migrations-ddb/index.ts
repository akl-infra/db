// The ordered list of DynamoDB data migrations. Add a file `NNNN_name.ts`
// exporting `migration`, then list it here (tests/ddb/migrate.test.ts fails
// when a file and this list disagree). Additive only: no deletes, no key
// rewrites that drop data (the DynamoDB twin of tests/tools/migrations-additive.test.ts).
import type { DdbMigration } from "../src/store/ddb/migrate";
import { migration as m0001 } from "./0001_noop_version_bump";

export const MIGRATIONS: readonly DdbMigration[] = [m0001];
