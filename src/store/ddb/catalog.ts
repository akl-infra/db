// The catalog read model (src/store/ddb/contracts.ts `Catalog`, design §2.7).
// Owner: P2 lane H (design/p2-p5-briefs.md).
import { notImplemented } from "../d1/stub";
import type { Catalog, DdbContext } from "./contracts";

export function createCatalog(_ctx: Omit<DdbContext, "catalog">): Catalog {
  return notImplemented<Catalog>("H", "ddb/catalog");
}
