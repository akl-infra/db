// DynamoDB implementation of `EventStore` (src/store/port.ts). Owner: P2 lane G
// (design/aws-port.md §2.4, §2.5, §2.8). Every event goes through runEventTx;
// every CAT/like/link change shares the transaction of the event naming it
// (LDB-AWS-RM1).
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { canonical } from "../../core/canonical";
import { DESTRUCTIVE_WINDOW_SECONDS, destructiveBudgetKey } from "../../core/destructive-budget";
import { alreadyLiked as alreadyLikedError, internal, nameTaken, notFound, notLiked as notLikedError } from "../../core/errors";
import {
  RevConflictError,
  formatSnapshot,
  layoutSnapshot,
  publicDetail,
  rowToEvent,
  type CommitResult,
  type EventSnapshot,
  type FormatSnapshot,
  type LayoutSnapshot,
  type WriteKind,
} from "../../core/events";
import type { FormatRow, LayoutRow, Source } from "../../core/records";
import type { EventStore } from "../port";
import { TxConditionFailed, type DdbContext, type EventInput, type EventTxBuilder, type TxItem } from "./contracts";
import { scanEvents, readHeadSeq } from "./evquery";
import { consistentGet } from "./head";
import { catKey, fold, likeKey, nameKey, revKey, userLikeKey } from "./keys";
import { byteLength, putPayload, SPILL_BYTES } from "./payload";
import { likersOf } from "./layouts";
import { planLinkSettle } from "./links";
import { eventRow, layoutRowOf } from "./schema/core";
import { runEventTx } from "./tx";

const MAX_FEED = 1000;
const INHERITED_LIKES_CHUNK = 15;
/** Revert scans stop this long (seconds) past the window start: `at` is a wall clock, not strictly monotone in `seq`. */
const REVERT_CLOCK_SLACK_MS = 60_000;

function lineageOf(format: string): string {
  const i = format.lastIndexOf("/");
  return i === -1 ? format : format.slice(0, i);
}

function nowSeconds(at: string): number {
  return Math.floor(new Date(at).getTime() / 1000);
}

/** Builds `SET #a = :a, ...` pieces for a flat attribute object. */
function setClauses(fields: Record<string, unknown>, prefix = "f"): { set: string[]; names: Record<string, string>; values: Record<string, unknown> } {
  const set: string[] = [];
  const names: Record<string, string> = {};
  const values: Record<string, unknown> = {};
  Object.entries(fields).forEach(([k, v], i) => {
    set.push(`#${prefix}${i} = :${prefix}${i}`);
    names[`#${prefix}${i}`] = k;
    values[`:${prefix}${i}`] = v;
  });
  return { set, names, values };
}

async function readCat(ctx: DdbContext, id: string) {
  return consistentGet(ctx, catKey(id));
}

/** The CAT item as `LayoutRow` plus counters, read after a commit for the truth D1's same-batch read-back gave. */
async function readLikeCount(ctx: DdbContext, id: string): Promise<{ like_count: number; link: string | null } | undefined> {
  const it = await readCat(ctx, id);
  return it === undefined ? undefined : { like_count: it.like_count as number, link: (it.link as string | null) ?? null };
}

// The destructive-budget counter lives in the ephemeral table, key shape shared with lane I's `hitWindow`.
function budgetKey(clientId: string, windowStart: number) {
  return { pk: `RL#${destructiveBudgetKey(clientId)}`, sk: String(windowStart) };
}

function budgetItem(ctx: DdbContext, clientId: string, at: string): { tag: string; item: TxItem; key: { pk: string; sk: string } } {
  const windowStart = Math.floor(nowSeconds(at) / DESTRUCTIVE_WINDOW_SECONDS) * DESTRUCTIVE_WINDOW_SECONDS;
  const key = budgetKey(clientId, windowStart);
  return {
    tag: "budget",
    key,
    item: {
      Update: {
        TableName: ctx.tables.ephemeral,
        Key: key,
        UpdateExpression: "ADD n :one SET #ttl = :ttl",
        ExpressionAttributeNames: { "#ttl": "ttl" },
        ExpressionAttributeValues: { ":one": 1, ":ttl": windowStart + 2 * DESTRUCTIVE_WINDOW_SECONDS },
      },
    },
  };
}

async function readBudgetCount(ctx: DdbContext, key: { pk: string; sk: string }): Promise<number> {
  const r = await ctx.doc.send(new GetCommand({ TableName: ctx.tables.ephemeral, Key: key, ConsistentRead: true }));
  return (r.Item?.n as number | undefined) ?? 0;
}

function eventInput(base: Omit<EventInput, "detail_json" | "before_json" | "after_json"> & { detail?: object; before?: object | null; after?: object | null }): EventInput {
  const { detail, before, after, ...rest } = base;
  return {
    ...rest,
    detail_json: detail === undefined ? null : canonical(detail),
    before_json: before == null ? null : canonical(before),
    after_json: after == null ? null : canonical(after),
  };
}

export function ddbEventStore(ctx: DdbContext): EventStore {
  return {
    async commitWrite(now, input) {
      const at = now();
      const id = input.layoutId;

      const finalLayoutRev = input.layout !== undefined ? (input.creating ? 1 : input.currentLayout!.layout_rev + 1) : (input.currentLayout?.layout_rev ?? 0);
      const finalLikeCount = input.like_count ?? input.currentLayout?.like_count ?? 0;
      const finalName = input.layout?.name ?? input.currentLayout!.name;
      const finalOwner = input.layout?.owner ?? input.currentLayout!.owner;
      const finalCreatedAt = input.layout?.created_at ?? input.currentLayout!.created_at;
      const finalDeleted = input.layout?.deleted ?? input.currentLayout!.deleted;
      const finalModifiedAt = input.layout !== undefined ? input.modified_at : (input.currentLayout?.modified_at ?? input.modified_at);
      const finalLayoutSource: Source | null = input.layout !== undefined ? input.source : (input.currentLayout?.source ?? null);

      const existingFormat = input.format !== undefined ? input.currentFormats.get(input.format.lineage) ?? null : null;
      const finalFormatRev = input.format !== undefined ? (existingFormat?.rev ?? 0) + 1 : 0;
      const finalFormatCreatedAt = input.format !== undefined ? (existingFormat?.created_at ?? input.modified_at) : "";

      const beforeLayout: LayoutSnapshot | null = input.currentLayout === null ? null : layoutSnapshot(input.currentLayout);
      const beforeFormat: FormatSnapshot | null = existingFormat === null ? null : formatSnapshot(existingFormat);
      const afterLayout: LayoutSnapshot = layoutSnapshot({
        id,
        name: finalName,
        owner: finalOwner,
        layout_rev: finalLayoutRev,
        created_at: finalCreatedAt,
        modified_at: finalModifiedAt,
        deleted: finalDeleted,
        upstream: input.upstream,
        source: finalLayoutSource,
      });
      const formatTouchesUpstream = input.format !== undefined && input.format.lineage === "spark";
      const afterFormat: FormatSnapshot | undefined =
        input.format === undefined
          ? undefined
          : formatSnapshot({
              layout_id: id,
              lineage: input.format.lineage,
              format: input.format.format,
              rev: finalFormatRev,
              created_at: finalFormatCreatedAt,
              modified_at: input.modified_at,
              has_magic: input.format.hasMagic,
              has_alts: input.format.hasAlts ?? false,
              has_combos: input.format.hasCombos ?? false,
              source: input.source,
              ...(formatTouchesUpstream ? { upstream: input.upstream } : {}),
            });

      // Payloads over the item limit go to the blob store first (content-addressed, so a retry rewrites the same object).
      const payloadJson = input.format === undefined ? undefined : canonical(input.format.payload);
      const payloadBytes = payloadJson === undefined ? 0 : byteLength(payloadJson);
      let revRef: string | undefined;
      let catRef: string | undefined;
      if (payloadJson !== undefined) {
        if (payloadBytes > SPILL_BYTES) revRef = await putPayload(ctx.blobs, payloadJson);
        let others = 0;
        for (const [lin, f] of input.currentFormats) if (lin !== input.format!.lineage) others += JSON.stringify(f.payload).length;
        if (payloadBytes + others + 4096 > SPILL_BYTES) catRef = revRef ?? (await putPayload(ctx.blobs, payloadJson));
      }

      const live = (l: { deleted: boolean } | null) => l !== null && !l.deleted;
      const dlive = (finalDeleted ? 0 : 1) - (live(input.currentLayout) ? 1 : 0);
      const budget = input.destructiveBudget === undefined ? undefined : budgetItem(ctx, input.destructiveBudget.clientId, at);

      let liveAfter = 0;
      let nFinal = input.currentN;
      let seqsOut: number[];
      try {
        seqsOut = (await runEventTx(ctx, (b: EventTxBuilder) => {
        let nCursor = input.currentN;
        const parts: { kind: WriteKind; format: string | null; rev: number; before: EventSnapshot | null; after: EventSnapshot; detail: object | undefined }[] = [];
        if (input.layout !== undefined) parts.push({ kind: input.layout.kind, format: null, rev: finalLayoutRev, before: beforeLayout, after: afterLayout, detail: input.layout.detail });
        if (input.format !== undefined) parts.push({ kind: input.format.kind, format: input.format.format, rev: finalFormatRev, before: beforeFormat, after: afterFormat!, detail: input.format.detail });
        for (const p of parts) {
          const seq = b.event(
            eventInput({
              at, kind: p.kind, layout_id: id, name: finalName, owner: finalOwner, format: p.format, rev: p.rev,
              actor: input.actor, via: input.via, admin: input.admin === true ? 1 : 0, detail: p.detail, before: p.before, after: p.after,
              source_client: input.source.client, source_version: input.source.version,
            }),
          );
          nCursor += 1;
          const lineage = p.format === null ? null : lineageOf(p.format);
          b.item("rev", {
            Put: {
              TableName: ctx.tables.main,
              Item: {
                ...revKey(id, lineage, p.rev), layout_id: id, n: nCursor, lineage, rev: p.rev, event_seq: seq, format: p.format,
                ...(p.format === null ? { payload_json: null } : revRef !== undefined ? { payload_ref: revRef } : { payload_json: payloadJson }),
              },
              ConditionExpression: "attribute_not_exists(pk)",
            },
          });
        }
        nFinal = nCursor;

        // The layouts upsert: a Put for a new layout, an Update (which leaves like_count and link alone) otherwise.
        const upstream = input.upstream;
        const fmtEntry =
          input.format === undefined
            ? undefined
            : {
                format: input.format.format, rev: finalFormatRev, created_at: finalFormatCreatedAt, modified_at: input.modified_at,
                ...(catRef !== undefined ? { payload_ref: catRef } : { payload_json: payloadJson }),
                has_magic: input.format.hasMagic ? 1 : 0, has_alts: input.format.hasAlts ? 1 : 0, has_combos: input.format.hasCombos ? 1 : 0,
                source_client: input.source.client, source_version: input.source.version,
              };
        const cols = {
          name: finalName, owner: finalOwner, n: nCursor, layout_rev: finalLayoutRev, created_at: finalCreatedAt, modified_at: finalModifiedAt,
          deleted: finalDeleted ? 1 : 0,
          upstream_source: upstream?.source ?? null, upstream_id: upstream?.id ?? null, upstream_state: upstream?.state ?? null,
          source_client: finalLayoutSource?.client ?? null, source_version: finalLayoutSource?.version ?? null,
        };
        if (input.creating) {
          b.item("cat", {
            Put: {
              TableName: ctx.tables.main,
              Item: {
                ...catKey(id), id, ...cols, like_count: finalLikeCount, like_adjust: 0, link: null,
                fmt: input.format === undefined ? {} : { [input.format.lineage]: fmtEntry },
              },
              ConditionExpression: "attribute_not_exists(pk)",
            },
          });
        } else {
          const { set, names, values } = setClauses(cols);
          if (fmtEntry !== undefined) {
            set.push("fmt.#lin = :fmt");
            names["#lin"] = input.format!.lineage;
            values[":fmt"] = fmtEntry;
          }
          b.item("cat", {
            Update: {
              TableName: ctx.tables.main,
              Key: catKey(id),
              UpdateExpression: `SET ${set.join(", ")}`,
              ConditionExpression: "n = :expectedN",
              ExpressionAttributeNames: names,
              ExpressionAttributeValues: { ...values, ":expectedN": input.currentN },
            },
          });
        }

        // The live-name claim follows the live name: released when it changes or the layout dies, taken when a live layout (re)appears or is renamed.
        const wasLive = live(input.currentLayout);
        const nowLive = !finalDeleted;
        const oldName = input.currentLayout?.name;
        const nameChanged = oldName === undefined || fold(oldName) !== fold(finalName);
        if (wasLive && (!nowLive || nameChanged)) {
          b.item("name-release", {
            Delete: { TableName: ctx.tables.main, Key: nameKey(oldName!), ConditionExpression: "id = :id", ExpressionAttributeValues: { ":id": id } },
          });
        }
        if (nowLive && (!wasLive || nameChanged)) {
          b.item("name", {
            Put: {
              TableName: ctx.tables.main,
              Item: { ...nameKey(finalName), id },
              ConditionExpression: "attribute_not_exists(pk) OR id = :id",
              ExpressionAttributeValues: { ":id": id },
            },
          });
        }

        if (budget !== undefined) b.item(budget.tag, budget.item);
        b.addLive(dlive);
        liveAfter = b.head.live + dlive;
      })).seqs;
      } catch (e) {
        if (e instanceof TxConditionFailed) {
          if (e.tags.includes("cat") || e.tags.includes("rev")) throw new RevConflictError(id);
          if (e.tags.includes("name")) throw nameTaken(finalName);
          throw internal();
        }
        throw e;
      }

      let trueLikeCount = finalLikeCount;
      let link: string | null = null;
      if (!input.creating) {
        const fresh = await readLikeCount(ctx, id);
        if (fresh !== undefined) {
          trueLikeCount = fresh.like_count;
          link = fresh.link;
        }
      }
      const layout: LayoutRow = {
        id, name: finalName, owner: finalOwner, n: nFinal, layout_rev: finalLayoutRev, created_at: finalCreatedAt, modified_at: finalModifiedAt,
        deleted: finalDeleted, like_count: trueLikeCount, link, upstream: input.upstream, source: finalLayoutSource,
      };
      const formats = new Map<string, FormatRow>(input.currentFormats);
      if (input.format !== undefined) {
        formats.set(input.format.lineage, {
          layout_id: id, lineage: input.format.lineage, format: input.format.format, rev: finalFormatRev, created_at: finalFormatCreatedAt,
          modified_at: input.modified_at, payload: input.format.payload, has_magic: input.format.hasMagic,
          has_alts: input.format.hasAlts ?? false, has_combos: input.format.hasCombos ?? false, source: input.source,
        });
      }
      let budgetProbe: CommitResult["budgetProbe"];
      if (budget !== undefined) {
        budgetProbe = { clientId: input.destructiveBudget!.clientId, countInWindow: await readBudgetCount(ctx, budget.key), liveLayouts: liveAfter };
      }
      return { layout, formats, seqs: seqsOut, budgetProbe };
    },

    async appendInfo(now, i) {
      const current = await readCat(ctx, i.layoutId);
      if (current === undefined) throw new Error(`appendInfo: layoutId '${i.layoutId}' does not exist`);
      const at = now();
      const { seqs } = await runEventTx(ctx, (b) => {
        b.event(
          eventInput({
            at, kind: i.kind, layout_id: i.layoutId, name: current.name as string, owner: current.owner as string, format: null, rev: null,
            actor: i.actor, via: i.via, admin: 0, detail: i.detail, source_client: i.source.client, source_version: i.source.version,
          }),
        );
      });
      return { seq: seqs[0]! };
    },

    async appendAdmin(now, a) {
      const at = now();
      const { seqs } = await runEventTx(ctx, (b) => {
        b.event(
          eventInput({
            at, kind: a.kind, layout_id: null, name: null, owner: null, format: null, rev: null, actor: a.actor, via: a.via ?? "discord", admin: 1,
            detail: a.detail, source_client: a.source?.client ?? null, source_version: a.source?.version ?? null,
          }),
        );
      });
      return { seq: seqs[0]! };
    },

    async appendModeration(now, m) {
      const current = await readCat(ctx, m.layoutId);
      if (current === undefined) throw new Error(`appendModeration: layoutId '${m.layoutId}' does not exist`);
      const at = now();
      const { seqs } = await runEventTx(ctx, (b) => {
        b.event(
          eventInput({
            at, kind: m.kind, layout_id: m.layoutId, name: current.name as string, owner: current.owner as string, format: null, rev: null,
            actor: m.actor, via: m.via, admin: 1, detail: m.detail, after: m.after, source_client: m.source.client, source_version: m.source.version,
          }),
        );
      });
      return { seq: seqs[0]! };
    },

    async appendLinkChange(now, l) {
      const current = await readCat(ctx, l.layoutId);
      if (current === undefined) throw new Error(`appendLinkChange: layoutId '${l.layoutId}' does not exist`);
      const at = now();
      const budget = l.destructiveBudget === undefined ? undefined : budgetItem(ctx, l.destructiveBudget.clientId, at);
      let seq = 0;
      for (let attempt = 0; ; attempt++) {
        try {
          const r = await runEventTx(ctx, async (b) => {
            // Lane J's plan: claim the submission (if any), supersede the layout's other pending ones, bump the set guard.
            const plan = await planLinkSettle(ctx, { layoutId: l.layoutId, submissionId: l.submissionId, by: l.actor, at });
            if (plan === null) throw notFound(`link submission '${l.submissionId}' is not pending`, l.submissionId!);
            for (const op of plan.ops) b.item(op.tag, op.item);
            b.item(l.submissionId !== undefined ? "claim" : "layout", {
              Update: {
                TableName: ctx.tables.main,
                Key: catKey(l.layoutId),
                UpdateExpression: "SET link = :link",
                ConditionExpression: l.submissionId !== undefined ? "deleted = :zero" : "attribute_exists(pk)",
                ExpressionAttributeValues: l.submissionId !== undefined ? { ":link": l.link, ":zero": 0 } : { ":link": l.link },
              },
            });
            b.event(
              eventInput({
                at, kind: l.kind, layout_id: l.layoutId, name: current.name as string, owner: current.owner as string, format: null, rev: null,
                actor: l.actor, via: l.via, admin: l.admin ? 1 : 0, detail: l.detail, after: { scope: "link", link: l.link },
                source_client: l.source.client, source_version: l.source.version,
              }),
            );
            if (budget !== undefined) b.item(budget.tag, budget.item);
          });
          seq = r.seqs[0] ?? 0;
        } catch (e) {
          if (e instanceof TxConditionFailed) {
            if (e.tags.includes("claim") || e.tags.includes("link-claim")) throw notFound(`link submission '${l.submissionId}' is not pending`, l.submissionId!);
            if (attempt < 7) continue; // another submission changed under the plan: plan again
          }
          throw e;
        }
        break;
      }
      let budgetProbe: { clientId: string; countInWindow: number; liveLayouts: number } | undefined;
      if (budget !== undefined) {
        const head = await readHeadLive(ctx);
        budgetProbe = { clientId: l.destructiveBudget!.clientId, countInWindow: await readBudgetCount(ctx, budget.key), liveLayouts: head };
      }
      return { seq, link: l.link, budgetProbe };
    },

    async appendLike(now, l) {
      let currentRow: LayoutRow | null = l.current ?? null;
      if (currentRow === null) {
        const it = await readCat(ctx, l.layoutId);
        if (it === undefined) throw new Error(`appendLike: layoutId '${l.layoutId}' does not exist`);
        currentRow = layoutRowOf(it);
      }
      const current = currentRow;
      const wantsLike = l.kind === "liked";
      const at = now();
      let seq = 0;
      try {
        const r = await runEventTx(ctx, (b) => {
          b.item("live", {
            Update: {
              TableName: ctx.tables.main,
              Key: catKey(l.layoutId),
              UpdateExpression: "ADD like_count :d",
              ConditionExpression: "attribute_exists(pk) AND deleted = :zero",
              ExpressionAttributeValues: { ":d": wantsLike ? 1 : -1, ":zero": 0 },
            },
          });
          const mine = likeKey(l.layoutId, l.userId);
          const theirs = userLikeKey(l.userId, l.layoutId);
          if (wantsLike) {
            const body = { layout_id: l.layoutId, user_id: l.userId, at, via: l.via };
            b.item("like", { Put: { TableName: ctx.tables.main, Item: { ...mine, ...body }, ConditionExpression: "attribute_not_exists(pk)" } });
            b.item("like2", { Put: { TableName: ctx.tables.main, Item: { ...theirs, ...body } } });
          } else {
            b.item("like", { Delete: { TableName: ctx.tables.main, Key: mine, ConditionExpression: "attribute_exists(pk)" } });
            b.item("like2", { Delete: { TableName: ctx.tables.main, Key: theirs } });
          }
          b.event(
            eventInput({
              at, kind: l.kind, layout_id: l.layoutId, name: current.name, owner: current.owner, format: null, rev: null,
              actor: l.userId, via: l.via, admin: 0, detail: l.detail, source_client: l.source.client, source_version: l.source.version,
            }),
          );
        });
        seq = r.seqs[0]!;
      } catch (e) {
        if (e instanceof TxConditionFailed) {
          if (e.tags.includes("live")) throw notFound(`no layout '${current.name}'`, current.name);
          throw wantsLike ? alreadyLikedError() : notLikedError();
        }
        throw e;
      }
      const counted = (await readLikeCount(ctx, l.layoutId))?.like_count;
      return { seq, like_count: counted ?? current.like_count };
    },

    async appendInheritedLikes(now, a) {
      const at = now();
      // Skip anyone who already likes it (D1's per-user NOT EXISTS guard), then chunk the rest.
      const existing = new Set(await likersOf(ctx, a.layoutId));
      let todo = [...new Set(a.userIds)].filter((u) => !existing.has(u));
      while (todo.length > 0) {
        const chunk = todo.slice(0, INHERITED_LIKES_CHUNK);
        try {
          await runEventTx(ctx, (b) => {
            b.item("live", {
              Update: {
                TableName: ctx.tables.main,
                Key: catKey(a.layoutId),
                UpdateExpression: "ADD like_count :d",
                ConditionExpression: "attribute_exists(pk) AND deleted = :zero",
                ExpressionAttributeValues: { ":d": chunk.length, ":zero": 0 },
              },
            });
            for (const userId of chunk) {
              const body = { layout_id: a.layoutId, user_id: userId, at, via: a.via };
              b.item(`like:${userId}`, { Put: { TableName: ctx.tables.main, Item: { ...likeKey(a.layoutId, userId), ...body }, ConditionExpression: "attribute_not_exists(pk)" } });
              b.item("like2", { Put: { TableName: ctx.tables.main, Item: { ...userLikeKey(userId, a.layoutId), ...body } } });
              b.event(
                eventInput({
                  at, kind: "liked", layout_id: a.layoutId, name: a.name, owner: a.owner, format: null, rev: null, actor: userId, via: a.via, admin: 0,
                  detail: a.detail, source_client: a.source.client, source_version: a.source.version,
                }),
              );
            }
          });
          todo = todo.slice(chunk.length);
        } catch (e) {
          if (!(e instanceof TxConditionFailed)) throw e;
          if (e.tags.includes("live")) break; // layout gone: nothing more to inherit
          // A real like landed since the read: drop those users, redo the chunk.
          const lost = new Set(e.tags.filter((t) => t.startsWith("like:")).map((t) => t.slice(5)));
          if (lost.size === 0) throw e;
          todo = todo.filter((u) => !lost.has(u));
        }
      }
      return { like_count: (await readLikeCount(ctx, a.layoutId))?.like_count ?? 0 };
    },

    async feed(since, limit, kinds, filter) {
      const cap = Math.min(limit, MAX_FEED);
      const hi = await readHeadSeq(ctx);
      if (cap <= 0 || since >= hi) return { next: since, items: [] };

      // The most selective mirror serves the query; the rest become a server-side filter.
      let pk = "EV";
      const conds: string[] = [];
      const names: Record<string, string> = {};
      const values: Record<string, unknown> = {};
      const useKinds = kinds !== undefined && kinds.length > 0;
      if (filter?.layoutId !== undefined) pk = `EVL#${filter.layoutId}`;
      else if (filter?.actor !== undefined) pk = `EVA#${filter.actor}`;
      else if (useKinds && kinds.length === 1) pk = `EVK#${kinds[0]}`;
      if (useKinds && pk !== `EVK#${kinds[0]}`) {
        conds.push(`#kind IN (${kinds.map((_, i) => `:k${i}`).join(", ")})`);
        names["#kind"] = "kind";
        kinds.forEach((k, i) => (values[`:k${i}`] = k));
      }
      if (filter?.layoutId !== undefined && pk !== `EVL#${filter.layoutId}`) {
        conds.push("layout_id = :lay");
        values[":lay"] = filter.layoutId;
      }
      if (filter?.actor !== undefined && pk !== `EVA#${filter.actor}`) {
        conds.push("actor = :act");
        values[":act"] = filter.actor;
      }
      if (filter?.format !== undefined) {
        conds.push("#fmt = :fmt");
        names["#fmt"] = "format";
        values[":fmt"] = filter.format;
      }

      const rows: Record<string, any>[] = [];
      for await (const it of scanEvents(ctx, {
        pk,
        lo: since + 1,
        hi,
        pageSize: cap,
        ...(conds.length === 0 ? {} : { filter: { expr: conds.join(" AND "), names, values } }),
      })) {
        rows.push(it);
        if (rows.length >= cap) break;
      }
      if (pk === "EV" && conds.length === 0) {
        rows.forEach((r, i) => {
          if (r.seq !== since + 1 + i) {
            console.error(`FEED_GAP expected seq ${since + 1 + i}, got ${r.seq}`);
            throw internal();
          }
        });
      }
      const items = rows.map((r) => rowToEvent(eventRow(r) as never)).map((e) => ({ ...e, detail: publicDetail(e.kind, e.detail) }));
      return { next: items.length > 0 ? items[items.length - 1]!.seq : since, items };
    },

    async revertCandidates(sourceClient, sinceAt, beforeSeq, limit) {
      const hi = Math.min(await readHeadSeq(ctx), beforeSeq - 1);
      const out: { seq: number; at: string; kind: string; layout_id: string | null; format: string | null; rev: number | null; before_json: string | null; after_json: string | null }[] = [];
      const stopAt = new Date(new Date(sinceAt).getTime() - REVERT_CLOCK_SLACK_MS).toISOString();
      for await (const e of scanEvents(ctx, { pk: "EV", lo: 1, hi, desc: true, pageSize: 100 })) {
        const at = e.at as string;
        if (at < stopAt) break;
        if (e.source_client !== sourceClient || at < sinceAt) continue;
        const kind = e.kind as string;
        const rev = e.rev as number | null;
        const format = e.format as string | null;
        const ok =
          (rev !== null && ((format === null && ["deleted", "renamed", "transferred"].includes(kind)) || (format !== null && ["updated", "fingermap"].includes(kind)))) ||
          kind === "link_cleared";
        if (!ok) continue;
        out.push({
          seq: e.seq as number, at, kind, layout_id: e.layout_id as string | null, format, rev, before_json: e.before_json as string | null, after_json: e.after_json as string | null,
        });
        if (out.length >= limit) break;
      }
      return out;
    },

    async latestLinkEvent(layoutId, beforeSeq) {
      const head = await readHeadSeq(ctx);
      const hi = beforeSeq === undefined ? head : Math.min(head, beforeSeq - 1);
      for await (const e of scanEvents(ctx, {
        pk: `EVL#${layoutId}`,
        lo: 1,
        hi,
        desc: true,
        filter: { expr: "#kind IN (:a, :b)", names: { "#kind": "kind" }, values: { ":a": "link_approved", ":b": "link_cleared" } },
        pageSize: 25,
      })) {
        return { seq: e.seq as number, after_json: (e.after_json as string | null) ?? null, source_client: (e.source_client as string | null) ?? null };
      }
      return null;
    },
  };
}

async function readHeadLive(ctx: DdbContext): Promise<number> {
  const h = await consistentGet(ctx, { pk: "META", sk: "HEAD" });
  return (h?.live as number | undefined) ?? 0;
}
