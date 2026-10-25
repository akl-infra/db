// DynamoDB implementation of `CommentStore` (src/store/port.ts). Owner: P2
// lane J (design/p2-p5-briefs.md). Reproduces src/store/d1/comments.ts
// statement by statement; the item model is src/store/ddb/community.ts.
import type { CommentQueueRow, CommentRow, PublicCommentCount } from "../../core/comments";
import type { CommentStore, PublicCommentDbRow } from "../port";
import { TxConditionFailed, type DdbContext, type Item } from "./contracts";
import { runEventTx, runTx } from "./tx";
import {
  commentCountKey,
  commentGuardKey,
  commentLikeByAuthorKey,
  commentLikeGuardKey,
  commentLikeKey,
  commentLikesOfSlotPrefix,
  commentOkKey,
  commentPairKey,
  commentStatusKey,
  commentUserKey,
  subKey,
} from "./keys-community";
import {
  addHistory,
  authorNames,
  catCheck,
  compareBinary,
  compareNocase,
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
  type Cond,
  type Row,
} from "./community";

const pub = (row: Row): CommentRow => publicRow("comment", row) as unknown as CommentRow;

/** `body IS NOT NULL` as a condition on the row item. */
const BODY_PRESENT: Cond = { expr: "attribute_exists(#eb) AND NOT attribute_type(#eb, :enul)", names: { "#eb": "body" }, values: { ":enul": "NULL" } };

/** The index items of one (layout, user) pair, in submitted_at, id order: id, status, decided_at, has_body. */
function pairItems(ctx: DdbContext, layoutId: string, userId: string): Promise<Item[]> {
  return queryPartition(ctx, commentPairKey(layoutId, userId, "", "").pk);
}

function slotLikes(ctx: DdbContext, layoutId: string, authorId: string): Promise<Item[]> {
  const k = commentLikesOfSlotPrefix(layoutId, authorId);
  return queryPartition(ctx, k.pk, { prefix: k.sk });
}

/**
 * Delete up to what fits of a slot's likes (primary and mirror each, existence
 * conditioned so a concurrent unlike retries the whole decision) and move the
 * slot guard. Returns the likes left over, for `purgeLikeTail`.
 */
function clearLikes(plan: Plan, layoutId: string, authorId: string, likes: readonly Item[], likeVer: number): Item[] {
  const room = 95 - plan.ops.length - 3;
  const k = Math.min(likes.length, Math.max(0, Math.floor((room - 1) / 2)));
  const exists: Cond = { expr: "attribute_exists(pk)" };
  for (const l of likes.slice(0, k)) {
    plan.delete("like", commentLikeKey(layoutId, authorId, l.user_id as string), exists);
    plan.delete("like", commentLikeByAuthorKey(authorId, layoutId, l.user_id as string), exists);
  }
  if (likes.length > 0 || likeVer > 0) guard(plan, "likeguard", commentLikeGuardKey(layoutId, authorId), likeVer, -k);
  return likes.slice(k);
}

/** Likes beyond one transaction's room go in follow-up transactions, only while the slot is still empty. */
async function purgeLikeTail(ctx: DdbContext, layoutId: string, authorId: string): Promise<void> {
  for (let i = 0; i < 100; i++) {
    const slot = (await queryPartition(ctx, commentOkKey(layoutId, "", "").pk)).some((x) => x.user_id === authorId);
    if (slot) return;
    const likeVer = await readVer(ctx, commentLikeGuardKey(layoutId, authorId));
    const likes = await slotLikes(ctx, layoutId, authorId);
    if (likes.length === 0) return;
    const plan = new Plan(ctx);
    clearLikes(plan, layoutId, authorId, likes, likeVer);
    try {
      await runTx(ctx, await plan.finish());
    } catch (e) {
      if (!(e instanceof TxConditionFailed)) throw e;
    }
  }
}

export function ddbCommentStore(ctx: DdbContext): CommentStore {
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
      const row = await getRow(ctx, "comment", r.id);
      if (row === null || row.status !== "pending" || row.review_version !== r.reviewVersion || row.body === null) return lost;
      const layoutId = row.layout_id as string;
      const userId = row.user_id as string;
      const cat = await readCat(ctx, layoutId);
      if (target === "approved" && (cat === null || cat.deleted !== 0)) return lost;
      const ver = await readVer(ctx, commentGuardKey(layoutId, userId));
      const others =
        target === "approved"
          ? await getRows(
              ctx,
              "comment",
              (await pairItems(ctx, layoutId, userId)).filter((i) => i.status === "approved" && i.id !== r.id).map((i) => i.id as string),
            )
          : [];
      const st = await readHistory(ctx, "comment", r.id);
      try {
        await runEventTx(ctx, async (b) => {
          const plan = new Plan(ctx);
          transition(plan, "comment", row, { ...row, status: target, decided_by: r.by, decided_at: r.at, reason }, "claim", BODY_PRESENT);
          for (const o of others) {
            transition(plan, "comment", o, { ...o, status: "replaced", body: null, decided_by: r.by, decided_at: r.at }, `replace:${o.id}`);
          }
          if (target === "approved") guard(plan, "guard", commentGuardKey(layoutId, userId), ver, 0);
          catCheck(plan, layoutId, cat, target === "approved");
          const seq = b.event(moderationEvent(r.at, r.event, cat));
          if (r.outbox !== undefined) outboxOps(plan, r.outbox, seq);
          addHistory(plan, { ...st, claims: new Set(st.claims) }, r.history);
          for (const op of await plan.finish()) b.item(op.tag, op.item);
        });
      } catch (e) {
        if (e instanceof TxConditionFailed) {
          if (e.tags.includes("claim")) return lost;
          if (e.tags.includes("cat") && target === "approved") {
            const again = await readCat(ctx, layoutId);
            if (again === null || again.deleted !== 0) return lost;
          }
          if (e.tags.some((t) => t.startsWith("outbox:"))) throw new Error(`UNIQUE constraint failed (${uniqueConflict(e)})`);
          return RETRY;
        }
        throw e;
      }
      return { claimed: true, eventAppended: true };
    });
  }

  return {
    async get(id) {
      const row = await getRow(ctx, "comment", id);
      return row === null ? null : pub(row);
    },

    async submit(r) {
      const layoutId = r.row.layout_id;
      const userId = r.row.user_id;
      await decide(async () => {
        const ver = await readVer(ctx, commentGuardKey(layoutId, userId));
        const pendingIds = (await pairItems(ctx, layoutId, userId)).filter((i) => i.status === "pending").map((i) => i.id as string);
        const pending = await getRows(ctx, "comment", pendingIds);
        const plan = new Plan(ctx);
        // D1 filters on user_id = r.by; the pair is (layout, user_id) and the caller passes by = user_id.
        for (const p of pending) transition(plan, "comment", p, { ...p, status: "superseded", decided_by: r.by, decided_at: r.at }, `supersede:${p.id}`);
        transition(
          plan,
          "comment",
          null,
          { ...r.row, status: "pending", decided_by: null, decided_at: null, reason: null, review_version: 0 },
          "insert",
        );
        guard(plan, "guard", commentGuardKey(layoutId, userId), ver, 1);
        try {
          await runTx(ctx, await plan.finish());
        } catch (e) {
          if (e instanceof TxConditionFailed) {
            if (e.tags.includes("insert")) throw new Error("UNIQUE constraint failed: layout_comments.id");
            return RETRY;
          }
          throw e;
        }
        return undefined;
      });
    },

    async hasBody(layoutId, userId) {
      return (await pairItems(ctx, layoutId, userId)).some((i) => i.has_body === 1);
    },

    async deleteOwn(r) {
      let tail = false;
      await decide(async () => {
        // Guards first: a set read is only as fresh as the version read before it (R5).
        const ver = await readVer(ctx, commentGuardKey(r.layoutId, r.userId));
        const likeVer = await readVer(ctx, commentLikeGuardKey(r.layoutId, r.userId));
        const items = await pairItems(ctx, r.layoutId, r.userId);
        const targets = items.filter((i) => i.status === "approved" || i.status === "pending" || i.has_body === 1);
        const rows = await getRows(ctx, "comment", targets.map((i) => i.id as string));
        const likes = await slotLikes(ctx, r.layoutId, r.userId);
        if (rows.length === 0 && likes.length === 0) return undefined;
        const plan = new Plan(ctx);
        for (const row of rows) {
          const dies = row.status === "approved" || row.status === "pending";
          transition(
            plan,
            "comment",
            row,
            { ...row, body: null, ...(dies ? { status: "deleted", decided_by: r.userId, decided_at: r.at } : {}) },
            `row:${row.id}`,
          );
        }
        guard(plan, "guard", commentGuardKey(r.layoutId, r.userId), ver, 0);
        tail = clearLikes(plan, r.layoutId, r.userId, likes, likeVer).length > 0;
        try {
          await runTx(ctx, await plan.finish());
        } catch (e) {
          if (e instanceof TxConditionFailed) return RETRY;
          throw e;
        }
        return undefined;
      });
      if (tail) await purgeLikeTail(ctx, r.layoutId, r.userId);
    },

    async queue(status) {
      const ix = await queryPartition(ctx, commentStatusKey(status, "", "").pk);
      const rows = await getRows(ctx, "comment", ix.map((i) => i.id as string));
      const byId = new Map(rows.map((x) => [x.id as string, x]));
      const ordered = ix.map((i) => byId.get(i.id as string)).filter((x): x is Row => x !== undefined);
      const layouts = [...new Set(ordered.map((x) => x.layout_id as string))];
      const [cats, names, oks] = await Promise.all([
        readCats(ctx, layouts),
        authorNames(ctx, ordered.map((x) => x.user_id as string)),
        Promise.all(layouts.map(async (l) => [l, await queryPartition(ctx, commentOkKey(l, "", "").pk)] as const)),
      ]);
      const okBy = new Map(oks);
      const out: CommentQueueRow[] = [];
      for (const x of ordered) {
        const cat = cats.get(x.layout_id as string);
        if (cat === undefined || cat.deleted !== 0) continue;
        // The user's approved text on this layout other than this row: newest decided_at, then id.
        const live = (okBy.get(x.layout_id as string) ?? [])
          .filter((o) => o.user_id === x.user_id && o.id !== x.id)
          .sort((a, b) => compareBinary(b.decided_at as string, a.decided_at as string) || compareBinary(a.id as string, b.id as string))[0];
        out.push({ ...pub(x), layout_name: cat.name, user_name: names.get(x.user_id as string) ?? null, live_body: live === undefined ? null : (live.body as string) });
      }
      return out;
    },

    approve: (r) => decideRow(r, "approved", null),

    reject: (r) => decideRow(r, "rejected", r.reason),

    async remove(r) {
      let tail = false;
      const res = await decide(async () => {
        const row = await getRow(ctx, "comment", r.id);
        if (row === null || row.status !== "approved" || row.review_version !== r.reviewVersion) return { claimed: false };
        const ver = await readVer(ctx, commentGuardKey(r.layoutId, r.userId));
        const likeVer = await readVer(ctx, commentLikeGuardKey(r.layoutId, r.userId));
        const items = await pairItems(ctx, r.layoutId, r.userId);
        // The likes go only if no other approved row keeps the slot (`NOT EXISTS ... status = 'approved'`).
        const slotStays = items.some((i) => i.status === "approved" && i.id !== r.id);
        const likes = slotStays ? [] : await slotLikes(ctx, r.layoutId, r.userId);
        const plan = new Plan(ctx);
        transition(plan, "comment", row, { ...row, status: "removed", decided_by: r.by, decided_at: r.at, reason: r.reason }, "claim");
        guard(plan, "guard", commentGuardKey(r.layoutId, r.userId), ver, 0);
        tail = slotStays ? false : clearLikes(plan, r.layoutId, r.userId, likes, likeVer).length > 0;
        try {
          await runTx(ctx, await plan.finish());
        } catch (e) {
          if (e instanceof TxConditionFailed) return e.tags.includes("claim") ? { claimed: false } : RETRY;
          throw e;
        }
        return { claimed: true };
      });
      if (res.claimed && tail) await purgeLikeTail(ctx, r.layoutId, r.userId);
      return res;
    },

    async counts() {
      const cc = (await queryPartition(ctx, commentCountKey("").pk)).filter((i) => (i.count as number) > 0);
      const cats = await readCats(ctx, cc.map((i) => i.sk as string));
      const out: PublicCommentCount[] = [];
      for (const i of cc) {
        const cat = cats.get(i.sk as string);
        if (cat === undefined || cat.deleted !== 0) continue;
        out.push({ layout_id: i.sk as string, layout_name: cat.name, count: i.count as number });
      }
      out.sort((a, b) => compareNocase(a.layout_name, b.layout_name) || compareBinary(a.layout_id, b.layout_id));
      return out;
    },

    async list(r) {
      const ok = await queryPartition(ctx, commentOkKey(r.layoutId, "", "").pk);
      if (ok.length === 0) return [];
      const [likes, names, pairs] = await Promise.all([
        queryPartition(ctx, `CL#${r.layoutId}`),
        authorNames(ctx, ok.map((x) => x.user_id as string)),
        Promise.all(ok.map((x) => pairItems(ctx, r.layoutId, x.user_id as string))),
      ]);
      const rows: PublicCommentDbRow[] = ok.map((x, i) => {
        const author = x.user_id as string;
        // `edited`: a replaced row retired after the pair's last delete or removal.
        const cut = pairs[i]!.filter((p) => p.status === "deleted" || p.status === "removed").reduce((m, p) => (compareBinary(p.decided_at as string, m) > 0 ? (p.decided_at as string) : m), "");
        const edited = pairs[i]!.some((p) => p.status === "replaced" && compareBinary(p.decided_at as string, cut) > 0);
        const mine = likes.filter((l) => l.author_id === author);
        return {
          id: x.id as string,
          user_id: author,
          name: names.get(author) ?? null,
          body: x.body as string,
          approved_at: x.decided_at as string,
          edited: edited ? 1 : 0,
          likes: mine.length,
          liked: mine.some((l) => l.user_id === r.viewer) ? 1 : 0,
          is_author: author === r.owner ? 1 : 0,
        };
      });
      rows.sort(
        (a, b) =>
          b.is_author - a.is_author ||
          (r.sort === "newest" ? 0 : b.likes - a.likes) ||
          compareBinary(b.approved_at, a.approved_at) ||
          compareBinary(a.id, b.id),
      );
      return rows;
    },

    async like(r) {
      return decide(async () => {
        const slot = (await queryPartition(ctx, commentOkKey(r.layoutId, "", "").pk)).find((x) => x.user_id === r.authorId);
        if (slot === undefined) return false;
        const likeVer = await readVer(ctx, commentLikeGuardKey(r.layoutId, r.authorId));
        const body = {
          layout_id: r.layoutId,
          author_id: r.authorId,
          user_id: r.userId,
          via: r.via,
          created_at: r.at,
        };
        const plan = new Plan(ctx);
        plan.add("slot", {
          ConditionCheck: {
            TableName: ctx.tables.main,
            Key: subKey("comment", slot.id as string),
            ConditionExpression: "#s = :a AND attribute_exists(#b) AND NOT attribute_type(#b, :nul)",
            ExpressionAttributeNames: { "#s": "status", "#b": "body" },
            ExpressionAttributeValues: { ":a": "approved", ":nul": "NULL" },
          },
        });
        plan.put("like", { ...commentLikeKey(r.layoutId, r.authorId, r.userId), ...body }, "attribute_not_exists(pk)");
        plan.put("like:mirror", { ...commentLikeByAuthorKey(r.authorId, r.layoutId, r.userId), ...body });
        guard(plan, "likeguard", commentLikeGuardKey(r.layoutId, r.authorId), likeVer, 1);
        try {
          await runTx(ctx, await plan.finish());
        } catch (e) {
          if (e instanceof TxConditionFailed) return e.tags.includes("slot") || e.tags.includes("likeguard") ? RETRY : false;
          throw e;
        }
        return true;
      });
    },

    async approvedSlotExists(layoutId, authorId) {
      return (await queryPartition(ctx, commentOkKey(layoutId, "", "").pk)).some((x) => x.user_id === authorId);
    },

    async unlike(layoutId, authorId, userId) {
      return decide(async () => {
        const likeVer = await readVer(ctx, commentLikeGuardKey(layoutId, authorId));
        if (likeVer === 0) return false;
        const plan = new Plan(ctx);
        plan.delete("like", commentLikeKey(layoutId, authorId, userId), { expr: "attribute_exists(pk)" });
        plan.delete("like:mirror", commentLikeByAuthorKey(authorId, layoutId, userId));
        guard(plan, "likeguard", commentLikeGuardKey(layoutId, authorId), likeVer, -1);
        try {
          await runTx(ctx, await plan.finish());
        } catch (e) {
          if (e instanceof TxConditionFailed) return e.tags.includes("like") ? (await likeExists(layoutId, authorId, userId) ? RETRY : false) : RETRY;
          throw e;
        }
        return true;
      });
    },

    async pairRows(layoutId, userId) {
      const items = await pairItems(ctx, layoutId, userId);
      const rows = await getRows(ctx, "comment", items.map((i) => i.id as string));
      const byId = new Map(rows.map((x) => [x.id as string, x]));
      return items.map((i) => byId.get(i.id as string)).filter((x): x is Row => x !== undefined).map(pub);
    },

    async mine(userId) {
      const ix = await queryPartition(ctx, commentUserKey(userId, "", "", "").pk);
      const rows = await getRows(ctx, "comment", ix.map((i) => i.id as string));
      const byId = new Map(rows.map((x) => [x.id as string, x]));
      const ordered = ix.map((i) => byId.get(i.id as string)).filter((x): x is Row => x !== undefined);
      const cats = await readCats(ctx, ordered.map((x) => x.layout_id as string));
      const out: (CommentRow & { layout_name: string; layout_owner: string })[] = [];
      for (const x of ordered) {
        const cat = cats.get(x.layout_id as string);
        if (cat === undefined || cat.deleted !== 0) continue;
        out.push({ ...pub(x), layout_name: cat.name, layout_owner: cat.owner });
      }
      const likeCounts = new Map<string, number>();
      for (const l of await queryPartition(ctx, commentLikeByAuthorKey(userId, "", "").pk)) {
        likeCounts.set(l.layout_id as string, (likeCounts.get(l.layout_id as string) ?? 0) + 1);
      }
      return { rows: out, likeCounts };
    },
  };

  async function likeExists(layoutId: string, authorId: string, userId: string): Promise<boolean> {
    return (await getItem(ctx, commentLikeKey(layoutId, authorId, userId))) !== null;
  }
}
