// P1 transition helpers (design/aws-port.md §9, P1). While call sites move
// from `D1Database` to `Store` area by area, a core function takes
// `StoreArg` and converts at its top with `toStore()`; callers in other
// areas that still hold a `D1Database` keep compiling. `legacyD1()` lets an
// already-converted function call one that still wants the raw database.
// P1's gate: no `StoreArg` and no `legacyD1` left anywhere under src/.
import type { Store } from "./port";
import { createD1Store, d1HandleOf } from "./d1";

export type StoreArg = Store | D1Database;

function isStore(arg: StoreArg): arg is Store {
  return typeof (arg as Partial<Store>).events === "object" && typeof (arg as { prepare?: unknown }).prepare !== "function";
}

/** The port for `arg`: as is if it already is one, else the D1 implementation over it. */
export function toStore(arg: StoreArg): Store {
  return isStore(arg) ? arg : createD1Store(arg);
}

/** The raw D1 database behind `arg`. Throws for a store that is not D1-backed. */
export function legacyD1(arg: StoreArg): D1Database {
  if (!isStore(arg)) return arg;
  const db = d1HandleOf(arg);
  if (db === undefined) throw new Error("legacyD1: this store is not backed by D1");
  return db;
}
