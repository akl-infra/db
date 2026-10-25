// Lane I's slice of the item model (src/store/ddb/contracts.ts `LaneSchema`,
// design/p2-p5-briefs.md): rows of these tables <-> their DynamoDB items.
import type { LaneSchema } from "../contracts";

export const authSchema: LaneSchema = {
  lane: "I",
  tables: ["authors", "authors_head", "admins", "bans", "clients", "nonces", "auth_cache", "ratelimit", "idempotency"],
  toItems() {
    throw new Error("schema/auth toItems is not implemented yet (P2 lane I)");
  },
  tableOf() {
    throw new Error("schema/auth tableOf is not implemented yet (P2 lane I)");
  },
  fromItems() {
    throw new Error("schema/auth fromItems is not implemented yet (P2 lane I)");
  },
};
