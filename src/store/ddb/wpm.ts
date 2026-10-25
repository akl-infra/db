// DynamoDB implementation of `WpmStore` (src/store/port.ts). Owner: P2 lane J
// (design/p2-p5-briefs.md). Reproduces src/store/d1/wpm.ts statement by
// statement; the item model is src/store/ddb/community.ts.
import type { WpmQueueRow, WpmRecord, WpmSubmissionRow } from "../../core/wpm";
import type { WpmStore } from "../port";
import { TxConditionFailed, type DdbContext } from "./contracts";
import { runEventTx, runTx } from "./tx";
import { mqnDirtyKey, wpmGuardKey, wpmOkKey, wpmPairKey, wpmStatusKey, subKey } from "./keys-community";
import {
  addHistory,
  authorNames,
  catCheck,
  compareBinary,
  decide,
  getItem,
  getRow,
  getRows,
  guard,
  moderationEvent,
  outboxOps,
  Plan,
  publicRow,
  queryPartition,
  readCat,
  readCats,
  readHistory,
  readVer,
  RETRY,
  transition,
  uniqueConflict,
  type Row,
} from "./community";

const pub = (row: Row): WpmSubmissionRow => publicRow("wpm", row) as unknown as WpmSubmissionRow;

export function ddbWpmStore(ctx: DdbContext): WpmStore {
  /** `approve` and `reject` differ in the layout rule (approve needs a live layout) and the claim's target status. */
  async function decideRow(
    r: {
      id: string;
      by: string;
      at: string;
      reviewVersion: number;
      event: Parameters<typeof moderationEvent>[1];
      outbox?: Parameters<typeof outboxOps>[1];
      history: Parameters<typeof addHistory>[2];
    },
    target: "approved" | "rejected",
    reason: string | null,
  ): Promise<{ claimed: boolean; eventAppended: boolean }> {
    const lost = { claimed: false, eventAppended: false };
    return decide(async () => {
      const row = await getRow(ctx, "wpm", r.id);
      if (row === null || row.status !== "pending" || row.review_version !== r.reviewVersion) return lost;
      const layoutId = row.layout_id as string;
      const cat = await readCat(ctx, layoutId);
      if (target === "approved" && (cat === null || cat.deleted !== 0)) return lost;
      const st = await readHistory(ctx, "wpm", r.id);
      try {
        await runEventTx(ctx, (b) => {
          const plan = new Plan(ctx);
          transition(plan, "wpm", row, { ...row, status: target, decided_by: r.by, decided_at: r.at, reason }, "claim");
          catCheck(plan, layoutId, cat, target === "approved");
          const seq = b.event(moderationEvent(r.at, r.event, cat));
          if (r.outbox !== undefined) outboxOps(plan, r.outbox, seq);
          addHistory(plan, { ...st, claims: new Set(st.claims) }, r.history);
          for (const op of plan.finish()) b.item(op.tag, op.item);
        });
      } catch (e) {
        if (e instanceof TxConditionFailed) {
          if (e.tags.includes("claim")) return lost;
          if (e.tags.includes("cat") && target === "approved") {
            const again = await readCat(ctx, layoutId);
            if (again === null || again.deleted !== 0) return lost;
          }
          const dup = e.tags.find((t) => t.startsWith("outbox:"));
          if (dup !== undefined) throw new Error(`UNIQUE constraint failed (${uniqueConflict(e)})`);
          return RETRY;
        }
        throw e;
      }
      return { claimed: true, eventAppended: true };
    });
  }

  return {
    async get(id) {
      const row = await getRow(ctx, "wpm", id);
      return row === null ? null : pub(row);
    },

    async bindSourceMessage(r) {
      const names: Record<string, string> = { "#u": "source_message_url" };
      const values: Record<string, unknown> = { ":url": r.url, ":nul": "NULL" };
      let cond = "attribute_exists(pk) AND (attribute_not_exists(#u) OR attribute_type(#u, :nul))";
      if (!r.admin) {
        names["#sb"] = "submitted_by";
        values[":actor"] = r.actorId;
        cond += " AND #sb = :actor";
      }
      try {
        await runTx(ctx, [
          {
            tag: "bind",
            item: {
              Update: {
                TableName: ctx.tables.main,
                Key: subKey("wpm", r.id),
                UpdateExpression: "SET #u = :url",
                ConditionExpression: cond,
                ExpressionAttributeNames: names,
                ExpressionAttributeValues: values,
              },
            },
          },
          { tag: "mqn", item: { Put: { TableName: ctx.tables.main, Item: { ...mqnDirtyKey("wpm", r.id), kind: "wpm", submission_id: r.id } } } },
        ]);
        return true;
      } catch (e) {
        if (e instanceof TxConditionFailed) return false;
        throw e;
      }
    },

    async sourceMessage(r) {
      const it = await getItem(ctx, subKey("wpm", r.id));
      if (it === null) return null;
      if (!r.admin && it.submitted_by !== r.actorId) return null;
      return { source_message_url: (it.source_message_url as string | null | undefined) ?? null };
    },

    async insertApproved(r) {
      const row = { ...r.row, status: "approved", reason: null, review_version: 0, notified_at: null, source_message_url: null };
      const layoutId = row.layout_id as string;
      const userId = row.user_id as string;
      await decide(async () => {
        const ver = await readVer(ctx, wpmGuardKey(layoutId, userId));
        const cat = await readCat(ctx, layoutId);
        const st = await readHistory(ctx, "wpm", row.id);
        try {
          await runEventTx(ctx, (b) => {
            const plan = new Plan(ctx);
            transition(plan, "wpm", null, row, "insert");
            guard(plan, "guard", wpmGuardKey(layoutId, userId), ver, 1);
            catCheck(plan, layoutId, cat, false);
            b.event(moderationEvent(r.history.at, r.event, cat));
            addHistory(plan, { ...st, claims: new Set(st.claims) }, r.history);
            for (const op of plan.finish()) b.item(op.tag, op.item);
          });
        } catch (e) {
          if (e instanceof TxConditionFailed) {
            if (e.tags.includes("insert")) throw new Error("UNIQUE constraint failed: wpm_submissions.id");
            return RETRY;
          }
          throw e;
        }
        return undefined;
      });
    },

    async submit(r) {
      const layoutId = r.row.layout_id;
      const userId = r.row.user_id;
      await decide(async () => {
        const ver = await readVer(ctx, wpmGuardKey(layoutId, userId));
        const pendingIx = await queryPartition(ctx, wpmPairKey(layoutId, userId, "pending", "").pk, { prefix: "pending#" });
        const pending = await getRows(ctx, "wpm", pendingIx.map((i) => i.id as string));
        const plan = new Plan(ctx);
        for (const p of pending) transition(plan, "wpm", p, { ...p, status: "superseded", decided_by: r.by, decided_at: r.at }, `supersede:${p.id}`);
        transition(
          plan,
          "wpm",
          null,
          { ...r.row, status: "pending", decided_by: null, decided_at: null, reason: null, review_version: 0, notified_at: null, source_message_url: null },
          "insert",
        );
        guard(plan, "guard", wpmGuardKey(layoutId, userId), ver, 1);
        try {
          await runTx(ctx, plan.finish());
        } catch (e) {
          if (e instanceof TxConditionFailed) {
            if (e.tags.includes("insert")) throw new Error("UNIQUE constraint failed: wpm_submissions.id");
            return RETRY;
          }
          throw e;
        }
        return undefined;
      });
    },

    async queue(status) {
      const ix = await queryPartition(ctx, wpmStatusKey(status, "", "").pk);
      const rows = await getRows(ctx, "wpm", ix.map((i) => i.id as string));
      const byId = new Map(rows.map((x) => [x.id as string, x]));
      const ordered = ix.map((i) => byId.get(i.id as string)).filter((x): x is Row => x !== undefined);
      const [cats, names] = await Promise.all([
        readCats(ctx, ordered.map((x) => x.layout_id as string)),
        authorNames(ctx, ordered.map((x) => x.user_id as string)),
      ]);
      const out: WpmQueueRow[] = [];
      for (const x of ordered) {
        const cat = cats.get(x.layout_id as string);
        if (cat === undefined || cat.deleted !== 0) continue;
        out.push({ ...pub(x), layout_name: cat.name, user_name: names.get(x.user_id as string) ?? null });
      }
      return out;
    },

    approve: (r) => decideRow(r, "approved", null),

    reject: (r) => decideRow(r, "rejected", r.reason),

    async records(filter) {
      const ix = await queryPartition(ctx, wpmOkKey("", "", "").pk, filter.layoutId === undefined ? {} : { prefix: `${filter.layoutId}#` });
      const best = new Map<string, (typeof ix)[number]>();
      for (const i of ix) {
        if (filter.userId !== undefined && i.user_id !== filter.userId) continue;
        const key = `${i.layout_id}\u0000${i.user_id}`;
        const cur = best.get(key);
        if (cur === undefined || beats(i, cur)) best.set(key, i);
      }
      const winners = [...best.values()];
      const [cats, names] = await Promise.all([
        readCats(ctx, winners.map((w) => w.layout_id as string)),
        authorNames(ctx, winners.map((w) => w.user_id as string)),
      ]);
      const out: WpmRecord[] = [];
      for (const w of winners) {
        const cat = cats.get(w.layout_id as string);
        if (cat === undefined || cat.deleted !== 0) continue;
        out.push({
          layout_id: w.layout_id as string,
          layout_name: cat.name,
          user_id: w.user_id as string,
          user_name: names.get(w.user_id as string) ?? null,
          wpm: w.wpm as number,
          proof: w.proof as string,
          approved_at: w.decided_at as string,
          submission_id: w.id as string,
        });
      }
      out.sort((a, b) => b.wpm - a.wpm || compareBinary(a.approved_at, b.approved_at) || compareBinary(a.submission_id, b.submission_id));
      return out;
    },
  };
}

/** `wpm DESC, decided_at ASC, id ASC`: does `a` beat `b` as a pair's best approved row? */
function beats(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  if (a.wpm !== b.wpm) return (a.wpm as number) > (b.wpm as number);
  const c = compareBinary(a.decided_at as string, b.decided_at as string);
  if (c !== 0) return c < 0;
  return compareBinary(a.id as string, b.id as string) < 0;
}
