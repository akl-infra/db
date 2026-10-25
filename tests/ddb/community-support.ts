// Shared fixtures of lane J's tests (tests/ddb/{links,wpm,comments,review,reopen-fault}.test.ts):
// layouts and rows seeded through the lane codecs, the stores under test, and
// an index checker that rebuilds every derived item from the primary rows.
import { createHash } from "node:crypto";
import { BatchWriteCommand, ScanCommand } from "@aws-sdk/lib-dynamodb";
import { expect } from "vitest";
import { ddbHarness } from "../harness/ddb";
import type { DdbContext, Item, RowsByTable } from "../../src/store/ddb/contracts";
import { ddbCommentStore } from "../../src/store/ddb/comments";
import { ddbLinkStore } from "../../src/store/ddb/links";
import { ddbReviewStore } from "../../src/store/ddb/review";
import { ddbWpmStore } from "../../src/store/ddb/wpm";
import { communitySchema } from "../../src/store/ddb/schema/community";
import { coreSchema } from "../../src/store/ddb/schema/core";
import { txTuning } from "../../src/store/ddb/tx";
import type { GatedEvent, HistoryIntent, OutboxIntent } from "../../src/store/port";

txTuning.sleep = async () => {};

export const ctx: DdbContext = { ...ddbHarness.ctxBase, catalog: undefined as never };
export const links = ddbLinkStore(ctx);
export const wpm = ddbWpmStore(ctx);
export const comments = ddbCommentStore(ctx);
export const review = ddbReviewStore(ctx);

export const AT = "2026-10-18T01:00:00.000Z";
export const MOD = "900000000000000001";
export const USER = "900000000000000002";
export const OTHER = "900000000000000003";

let counter = 0;
/** A fresh, sortable 26-character id. */
export function id(prefix = "01X"): string {
  counter++;
  return `${prefix}${String(counter).padStart(23, "0")}`;
}

export async function scanMain(): Promise<Item[]> {
  const out: Item[] = [];
  let start: Record<string, unknown> | undefined;
  do {
    const res = await ddbHarness.raw.send(new ScanCommand({ TableName: ddbHarness.tables.main, ConsistentRead: true, ...(start === undefined ? {} : { ExclusiveStartKey: start }) }));
    out.push(...((res.Items ?? []) as Item[]));
    start = res.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (start !== undefined);
  return out;
}

export async function putItems(items: readonly Item[]): Promise<void> {
  for (let i = 0; i < items.length; i += 25) {
    await ddbHarness.raw.send(
      new BatchWriteCommand({ RequestItems: { [ddbHarness.tables.main]: items.slice(i, i + 25).map((Item) => ({ PutRequest: { Item } })) } }),
    );
  }
}

export async function seedLayout(over: Record<string, unknown> = {}): Promise<{ id: string; name: string; owner: string }> {
  const layoutId = (over.id as string | undefined) ?? id("01L");
  const row = {
    id: layoutId, name: `layout-${layoutId.toLowerCase()}`, owner: USER, n: 1, layout_rev: 1, created_at: AT, modified_at: AT, deleted: 0,
    like_count: 0, like_adjust: 0, link: null, upstream_source: null, upstream_id: null, upstream_state: null, source_client: null, source_version: null,
    ...over,
  };
  await putItems(coreSchema.toItems({ layouts: [row], layout_formats: [] }).main);
  return { id: layoutId, name: row.name as string, owner: row.owner as string };
}

/** Insert primary rows through the lane codec (counters are written whole: call once per pair/layout). */
export async function seedRows(rows: RowsByTable): Promise<void> {
  await putItems(communitySchema.toItems(rows).main);
}

export async function itemOf(pk: string, sk: string): Promise<Item | undefined> {
  return (await scanMain()).find((i) => i.pk === pk && i.sk === sk);
}

export async function eventsOf(kind: string): Promise<Item[]> {
  return (await scanMain()).filter((i) => i.pk === "EV" && i.kind === kind);
}

const key = (i: Item): string => `${i.pk}\u0000${i.sk}`;

/**
 * The index checker (R2/R4/R5): every item of lane J's tables equals what
 * `toItems(fromItems(primary items))` derives, and nothing else of lane J's
 * exists. Run after every scenario.
 */
export async function expectIndexesConsistent(): Promise<void> {
  const mine = (await scanMain()).filter((i) => communitySchema.tableOf(i) !== null);
  const rows = communitySchema.fromItems({ main: mine, ephemeral: [] });
  const derived = communitySchema.toItems(rows).main;
  const strip = (i: Item): Item => JSON.parse(JSON.stringify(i));
  const live = new Map(mine.map((i) => [key(i), strip(i)]));
  const want = new Map(derived.map((i) => [key(i), strip(i)]));
  expect([...live.keys()].sort()).toEqual([...want.keys()].sort());
  for (const [k, v] of want) expect(live.get(k), k).toEqual(v);
}

export function moderation(over: Partial<GatedEvent> & { kind: string; layoutId: string }): GatedEvent {
  return { actor: MOD, via: "discord", source: { client: "discord-app:test", version: null }, ...over } as GatedEvent;
}

export function history(over: Partial<HistoryIntent> & { kind: "comment" | "wpm"; submissionId: string; action: HistoryIntent["action"] }): HistoryIntent {
  return { actor: MOD, at: AT, reason: null, reviewVersion: 0, ...over };
}

export function outbox(over: Partial<OutboxIntent> & { kind: OutboxIntent["kind"]; submissionId: string; layoutId: string }): OutboxIntent {
  const rv = over.reviewVersion ?? 0;
  const decision = over.decision ?? "rejection";
  const deliveryKey = `${decision}:${over.kind}:${over.submissionId}${rv ? `:${rv}` : ""}`;
  return { decision, deliveryKey, nonce: createHash("sha1").update(deliveryKey).digest("hex").slice(0, 24), recipientId: USER, at: AT, reviewVersion: rv, ...over };
}
