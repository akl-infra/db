// DynamoDB implementation of `ReviewStore` (src/store/port.ts). Owner: P2
// lane J (design/p2-p5-briefs.md). Reproduces src/store/d1/review.ts; the item
// model is src/store/ddb/community.ts.
import type { ReviewHistoryRow } from "../../core/moderation-review";
import type { ReviewStore } from "../port";
import { TxConditionFailed, type DdbContext } from "./contracts";
import { runEventTx } from "./tx";
import {
  commentGuardKey,
  commentPairKey,
  historyClaimKey,
  historyPrefix,
  outboxDueKey,
  outboxRowKey,
  wpmGuardKey,
  wpmPairKey,
  type SubmissionKind,
} from "./keys-community";
import {
  addHistory,
  batchGet,
  catCheck,
  decide,
  getItem,
  getRow,
  guard,
  moderationEvent,
  Plan,
  queryPartition,
  readCat,
  readHistory,
  readVer,
  RETRY,
  transition,
  type Cond,
  type Row,
} from "./community";

const BODY_PRESENT: Cond = { expr: "attribute_exists(#eb) AND NOT attribute_type(#eb, :enul)", names: { "#eb": "body" }, values: { ":enul": "NULL" } };

/** The other rows of a reopened row's (layout, user) pair, as (id, status, submitted_at). */
async function pairOthers(ctx: DdbContext, kind: "comment" | "wpm", row: Row): Promise<{ id: string; status: string; submitted_at: string }[]> {
  const layout = row.layout_id as string;
  const user = row.user_id as string;
  if (kind === "comment") {
    const items = await queryPartition(ctx, commentPairKey(layout, user, "", "").pk);
    return items.map((i) => ({ id: i.id as string, status: i.status as string, submitted_at: (i.sk as string).split("#")[0]! }));
  }
  const items = await queryPartition(ctx, wpmPairKey(layout, user, "", "").pk);
  return items.map((i) => ({ id: i.id as string, status: (i.sk as string).split("#")[0]!, submitted_at: i.submitted_at as string }));
}

/** Every delivery key a submission can have had so far: `<decision>:<kind>:<id>[:<review_version>]` for each cycle. */
function deliveryKeys(kind: string, id: string, reviewVersion: number): string[] {
  const out: string[] = [];
  for (let rv = 0; rv <= reviewVersion; rv++) {
    for (const decision of ["rejection", "approval"]) out.push(`${decision}:${kind}:${id}${rv === 0 ? "" : `:${rv}`}`);
  }
  return out;
}

export function ddbReviewStore(ctx: DdbContext): ReviewStore {
  return {
    async decisionState(kind, id) {
      const row = await getRow(ctx, kind, id);
      if (row === null) return null;
      return {
        status: row.status as string,
        decided_by: row.decided_by as string | null,
        decided_at: row.decided_at as string | null,
        reason: row.reason as string | null,
        review_version: row.review_version as number,
      };
    },

    async history(kind, id) {
      const k = historyPrefix(kind, id);
      const items = await queryPartition(ctx, k.pk, { prefix: k.sk });
      return items.map(
        (i): ReviewHistoryRow => ({
          action: i.action as ReviewHistoryRow["action"],
          actor: i.actor as string,
          at: i.at as string,
          reason: (i.reason as string | null) ?? null,
          review_version: i.review_version as number,
        }),
      );
    },

    async submissionLayout(kind, id) {
      const row = await getRow(ctx, kind, id);
      return row === null ? null : (row.layout_id as string);
    },

    async reopen(r) {
      const lost = { claimed: false, eventAppended: false };
      const { kind, id, expected, at } = r;
      return decide(async () => {
        const row = await getRow(ctx, kind, id);
        if (row === null || row.status !== expected.status || row.review_version !== expected.review_version) return lost;
        if (kind === "comment" && row.body === null) return lost;
        const layoutId = row.layout_id as string;
        const userId = row.user_id as string;
        const cat = await readCat(ctx, layoutId);
        if (cat === null || cat.deleted !== 0) return lost;
        // No newer row in the pair: nothing pending, nothing submitted later (ties by id).
        const newer = (await pairOthers(ctx, kind, row)).some(
          (o) => o.id !== id && (o.status === "pending" || o.submitted_at > (row.submitted_at as string) || (o.submitted_at === row.submitted_at && o.id > id)),
        );
        if (newer) return lost;

        const guardKey = kind === "comment" ? commentGuardKey(layoutId, userId) : wpmGuardKey(layoutId, userId);
        const ver = await readVer(ctx, guardKey);
        const st = await readHistory(ctx, kind, id);
        const keys = deliveryKeys(kind, id, row.review_version as number);
        const deliveries = (await batchGet(ctx, keys.map(outboxRowKey))).filter((d) => d.status === "pending" || d.status === "leased");

        try {
          await runEventTx(ctx, (b) => {
            const plan = new Plan(ctx);
            const hist = { ...st, claims: new Set(st.claims) };
            // Save an older decision's private reason before clearing the current row.
            if (row.decided_by !== null && row.decided_at !== null) {
              addHistory(
                plan,
                hist,
                { kind, submissionId: id, action: expected.status, actor: row.decided_by as string, at: row.decided_at as string, reason: row.reason as string | null, reviewVersion: row.review_version as number },
                true,
              );
            }
            transition(
              plan,
              kind,
              row,
              { ...row, status: "pending", review_version: (row.review_version as number) + 1, decided_by: null, decided_at: null, reason: null },
              "claim",
              kind === "comment" ? BODY_PRESENT : undefined,
            );
            guard(plan, "guard", guardKey, ver, 1);
            catCheck(plan, layoutId, cat, true);
            b.event(moderationEvent(at, r.event, cat));
            addHistory(plan, hist, r.history);
            // Expire the pending DM of every earlier cycle (`status IN ('pending', 'leased')`).
            for (const d of deliveries) {
              const key = d.delivery_key as string;
              plan.add(`expire:${key}`, {
                Update: {
                  TableName: ctx.tables.main,
                  Key: outboxRowKey(key),
                  UpdateExpression: "SET #st = :expired, lease_token = :nul, lease_until = :nul, updated_at = :at, last_error_class = :err",
                  ConditionExpression: "#st = :cs AND next_attempt_at = :na",
                  ExpressionAttributeNames: { "#st": "status" },
                  ExpressionAttributeValues: { ":expired": "expired", ":nul": null, ":at": at, ":err": "review_reopened", ":cs": d.status, ":na": d.next_attempt_at },
                },
              });
              plan.delete(`expire:${key}:due`, outboxDueKey(d.status as string, d.next_attempt_at as string, key));
            }
            for (const op of plan.finish()) b.item(op.tag, op.item);
          });
        } catch (e) {
          if (e instanceof TxConditionFailed) {
            if (e.tags.includes("claim")) return lost;
            if (e.tags.includes("cat")) {
              const again = await readCat(ctx, layoutId);
              if (again === null || again.deleted !== 0) return lost;
            }
            return RETRY;
          }
          throw e;
        }
        return { claimed: true, eventAppended: true };
      });
    },

    async reopenRecorded(r) {
      if (r.kind === "link") return false;
      const claim = await getItem(ctx, historyClaimKey(r.kind, r.id, r.reviewVersion, "reopened"));
      return claim !== null && claim.actor === r.actor;
    },

    async submissionDecision(kind: SubmissionKind, id) {
      const row = await getRow(ctx, kind, id);
      if (row === null) return null;
      return { status: row.status as string, decided_by: row.decided_by as string | null, review_version: kind === "link" ? 0 : (row.review_version as number) };
    },
  };
}
