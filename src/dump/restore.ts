// restoreInto(db, dump) (07 §6 S7): loads a dump (`dump/write.ts`) into an
// empty database through the port's `DumpStore.restore`. The SQL renderer,
// `restoreSql`, lives with the D1 store (store/d1/dump.ts) and is
// re-exported here for its existing callers. Test-only in phase 1
// (`tests/rehost.test.ts`); `scripts/rehost.mjs` imports `restoreSql` from
// store/d1/dump.ts directly and runs it with `wrangler d1 execute --file`,
// so a real rehost never depends on Worker code running at all.
import type { Dump } from "./write";
import type { StoreArg } from "../store/arg";

export { restoreSql } from "../store/d1/dump";

export async function restoreInto(dbArg: StoreArg, dump: Dump): Promise<void> {
  const { toStore } = await import("../store/arg");
  await toStore(dbArg).dump.restore(dump);
}
