// P1 transition helpers (design/aws-port.md §9, P1). While call sites move
// from `D1Database` to `Store` area by area, a core function takes
// `StoreArg` and converts at its top with `toStore()`; callers in other
// areas that still hold a `D1Database` keep compiling. P1 ended with every
// statement behind the port (LDB-W2); `StoreArg` stays until P2 retires the
// D1Database callers.
import type { Store } from "./port";
import { TEE_TAG, type TeeTag } from "../mirror/tag";
import { createD1Store } from "./d1";

export type StoreArg = Store | D1Database;

function isStore(arg: StoreArg): arg is Store {
  return typeof (arg as Partial<Store>).events === "object" && typeof (arg as { prepare?: unknown }).prepare !== "function";
}

/** The port for `arg`: as is if it already is one, else the D1 implementation over it. */
export function toStore(arg: StoreArg): Store {
  if (isStore(arg)) return arg;
  const store = createD1Store(arg);
  // The production mirror (design/aws-port.md §5.2): a handle from src/mirror/tee-env.ts carries a tag that records
  // the store's writes. Untagged (TEE_URL unset), this is exactly `createD1Store(arg)`.
  const tag = (arg as unknown as Record<symbol, TeeTag | undefined>)[TEE_TAG];
  return tag === undefined ? store : tag.wrap(store);
}
