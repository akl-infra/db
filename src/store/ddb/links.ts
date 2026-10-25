// DynamoDB implementation of `LinkStore` (src/store/port.ts). Owner: P2 lane J
// (design/p2-p5-briefs.md). Reproduces src/store/d1/links.ts statement by
// statement; the item model is src/store/ddb/community.ts.
import type { LinkQueueRow, LinkSubmissionRow } from "../../core/links";
import type { LinkStore } from "../port";
import { TxConditionFailed, type DdbContext } from "./contracts";
import { runEventTx, runTx } from "./tx";
import { linkGuardKey, linkLayoutKey, linkStatusKey } from "./keys-community";
import {
  authorNames,
  catCheck,
  decide,
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
  readVer,
  RETRY,
  transition,
  uniqueConflict,
  type Row,
} from "./community";

/** The pending submissions of a layout, newest first, as full rows. */
async function pendingRows(ctx: DdbContext, layoutId: string): Promise<Row[]> {
  const ix = await queryPartition(ctx, linkLayoutKey(layoutId, "pending", "", "").pk, { prefix: "pending#", forward: false });
  return getRows(ctx, "link", ix.map((i) => i.id as string));
}

/**
 * For lane G's `appendLinkChange` (approve / clear): the writes that settle the
 * link submissions of a layout inside the link event's transaction.
 * - `submissionId` given: claim that submission (pending -> approved, tag
 *   `link-claim`), then supersede every other pending one. Returns null when the
 *   submission is not pending (the D1 claim would have changed no row).
 * - `submissionId` absent (a clear): supersede every pending one.
 * The returned ops belong in the same `runEventTx` (as `b.item(tag, item)`),
 * together with their guard, which makes the set-based supersede safe (R5).
 */
export async function planLinkSettle(
  ctx: DdbContext,
  r: { layoutId: string; submissionId?: string; by: string; at: string },
): Promise<{ ops: { tag: string; item: import("./contracts").TxItem }[] } | null> {
  const plan = new Plan(ctx);
  const ver = await readVer(ctx, linkGuardKey(r.layoutId));
  const pending = await pendingRows(ctx, r.layoutId);
  if (r.submissionId !== undefined) {
    const claimed = await getRow(ctx, "link", r.submissionId);
    if (claimed === null || claimed.status !== "pending") return null;
    transition(plan, "link", claimed, { ...claimed, status: "approved", decided_by: r.by, decided_at: r.at }, "link-claim");
    for (const p of pending) {
      if (p.id === r.submissionId) continue;
      transition(plan, "link", p, { ...p, status: "superseded", decided_by: r.by, decided_at: r.at }, `link-superseded:${p.id}`);
    }
  } else {
    for (const p of pending) transition(plan, "link", p, { ...p, status: "superseded", decided_by: r.by, decided_at: r.at }, `link-superseded:${p.id}`);
  }
  guard(plan, "link-guard", linkGuardKey(r.layoutId), ver, 0);
  return { ops: await plan.finish() };
}

export function ddbLinkStore(ctx: DdbContext): LinkStore {
  return {
    async pending(layoutId) {
      const ix = await queryPartition(ctx, linkLayoutKey(layoutId, "pending", "", "").pk, { prefix: "pending#", forward: false, limit: 1 });
      if (ix.length === 0) return null;
      const row = await getRow(ctx, "link", ix[0]!.id as string);
      return row === null ? null : (publicRow("link", row) as unknown as LinkSubmissionRow);
    },

    async get(id) {
      const row = await getRow(ctx, "link", id);
      return row === null ? null : (publicRow("link", row) as unknown as LinkSubmissionRow);
    },

    async submit(r) {
      await decide(async () => {
        const plan = new Plan(ctx);
        const ver = await readVer(ctx, linkGuardKey(r.row.layout_id));
        if (r.supersedeId !== null) {
          const old = await getRow(ctx, "link", r.supersedeId);
          // `UPDATE ... WHERE id = ?`: unconditional on the status, a no-op on a missing row.
          if (old !== null) transition(plan, "link", old, { ...old, status: "superseded", decided_by: r.by, decided_at: r.at }, "supersede");
        }
        transition(
          plan,
          "link",
          null,
          { ...r.row, status: "pending", decided_by: null, decided_at: null, reason: null, notified_at: null },
          "insert",
        );
        guard(plan, "guard", linkGuardKey(r.row.layout_id), ver, 1);
        try {
          await runTx(ctx, await plan.finish());
        } catch (e) {
          if (e instanceof TxConditionFailed) {
            if (e.tags.includes("insert")) throw new Error("UNIQUE constraint failed: link_submissions.id");
            return RETRY;
          }
          throw e;
        }
        return undefined;
      });
    },

    async queue(status) {
      const ix = await queryPartition(ctx, linkStatusKey(status, "", "").pk);
      const rows = await getRows(ctx, "link", ix.map((i) => i.id as string));
      const byId = new Map(rows.map((x) => [x.id as string, x]));
      const ordered = ix.map((i) => byId.get(i.id as string)).filter((x): x is Row => x !== undefined);
      const [cats, names] = await Promise.all([
        readCats(ctx, ordered.map((x) => x.layout_id as string)),
        authorNames(ctx, ordered.map((x) => x.submitted_by as string)),
      ]);
      const out: LinkQueueRow[] = [];
      for (const x of ordered) {
        const cat = cats.get(x.layout_id as string);
        if (cat === undefined || cat.deleted !== 0) continue;
        out.push({
          ...(publicRow("link", x) as unknown as LinkSubmissionRow),
          layout_name: cat.name,
          submitter_name: names.get(x.submitted_by as string) ?? null,
        });
      }
      return out;
    },

    async reject(r) {
      return decide(async () => {
        const row = await getRow(ctx, "link", r.id);
        if (row === null || row.status !== "pending") return { claimed: false, eventAppended: false };
        const layoutId = row.layout_id as string;
        const cat = await readCat(ctx, layoutId);
        try {
          await runEventTx(ctx, async (b) => {
            const plan = new Plan(ctx);
            transition(plan, "link", row, { ...row, status: "rejected", decided_by: r.by, decided_at: r.at, reason: r.reason }, "claim");
            catCheck(plan, layoutId, cat, false);
            const seq = b.event(moderationEvent(r.at, r.event, cat));
            if (r.outbox !== undefined) outboxOps(plan, r.outbox, seq);
            for (const op of await plan.finish()) b.item(op.tag, op.item);
          });
        } catch (e) {
          if (e instanceof TxConditionFailed) {
            if (e.tags.includes("claim")) return { claimed: false, eventAppended: false };
            const dup = uniqueConflict(e);
            if (dup !== undefined) throw new Error(`UNIQUE constraint failed (${dup})`);
            return RETRY;
          }
          throw e;
        }
        return { claimed: true, eventAppended: true };
      });
    },
  };
}
