// [LDB-DDB62] The DynamoDB port of tests/auth/rejection-dm-d1.test.ts (lane K): a moderation decision, its public event and
// its private outbox row commit or roll back together. The D1 file injects the fault with a trigger; here
// `testStore.faults` makes the client wrapper cancel any transaction touching an item of the named table.
//
// Two parts. The first drives lane J's real decision functions through the Worker's store and needs lanes J and N merged;
// until then it is skipped with the reason below (the main session removes the skip at merge). The second builds the same
// transaction from lane K's own pieces and runs now.
import { PutCommand, GetCommand, QueryCommand, ScanCommand } from "@aws-sdk/lib-dynamodb";
import { describe, expect, it } from "vitest";
import { ulid } from "ulidx";
import type { Actor } from "../../src/auth/actor";
import { rejectComment } from "../../src/core/comments";
import { approveWpm, rejectWpm } from "../../src/core/wpm";
import type { Bindings } from "../../src/env";
import { TxConditionFailed } from "../../src/store/ddb/contracts";
import { HEAD_KEY } from "../../src/store/ddb/keys";
import { mqnDirtyKey, outboxInsertItems, outboxKey, submissionKey } from "../../src/store/ddb/keys-discord";
import { discordSchema } from "../../src/store/ddb/schema/discord";
import { runEventTx } from "../../src/store/ddb/tx";
import { ddbHarness } from "../harness/ddb";
import { env, testStore } from "../harness";

const db = (env as unknown as Bindings).DB;
const { raw, tables, faults } = ddbHarness;
const T = tables.main;

async function ready(): Promise<string | null> {
  try {
    await testStore.count("layouts");
  } catch (e) {
    return `lane N's TestStore is not merged (${(e as Error).message})`;
  }
  try {
    await rejectComment(db, () => "2026-10-18T00:00:00.000Z", { user_id: "x", name: "x", via: "discord", admin: true, banned: false, source_client: "x" } as Actor, null, "no-such-comment", "r", { notifySubmitter: true }).catch((e: unknown) => {
      if (/not implemented/.test((e as Error).message)) throw e;
    });
  } catch (e) {
    return `lane J's stores are not merged (${(e as Error).message})`;
  }
  return null;
}
const skipReason = await ready();

const actor: Actor = {
  user_id: "900000000000000001", name: "moderator", via: "discord", admin: true, banned: false,
  source_client: "discord-app:test",
};
const t0 = "2026-10-18T00:00:00.000Z";
const clock = () => t0;
const recipient = "900000000000000002";
const ids = { layout: "", comment: "", link: "", wpm: "" };

async function setup(): Promise<void> {
  // Start each case with no delivery work left by the previous case.
  await testStore.remove("discord_rejection_dm_outbox", {});
  const layoutId = ulid();
  await testStore.insert("layouts", { id: layoutId, name: `dm-test-${layoutId.toLowerCase()}`, owner: actor.user_id, n: 1, layout_rev: 1, created_at: t0, modified_at: t0 });
  const commentId = ulid();
  const linkId = ulid();
  const wpmId = ulid();
  await testStore.insert("layout_comments", { id: commentId, layout_id: layoutId, user_id: recipient, body: "private text", via: "discord", submitted_at: t0, status: "pending" });
  await testStore.insert("link_submissions", { id: linkId, layout_id: layoutId, url: "https://example.org/submitted-link", submitted_by: recipient, submitted_at: t0, status: "pending" });
  await testStore.insert("wpm_submissions", { id: wpmId, layout_id: layoutId, user_id: recipient, wpm: 84, proof: "https://example.org/proof", submitted_by: recipient, via: "discord", submitted_at: t0, status: "pending" });
  Object.assign(ids, { layout: layoutId, comment: commentId, link: linkId, wpm: wpmId });
}

const outbox = (id: string) => testStore.row("discord_rejection_dm_outbox", { submission_id: id });

describe.skipIf(skipReason !== null)(`[LDB-DDB62] [LDB-MD18] rejection DM outbox (testStore fault injection)${skipReason === null ? "" : `: skipped, ${skipReason}`}`, () => {
  it("rolls back rejection state, event, and enqueue together if event insertion fails", async () => {
    await setup();
    await testStore.faults.failWrites("events");
    try {
      await expect(rejectComment(db, clock, actor, null, ids.comment, "reason", { notifySubmitter: true })).rejects.toThrow();
    } finally {
      await testStore.faults.clear();
    }
    expect((await testStore.row("layout_comments", { id: ids.comment }))?.status).toBe("pending");
    expect(await outbox(ids.comment)).toBeNull();
    expect(await testStore.count("events", { kind: "comment_rejected", layout_id: ids.layout })).toBe(0);
  });

  it("rolls back claim and public event when the final outbox statement fails", async () => {
    await setup();
    await testStore.faults.failWrites("discord_rejection_dm_outbox");
    try {
      await expect(rejectWpm(db, clock, actor, null, ids.wpm, "reason", { notifySubmitter: true })).rejects.toThrow();
    } finally {
      await testStore.faults.clear();
    }
    expect((await testStore.row("wpm_submissions", { id: ids.wpm }))?.status).toBe("pending");
    expect(await outbox(ids.wpm)).toBeNull();
    expect(await testStore.count("events", { kind: "wpm_rejected", layout_id: ids.layout })).toBe(0);
  });

  it("[LDB-MD23] rolls back an approval and its event when private enqueue fails", async () => {
    await setup();
    await testStore.faults.failWrites("discord_rejection_dm_outbox");
    try {
      await expect(approveWpm(db, clock, actor, null, ids.wpm, 0, true)).rejects.toBeTruthy();
    } finally {
      await testStore.faults.clear();
    }
    expect((await testStore.row("wpm_submissions", { id: ids.wpm }))?.status).toBe("pending");
    expect(await outbox(ids.wpm)).toBeNull();
    expect(await testStore.count("events", { kind: "wpm_approved", layout_id: ids.layout })).toBe(0);
  });
});

// --- lane K's own half: the transaction J builds, made from `outboxInsertItems` -----------------------------------

const get = async (k: { pk: string; sk: string }) => (await raw.send(new GetCommand({ TableName: T, Key: k, ConsistentRead: true }))).Item;
const countPk = async (pk: string) => (await raw.send(new QueryCommand({ TableName: T, KeyConditionExpression: "pk = :p", ExpressionAttributeValues: { ":p": pk }, ConsistentRead: true }))).Count ?? 0;

describe("decision transaction with an outbox row", () => {
  const ctx = { doc: ddbHarness.doc, tables, blobs: ddbHarness.blobs, catalog: undefined as never };
  const event = (kind: string) => ({
    at: t0, kind, layout_id: "LAY", name: "n", owner: "o", format: null, rev: null, actor: "mod", via: "discord", admin: 1,
    detail_json: null, before_json: null, after_json: null, source_client: null, source_version: null,
  });
  const decide = (id: string, over: { seq: number; nonce: string; key: string }) =>
    runEventTx(ctx, (b) => {
      b.event(event("comment_rejected"));
      b.item("sub", {
        Update: {
          TableName: T, Key: submissionKey("comment", id), UpdateExpression: "SET #s = :r", ConditionExpression: "#s = :p",
          ExpressionAttributeNames: { "#s": "status" }, ExpressionAttributeValues: { ":r": "rejected", ":p": "pending" },
        },
      });
      for (const x of outboxInsertItems(T, {
        delivery_key: over.key, event_seq: over.seq, kind: "comment", submission_id: id, layout_id: "LAY", recipient_id: "u1", nonce: over.nonce,
        next_attempt_at: t0, created_at: t0, updated_at: t0, review_version: 0, decision: "rejection",
      })) b.item(x.tag, x.item);
      b.item("mark", { Put: { TableName: T, Item: { ...mqnDirtyKey("comment", id) } } });
    });
  const seed = (id: string) => raw.send(new PutCommand({ TableName: T, Item: { ...submissionKey("comment", id), id, status: "pending", body: "x" } }));
  const seqOfHead = async () => ((await get(HEAD_KEY))?.seq as number | undefined) ?? 0;

  it("[LDB-DDB62] commits the claim, the public event, the outbox row, its claims and index and the dirty mark together", async () => {
    await seed("C1");
    const before = await seqOfHead();
    const { seqs } = await decide("C1", { seq: before + 1, nonce: "nonce-1", key: "rejection:comment:C1" });
    expect(seqs).toEqual([before + 1]);
    expect((await get(submissionKey("comment", "C1")))?.status).toBe("rejected");
    expect(await get(outboxKey("rejection:comment:C1"))).toMatchObject({ status: "pending", event_seq: before + 1, decision: "rejection" });
    expect(await countPk("DMO#nonce#nonce-1")).toBe(1);
    expect(await countPk("IX#dmo#due")).toBeGreaterThanOrEqual(1);
    expect(await get(mqnDirtyKey("comment", "C1"))).toBeDefined();
    const rows = discordSchema.fromItems({ main: (await raw.send(new ScanCommand({ TableName: T, ConsistentRead: true }))).Items ?? [], ephemeral: [] }).discord_rejection_dm_outbox!;
    expect(rows.map((r) => r.delivery_key)).toContain("rejection:comment:C1");
  });

  it("[LDB-DDB62] rolls everything back when the outbox write fails (injected), and commits after the fault clears", async () => {
    await seed("C2");
    const head = await seqOfHead();
    faults.failWritesFor((t) => discordSchema.tableOf({ ...t.key, ...t.item }) === "discord_rejection_dm_outbox");
    try {
      await expect(decide("C2", { seq: head + 1, nonce: "nonce-2", key: "rejection:comment:C2" })).rejects.toBeTruthy();
    } finally {
      faults.clearFaults();
    }
    expect((await get(submissionKey("comment", "C2")))?.status).toBe("pending");
    expect(await get(outboxKey("rejection:comment:C2"))).toBeUndefined();
    expect(await countPk("DMO#nonce#nonce-2")).toBe(0);
    expect(await get(mqnDirtyKey("comment", "C2"))).toBeUndefined();
    expect(await seqOfHead()).toBe(head); // the event and HEAD rolled back too
    await decide("C2", { seq: head + 1, nonce: "nonce-2", key: "rejection:comment:C2" });
    expect((await get(submissionKey("comment", "C2")))?.status).toBe("rejected");
    expect(await seqOfHead()).toBe(head + 1);
  });

  it("[LDB-DDB62] a taken nonce or event_seq fails the whole decision, as the UNIQUE constraints do", async () => {
    await seed("C3");
    await seed("C4");
    const head = await seqOfHead();
    await decide("C3", { seq: head + 1, nonce: "nonce-3", key: "rejection:comment:C3" });
    const err = await decide("C4", { seq: head + 100, nonce: "nonce-3", key: "rejection:comment:C4" }).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(TxConditionFailed);
    expect((err as TxConditionFailed).tags).toContain("dmo:nonce");
    expect((await get(submissionKey("comment", "C4")))?.status).toBe("pending");
    expect(await get(outboxKey("rejection:comment:C4"))).toBeUndefined();
    expect(await seqOfHead()).toBe(head + 1);
  });
});
