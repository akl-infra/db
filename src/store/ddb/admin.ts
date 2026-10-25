// DynamoDB implementation of `AdminStore` (src/store/port.ts). Owner: P2 lane I
// (design/p2-p5-briefs.md; design/aws-port.md §2.2 R3-R6, §2.8).
//
// Eventual reads (design §8.5): `isAdmin` only. Every other read is strong.
// `META/ADMINS.count` is the admin counter (R4) that removeAdmin's `> 2`
// guard conditions on, in the same transaction as the delete.
import { BatchGetCommand, DeleteCommand, PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { internal } from "../../core/errors";
import type { AdminRow } from "../../core/admins";
import type { ClientRow } from "../../core/clients";
import type { BanRow } from "../../core/moderation";
import type { AdminStore } from "../port";
import { TxConditionFailed, type DdbContext, type Item, type TxItem } from "./contracts";
import { authorsHeadBump, batchDelete, cmpBinary, getAuthor, getItem, isConditionFailed, queryPartition } from "./auth";
import type { Key } from "./keys";
import { stateKey } from "./keys";
import { ADMINS_HEAD_KEY, ADMINS_PK, adminKey, authorKey, banKey, BANS_PK, clientKey, CLIENTS_PK, rateLimitPk } from "./keys-auth";
import { runTx, withRetry } from "./tx";

const MAX_ATTEMPTS = 8;

const adminRow = (it: Item): AdminRow => ({
  user_id: it.user_id as string,
  added_by: (it.added_by as string | null) ?? null,
  added_at: it.added_at as string,
  note: (it.note as string | null) ?? null,
});

const clientRow = (it: Item): ClientRow => ({
  id: it.id as string,
  name: it.name as string,
  pubkey: it.pubkey as string,
  owner_user_id: it.owner_user_id as string,
  caps: it.caps as string,
  discord_app_id: (it.discord_app_id as string | null) ?? null,
  status: it.status as ClientRow["status"],
  created_at: it.created_at as string,
  revoked_at: (it.revoked_at as string | null) ?? null,
});

export function ddbAdminStore(ctx: DdbContext): AdminStore {
  const { main, ephemeral } = ctx.tables;

  const setStatus = (id: string, status: string, extra?: { revokedAt: string }): TxItem => ({
    Update: {
      TableName: main,
      Key: clientKey(id),
      UpdateExpression: extra === undefined ? "SET #s = :s" : "SET #s = :s, revoked_at = :r",
      ConditionExpression: "attribute_exists(pk)",
      ExpressionAttributeNames: { "#s": "status" },
      ExpressionAttributeValues: { ":s": status, ...(extra === undefined ? {} : { ":r": extra.revokedAt }) },
    },
  });

  async function clients(): Promise<ClientRow[]> {
    const rows = (await queryPartition(ctx, main, CLIENTS_PK, true)).map(clientRow);
    return rows.sort((a, b) => cmpBinary(a.created_at, b.created_at) || cmpBinary(a.id, b.id));
  }

  return {
    async isAdmin(userId) {
      return (await getItem(ctx, main, adminKey(userId), false)) !== undefined;
    },

    async listAdmins() {
      const rows = (await queryPartition(ctx, main, ADMINS_PK, true)).map(adminRow);
      return rows.sort((a, b) => cmpBinary(a.added_at, b.added_at) || cmpBinary(a.user_id, b.user_id));
    },

    async getAdmin(userId) {
      const it = await getItem(ctx, main, adminKey(userId), true);
      return it === undefined ? null : adminRow(it);
    },

    async insertAdmin(row) {
      try {
        await runTx(ctx, [
          {
            tag: "admin",
            item: {
              Put: {
                TableName: main,
                Item: { ...adminKey(row.user_id), user_id: row.user_id, added_by: row.added_by, added_at: row.added_at, note: row.note },
                ConditionExpression: "attribute_not_exists(pk)",
              },
            },
          },
          {
            tag: "count",
            item: { Update: { TableName: main, Key: ADMINS_HEAD_KEY, UpdateExpression: "ADD #c :one", ExpressionAttributeNames: { "#c": "count" }, ExpressionAttributeValues: { ":one": 1 } } },
          },
        ]);
      } catch (e) {
        // D1's PRIMARY KEY refusal.
        if (e instanceof TxConditionFailed) throw new Error("UNIQUE constraint failed: admins.user_id");
        throw e;
      }
    },

    async removeAdmin(userId) {
      for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        try {
          await runTx(ctx, [
            { tag: "admin", item: { Delete: { TableName: main, Key: adminKey(userId), ConditionExpression: "attribute_exists(pk)" } } },
            {
              tag: "count",
              item: {
                Update: {
                  TableName: main,
                  Key: ADMINS_HEAD_KEY,
                  UpdateExpression: "ADD #c :minus",
                  ConditionExpression: "#c > :two",
                  ExpressionAttributeNames: { "#c": "count" },
                  ExpressionAttributeValues: { ":minus": -1, ":two": 2 },
                },
              },
            },
          ]);
          return { removed: true };
        } catch (e) {
          if (!(e instanceof TxConditionFailed)) throw e;
        }
        // Refused: say why, from strong reads, exactly as D1's follow-up SELECTs do.
        if ((await getItem(ctx, main, adminKey(userId), true)) === undefined) return { removed: false, exists: false, count: 0 };
        const count = ((await getItem(ctx, main, ADMINS_HEAD_KEY, true))?.count as number | undefined) ?? 2;
        if (count <= 2) return { removed: false, exists: true, count };
        // The admin is there and the count now allows it: another writer moved between the attempt and the read. Go again.
      }
      throw internal();
    },

    async listBans() {
      const bans = await queryPartition(ctx, main, BANS_PK, true);
      const names = new Map<string, string>();
      for (let i = 0; i < bans.length; i += 100) {
        let pending: Key[] = bans.slice(i, i + 100).map((b) => authorKey(b.user_id as string));
        for (let round = 0; pending.length > 0; round++) {
          if (round >= MAX_ATTEMPTS) throw internal();
          const todo = pending;
          const r = await withRetry(() => ctx.doc.send(new BatchGetCommand({ RequestItems: { [main]: { Keys: todo, ConsistentRead: true } } })));
          for (const a of (r.Responses?.[main] ?? []) as Item[]) names.set(a.user_id as string, a.name as string);
          pending = (r.UnprocessedKeys?.[main]?.Keys ?? []) as Key[];
        }
      }
      const rows: BanRow[] = bans.map((b) => ({
        user_id: b.user_id as string,
        by: b.by as string,
        at: b.at as string,
        reason: (b.reason as string | null) ?? null,
        name: names.get(b.user_id as string) ?? null,
      }));
      return rows.sort((a, b) => cmpBinary(a.at, b.at) || cmpBinary(a.user_id, b.user_id));
    },

    async banExists(userId) {
      return (await getItem(ctx, main, banKey(userId), true)) !== undefined;
    },

    async upsertBan(row) {
      await withRetry(() =>
        ctx.doc.send(new PutCommand({ TableName: main, Item: { ...banKey(row.user_id), user_id: row.user_id, by: row.by, at: row.at, reason: row.reason } })),
      );
    },

    async deleteBan(userId) {
      const r = await withRetry(() => ctx.doc.send(new DeleteCommand({ TableName: main, Key: banKey(userId), ReturnValues: "ALL_OLD" })));
      return r.Attributes !== undefined;
    },

    async setAuthorNameByAdmin(userId, name, at) {
      for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        const cur = await getAuthor(ctx, userId, true);
        if (cur === undefined) return; // D1's UPDATE of a missing row changes nothing.
        const update: TxItem = {
          Update: {
            TableName: main,
            Key: authorKey(userId),
            UpdateExpression: "SET #n = :n, name_source = :admin, last_seen_at = :at",
            ConditionExpression: "#n = :old",
            ExpressionAttributeNames: { "#n": "name" },
            ExpressionAttributeValues: { ":n": name, ":admin": "admin", ":at": at, ":old": cur.name },
          },
        };
        try {
          // A rename moves the authors head (the authors_head_on_rename trigger); a same-name write only moves bookkeeping.
          await runTx(ctx, [{ tag: "author", item: update }, ...(cur.name === name ? [] : [authorsHeadBump(ctx, at, false)])]);
          return;
        } catch (e) {
          if (!(e instanceof TxConditionFailed)) throw e;
        }
      }
      throw internal();
    },

    async insertClient(row) {
      try {
        await withRetry(() =>
          ctx.doc.send(
            new PutCommand({
              TableName: main,
              Item: {
                ...clientKey(row.id),
                id: row.id,
                name: row.name,
                pubkey: row.pubkey,
                owner_user_id: row.owner_user_id,
                caps: row.caps,
                discord_app_id: row.discord_app_id,
                status: "active",
                created_at: row.created_at,
                revoked_at: null,
              },
              ConditionExpression: "attribute_not_exists(pk)",
            }),
          ),
        );
      } catch (e) {
        if (isConditionFailed(e)) throw new Error("UNIQUE constraint failed: clients.id");
        throw e;
      }
    },

    async clientStatus(id) {
      const it = await getItem(ctx, main, clientKey(id), true);
      return it === undefined ? null : { status: it.status as ClientRow["status"], revoked_at: (it.revoked_at as string | null) ?? null };
    },

    async revokeClient(id, at) {
      try {
        await withRetry(() =>
          ctx.doc.send(
            new UpdateCommand({
              TableName: main,
              Key: clientKey(id),
              UpdateExpression: "SET #s = :s, revoked_at = :r",
              ConditionExpression: "attribute_exists(pk)",
              ExpressionAttributeNames: { "#s": "status" },
              ExpressionAttributeValues: { ":s": "revoked", ":r": at },
            }),
          ),
        );
      } catch (e) {
        if (!isConditionFailed(e)) throw e; // D1: no such client, no change.
      }
    },

    listClients: clients,

    async suspendClient(id, stateKeyName, stateValue) {
      const state: TxItem = { Put: { TableName: main, Item: { ...stateKey(stateKeyName), key: stateKeyName, value: stateValue } } };
      try {
        await runTx(ctx, [{ tag: "client", item: setStatus(id, "suspended") }, { tag: "state", item: state }]);
      } catch (e) {
        if (!(e instanceof TxConditionFailed)) throw e;
        // No such client: D1's UPDATE changes nothing and its INSERT still lands.
        await runTx(ctx, [{ tag: "state", item: state }]);
      }
    },

    async reactivateClient(id, stateKeyName, budgetKey) {
      // The client's destructive-budget windows: a handful (ttl two hours), read consistently, deleted with the status flip.
      const windows = await queryPartition(ctx, ephemeral, rateLimitPk(budgetKey), true);
      const keys: Key[] = windows.map((w) => ({ pk: w.pk as string, sk: w.sk as string }));
      const overflow = keys.splice(90);
      if (overflow.length > 0) await batchDelete(ctx, ephemeral, overflow);
      const rest: { tag: string; item: TxItem }[] = [
        { tag: "state", item: { Delete: { TableName: main, Key: stateKey(stateKeyName) } } },
        ...keys.map((k, i) => ({ tag: `window${i}`, item: { Delete: { TableName: ephemeral, Key: k } } as TxItem })),
      ];
      try {
        await runTx(ctx, [{ tag: "client", item: setStatus(id, "active") }, ...rest]);
      } catch (e) {
        if (!(e instanceof TxConditionFailed)) throw e;
        await runTx(ctx, rest); // No such client: D1's UPDATE changes nothing, its DELETEs still run.
      }
    },

    async suspendedClients() {
      return (await clients())
        .filter((c) => c.status === "suspended")
        .sort((a, b) => cmpBinary(a.id, b.id))
        .map((c) => ({ id: c.id, name: c.name }));
    },
  };
}
