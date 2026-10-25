// Lane J's slice of the item model (src/store/ddb/contracts.ts `LaneSchema`,
// design/p2-p5-briefs.md): rows of these tables <-> their DynamoDB items.
import type { LaneSchema } from "../contracts";

export const communitySchema: LaneSchema = {
  lane: "J",
  tables: ["link_submissions", "wpm_submissions", "layout_comments", "comment_likes", "moderation_review_history"],
  toItems() {
    throw new Error("schema/community toItems is not implemented yet (P2 lane J)");
  },
  tableOf() {
    throw new Error("schema/community tableOf is not implemented yet (P2 lane J)");
  },
  fromItems() {
    throw new Error("schema/community fromItems is not implemented yet (P2 lane J)");
  },
};
