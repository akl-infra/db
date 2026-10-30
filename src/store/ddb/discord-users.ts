// DynamoDB implementation of `DiscordUserStore` (src/store/port.ts): the ONLY
// module that reads or writes `DUSERS/*` and `META/DISCORD_USERS` (D1:
// src/store/d1/discord-users.ts, migrations/0036). Reproduces that file
// statement by statement. The head version moves in the same transaction as
// the row, under conditions on the values it read, exactly when 0036's two
// triggers fire (an insert, or a username/global_name that really changes,
// compared null-safely as `IS NOT`).
import type { DiscordUserRow, DiscordUserStore } from "../port";
import { TxConditionFailed, type DdbContext, type Item, type TxItem } from "./contracts";
import { batchGet, compareBinary, getRows, queryPartition } from "./community";
import { DISCORD_USERS_HEAD_KEY, discordUserKey } from "./keys-auth";
import { wpmStatusKey } from "./keys-community";
import { getItem } from "./auth";
import { runTx } from "./tx";
import { internal } from "../../core/errors";

const MAX_ATTEMPTS = 8;

/** SQLite `TRIM(x)`: spaces (U+0020) only, no other whitespace. */
export function trimSpaces(s: string): string {
  let a = 0;
  let b = s.length;
  while (a < b && s[a] === " ") a++;
  while (b > a && s[b - 1] === " ") b--;
  return s.slice(a, b);
}

/**
 * `resolvedNameSql` of src/store/d1/discord-users.ts [LDB-WPM18]: `authors.name`
 * when non-null, non-blank (spaces only) and not the user id (returned as
 * stored, untrimmed); else the trimmed global name, else the trimmed username,
 * else null.
 */
export function resolveTypistName(userId: string, authorName: string | null | undefined, du: { username?: unknown; global_name?: unknown } | undefined): string | null {
  if (typeof authorName === "string" && trimSpaces(authorName) !== "" && authorName !== userId) return authorName;
  for (const v of [du?.global_name, du?.username]) {
    if (typeof v === "string" && trimSpaces(v) !== "") return trimSpaces(v);
  }
  return null;
}

/** The names `LEFT JOIN discord_users` lays beside a WPM read: one strong BatchGetItem pass over distinct ids. */
export async function discordUsersById(ctx: DdbContext, ids: readonly string[]): Promise<Map<string, Item>> {
  const items = await batchGet(ctx, ids.map(discordUserKey));
  return new Map(items.map((i) => [i.sk as string, i]));
}

/** The resolved typist name of each id: `authorNames` (authors.name, where stored) overlaid by the Discord fallback. Ids with no name are absent. */
export async function resolvedNames(ctx: DdbContext, ids: readonly string[], authorNames: ReadonlyMap<string, string>): Promise<Map<string, string>> {
  const distinct = [...new Set(ids)];
  const du = await discordUsersById(ctx, distinct);
  const out = new Map<string, string>();
  for (const id of distinct) {
    const n = resolveTypistName(id, authorNames.get(id), du.get(id));
    if (n !== null) out.set(id, n);
  }
  return out;
}

function toRow(it: Item): DiscordUserRow {
  return { id: it.id as string, username: it.username as string, global_name: (it.global_name as string | null | undefined) ?? null, updated_at: it.updated_at as string };
}

export function ddbDiscordUserStore(ctx: DdbContext): DiscordUserStore {
  const table = ctx.tables.main;
  const bump: TxItem = {
    Update: { TableName: table, Key: DISCORD_USERS_HEAD_KEY, UpdateExpression: "ADD version :one", ExpressionAttributeValues: { ":one": 1 } },
  };

  return {
    async upsert(r) {
      for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        const cur = await getItem(ctx, table, discordUserKey(r.id), true);
        const items: { tag: string; item: TxItem }[] = [];
        if (cur === undefined) {
          items.push(
            {
              tag: "row",
              item: {
                Put: {
                  TableName: table,
                  Item: { ...discordUserKey(r.id), id: r.id, username: r.username, global_name: r.globalName, updated_at: r.at },
                  ConditionExpression: "attribute_not_exists(pk)",
                },
              },
            },
            { tag: "discord_users_head", item: bump },
          );
        } else {
          const oldG = (cur.global_name as string | null | undefined) ?? null;
          const changed = cur.username !== r.username || oldG !== r.globalName;
          const names: Record<string, string> = { "#u": "username", "#g": "global_name" };
          const values: Record<string, unknown> = { ":u": r.username, ":g": r.globalName, ":at": r.at, ":oldu": cur.username };
          let cond = "#u = :oldu AND ";
          if (oldG === null) {
            cond += "(attribute_not_exists(#g) OR attribute_type(#g, :nul))";
            values[":nul"] = "NULL";
          } else {
            cond += "#g = :oldg";
            values[":oldg"] = oldG;
          }
          items.push({
            tag: "row",
            item: {
              Update: {
                TableName: table,
                Key: discordUserKey(r.id),
                UpdateExpression: "SET #u = :u, #g = :g, updated_at = :at",
                ConditionExpression: cond,
                ExpressionAttributeNames: names,
                ExpressionAttributeValues: values,
              },
            },
          });
          if (changed) items.push({ tag: "discord_users_head", item: bump });
        }
        try {
          await runTx(ctx, items);
          return;
        } catch (e) {
          if (!(e instanceof TxConditionFailed)) throw e;
        }
      }
      throw internal();
    },

    async get(id) {
      const it = await getItem(ctx, table, discordUserKey(id), true);
      return it === undefined ? null : toRow(it);
    },

    async version() {
      return ((await getItem(ctx, table, DISCORD_USERS_HEAD_KEY, true))?.version as number | undefined) ?? 0;
    },

    async missingWpmUsers(limit) {
      // Every typist with a pending, approved or rejected submission (the status index, re-checked on the row) ...
      const users = new Set<string>();
      for (const status of ["pending", "approved", "rejected"]) {
        const ix = await queryPartition(ctx, wpmStatusKey(status, "", "").pk);
        const rows = await getRows(ctx, "wpm", ix.map((i) => i.id as string));
        for (const row of rows) if (row.status === status) users.add(row.user_id as string);
      }
      // ... and no usable name: no discord_users row, authors.name missing, blank or the id.
      const ids = [...users];
      const [du, authors] = await Promise.all([
        discordUsersById(ctx, ids),
        batchGet(ctx, ids.map((id) => ({ pk: "AUTHORS", sk: id }))),
      ]);
      const authorName = new Map(authors.map((a) => [a.sk as string, a.name as unknown]));
      const missing = ids
        .filter((id) => {
          if (du.has(id)) return false;
          const n = authorName.get(id);
          return typeof n !== "string" || trimSpaces(n) === "" || n === id;
        })
        .sort(compareBinary);
      return { ids: limit < 0 ? missing : missing.slice(0, limit), total: missing.length };
    },
  };
}
