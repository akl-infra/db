// [LDB-DDB36] [LDB-DDB37] [LDB-DDB39] Auth on DynamoDB: eventual reads for the
// auth lookups (a revoked client is refused once the replica catches up),
// author upserts that keep META/AUTHORS exact, the Discord cache, and the
// item codec round trip.
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { afterEach, describe, expect, it } from "vitest";
import { ddbHarness } from "../harness/ddb";
import { authSchema, inlineIdempotencyBodies } from "../../src/store/ddb/schema/auth";

const { store, doc, tables, faults } = ddbHarness;
let n = 0;
const uid = (p: string) => `${p}${n++}${Math.random().toString(36).slice(2, 8)}`;
const AT = "2026-08-01T00:00:00.000Z";
const authorsHead = async () =>
  ((await doc.send(new GetCommand({ TableName: tables.main, Key: { pk: "META", sk: "AUTHORS" }, ConsistentRead: true }))).Item ?? {}) as { version?: number; count?: number; modified_at?: string };
const clientRow = (id: string) => ({
  id, name: "c", pubkey: "pk", owner_user_id: "111111111111111111", caps: "act-as-user", discord_app_id: null, status: "active" as const, created_at: AT, revoked_at: null,
});

afterEach(() => faults.clearFaults());

describe("client lookups are eventual", () => {
  it("[LDB-DDB36] client() reads with ConsistentRead false; a revoked client is refused after the lag, and a consistent read sees it at once", async () => {
    const id = uid("cl");
    await store.admin.insertClient(clientRow(id));
    expect(await store.auth.client(id)).toMatchObject({ id, status: "active", pubkey: "pk", caps: "act-as-user" });
    faults.staleReads(1);
    await store.admin.revokeClient(id, AT);
    // Inside the replica lag the eventual read may still say active ...
    expect((await store.auth.client(id))?.status).toBe("active");
    // ... the lag ends (the stale budget is spent) and the refusal follows.
    expect((await store.auth.client(id))?.status).toBe("revoked");
    // The admin side reads strongly and never lags.
    faults.staleReads(1);
    await store.admin.revokeClient(id, AT);
    expect((await store.admin.clientStatus(id))?.status).toBe("revoked");
  });

  it("[LDB-DDB36] authorName and rolesOf are eventual too; a missing client or author is null", async () => {
    expect(await store.auth.client(uid("nope"))).toBeNull();
    expect(await store.auth.authorName(uid("nope"))).toBeNull();
    const u = uid("u");
    expect(await store.auth.rolesOf(u)).toEqual({ admin: false, banned: false });
    await store.admin.insertAdmin({ user_id: u, added_by: null, added_at: AT, note: null });
    await store.admin.upsertBan({ user_id: u, by: "x", at: AT, reason: null });
    expect(await store.auth.rolesOf(u)).toEqual({ admin: true, banned: true });
  });
});

describe("author upserts keep META/AUTHORS exact", () => {
  it("[LDB-DDB37] touchClientAuthor inserts once (version and count +1), refreshes only when stale, and never regresses", async () => {
    const u = uid("u");
    const h0 = await authorsHead();
    expect(await store.auth.touchClientAuthor(u, AT, "2026-07-01T00:00:00.000Z")).toBe(u);
    const h1 = await authorsHead();
    expect(h1.version).toBe((h0.version ?? 0) + 1);
    expect(h1.count).toBe((h0.count ?? 0) + 1);
    expect(h1.modified_at).toBe(AT);
    // Inside the hour: no write at all.
    const before = ddbHarness.calls.snapshot();
    expect(await store.auth.touchClientAuthor(u, "2026-08-01T00:10:00.000Z", AT)).toBe(u);
    expect(ddbHarness.calls.snapshot().writes ?? 0).toBe(before.writes ?? 0);
    // Past it: last_seen_at moves, the head does not.
    expect(await store.auth.touchClientAuthor(u, "2026-08-01T02:00:00.000Z", "2026-08-01T01:00:00.000Z")).toBe(u);
    expect((await doc.send(new GetCommand({ TableName: tables.main, Key: { pk: "AUTHORS", sk: u }, ConsistentRead: true }))).Item).toMatchObject({
      last_seen_at: "2026-08-01T02:00:00.000Z", first_seen_at: AT, name_source: "client",
    });
    expect(await authorsHead()).toEqual(h1);
  });

  it("[LDB-DDB37] N concurrent first touches insert one author and move the head once", async () => {
    const u = uid("u");
    const h0 = await authorsHead();
    const names = await Promise.all(Array.from({ length: 8 }, () => store.auth.touchClientAuthor(u, AT, "2026-07-01T00:00:00.000Z")));
    expect(new Set(names)).toEqual(new Set([u]));
    const h1 = await authorsHead();
    expect(h1.version).toBe((h0.version ?? 0) + 1);
    expect(h1.count).toBe((h0.count ?? 0) + 1);
  });

  it("[LDB-DDB37] cacheAuthSuccess inserts, renames (version +1 only), keeps an admin-set name, and moves last_seen_at always", async () => {
    const u = uid("u");
    const base = { tokenHash: uid("th"), userId: u, appId: "app", expiresAt: "2026-08-01T00:05:00.000Z" };
    const h0 = await authorsHead();
    await store.auth.cacheAuthSuccess({ ...base, name: "Alice", at: AT });
    const h1 = await authorsHead();
    expect(h1.version).toBe((h0.version ?? 0) + 1);
    expect(h1.count).toBe((h0.count ?? 0) + 1);
    expect(await store.auth.author(u)).toEqual({ user_id: u, name: "Alice" });
    // Same name again: bookkeeping only.
    await store.auth.cacheAuthSuccess({ ...base, name: "Alice", at: "2026-08-01T00:01:00.000Z" });
    expect(await authorsHead()).toEqual(h1);
    // A rename.
    await store.auth.cacheAuthSuccess({ ...base, name: "Alicia", at: "2026-08-01T00:02:00.000Z" });
    const h2 = await authorsHead();
    expect(h2).toMatchObject({ version: h1.version! + 1, count: h1.count, modified_at: "2026-08-01T00:02:00.000Z" });
    // The admin names her; the next sign-in must not undo it.
    await store.admin.setAuthorNameByAdmin(u, "Alice Admin", "2026-08-01T00:03:00.000Z");
    const h3 = await authorsHead();
    expect(h3.version).toBe(h2.version! + 1);
    await store.auth.cacheAuthSuccess({ ...base, name: "Alicia Again", at: "2026-08-01T00:04:00.000Z" });
    expect(await store.auth.author(u)).toEqual({ user_id: u, name: "Alice Admin" });
    expect(await authorsHead()).toEqual(h3);
    expect((await doc.send(new GetCommand({ TableName: tables.main, Key: { pk: "AUTHORS", sk: u }, ConsistentRead: true }))).Item).toMatchObject({
      name_source: "admin", last_seen_at: "2026-08-01T00:04:00.000Z",
    });
    // The cache row came with it.
    expect(await store.auth.authCache(base.tokenHash)).toEqual({ user_id: u, name: "Alicia Again", app_id: "app", ok: 1, expires_at: base.expiresAt });
  });

  it("[LDB-DDB37] authors() orders by user_id or by name in BINARY order, and a refused or failed write changes nothing", async () => {
    const tag = uid("ord");
    const mk = async (id: string, name: string) => store.auth.cacheAuthSuccess({ tokenHash: uid("t"), userId: `${tag}${id}`, name, appId: null, expiresAt: AT, at: AT });
    await mk("3", "b");
    await mk("1", "B");
    await mk("2", "a\u{1F600}");
    await mk("4", "a￿");
    const mine = (rows: { user_id: string; name: string }[]) => rows.filter((r) => r.user_id.startsWith(tag));
    expect(mine(await store.auth.authors("user_id")).map((r) => r.user_id)).toEqual([`${tag}1`, `${tag}2`, `${tag}3`, `${tag}4`]);
    // UTF-8 byte order: "B" < "a￿" (EF BF BF) < "a😀" (F0 ...) < "b".
    expect(mine(await store.auth.authors("name")).map((r) => r.name)).toEqual(["B", "a￿", "a\u{1F600}", "b"]);
  });
});

describe("the Discord auth cache", () => {
  it("[LDB-DDB37] a failure and a success cache to the same key, reads null for an unknown hash, and prune drops the expired", async () => {
    const t = uid("th");
    expect(await store.auth.authCache(t)).toBeNull();
    await store.auth.cacheAuthFailure(t, "2026-08-01T00:01:00.000Z");
    expect(await store.auth.authCache(t)).toEqual({ user_id: null, name: null, app_id: null, ok: 0, expires_at: "2026-08-01T00:01:00.000Z" });
    await store.auth.cacheAuthSuccess({ tokenHash: t, userId: uid("u"), name: "N", appId: null, expiresAt: "2026-08-01T00:05:00.000Z", at: AT });
    expect(await store.auth.authCache(t)).toMatchObject({ ok: 1, app_id: null, expires_at: "2026-08-01T00:05:00.000Z" });
    await store.auth.pruneAuthCache("2026-08-01T00:06:00.000Z");
    expect(await store.auth.authCache(t)).toBeNull();
  });
});

describe("the item codec", () => {
  it("[LDB-DDB39] fromItems(toItems(rows)) returns the rows, for every table of the lane", async () => {
    const rows = {
      authors: [{ user_id: "u1", name: "A", first_seen_at: AT, last_seen_at: AT, name_source: "user" }],
      authors_head: [{ id: 1, version: 4, modified_at: AT, count: 1 }],
      admins: [
        { user_id: "u1", added_by: null, added_at: AT, note: "boot" },
        { user_id: "u2", added_by: "u1", added_at: AT, note: null },
      ],
      bans: [{ user_id: "u3", by: "u1", at: AT, reason: null }],
      clients: [clientRow("c1")],
      nonces: [{ client_id: "c1", nonce: "n", at: AT }],
      auth_cache: [{ token_hash: "th", user_id: null, name: null, app_id: null, ok: 0, expires_at: AT }],
      ratelimit: [{ key: "write:u1", window_start: 600, n: 3 }],
      idempotency: [{ scope: "client:c1", key: "k", method: "POST", path: "/p", request_hash: "h", status: 201, response_body: "{\"a\":1}\n", at: AT }],
    };
    const items = authSchema.toItems(rows);
    const back = authSchema.fromItems({ main: items.main, ephemeral: await inlineIdempotencyBodies(items.ephemeral) });
    expect(back).toEqual(rows);
    for (const it of [...items.main, ...items.ephemeral]) expect(authSchema.tableOf(it)).not.toBeNull();
    expect(items.main.find((i) => i.pk === "META" && i.sk === "ADMINS")?.count).toBe(2);
    expect(authSchema.tableOf({ pk: "RL#holds", sk: "2026-01-01" })).toBeNull();
    expect(authSchema.tableOf({ pk: "HOLD#c", sk: "LEASE" })).toBeNull();
  });
});
