// [LDB-MD1] [LDB-MD4] [LDB-MD10] L5 moderation (design/akldb-site/01-plan.md
// §4.1, §4.3): bans, the author display-name override. Black-box via
// SELF.fetch, same pattern tests/api/admin.test.ts uses for T3's admin
// routes. (H24, 2026-09-13: the like-count override, §4.2, was removed --
// see the "[H24] no admin like-count override exists" describe below.)
import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Bindings } from "../../src/env";
import { commitWrite, feed, type CommitInput } from "../../src/core/events";
import { fixedClock } from "../../src/core/time";
import { ulid } from "ulidx";
import { AKL_PAYLOAD, BOOTSTRAP_ADMIN, actorFixture, pinTestClock, register, uniqueName, writeFetch } from "./write-support";

const bindings = env as unknown as Bindings;
const db = bindings.DB;
const clock = fixedClock("2026-09-12T00:00:00.000Z");
pinTestClock(env as unknown as { TEST_CLOCK?: typeof clock }, clock);

afterEach(() => {
  vi.unstubAllGlobals();
});

function adminHeaders(token: string) {
  const fake = actorFixture();
  return register(fake, token, BOOTSTRAP_ADMIN);
}

function userHeaders(token: string, id: string) {
  const fake = actorFixture();
  return register(fake, token, id);
}

let idCounter = 0;
function testUserId(): string {
  idCounter++;
  return `31000000000000${String(idCounter).padStart(3, "0")}`;
}

async function createLayout(owner: string): Promise<string> {
  const input: CommitInput = {
    layoutId: ulid(),
    creating: true,
    currentN: 0,
    currentLayout: null,
    currentFormats: new Map(),
    layout: { kind: "created", name: uniqueName("mod-layout"), owner, created_at: clock(), deleted: false },
    format: { kind: "format_added", lineage: "spark", format: "spark/1", payload: AKL_PAYLOAD, hasMagic: false },
    modified_at: clock(),
    actor: owner,
    via: "discord",
    source: { client: "discord-app:test", version: null },
    upstream: null,
  };
  const { layout } = await commitWrite(db, clock, input);
  return layout.id;
}

describe("[LDB-MD1] bans", () => {
  it("[LDB-MD1] a fresh ban is 201, an already-banned user is 200 with reason updated", async () => {
    const target = testUserId();
    const admin = adminHeaders("tok-ban-201");
    const first = await writeFetch(`/v1/admin/bans/${target}`, "PUT", admin, { reason: "spam" });
    expect(first.status).toBe(201);
    await expect(first.json()).resolves.toMatchObject({ user_id: target, by: BOOTSTRAP_ADMIN, reason: "spam" });

    const second = await writeFetch(`/v1/admin/bans/${target}`, "PUT", admin, { reason: "still spam" });
    expect(second.status).toBe(200);
    await expect(second.json()).resolves.toMatchObject({ user_id: target, reason: "still spam" });
  });

  it("[LDB-MD1] banning an admin is 409 cannot_ban_admin, and the admin is never listed as banned", async () => {
    const admin = adminHeaders("tok-ban-admin");
    const res = await writeFetch(`/v1/admin/bans/${BOOTSTRAP_ADMIN}`, "PUT", admin, {});
    expect(res.status).toBe(409);
    await expect(res.json()).resolves.toMatchObject({ error: "cannot_ban_admin" });

    const me = await writeFetch("/v1/me", "GET", adminHeaders("tok-ban-admin-me"));
    await expect(me.json()).resolves.toMatchObject({ admin: true, banned: false });
  });

  it("[LDB-MD1] a banned actor's non-safe request is 403 banned; reads and GET /v1/me are unaffected", async () => {
    const target = testUserId();
    const admin = adminHeaders("tok-ban-gate-admin");
    await writeFetch(`/v1/admin/bans/${target}`, "PUT", admin, {});

    const asTarget = userHeaders("tok-ban-gate-target", target);
    const me = await writeFetch("/v1/me", "GET", asTarget);
    expect(me.status).toBe(200);
    await expect(me.json()).resolves.toMatchObject({ banned: true });

    const write = await writeFetch("/v1/layouts", "POST", asTarget, { name: uniqueName("banned-write"), format: "spark/1", payload: AKL_PAYLOAD });
    expect(write.status).toBe(403);
    await expect(write.json()).resolves.toMatchObject({ error: "banned" });

    const like = await writeFetch(`/v1/layouts/${await createLayout(BOOTSTRAP_ADMIN)}/like`, "PUT", asTarget);
    expect(like.status, "[LDB-MD1] a like is a non-safe write too").toBe(403);
    await expect(like.json()).resolves.toMatchObject({ error: "banned" });
  });

  it("[LDB-MD1] [LDB-MD10] unban lifts the gate on the very next request, no cache window", async () => {
    const target = testUserId();
    // One shared fake: `admin` is reused AFTER `asTarget` is minted below,
    // and `actorFixture()` re-stubs global fetch on every call -- a second
    // call would silently orphan `admin`'s own token for the rest of this
    // test (bearer tokens are cached in `auth_cache` for 5 min, so a
    // reused token can mask this; a fresh one like `admin`'s here cannot).
    const fake = actorFixture();
    const admin = register(fake, "tok-unban-admin", BOOTSTRAP_ADMIN);
    await writeFetch(`/v1/admin/bans/${target}`, "PUT", admin, {});
    const asTarget = register(fake, "tok-unban-target", target);
    expect((await writeFetch("/v1/me", "GET", asTarget)).status).toBe(200);
    await expect((await writeFetch("/v1/me", "GET", asTarget)).json()).resolves.toMatchObject({ banned: true });

    const unban = await writeFetch(`/v1/admin/bans/${target}`, "DELETE", admin);
    expect(unban.status).toBe(200);
    await expect(unban.json()).resolves.toEqual({ unbanned: target });

    await expect((await writeFetch("/v1/me", "GET", asTarget)).json()).resolves.toMatchObject({ banned: false });
    const write = await writeFetch("/v1/layouts", "POST", asTarget, { name: uniqueName("unbanned-write"), format: "spark/1", payload: AKL_PAYLOAD });
    expect(write.status).toBe(201);
  });

  it("unbanning a user who isn't banned is 404 not_found", async () => {
    const target = testUserId();
    const res = await writeFetch(`/v1/admin/bans/${target}`, "DELETE", adminHeaders("tok-unban-404"));
    expect(res.status).toBe(404);
  });

  it("GET /v1/admin/bans lists every ban with a joined author name", async () => {
    const target = testUserId();
    const admin = adminHeaders("tok-list-bans");
    await writeFetch(`/v1/admin/bans/${target}`, "PUT", admin, { reason: "for the list" });
    const res = await writeFetch("/v1/admin/bans", "GET", admin);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { bans: { user_id: string; reason: string | null }[] };
    expect(body.bans.some((b) => b.user_id === target && b.reason === "for the list")).toBe(true);
  });

  it("every ban/unban is exactly one admin.user_banned/admin.user_unbanned event, admin: true", async () => {
    const target = testUserId();
    const admin = adminHeaders("tok-ban-event");
    await writeFetch(`/v1/admin/bans/${target}`, "PUT", admin, { reason: "x" });
    await writeFetch(`/v1/admin/bans/${target}`, "DELETE", admin);
    const { items } = await feed(db, 0, 5000, ["admin.user_banned", "admin.user_unbanned"]);
    const mine = items.filter((e) => (e.detail as { user_id?: string } | null)?.user_id === target);
    expect(mine.map((e) => e.kind)).toEqual(["admin.user_banned", "admin.user_unbanned"]);
    for (const e of mine) {
      expect(e.admin).toBe(true);
      expect(e.actor).toBe(BOOTSTRAP_ADMIN);
      expect(e.via).toBe("discord");
    }
  });
});

// H24 (saltorbit, 2026-09-13): the admin like-count override (§4.2, `PUT
// /v1/admin/layouts/:ref/likes`) was removed entirely -- mods must never be
// able to move `like_count` away from `COUNT(DISTINCT user_id) FROM likes`,
// and likes must always be tied to the users who liked, never an opaque
// admin-set number. The route itself is gone (404, same as any unknown
// path); a real like/unlike is the only thing that ever moves the count.
describe("[H24] no admin like-count override exists", () => {
  it("PUT /v1/admin/layouts/:ref/likes is gone -- 404, not a route", async () => {
    const owner = testUserId();
    const layoutId = await createLayout(owner);
    const admin = adminHeaders("tok-likes-admin-h24");
    const res = await writeFetch(`/v1/admin/layouts/${layoutId}/likes`, "PUT", admin, { count: 5 });
    expect(res.status).toBe(404);
  });

  it("like_count only ever moves via a real like/unlike, tied to the liking user", async () => {
    const owner = testUserId();
    const layoutId = await createLayout(owner);
    const liker = userHeaders("tok-likes-liker-h24", testUserId());

    const like = await writeFetch(`/v1/layouts/${layoutId}/like`, "PUT", liker);
    expect(like.status).toBe(200);
    await expect(like.json()).resolves.toEqual({ like_count: 1 });

    const unlike = await writeFetch(`/v1/layouts/${layoutId}/like`, "DELETE", liker);
    expect(unlike.status).toBe(200);
    await expect(unlike.json()).resolves.toEqual({ like_count: 0 });
  });
});

describe("[LDB-MD4] author display-name override", () => {
  it("[LDB-MD4] survives a later sign-in with a different Discord name", async () => {
    const userId = testUserId();
    const fake = actorFixture();
    const signInHeaders = register(fake, "tok-author-signin-1", userId);
    await writeFetch("/v1/me", "GET", signInHeaders); // first sight -> authors row, name_source 'user'

    const admin = adminHeaders("tok-author-admin");
    const rename = await writeFetch(`/v1/admin/authors/${userId}`, "PUT", admin, { name: "Admin Picked Name" });
    expect(rename.status).toBe(200);
    await expect(rename.json()).resolves.toEqual({ user_id: userId, name: "Admin Picked Name", name_source: "admin" });

    // A later sign-in under a DIFFERENT Discord display name must not move it.
    fake.setAnswer("tok-author-signin-2", { kind: "ok", id: userId, username: "totally-different-handle", global_name: null });
    await writeFetch("/v1/me", "GET", { Authorization: "Bearer tok-author-signin-2" });

    const row = await db.prepare("SELECT name, name_source FROM authors WHERE user_id = ?").bind(userId).first<{ name: string; name_source: string }>();
    expect(row).toEqual({ name: "Admin Picked Name", name_source: "admin" });
  });

  it("[LDB-MD4] survives a later cmini import pass under a different name", async () => {
    const userId = testUserId();
    const admin = adminHeaders("tok-author-admin-import");
    // Seed a plain 'import'-sourced row first (as the cmini import would).
    const now = clock();
    await db.prepare("INSERT INTO authors (user_id, name, first_seen_at, last_seen_at, name_source) VALUES (?, ?, ?, ?, 'import')").bind(userId, "old-import-name", now, now).run();
    await writeFetch(`/v1/admin/authors/${userId}`, "PUT", admin, { name: "Sticky Admin Name" });

    const { applyAuthors } = await import("../../src/import/apply");
    await applyAuthors(db, clock, { "brand-new-import-name": userId });

    const row = await db.prepare("SELECT name, name_source FROM authors WHERE user_id = ?").bind(userId).first<{ name: string; name_source: string }>();
    expect(row).toEqual({ name: "Sticky Admin Name", name_source: "admin" });
  });

  it("empty name is 400 bad_request; unknown user is 404 not_found", async () => {
    const admin = adminHeaders("tok-author-bad");
    const bad = await writeFetch("/v1/admin/authors/whatever", "PUT", admin, { name: "" });
    expect(bad.status).toBe(400);
    const missing = await writeFetch(`/v1/admin/authors/${testUserId()}`, "PUT", admin, { name: "X" });
    expect(missing.status).toBe(404);
  });

  it("a non-admin gets 403 not_admin", async () => {
    const res = await writeFetch(`/v1/admin/authors/${testUserId()}`, "PUT", userHeaders("tok-author-nonadmin", testUserId()), { name: "X" });
    expect(res.status).toBe(403);
  });
});
