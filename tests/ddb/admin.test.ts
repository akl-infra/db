// [LDB-DDB38] Admin on DynamoDB: the admin counter guards removal under
// concurrency, bans join author names, client status changes are atomic with
// their side tables, and reactivation clears the destructive budget.
import { GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { describe, expect, it } from "vitest";
import { ddbHarness } from "../harness/ddb";

const { store, doc, tables, raw } = ddbHarness; // `raw` is the unfaulted client, for test setup writes
let n = 0;
const uid = (p: string) => `${p}${n++}${Math.random().toString(36).slice(2, 8)}`;
const AT = "2026-08-01T00:00:00.000Z";
const admin = (user_id: string, added_at = AT) => ({ user_id, added_by: null, added_at, note: null });
const adminCount = async () =>
  ((await doc.send(new GetCommand({ TableName: tables.main, Key: { pk: "META", sk: "ADMINS" }, ConsistentRead: true }))).Item?.count as number | undefined) ?? 0;

describe("admins", () => {
  it("[LDB-DDB38] insert, get, list in (added_at, user_id) order, and a duplicate insert refuses", async () => {
    const [a, b, c] = [uid("a"), uid("b"), uid("c")];
    await store.admin.insertAdmin(admin(b, "2026-08-02T00:00:00.000Z"));
    await store.admin.insertAdmin(admin(c, AT));
    await store.admin.insertAdmin(admin(a, AT));
    await expect(store.admin.insertAdmin(admin(a))).rejects.toThrow(/UNIQUE/);
    expect(await store.admin.getAdmin(a)).toEqual(admin(a));
    expect(await store.admin.getAdmin(uid("none"))).toBeNull();
    expect(await store.admin.isAdmin(a)).toBe(true);
    const mine = (await store.admin.listAdmins()).map((r) => r.user_id).filter((u) => [a, b, c].includes(u));
    expect(mine).toEqual([a, c, b]);
    expect(await adminCount()).toBeGreaterThanOrEqual(3);
  });

  it("[LDB-DDB38] removal keeps at least two admins, and of N concurrent removals at the floor+1 exactly one lands", async () => {
    // Bring the set to exactly four (the table is this file's own).
    const have = await store.admin.listAdmins();
    const ids = have.map((r) => r.user_id);
    while (ids.length < 4) {
      const u = uid("x");
      await store.admin.insertAdmin(admin(u));
      ids.push(u);
    }
    // Remove down to three, then race the three removals: only one may win (3 -> 2).
    for (const u of ids.slice(3)) expect(await store.admin.removeAdmin(u)).toEqual({ removed: true });
    const keep = ids.slice(0, 3);
    expect(await adminCount()).toBe(3);
    const results = await Promise.all(keep.map((u) => store.admin.removeAdmin(u)));
    expect(results.filter((r) => r.removed)).toHaveLength(1);
    expect(results.filter((r) => !r.removed)).toEqual([{ removed: false, exists: true, count: 2 }, { removed: false, exists: true, count: 2 }]);
    expect(await adminCount()).toBe(2);
    expect((await store.admin.listAdmins()).length).toBe(2);
    expect(await store.admin.removeAdmin(uid("ghost"))).toEqual({ removed: false, exists: false, count: 0 });
  });
});

describe("bans", () => {
  it("[LDB-DDB38] upsert replaces, delete reports whether a ban existed, and the list joins author names in (at, user_id) order", async () => {
    const [u1, u2, u3] = [uid("u"), uid("u"), uid("u")];
    await store.auth.cacheAuthSuccess({ tokenHash: uid("t"), userId: u1, name: "One", appId: null, expiresAt: AT, at: AT });
    await store.admin.upsertBan({ user_id: u2, by: "mod", at: "2026-08-03T00:00:00.000Z", reason: "r" });
    await store.admin.upsertBan({ user_id: u1, by: "mod", at: "2026-08-02T00:00:00.000Z", reason: null });
    await store.admin.upsertBan({ user_id: u3, by: "mod", at: "2026-08-02T00:00:00.000Z", reason: null });
    await store.admin.upsertBan({ user_id: u1, by: "mod2", at: "2026-08-02T00:00:00.000Z", reason: "again" });
    expect(await store.admin.banExists(u1)).toBe(true);
    const mine = (await store.admin.listBans()).filter((b) => [u1, u2, u3].includes(b.user_id));
    expect(mine).toEqual([
      { user_id: u1, name: "One", by: "mod2", at: "2026-08-02T00:00:00.000Z", reason: "again" },
      { user_id: u3, name: null, by: "mod", at: "2026-08-02T00:00:00.000Z", reason: null },
      { user_id: u2, name: null, by: "mod", at: "2026-08-03T00:00:00.000Z", reason: "r" },
    ].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.user_id < b.user_id ? -1 : 1)));
    expect(await store.admin.deleteBan(u1)).toBe(true);
    expect(await store.admin.deleteBan(u1)).toBe(false);
    expect(await store.admin.banExists(u1)).toBe(false);
  });

  it("[LDB-DDB38] renaming a missing author changes nothing", async () => {
    const u = uid("ghost");
    await store.admin.setAuthorNameByAdmin(u, "X", AT);
    expect(await store.auth.author(u)).toBeNull();
  });
});

describe("clients", () => {
  const row = (id: string, created_at = AT) => ({
    id, name: `n-${id}`, pubkey: "pk", owner_user_id: "111111111111111111", caps: "act-as-user", discord_app_id: "app", status: "active" as const, created_at, revoked_at: null,
  });

  it("[LDB-DDB38] register, status, revoke, list in (created_at, id) order, and a duplicate id refuses", async () => {
    const [a, b] = [uid("c"), uid("c")];
    await store.admin.insertClient(row(b, "2026-08-02T00:00:00.000Z"));
    await store.admin.insertClient(row(a));
    await expect(store.admin.insertClient(row(a))).rejects.toThrow(/UNIQUE/);
    expect(await store.admin.clientStatus(a)).toEqual({ status: "active", revoked_at: null });
    await store.admin.revokeClient(a, "2026-08-05T00:00:00.000Z");
    expect(await store.admin.clientStatus(a)).toEqual({ status: "revoked", revoked_at: "2026-08-05T00:00:00.000Z" });
    expect(await store.admin.clientStatus(uid("none"))).toBeNull();
    await store.admin.revokeClient(uid("none"), AT); // no row, no change, no phantom
    const mine = (await store.admin.listClients()).filter((c) => [a, b].includes(c.id));
    expect(mine.map((c) => c.id)).toEqual([a, b]);
    expect(mine[0]).toMatchObject({ discord_app_id: "app", status: "revoked" });
  });

  it("[LDB-DDB38] suspend sets the status and the suspend state together; reactivate clears the state and the destructive windows", async () => {
    const id = uid("c");
    await store.admin.insertClient(row(id));
    await store.admin.suspendClient(id, `client.${id}.suspend`, "{\"at\":1}");
    expect(await store.admin.clientStatus(id)).toMatchObject({ status: "suspended" });
    expect((await store.admin.suspendedClients()).some((c) => c.id === id)).toBe(true);
    const state = await doc.send(new GetCommand({ TableName: tables.main, Key: { pk: "STATE", sk: `client.${id}.suspend` }, ConsistentRead: true }));
    expect(state.Item).toMatchObject({ key: `client.${id}.suspend`, value: "{\"at\":1}" });
    // Lane G's budget windows for this client, plus another client's that must survive.
    const budget = `destructive:${id}`;
    for (const w of [0, 3600]) await raw.send(new PutCommand({ TableName: tables.ephemeral, Item: { pk: `RL#${budget}`, sk: String(w), n: 5, ttl: w + 7200 } }));
    await raw.send(new PutCommand({ TableName: tables.ephemeral, Item: { pk: `RL#destructive:other`, sk: "0", n: 5 } }));
    await store.admin.reactivateClient(id, `client.${id}.suspend`, budget);
    expect(await store.admin.clientStatus(id)).toMatchObject({ status: "active" });
    expect((await store.admin.suspendedClients()).some((c) => c.id === id)).toBe(false);
    expect((await doc.send(new GetCommand({ TableName: tables.main, Key: { pk: "STATE", sk: `client.${id}.suspend` }, ConsistentRead: true }))).Item).toBeUndefined();
    for (const w of ["0", "3600"]) {
      expect((await doc.send(new GetCommand({ TableName: tables.ephemeral, Key: { pk: `RL#${budget}`, sk: w }, ConsistentRead: true }))).Item).toBeUndefined();
    }
    expect((await doc.send(new GetCommand({ TableName: tables.ephemeral, Key: { pk: "RL#destructive:other", sk: "0" }, ConsistentRead: true }))).Item).toBeDefined();
    // The next hit on the same window starts from 1: nothing re-trips.
    expect((await store.auth.hitWindow(budget, 0)).n).toBe(1);
  });

  it("[LDB-DDB38] suspending or reactivating a client that does not exist writes no phantom client", async () => {
    const id = uid("ghost");
    await store.admin.suspendClient(id, `client.${id}.suspend`, "v");
    await store.admin.reactivateClient(id, `client.${id}.suspend`, `destructive:${id}`);
    expect(await store.admin.clientStatus(id)).toBeNull();
  });
});
