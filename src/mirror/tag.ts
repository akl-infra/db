// The mark a tee-enabled D1 handle carries (src/mirror/tee-env.ts sets it, src/store/arg.ts reads it). A leaf
// module on purpose: src/store/arg.ts imports only this symbol, so the store layer never imports the recorder.
import type { Store } from "../store/port";

export const TEE_TAG: unique symbol = Symbol.for("akldb.tee") as never;

export interface TeeTag {
  /** `store` with its write methods recorded into this unit of work's sender. */
  wrap(store: Store): Store;
}
