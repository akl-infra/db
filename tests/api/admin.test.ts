// [LDB-A6] [LDB-A5] Admin routes (09 §3 T3): every admin route requires an
// admin actor (401 anonymous -- already swept exhaustively by tests/auth/
// routes.test.ts, checked once more here per-route for this matrix's own
// sake; 403 for any signed-in non-admin); list/add/remove admins with the
// last-two guard (both orderings, and a genuine Promise.all race); import
// pause/resume; every admin action lands in the event log with `admin = 1`,
// `rev NULL`, `layout_id NULL`, and is visible through `/v1/changes`.
import { createExecutionContext, createScheduledController, env, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ulid } from "ulidx";
import type { Bindings } from "../../src/env";
import type { Actor } from "../../src/auth/actor";
import type { IfMatch } from "../../src/core/ifmatch";
import { type CommitInput, type EventDbRow, commitWrite, feed, rowToEvent } from "../../src/core/events";
import { fixedClock } from "../../src/core/time";
import { deleteLayout, seedMagic } from "../../src/core/write";
import * as nightlyModule from "../../src/core/nightly";
import worker from "../../src/index";
import { FakeDiscord } from "../auth/fake-discord";
import { AKL_PAYLOAD, BOOTSTRAP_ADMIN, actorFixture, pinTestClock, register, uniqueName, writeFetch } from "./write-support";

const bindings = env as unknown as Bindings;
const db = bindings.DB;
const clock = fixedClock("2026-07-15T00:00:00.000Z");
pinTestClock(env as unknown as { TEST_CLOCK?: typeof clock }, clock);

// Only hour:minute (UTC) drives scheduled()'s dispatch since the cron
// consolidation (one `*/5 * * * *` trigger, 12 §3 X4 follow-up 2).
function atUTC(hour: number, minute: number): Date {
  return new Date(Date.UTC(2026, 6, 15, hour, minute));
}

const OTHER_USER = "owner-admin-nonadmin";

afterEach(() => {
  vi.unstubAllGlobals();
});

function adminHeaders(token: string) {
  const fake = actorFixture();
  return register(fake, token, BOOTSTRAP_ADMIN);
}

function userHeaders(token: string, id = OTHER_USER) {
  const fake = actorFixture();
  return register(fake, token, id);
}

let idCounter = 0;
// 17 digits, matches the same shape core/write.ts's TRANSFER_USER_ID_RE and
// routes/schemas.ts's admin-add pattern both require -- globally unique
// within this file's run so tests never collide on an id.
function testUserId(): string {
  idCounter++;
  return `30000000000000${String(idCounter).padStart(3, "0")}`;
}

async function currentAdminCount(): Promise<number> {
  const row = await db.prepare("SELECT COUNT(*) AS n FROM admins").first<{ n: number }>();
  return row?.n ?? 0;
}

// Deterministic baseline for the A6 tests below: wipes every admin except
// the bootstrap row, then seeds `extraCount` more via a direct INSERT
// (bypassing the guarded route on purpose -- this is test setup, not the
// thing under test). Returns the seeded ids in insertion order.
async function resetAdmins(extraCount: number): Promise<string[]> {
  await db.prepare("DELETE FROM admins WHERE user_id != ?").bind(BOOTSTRAP_ADMIN).run();
  const extras: string[] = [];
  for (let i = 0; i < extraCount; i++) {
    const id = testUserId();
    await db
      .prepare("INSERT INTO admins (user_id, added_by, added_at, note) VALUES (?, ?, ?, ?)")
      .bind(id, BOOTSTRAP_ADMIN, clock(), null)
      .run();
    extras.push(id);
  }
  return extras;
}

describe("[LDB-A5] admin routes: role matrix", () => {
  const routes: { method: string; path: string; body?: unknown }[] = [
    { method: "GET", path: "/v1/admin/admins" },
    { method: "POST", path: "/v1/admin/admins", body: { user_id: "30000000000009001" } },
    { method: "DELETE", path: "/v1/admin/admins/30000000000009002" },
  ];

  it("anonymous -> 401 unauthorized on every admin route", async () => {
    for (const r of routes) {
      const res = await writeFetch(r.path, r.method, {}, r.body);
      expect(res.status, `${r.method} ${r.path}`).toBe(401);
      const body = await res.json<{ error: string }>();
      expect(body.error, `${r.method} ${r.path}`).toBe("unauthorized");
    }
  });

  it("a signed-in non-admin -> 403 not_admin on every admin route", async () => {
    for (const r of routes) {
      const headers = userHeaders(`tok-${uniqueName("nonadmin")}`);
      const res = await writeFetch(r.path, r.method, headers, r.body);
      expect(res.status, `${r.method} ${r.path}`).toBe(403);
      const body = await res.json<{ error: string }>();
      expect(body.error, `${r.method} ${r.path}`).toBe("not_admin");
    }
  });

  it("an admin -> 200/201 on every admin route (GET/add/remove)", async () => {
    await resetAdmins(1); // leaves room for POST+DELETE below to stay above the A6 floor

    const getRes = await writeFetch("/v1/admin/admins", "GET", adminHeaders(`tok-${uniqueName("m")}`));
    expect(getRes.status).toBe(200);

    const target = testUserId();
    const postRes = await writeFetch("/v1/admin/admins", "POST", adminHeaders(`tok-${uniqueName("m")}`), { user_id: target });
    expect(postRes.status).toBe(201);

    const delRes = await writeFetch(`/v1/admin/admins/${target}`, "DELETE", adminHeaders(`tok-${uniqueName("m")}`));
    expect(delRes.status).toBe(200);
  });
});

describe("[LDB-A5] POST /v1/admin/admins", () => {
  it("a new user_id -> 201, the row, one admin.added event (admin=1, rev NULL, layout_id NULL, via discord)", async () => {
    const target = testUserId();
    const res = await writeFetch("/v1/admin/admins", "POST", adminHeaders(`tok-${uniqueName("add")}`), { user_id: target, note: "trusted" });
    expect(res.status).toBe(201);
    const body = await res.json<{ user_id: string; added_by: string; note: string | null }>();
    expect(body.user_id).toBe(target);
    expect(body.added_by).toBe(BOOTSTRAP_ADMIN);
    expect(body.note).toBe("trusted");

    const { results } = await db
      .prepare("SELECT * FROM events WHERE kind = 'admin.added' AND detail_json LIKE ? ORDER BY seq DESC LIMIT 1")
      .bind(`%${target}%`)
      .all<EventDbRow>();
    expect(results).toHaveLength(1);
    const e = rowToEvent(results[0]!);
    expect(e.admin).toBe(true);
    expect(e.rev).toBeNull();
    expect(e.layout_id).toBeNull();
    expect(e.via).toBe("discord");
    expect(e.detail).toEqual({ user_id: target, note: "trusted" });
  });

  it("re-adding an existing admin -> 200 idempotent, no new event", async () => {
    const target = testUserId();
    const first = await writeFetch("/v1/admin/admins", "POST", adminHeaders(`tok-${uniqueName("add")}`), { user_id: target });
    expect(first.status).toBe(201);

    const before = await db.prepare("SELECT COUNT(*) AS n FROM events WHERE kind = 'admin.added'").first<{ n: number }>();
    const second = await writeFetch("/v1/admin/admins", "POST", adminHeaders(`tok-${uniqueName("add")}`), { user_id: target });
    expect(second.status).toBe(200);
    const after = await db.prepare("SELECT COUNT(*) AS n FROM events WHERE kind = 'admin.added'").first<{ n: number }>();
    expect(after?.n).toBe(before?.n);
  });

  it("user_id not a 17-20 digit snowflake -> 400 bad_request", async () => {
    const res = await writeFetch("/v1/admin/admins", "POST", adminHeaders(`tok-${uniqueName("add")}`), { user_id: "not-an-id" });
    expect(res.status).toBe(400);
    const body = await res.json<{ error: string }>();
    expect(body.error).toBe("bad_request");
  });

  it("an unknown body field (e.g. added_by) -> 400 bad_request", async () => {
    const res = await writeFetch("/v1/admin/admins", "POST", adminHeaders(`tok-${uniqueName("add")}`), {
      user_id: testUserId(),
      added_by: "someone-else",
    });
    expect(res.status).toBe(400);
  });
});

describe("[LDB-A6] DELETE /v1/admin/admins/{user_id} -- the last-two guard", () => {
  it("[LDB-A6] with 3 rows -> 200, the row is gone, one admin.removed event", async () => {
    const [a] = await resetAdmins(2); // bootstrap + a + b = 3
    const res = await writeFetch(`/v1/admin/admins/${a}`, "DELETE", adminHeaders(`tok-${uniqueName("rm")}`));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ removed: a });
    expect(await currentAdminCount()).toBe(2);

    const { results } = await db
      .prepare("SELECT * FROM events WHERE kind = 'admin.removed' ORDER BY seq DESC LIMIT 1")
      .all<EventDbRow>();
    const e = rowToEvent(results[0]!);
    expect(e.admin).toBe(true);
    expect(e.rev).toBeNull();
    expect(e.layout_id).toBeNull();
    expect(e.detail).toEqual({ user_id: a });
  });

  it("[LDB-A6] with 2 rows -> 409 last_admins, removing the acting admin itself", async () => {
    await resetAdmins(1); // bootstrap + one = 2
    const res = await writeFetch(`/v1/admin/admins/${BOOTSTRAP_ADMIN}`, "DELETE", adminHeaders(`tok-${uniqueName("rm")}`));
    expect(res.status).toBe(409);
    const body = await res.json<{ error: string; count: number }>();
    expect(body.error).toBe("last_admins");
    expect(body.count).toBe(2);
    expect(await currentAdminCount()).toBe(2);
  });

  it("[LDB-A6] with 2 rows -> 409 last_admins, removing the OTHER admin (both orderings covered)", async () => {
    const [other] = await resetAdmins(1);
    const res = await writeFetch(`/v1/admin/admins/${other}`, "DELETE", adminHeaders(`tok-${uniqueName("rm")}`));
    expect(res.status).toBe(409);
    expect(await currentAdminCount()).toBe(2);
  });

  it("[LDB-A6] a Promise.all race of two removes at 3 rows leaves exactly two, one 200 one 409", async () => {
    const [a, b] = await resetAdmins(2);
    const headers = adminHeaders(`tok-${uniqueName("rm-race")}`);
    const [resA, resB] = await Promise.all([
      writeFetch(`/v1/admin/admins/${a}`, "DELETE", headers),
      writeFetch(`/v1/admin/admins/${b}`, "DELETE", headers),
    ]);
    expect([resA.status, resB.status].sort()).toEqual([200, 409]);
    expect(await currentAdminCount()).toBe(2);
  });

  it("removing a user_id that isn't an admin -> 404", async () => {
    const res = await writeFetch(`/v1/admin/admins/${testUserId()}`, "DELETE", adminHeaders(`tok-${uniqueName("rm")}`));
    expect(res.status).toBe(404);
  });
});

describe("[LDB-P6] admin events on the public feed", () => {
  it("every admin.* kind is visible through GET /v1/changes and via feed()", async () => {
    await resetAdmins(1); // 2 admins: bootstrap + filler, room to add-then-remove one more
    const target = testUserId();

    const addRes = await writeFetch("/v1/admin/admins", "POST", adminHeaders(`tok-${uniqueName("feed")}`), { user_id: target });
    expect(addRes.status).toBe(201);
    const rmRes = await writeFetch(`/v1/admin/admins/${target}`, "DELETE", adminHeaders(`tok-${uniqueName("feed")}`));
    expect(rmRes.status).toBe(200);

    const httpRes = await writeFetch(
      "/v1/changes?since=0&limit=1000&kinds=admin.added,admin.removed",
      "GET",
      {},
    );
    expect(httpRes.status).toBe(200);
    const body = await httpRes.json<{ items: { kind: string; layout_id: string | null; admin: boolean; rev: number | null }[] }>();
    const kinds = body.items.map((i) => i.kind);
    expect(kinds).toContain("admin.added");
    expect(kinds).toContain("admin.removed");
    for (const item of body.items) {
      expect(item.layout_id).toBeNull();
      expect(item.rev).toBeNull();
      expect(item.admin).toBe(true);
    }

    // and the same, directly through feed() -- rowToEvent's own round trip.
    const { items } = await feed(db, 0, 1000, ["admin.added"]);
    expect(items.some((e) => e.kind === "admin.added")).toBe(true);
  });
});

// X4 follow-up (+ follow-up 3): manual triggers for the `0 3` nightly job
// set (prunes + dump) -- production reason: the deployed Worker's cron
// triggers are registered but Cloudflare has, at least once, simply stopped
// dispatching them (0 scheduled invocations observed over 25 minutes, no
// error anywhere), leaving operators with no way to force a tick short of
// waiting it out; `wrangler dev --test-scheduled` ignoring `?time=` means
// there's no local workaround for the nightly slot either. This route calls
// the EXACT SAME function `src/index.ts`'s `scheduled()` calls for its own
// cron -- proven below by a spy shared across both call sites, not just by
// code review -- so there is no second implementation of the tick to drift
// out of sync with the real one.
describe("POST /v1/admin/dump, POST /v1/admin/magic-seed, and POST /v1/admin/nightly/tick", () => {
  afterEach(() => {
    vi.restoreAllMocks(); // vi.unstubAllGlobals() (this file's own top-level afterEach) does not cover vi.spyOn
  });

  function adminHeadersFor(discord: FakeDiscord, token: string): Record<string, string> {
    discord.setAnswer(token, { kind: "ok", id: BOOTSTRAP_ADMIN, username: "bootstrap-admin", global_name: null });
    return { Authorization: `Bearer ${token}` };
  }

  function userHeadersFor(discord: FakeDiscord, token: string): Record<string, string> {
    discord.setAnswer(token, { kind: "ok", id: OTHER_USER, username: "nonadmin", global_name: null });
    return { Authorization: `Bearer ${token}` };
  }

  async function eventCount(kind: string): Promise<number> {
    const row = await db.prepare("SELECT COUNT(*) AS n FROM events WHERE kind = ?").bind(kind).first<{ n: number }>();
    return row?.n ?? 0;
  }

  // The cutover follow-up (design/layout-db/23-geometry.md, "admin dump
  // route"): writes a dump on demand, via the exact same path the hour=3
  // nightly job (`writeDump`) uses -- needed because the cutover imports
  // into a wiped DB and the bot/site rebuild boot from the daily dump.
  describe("POST /v1/admin/dump", () => {
    it("anonymous 401, non-admin 403, admin 200 -> {seq, layout_count, written_at}, and /v1/dump/latest.json reflects it", async () => {
      await writeFetch("/v1/layouts", "POST", { ...adminHeaders(`tok-${uniqueName("dump-seed-owner")}`) }, { name: uniqueName("dump-seed"), format: "spark/1", payload: AKL_PAYLOAD });

      const anon = await writeFetch("/v1/admin/dump", "POST", {});
      expect(anon.status).toBe(401);

      const user = await writeFetch("/v1/admin/dump", "POST", userHeaders(`tok-${uniqueName("dump-user")}`));
      expect(user.status).toBe(403);

      const admin = await writeFetch("/v1/admin/dump", "POST", adminHeaders(`tok-${uniqueName("dump-admin")}`));
      expect(admin.status).toBe(200);
      const body = await admin.json<{ seq: number; layout_count: number; written_at: string }>();
      expect(typeof body.seq).toBe("number");
      expect(body.layout_count).toBeGreaterThan(0);
      expect(typeof body.written_at).toBe("string");

      const latestRes = await writeFetch("/v1/dump/latest.json", "GET");
      expect(latestRes.status).toBe(200);
      const latest = await latestRes.json<{ seq: number; layout_count: number }>();
      expect(latest.seq).toBe(body.seq);
      expect(latest.layout_count).toBe(body.layout_count);
    });
  });

  // design/layout-db/23-geometry.md §10.1: the one-time magic re-seed route.
  describe("POST /v1/admin/magic-seed", () => {
    it("[LDB-P24] anonymous 401, non-admin 403, admin 200 as a SYSTEM write (system:magic-seed / seed:aklgg, admin false) that sets has_magic and leaves upstream following; an invalid candidate is refused with nothing written", async () => {
      const name = uniqueName("seed-target");
      const payload = { keys: [{ char: "a", row: 1, col: 0, finger: "LP" }, { char: "b", row: 1, col: 5, finger: "RI" }, { char: "@", row: 0, col: 1, finger: "LR" }] };
      const created = await writeFetch("/v1/layouts", "POST", userHeaders(`tok-${uniqueName("seed-owner")}`), { name, format: "spark/1", payload });
      expect(created.status).toBe(201);
      const magic = { magic_keys: [{ key: "@", default: { kind: "repeat" }, rules: [{ after: "a", emit: "b" }] }] };

      const anon = await writeFetch("/v1/admin/magic-seed", "POST", {}, { ref: name, magic });
      expect(anon.status).toBe(401);
      const user = await writeFetch("/v1/admin/magic-seed", "POST", userHeaders(`tok-${uniqueName("seed-user")}`), { ref: name, magic });
      expect(user.status).toBe(403);

      const bad = await writeFetch("/v1/admin/magic-seed", "POST", adminHeaders(`tok-${uniqueName("seed-admin")}`), { ref: name, magic: { magic_keys: [{ key: "@", default: "repeat_previous" }] } });
      expect(bad.status).toBe(400);
      const untouched = await (await writeFetch(`/v1/layouts/${encodeURIComponent(name)}?format=spark/1`, "GET")).json<{ formats: Record<string, { rev: number; has_magic: boolean }> }>();
      expect(untouched.formats["spark/1"]!.has_magic).toBe(false);
      expect(untouched.formats["spark/1"]!.rev).toBe(1);

      const ok = await writeFetch("/v1/admin/magic-seed", "POST", adminHeaders(`tok-${uniqueName("seed-admin")}`), { ref: name, magic });
      expect(ok.status).toBe(200);
      const body = await ok.json<{ id: string; name: string; rev: number; has_magic: boolean; upstream: unknown }>();
      expect(body.name).toBe(name);
      expect(body.rev).toBe(2);
      expect(body.has_magic).toBe(true);
      expect(body.upstream).toBeNull(); // a bot-created record has no upstream; the seed never invents one

      const after = await (await writeFetch(`/v1/layouts/${encodeURIComponent(name)}?format=spark/1`, "GET")).json<{ payload: { magic?: unknown }; formats: Record<string, { rev: number; has_magic: boolean }> }>();
      expect(after.payload.magic).toEqual(magic);
      expect(after.formats["spark/1"]!.has_magic).toBe(true);

      const ev = await db
        .prepare("SELECT actor, via, admin FROM events WHERE layout_id = ? AND rev IS NOT NULL ORDER BY seq DESC LIMIT 1")
        .bind(body.id)
        .first<{ actor: string; via: string; admin: number }>();
      expect(ev).toEqual({ actor: "system:magic-seed", via: "seed:aklgg", admin: 0 });
    });

    // [LDB-P26] docs/decisions/26-magic-reseed.md §3, added 2026-09-14
    // (akldb is no longer disposable): `seedMagic`'s own guard, exercised
    // directly against `core/write.ts` (bypassing HTTP) so a forked/
    // system-written fixture can be built with `commitWrite` exactly like
    // tests/events/upstream.test.ts's own `createLayout` does, rather than
    // driving a real cmini import + user edit just to reach the same
    // states. The `ok` case above already covers the OTHER allowed branch
    // (no magic, not forked, written by a real user) end to end over HTTP.
    const VALID_SPARK_PAYLOAD = { keys: [{ char: "a", row: 1, col: 0, finger: "LP" }, { char: "b", row: 1, col: 5, finger: "RI" }] };
    const VALID_MAGIC = { magic_keys: [{ key: "a", default: { kind: "repeat" } }] };

    function seedGuardFixture(opts: { sourceClient: string; hasMagic: boolean; upstream: CommitInput["upstream"]; payload?: unknown }) {
      const input: CommitInput = {
        layoutId: ulid(),
        creating: true,
        currentN: 0,
        currentLayout: null,
        currentFormats: new Map(),
        layout: { kind: "created", name: uniqueName("seed-guard"), owner: "owner-seed-guard", created_at: clock(), deleted: false },
        format: { kind: "format_added", lineage: "spark", format: "spark/1", payload: opts.payload ?? VALID_SPARK_PAYLOAD, hasMagic: opts.hasMagic },
        modified_at: clock(),
        actor: "owner-seed-guard",
        via: "discord",
        source: { client: opts.sourceClient, version: null },
        upstream: opts.upstream,
      };
      return commitWrite(db, clock, input);
    }

    it("[LDB-P26] allows re-seeding a record whose spark/1 row was last written by a system client, even with magic already set and even forked", async () => {
      const { layout } = await seedGuardFixture({ sourceClient: "system:cmini-import", hasMagic: true, upstream: { source: "cmini", id: "up-1", state: "forked" } });
      const out = await seedMagic(bindings, clock, layout.id, VALID_MAGIC, null);
      expect(out.formats.get(out.lineage)!.has_magic).toBe(true);
      expect(out.layout.upstream).toEqual({ source: "cmini", id: "up-1", state: "following" });
    });

    it("[LDB-P26] refuses 409 magic_edited when the spark/1 row's magic was last written by a real client", async () => {
      const { layout } = await seedGuardFixture({ sourceClient: "discord-app:test-guard", hasMagic: true, upstream: null });
      await expect(seedMagic(bindings, clock, layout.id, VALID_MAGIC, null)).rejects.toMatchObject({
        status: 409,
        body: { error: "magic_edited", client: "discord-app:test-guard" },
      });
      const after = await db.prepare("SELECT rev FROM layout_formats WHERE layout_id = ? AND lineage = 'spark'").bind(layout.id).first<{ rev: number }>();
      expect(after?.rev).toBe(1); // nothing written
    });

    it("[LDB-P26] refuses 409 magic_edited for a forked layout with no magic, even though a fresh unforked/no-magic record is allowed", async () => {
      const { layout } = await seedGuardFixture({ sourceClient: "discord-app:test-guard", hasMagic: false, upstream: { source: "cmini", id: "up-2", state: "forked" } });
      await expect(seedMagic(bindings, clock, layout.id, VALID_MAGIC, null)).rejects.toMatchObject({
        status: 409,
        body: { error: "magic_edited", client: "discord-app:test-guard" },
      });

      const { layout: unforked } = await seedGuardFixture({ sourceClient: "discord-app:test-guard", hasMagic: false, upstream: null });
      const out = await seedMagic(bindings, clock, unforked.id, VALID_MAGIC, null);
      expect(out.formats.get(out.lineage)!.has_magic).toBe(true);
    });
  });

  describe("POST /v1/admin/nightly/tick", () => {
    it("[LDB-A5] anonymous 401, non-admin 403, admin 200 -> { ran: true, at, jobs, dump }; logs admin.nightly_ticked", async () => {
      const discord = new FakeDiscord();
      vi.stubGlobal("fetch", discord.fetchImpl);

      const anon = await writeFetch("/v1/admin/nightly/tick", "POST", {});
      expect(anon.status).toBe(401);

      const user = await writeFetch("/v1/admin/nightly/tick", "POST", userHeadersFor(discord, `tok-${uniqueName("nightly-user")}`));
      expect(user.status).toBe(403);

      const before = await eventCount("admin.nightly_ticked");
      const admin = await writeFetch("/v1/admin/nightly/tick", "POST", adminHeadersFor(discord, `tok-${uniqueName("nightly-admin")}`));
      expect(admin.status).toBe(200);
      const body = await admin.json<{
        ran: boolean;
        at: string;
        jobs: Record<string, "ok" | "error">;
        dump: { key: string; latest: { sha256: string } } | null;
      }>();
      expect(body.ran).toBe(true);
      expect(typeof body.at).toBe("string");
      expect(body.jobs).toEqual({
        "prune-auth-cache": "ok",
        "prune-rate-limits": "ok",
        "prune-nonces": "ok",
        "prune-idempotency": "ok",
        "write-dump": "ok",
      });
      expect(body.dump).not.toBeNull();
      expect(typeof body.dump!.key).toBe("string");
      expect(typeof body.dump!.latest.sha256).toBe("string");
      expect(await eventCount("admin.nightly_ticked")).toBe(before + 1);
    });

    it("[LDB-A5] shares one implementation with the hour=3 minute=0 slot (a spy on core/nightly.ts's runNightly sees both call sites)", async () => {
      const discord = new FakeDiscord();
      vi.stubGlobal("fetch", discord.fetchImpl);

      const spy = vi.spyOn(nightlyModule, "runNightly");
      const before = spy.mock.calls.length;

      const ctx = createExecutionContext();
      const controller = createScheduledController({ cron: "*/5 * * * *", scheduledTime: atUTC(3, 0) });
      await worker.scheduled(controller, bindings, ctx);
      await waitOnExecutionContext(ctx);
      expect(spy.mock.calls.length).toBe(before + 1);

      const res = await writeFetch("/v1/admin/nightly/tick", "POST", adminHeadersFor(discord, `tok-${uniqueName("nightly-spy")}`));
      expect(res.status).toBe(200);
      expect(spy.mock.calls.length).toBe(before + 2);
    });

    // [LDB-D1] The dump row's own invariant, extended: the cron
    // (`scheduled()`'s hour=3 minute=0 slot) and this manual route both
    // reach `runNightly` -- proven above by a shared spy -- but a shared
    // implementation alone doesn't prove a shared OUTPUT: this drives both
    // against the identical seeded state and compares the R2 object each
    // one actually wrote. No fake timers here (`vi.useFakeTimers()` + a
    // request that crosses into the Worker can hang pool-workers' own
    // dispatch) -- instead, this file's own top-level `pinTestClock` pin is
    // cleared for the duration (saved and restored below) so BOTH the cron
    // (always the real `systemClock`, `src/index.ts`'s `scheduled()`) and
    // the manual route (`resolveNow()`'s `TEST_CLOCK ?? systemClock`
    // fallback, routes/admin.ts) read the SAME real wall clock --
    // `event.scheduledTime` alone (an explicit `createScheduledController`
    // override, no global Date/timer mocking) still lands the cron
    // dispatch on the `hour=3, minute=0` nightly branch. A warm-up `GET
    // /v1/me` with the SAME bearer, fired before either dump, absorbs the
    // one real side effect authenticating that token has (`resolveBearer`'s
    // `authors` upsert, `auth/discord.ts`) -- once cached (5 min TTL), the
    // SAME token's second use (the manual route call, after the cron dump)
    // hits the cache and touches nothing, so it no longer bumps
    // `authors.last_seen_at` to a second, later "now" out from under the
    // comparison.
    it("[LDB-D1] the manual nightly tick and the cron write byte-identical dumps for the same state", async () => {
      await writeFetch(
        "/v1/layouts",
        "POST",
        adminHeaders(`tok-${uniqueName("nightly-dump-seed-owner")}`),
        { name: uniqueName("nightly-dump-seed"), format: "spark/1", payload: AKL_PAYLOAD },
      );

      const testEnv = bindings as unknown as { TEST_CLOCK?: typeof clock };
      const savedTestClock = testEnv.TEST_CLOCK;
      testEnv.TEST_CLOCK = undefined;

      const discord = new FakeDiscord();
      const nightlyAdminToken = `tok-${uniqueName("nightly-dump-admin")}`;
      discord.setAnswer(nightlyAdminToken, { kind: "ok", id: BOOTSTRAP_ADMIN, username: "nightly-dump-admin", global_name: null });
      vi.stubGlobal("fetch", discord.fetchImpl);
      try {
        const warmup = await writeFetch("/v1/me", "GET", { Authorization: `Bearer ${nightlyAdminToken}` });
        expect(warmup.status).toBe(200);

        const now = new Date();
        const nightlySlot = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 3, 0));

        const ctx = createExecutionContext();
        const controller = createScheduledController({ cron: "*/5 * * * *", scheduledTime: nightlySlot });
        await worker.scheduled(controller, bindings, ctx);
        await waitOnExecutionContext(ctx);

        const cronLatestRes = await writeFetch("/v1/dump/latest.json", "GET", {});
        expect(cronLatestRes.status).toBe(200);
        const cronLatest = await cronLatestRes.json<{ sha256: string; date: string }>();

        const adminRes = await writeFetch("/v1/admin/nightly/tick", "POST", { Authorization: `Bearer ${nightlyAdminToken}` });
        expect(adminRes.status).toBe(200);
        const adminBody = await adminRes.json<{ dump: { latest: { sha256: string; date: string } } | null }>();
        expect(adminBody.dump).not.toBeNull();

        expect(adminBody.dump!.latest.date).toBe(cronLatest.date);
        expect(adminBody.dump!.latest.sha256).toBe(cronLatest.sha256);
      } finally {
        testEnv.TEST_CLOCK = savedTestClock;
        vi.unstubAllGlobals();
      }
    });
  });

});

