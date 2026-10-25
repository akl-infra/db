// Lane K's slice of the item model (src/store/ddb/contracts.ts `LaneSchema`,
// design/p2-p5-briefs.md): rows of these tables <-> their DynamoDB items.
import type { LaneSchema } from "../contracts";

export const discordSchema: LaneSchema = {
  lane: "K",
  tables: ["modqueue_notifications", "modqueue_delivery_gate", "discord_pending_actions", "discord_reopen_actions", "discord_deny_modals", "discord_reopen_confirmations", "discord_rejection_dm_outbox"],
  toItems() {
    throw new Error("schema/discord toItems is not implemented yet (P2 lane K)");
  },
  tableOf() {
    throw new Error("schema/discord tableOf is not implemented yet (P2 lane K)");
  },
  fromItems() {
    throw new Error("schema/discord fromItems is not implemented yet (P2 lane K)");
  },
};
