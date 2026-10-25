// [LDB-WPM18..LDB-WPM20] A known Discord name for every WPM typist
// (migrations/0036_discord_users.sql, docs/decisions/28-wpm-records.md):
// the self-lookup after a submit, the akldb-bot lookup on the admin
// entry, the backfill route, and the read precedence. Black-box via
// SELF.fetch; Discord is a stubbed global fetch, never the network.
import { env, store, testStore } from "../harness";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ulid } from "ulidx";
import type { Bindings } from "../../src/env";
import { commitWrite, type CommitInput } from "../../src/core/events";
import { steppingClock } from "../../src/core/time";
import { AKL_PAYLOAD, BOOTSTRAP_ADMIN, actorFixture, pinTestClock, register, uniqueName, writeFetch } from "./write-support";

const bindings = env as unknown as Bindings;
const originalBotToken = bindings.MODQUEUE_DISCORD_BOT_TOKEN;
const BOT_TOKEN = "test-akldb-bot-secret";
const clock = steppingClock("2026-10-02T00:00:00.000Z", 1000);
pinTestClock(env as unknown as { TEST_CLOCK?: typeof clock }, clock);
const PROOF = "https://www.youtube.com/watch?v=wpm-names";

let warn: ReturnType<typeof vi.spyOn>;
// The Worker's background work (the post-202 name lookup), collected by the
// platform's TEST_BACKGROUND hatch so a test awaits it instead of sleeping.
const background = () => (env as unknown as { TEST_BACKGROUND: Promise<unknown>[] }).TEST_BACKGROUND;
const settle = async () => { while (background().length > 0) await Promise.all(background().splice(0)); };
beforeEach(() => {
  (env as unknown as { TEST_BACKGROUND: Promise<unknown>[] }).TEST_BACKGROUND = [];
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(async () => {
  await settle();
  delete (env as unknown as { TEST_BACKGROUND?: unknown }).TEST_BACKGROUND;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  bindings.MODQUEUE_DISCORD_BOT_TOKEN = originalBotToken;
});

let idCounter = 0;
function userId(): string {
  idCounter++;
  return `34000000000000${String(idCounter).padStart(4, "0")}`;
}
let tokenCounter = 0;
const token = (label: string) => `tok-wpm-names-${label}-${++tokenCounter}`;

async function createLayout(owner: string): Promise<string> {
  const input: CommitInput = {
    layoutId: ulid(), creating: true, currentN: 0, currentLayout: null, currentFormats: new Map(),
    layout: { kind: "created", name: uniqueName("wpm-names"), owner, created_at: clock(), deleted: false },
    format: { kind: "format_added", lineage: "spark", format: "spark/1", payload: AKL_PAYLOAD, hasMagic: false },
    modified_at: clock(), actor: owner, via: "discord", source: { client: "discord-app:test", version: null }, upstream: null,
  };
  return (await commitWrite(store, clock, input)).layout.id;
}

interface Rec { user_id: string; user_name: string | null; wpm: number }
async function records(query: string): Promise<Rec[]> {
  const res = await writeFetch(`/v1/wpm${query}`, "GET");
  expect(res.status).toBe(200);
  return ((await res.json()) as { records: Rec[] }).records;
}

// Discord stub: actor lookups go to the fake, `/users/<id>` to `users`.
type UserAnswer = { status: number; body: unknown } | "hang" | "throw";
function stubDiscord(users: Map<string, UserAnswer>, seen: { url: string; auth: string }[] = []) {
  const fake = actorFixture();
  const actors = fake.fetchImpl;
  vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const m = /\/v10\/users\/(\d{17,20})$/.exec(url);
    if (m === null) return actors(url, { headers: { Authorization: new Headers(init?.headers).get("Authorization") ?? "" } });
    seen.push({ url, auth: new Headers(init?.headers).get("Authorization") ?? "" });
    const answer = users.get(m[1]!);
    if (answer === "throw") return Promise.reject(new TypeError("network down"));
    if (answer === "hang") return new Promise((_, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "TimeoutError"))));
    return Promise.resolve(Response.json(answer?.body ?? {}, { status: answer?.status ?? 404 }));
  });
  return fake;
}
const userJson = (username: string, global_name: string | null): UserAnswer => ({ status: 200, body: { id: "x", username, global_name } });
const notFound: UserAnswer = { status: 404, body: { message: "Unknown User" } };

describe("[LDB-WPM18] POST /v1/wpm learns the typist's name itself", () => {
  async function submit(user: string, users: Map<string, UserAnswer>, seen: { url: string; auth: string }[]) {
    const layout = await createLayout(user);
    const auth = register(stubDiscord(users, seen), token("submit"), user);
    return writeFetch("/v1/wpm", "POST", auth, { layout, wpm: 90, proof: PROOF });
  }

  it("[LDB-WPM18] the request surface is unchanged: user_name (or any extra field) is still 400 bad_request", async () => {
    const user = userId();
    const layout = await createLayout(user);
    const auth = register(actorFixture(), token("extra"), user);
    for (const extra of [{ user_name: "typist" }, { username: "x" }]) {
      const res = await writeFetch("/v1/wpm", "POST", auth, { layout, wpm: 90, proof: PROOF, ...extra });
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: "bad_request" });
    }
    expect(await testStore.rows("wpm_submissions", { layout_id: layout })).toHaveLength(0);
  });

  it("[LDB-WPM18] a submit answers 202, then looks the actor up with the bot and stores the names", async () => {
    bindings.MODQUEUE_DISCORD_BOT_TOKEN = BOT_TOKEN;
    const user = userId();
    const seen: { url: string; auth: string }[] = [];
    const res = await submit(user, new Map([[user, userJson("self_handle", "Self Display")]]), seen);
    expect(res.status).toBe(202);
    await settle();
    expect(await testStore.row("discord_users", { id: user })).toMatchObject({ username: "self_handle", global_name: "Self Display" });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.auth).toBe(`Bot ${BOT_TOKEN}`);
  });

  it("[LDB-WPM18] a name looked up within 7 days is not looked up again; an older one is, and the freshness stamp moves", async () => {
    bindings.MODQUEUE_DISCORD_BOT_TOKEN = BOT_TOKEN;
    const fresh = userId();
    await testStore.insert("discord_users", { id: fresh, username: "kept", global_name: null, updated_at: clock() });
    const seen: { url: string; auth: string }[] = [];
    expect((await submit(fresh, new Map([[fresh, userJson("changed", null)]]), seen)).status).toBe(202);
    await settle();
    expect(seen).toHaveLength(0);
    expect(await testStore.row("discord_users", { id: fresh })).toMatchObject({ username: "kept" });

    const stale = userId();
    await testStore.insert("discord_users", { id: stale, username: "old", global_name: null, updated_at: "2026-09-01T00:00:00.000Z" });
    expect((await submit(stale, new Map([[stale, userJson("old", null)]]), seen)).status).toBe(202);
    await settle();
    expect(seen).toHaveLength(1);
    expect((await testStore.row("discord_users", { id: stale }))!.updated_at).not.toBe("2026-09-01T00:00:00.000Z");
  });

  it("[LDB-WPM18] a Discord failure or a missing bot token never fails or blocks the submit", async () => {
    for (const [token_, answer] of [[BOT_TOKEN, notFound], [BOT_TOKEN, "throw"], [undefined, userJson("x", null)]] as [string | undefined, UserAnswer][]) {
      bindings.MODQUEUE_DISCORD_BOT_TOKEN = token_;
      const user = userId();
      const res = await submit(user, new Map([[user, answer]]), []);
      expect(res.status).toBe(202);
      await settle();
      expect(await testStore.rows("wpm_submissions", { user_id: user, status: "pending" })).toHaveLength(1);
      expect(await testStore.row("discord_users", { id: user })).toBeNull();
    }
  });
});

describe("[LDB-WPM19] POST /v1/admin/wpm resolves the typist's name", () => {
  async function enter(target: string, users: Map<string, UserAnswer>, seen?: { url: string; auth: string }[]) {
    const layout = await createLayout(userId());
    const admin = register(stubDiscord(users, seen), token("admin"), BOOTSTRAP_ADMIN);
    const res = await writeFetch("/v1/admin/wpm", "POST", admin, { user_id: target, layout, wpm: 101, proof: PROOF });
    return { res, layout };
  }

  it("[LDB-WPM19] success: asks Discord with the bot token, stores username and global_name, and the record carries the name", async () => {
    bindings.MODQUEUE_DISCORD_BOT_TOKEN = BOT_TOKEN;
    const target = userId();
    const seen: { url: string; auth: string }[] = [];
    const { res } = await enter(target, new Map([[target, userJson("handle", "Display")]]), seen);
    expect(res.status).toBe(201);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.auth).toBe(`Bot ${BOT_TOKEN}`);
    expect(seen[0]!.url).toMatch(new RegExp(`/users/${target}$`));
    expect(await testStore.row("discord_users", { id: target })).toMatchObject({ username: "handle", global_name: "Display" });
    expect(await records(`?user=${target}`)).toMatchObject([{ user_name: "Display", wpm: 101 }]);
  });

  it("[LDB-WPM19] a Discord 404, a network error and an aborted request each still save the entry, warn, and store nothing", async () => {
    bindings.MODQUEUE_DISCORD_BOT_TOKEN = BOT_TOKEN;
    for (const answer of [notFound, "throw", "hang"] as UserAnswer[]) {
      const target = userId();
      const { res } = await enter(target, new Map([[target, answer]]));
      expect(res.status, String(answer)).toBe(201);
      expect(await testStore.rows("wpm_submissions", { user_id: target, status: "approved" })).toHaveLength(1);
      expect(await testStore.row("discord_users", { id: target })).toBeNull();
    }
  });

  it("[LDB-WPM19] a missing bot token saves anyway without asking Discord, and no warning ever contains the token", async () => {
    bindings.MODQUEUE_DISCORD_BOT_TOKEN = undefined;
    const target = userId();
    const seen: { url: string; auth: string }[] = [];
    const { res } = await enter(target, new Map([[target, userJson("handle", null)]]), seen);
    expect(res.status).toBe(201);
    expect(seen).toHaveLength(0);
    expect(warn).toHaveBeenCalled();
    bindings.MODQUEUE_DISCORD_BOT_TOKEN = BOT_TOKEN;
    const other = userId();
    await enter(other, new Map([[other, "throw"]]));
    expect(JSON.stringify(warn.mock.calls)).not.toContain(BOT_TOKEN);
  });

  it("[LDB-WPM19] a lookup that never answers is cut at the timeout, not awaited forever", async () => {
    const { lookupDiscordUser } = await import("../../src/core/discord-users");
    const out = await lookupDiscordUser(
      { DISCORD_API_URL: "https://discord.test/api", MODQUEUE_DISCORD_BOT_TOKEN: BOT_TOKEN },
      "340000000000009999",
      { timeoutMs: 20, fetchImpl: ((_u: string, init?: RequestInit) => new Promise((_, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("t"))))) as unknown as typeof fetch },
    );
    expect(out).toBeNull();
  });
});

describe("[LDB-WPM18] Discord's deleted-account placeholder never overwrites a name", () => {
  const deleted = (id: string): [string, UserAnswer][] => [[id, { status: 200, body: { id, username: "deleted_user_1a2b3c4d", global_name: null } }]];
  const deletedGlobal = (id: string): [string, UserAnswer][] => [[id, { status: 200, body: { id, username: "someone", global_name: "Deleted User" } }]];

  it("[LDB-WPM18] after a submit: a stored row stays untouched (updated_at too), and no row is created when there was none", async () => {
    bindings.MODQUEUE_DISCORD_BOT_TOKEN = BOT_TOKEN;
    for (const answer of [deleted, deletedGlobal]) {
      const kept = userId();
      await testStore.insert("discord_users", { id: kept, username: "real_name", global_name: "Real Display", updated_at: "2026-09-01T00:00:00.000Z" });
      const none = userId();
      for (const user of [kept, none]) {
        const seen: { url: string; auth: string }[] = [];
        const layout = await createLayout(user);
        const auth = register(stubDiscord(new Map(answer(user)), seen), token("deleted"), user);
        expect((await writeFetch("/v1/wpm", "POST", auth, { layout, wpm: 90, proof: PROOF })).status).toBe(202);
        await settle();
        expect(seen, user).toHaveLength(1);
      }
      expect(await testStore.row("discord_users", { id: kept })).toEqual({ id: kept, username: "real_name", global_name: "Real Display", updated_at: "2026-09-01T00:00:00.000Z" });
      expect(await testStore.row("discord_users", { id: none })).toBeNull();
    }
  });

  it("[LDB-WPM19] on the admin entry the same holds, and the entry is still saved", async () => {
    bindings.MODQUEUE_DISCORD_BOT_TOKEN = BOT_TOKEN;
    const kept = userId();
    await testStore.insert("discord_users", { id: kept, username: "real_name", global_name: null, updated_at: "2026-09-01T00:00:00.000Z" });
    const none = userId();
    const layout = await createLayout(userId());
    const admin = register(stubDiscord(new Map([...deleted(kept), ...deletedGlobal(none)])), token("deleted-admin"), BOOTSTRAP_ADMIN);
    for (const user of [kept, none]) {
      expect((await writeFetch("/v1/admin/wpm", "POST", admin, { user_id: user, layout, wpm: 101, proof: PROOF })).status).toBe(201);
    }
    expect(await testStore.row("discord_users", { id: kept })).toMatchObject({ username: "real_name", updated_at: "2026-09-01T00:00:00.000Z" });
    expect(await testStore.row("discord_users", { id: none })).toBeNull();
  });
});

describe("[LDB-WPM20] POST /v1/admin/discord-users/refresh", () => {
  async function fresh(): Promise<void> {
    await testStore.remove("wpm_submissions", {});
    await testStore.remove("discord_users", {});
  }
  async function addRecord(layout: string, user: string, status = "approved"): Promise<void> {
    await testStore.insert("wpm_submissions", {
      id: ulid(), layout_id: layout, user_id: user, wpm: 80, proof: PROOF, submitted_by: user, via: "discord",
      submitted_at: "2026-09-01T00:00:00.000Z", status, decided_by: null, decided_at: null, reason: null,
    });
  }

  it("[LDB-WPM20] is admin-only (403 for a user, 401 without credentials) and rejects a bad limit or body", async () => {
    await fresh();
    const fake = stubDiscord(new Map());
    const admin = register(fake, token("refresh-admin"), BOOTSTRAP_ADMIN);
    const plain = register(fake, token("refresh-user"), userId());
    expect((await writeFetch("/v1/admin/discord-users/refresh", "POST", plain, {})).status).toBe(403);
    expect((await writeFetch("/v1/admin/discord-users/refresh", "POST")).status).toBe(401);
    for (const limit of [0, 51, 1.5, "5", null]) {
      const res = await writeFetch("/v1/admin/discord-users/refresh", "POST", admin, { limit });
      expect(res.status, String(limit)).toBe(400);
      expect(await res.json()).toMatchObject({ error: "bad_request", param: "limit" });
    }
    expect((await writeFetch("/v1/admin/discord-users/refresh", "POST", admin, { limite: 5 })).status).toBe(400);
  });

  it("[LDB-WPM20] resolves exactly the typists with no usable name, honours limit, and re-running touches only what is still missing", async () => {
    bindings.MODQUEUE_DISCORD_BOT_TOKEN = BOT_TOKEN;
    await fresh();
    const layout = await createLayout(userId());
    const [noRow, blank, isId, named, haveDu, gone, superseded, pendingOnly] = Array.from({ length: 8 }, userId) as [string, string, string, string, string, string, string, string];
    for (const [u, status] of [[noRow, "approved"], [blank, "pending"], [isId, "rejected"], [named, "approved"], [haveDu, "approved"], [gone, "approved"], [superseded, "superseded"], [pendingOnly, "pending"]] as const) await addRecord(layout, u, status);
    await addRecord(layout, noRow, "pending"); // the same typist twice counts once
    await testStore.insert("authors", { user_id: blank, name: "   ", first_seen_at: clock(), last_seen_at: clock() });
    await testStore.insert("authors", { user_id: isId, name: isId, first_seen_at: clock(), last_seen_at: clock() });
    await testStore.insert("authors", { user_id: named, name: "Has Name", first_seen_at: clock(), last_seen_at: clock() });
    await testStore.insert("discord_users", { id: haveDu, username: "known", global_name: null, updated_at: clock() });

    const seen: { url: string; auth: string }[] = [];
    const users = new Map<string, UserAnswer>([
      [noRow, userJson("n1", null)], [blank, userJson("n2", "N Two")], [isId, userJson("n3", null)],
      [gone, notFound], [pendingOnly, userJson("n5", null)],
    ]);
    const admin = register(stubDiscord(users, seen), token("refresh-admin2"), BOOTSTRAP_ADMIN);
    // missing: noRow, blank, isId, gone, pendingOnly (5). limit 2 resolves the two lowest ids.
    let res = await writeFetch("/v1/admin/discord-users/refresh", "POST", admin, { limit: 2 });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ resolved: 2, failed: 0, remaining: 3 });
    expect(seen).toHaveLength(2);
    // a full run: only the 3 still missing are asked; `gone` fails and stays.
    seen.length = 0;
    res = await writeFetch("/v1/admin/discord-users/refresh", "POST", admin);
    expect(await res.json()).toEqual({ resolved: 2, failed: 1, remaining: 1 });
    expect(seen).toHaveLength(3);
    // idempotent: nothing but the unresolvable id is touched on a re-run.
    seen.length = 0;
    res = await writeFetch("/v1/admin/discord-users/refresh", "POST", admin, {});
    expect(await res.json()).toEqual({ resolved: 0, failed: 1, remaining: 1 });
    expect(seen.map((s) => s.url.split("/").pop())).toEqual([gone]);
    expect(await testStore.row("discord_users", { id: haveDu })).toMatchObject({ username: "known" });
    expect(await testStore.row("discord_users", { id: superseded })).toBeNull();
    expect(await testStore.row("discord_users", { id: named })).toBeNull();
    expect(await testStore.row("discord_users", { id: blank })).toMatchObject({ username: "n2", global_name: "N Two" });
  });
});

describe("[LDB-WPM18] the user_name read precedence", () => {
  async function approved(user: string): Promise<{ layout: string }> {
    const layout = await createLayout(userId());
    await testStore.insert("wpm_submissions", {
      id: ulid(), layout_id: layout, user_id: user, wpm: 77, proof: PROOF, submitted_by: user, via: "discord",
      submitted_at: "2026-09-01T00:00:00.000Z", status: "approved", decided_by: "mod", decided_at: clock(), reason: null,
    });
    return { layout };
  }
  const du = (id: string, username: string, global_name: string | null) =>
    testStore.insert("discord_users", { id, username, global_name, updated_at: clock() });
  const author = (id: string, name: string) =>
    testStore.insert("authors", { user_id: id, name, first_seen_at: clock(), last_seen_at: clock() });

  it("[LDB-WPM18] authors.name, else global_name, else username, else null; a blank or id-equal authors.name does not count", async () => {
    const [a, b, c, d, e, f] = Array.from({ length: 6 }, userId) as [string, string, string, string, string, string];
    await author(a, "Author Name"); await du(a, "a_user", "A Global");
    await du(b, "b_user", "B Global");
    await du(c, "c_user", null);
    await author(d, d); await du(d, "d_user", "D Global");
    await author(e, "  "); await du(e, "e_user", "   ");
    await author(f, f);
    const layouts = await Promise.all([a, b, c, d, e, f].map(async (u) => (await approved(u)).layout));
    const expected: [string, string | null][] = [[a, "Author Name"], [b, "B Global"], [c, "c_user"], [d, "D Global"], [e, "e_user"], [f, null]];
    for (const [u, name] of expected) expect(await records(`?user=${u}`), u).toMatchObject([{ user_name: name }]);
    expect(layouts).toHaveLength(6);
  });

  it("[LDB-WPM18] the admin queue and the mod-queue card candidates use the same resolution", async () => {
    const user = userId();
    const layout = await createLayout(userId());
    await du(user, "queue_user", "Queue Display");
    await author(user, user);
    const id = ulid();
    await testStore.insert("wpm_submissions", {
      id, layout_id: layout, user_id: user, wpm: 70, proof: PROOF, submitted_by: user, via: "discord",
      submitted_at: "2026-09-01T00:00:00.000Z", status: "pending", decided_by: null, decided_at: null, reason: null,
    });
    const admin = register(actorFixture(), token("queue-admin"), BOOTSTRAP_ADMIN);
    const res = await writeFetch("/v1/admin/wpm-queue?status=pending", "GET", admin);
    const rows = ((await res.json()) as { submissions: { id: string; user_name: string | null }[] }).submissions;
    expect(rows.find((r) => r.id === id)?.user_name).toBe("Queue Display");
    const candidates = await store.modqueue.wpmCandidates(500);
    expect(candidates.find((r) => r.id === id)?.user_name).toBe("Queue Display");
  });

  it("[LDB-WPM18] GET /v1/wpm's ETag moves when a discord_users name changes, and a matching If-None-Match is 304 before that", async () => {
    const user = userId();
    await approved(user);
    await du(user, "etag_user", null);
    const first = await writeFetch(`/v1/wpm?user=${user}`, "GET");
    const etag = first.headers.get("ETag")!;
    expect(etag).toBeTruthy();
    expect((await writeFetch(`/v1/wpm?user=${user}`, "GET", { "If-None-Match": etag })).status).toBe(304);
    await testStore.patch("discord_users", { id: user }, { global_name: "Changed Name" });
    const after = await writeFetch(`/v1/wpm?user=${user}`, "GET", { "If-None-Match": etag });
    expect(after.status).toBe(200);
    expect(after.headers.get("ETag")).not.toBe(etag);
    expect(((await after.json()) as { records: Rec[] }).records[0]!.user_name).toBe("Changed Name");
    // a write that stores what is already there moves nothing
    const stable = after.headers.get("ETag")!;
    await store.discordUsers.upsert({ id: user, username: "etag_user", globalName: "Changed Name", at: clock() });
    expect((await writeFetch(`/v1/wpm?user=${user}`, "GET", { "If-None-Match": stable })).status).toBe(304);
  });
});
