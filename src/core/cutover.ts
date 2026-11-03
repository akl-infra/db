// The dormant write freeze of a cutover (docs/technical-reference.md "Cutover modes"; LDB-CV1..CV9). The flag is `store.cutover.mode()`,
// D1 `import_state['cutover.mode']` cached 1 s per isolate. Absent (or any value but `read_only`) is `null` and changes nothing at all.
//   - `read_only`: every non-safe request gets `503 read_only` (`Retry-After: 30`), reads continue. Mounted right after the actor is
//     resolved, before idempotency and the rate limit, so a frozen write is neither replayed from nor charged to either. The Discord
//     interaction POST is gated too (it writes), and so are the scheduled jobs (`frozen`), the nightly dump included.
import type { MiddlewareHandler } from "hono";
import { SAFE_METHODS } from "../auth/actor";
import { type AppEnv, platformOf } from "../app";
import type { Store } from "../store/port";
import { readOnly } from "./errors";

/** True while a cutover owns the data: scheduled work must not write. */
export async function frozen(store: Pick<Store, "cutover">): Promise<boolean> {
  return (await store.cutover.mode()) !== null;
}

/** Mounted after actor resolution on `/v1/*`, and on the Discord interaction path. */
export function cutoverReadOnly(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (!SAFE_METHODS.has(c.req.method) && (await platformOf(c).store.cutover.mode()) === "read_only") throw readOnly();
    await next();
  };
}
