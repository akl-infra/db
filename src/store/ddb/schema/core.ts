// Lane G's slice of the item model (src/store/ddb/contracts.ts `LaneSchema`,
// design/p2-p5-briefs.md): rows of these tables <-> their DynamoDB items.
import type { LaneSchema } from "../contracts";

export const coreSchema: LaneSchema = {
  lane: "G",
  tables: ["layouts", "layout_formats", "layout_revs", "likes", "events", "layouts_head", "import_state", "import_map"],
  toItems() {
    throw new Error("schema/core toItems is not implemented yet (P2 lane G)");
  },
  tableOf() {
    throw new Error("schema/core tableOf is not implemented yet (P2 lane G)");
  },
  fromItems() {
    throw new Error("schema/core fromItems is not implemented yet (P2 lane G)");
  },
};
