// [LDB-A6] [LDB-A5] Admin routes (09 §3 T3): every admin route requires an
// admin actor (401 anonymous -- already swept exhaustively by tests/auth/
// routes.test.ts, checked once more here per-route for this matrix's own
// sake; 403 for any signed-in non-admin); list/add/remove admins with the
// last-two guard (both orderings, and a genuine Promise.all race); import
// pause/resume; every admin action lands in the event log with `admin = 1`,
// `rev NULL`, `layout_id NULL`, and is visible through `/v1/changes`.
import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Bindings } from "../../src/env";
import { type EventDbRow, feed, rowToEvent } from "../../src/core/events";
import { fixedClock } from "../../src/core/time";
import { tick } from "../../src/import/cmini";
import { FakeUpstream } from "../import/fake-upstream";
import { BOOTSTRAP_ADMIN, actorFixture, pinTestClock, register, uniqueName, writeFetch } from "./write-support";

const bindings = env as unknown as Bindings;
const db = bindings.DB;
const clock = fixedClock("2026-07-15T00:00:00.000Z");
pinTestClock(env as unknown as { TEST_CLOCK?: typeof clock }, clock);

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
    { method: "POST", path: "/v1/admin/import/pause" },
    { method: "POST", path: "/v1/admin/import/resume" },
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

  it("an admin -> 200/201 on every admin route (GET/add/remove/pause/resume)", async () => {
    await resetAdmins(1); // leaves room for POST+DELETE below to stay above the A6 floor

    const getRes = await writeFetch("/v1/admin/admins", "GET", adminHeaders(`tok-${uniqueName("m")}`));
    expect(getRes.status).toBe(200);

    const target = testUserId();
    const postRes = await writeFetch("/v1/admin/admins", "POST", adminHeaders(`tok-${uniqueName("m")}`), { user_id: target });
    expect(postRes.status).toBe(201);

    const delRes = await writeFetch(`/v1/admin/admins/${target}`, "DELETE", adminHeaders(`tok-${uniqueName("m")}`));
    expect(delRes.status).toBe(200);

    const pauseRes = await writeFetch("/v1/admin/import/pause", "POST", adminHeaders(`tok-${uniqueName("m")}`));
    expect(pauseRes.status).toBe(200);

    const resumeRes = await writeFetch("/v1/admin/import/resume", "POST", adminHeaders(`tok-${uniqueName("m")}`));
    expect(resumeRes.status).toBe(200);
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

describe("POST /v1/admin/import/pause and /resume", () => {
  it("pause makes the next tick() a no-op (no upstream request); resume restores it", async () => {
    const pauseRes = await writeFetch("/v1/admin/import/pause", "POST", adminHeaders(`tok-${uniqueName("pause")}`));
    expect(pauseRes.status).toBe(200);
    await expect(pauseRes.json()).resolves.toEqual({ paused: true });

    const fake = new FakeUpstream();
    const result = await tick(bindings, clock, fake.fetchImpl, fake.sleepImpl);
    expect(result).toEqual({ quiet: true, stats: { at: clock(), quiet: true } });
    expect(fake.requestLog).toHaveLength(0);

    const resumeRes = await writeFetch("/v1/admin/import/resume", "POST", adminHeaders(`tok-${uniqueName("resume")}`));
    expect(resumeRes.status).toBe(200);
    await expect(resumeRes.json()).resolves.toEqual({ paused: false });

    const result2 = await tick(bindings, clock, fake.fetchImpl, fake.sleepImpl);
    expect(result2.quiet).toBe(false);
    expect(fake.requestLog.length).toBeGreaterThan(0);
  });

  it("[LDB-A5] pause and resume each append one admin.* event, admin=1, rev NULL", async () => {
    const before = await db
      .prepare("SELECT COUNT(*) AS n FROM events WHERE kind IN ('admin.import_paused','admin.import_resumed')")
      .first<{ n: number }>();
    await writeFetch("/v1/admin/import/pause", "POST", adminHeaders(`tok-${uniqueName("p")}`));
    await writeFetch("/v1/admin/import/resume", "POST", adminHeaders(`tok-${uniqueName("r")}`));
    const after = await db
      .prepare("SELECT COUNT(*) AS n FROM events WHERE kind IN ('admin.import_paused','admin.import_resumed')")
      .first<{ n: number }>();
    expect(after?.n).toBe((before?.n ?? 0) + 2);

    const { results } = await db
      .prepare("SELECT * FROM events WHERE kind IN ('admin.import_paused','admin.import_resumed') ORDER BY seq DESC LIMIT 2")
      .all<EventDbRow>();
    for (const row of results) {
      const e = rowToEvent(row);
      expect(e.admin).toBe(true);
      expect(e.rev).toBeNull();
      expect(e.layout_id).toBeNull();
    }
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
    await writeFetch("/v1/admin/import/pause", "POST", adminHeaders(`tok-${uniqueName("feed")}`));
    await writeFetch("/v1/admin/import/resume", "POST", adminHeaders(`tok-${uniqueName("feed")}`));

    const httpRes = await writeFetch(
      "/v1/changes?since=0&limit=1000&kinds=admin.added,admin.removed,admin.import_paused,admin.import_resumed",
      "GET",
      {},
    );
    expect(httpRes.status).toBe(200);
    const body = await httpRes.json<{ items: { kind: string; layout_id: string | null; admin: boolean; rev: number | null }[] }>();
    const kinds = body.items.map((i) => i.kind);
    expect(kinds).toContain("admin.added");
    expect(kinds).toContain("admin.removed");
    expect(kinds).toContain("admin.import_paused");
    expect(kinds).toContain("admin.import_resumed");
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

// X4 (12 §3 X4): the drill result and the health check. Neither appends an
// event (12 §6.4: ops state, not governance) -- the conformance suite
// (tests/conformance/admin-drill/*, admin-health/*) already sweeps the
// (route, status, code) matrix; this file covers the round-trip a fixture
// can't: a drill's own `ok`/`detail` reaching both `/v1/meta` (projected)
// and `/v1/admin/health` (in full).
describe("[LDB-A5] POST /v1/admin/drill and GET /v1/admin/health", () => {
  it("anonymous 401, non-admin 403, admin 200 -> { recorded: true }", async () => {
    const anon = await writeFetch("/v1/admin/drill", "POST", {}, { ok: true });
    expect(anon.status).toBe(401);

    const user = await writeFetch("/v1/admin/drill", "POST", userHeaders(`tok-${uniqueName("drill-user")}`), { ok: true });
    expect(user.status).toBe(403);

    const admin = await writeFetch("/v1/admin/drill", "POST", adminHeaders(`tok-${uniqueName("drill-admin")}`), {
      ok: true,
      detail: { dump: "dump-2026-07-15.json.gz" },
    });
    expect(admin.status).toBe(200);
    await expect(admin.json()).resolves.toEqual({ recorded: true });
  });

  it("a body missing 'ok' is 400 bad_request", async () => {
    const res = await writeFetch("/v1/admin/drill", "POST", adminHeaders(`tok-${uniqueName("drill-bad")}`), {});
    expect(res.status).toBe(400);
    const body = await res.json<{ error: string; param: string }>();
    expect(body.error).toBe("bad_request");
    expect(body.param).toBe("/ok");
  });

  it("a 'detail' over 4 KB is refused", async () => {
    const res = await writeFetch("/v1/admin/drill", "POST", adminHeaders(`tok-${uniqueName("drill-big")}`), {
      ok: true,
      detail: { blob: "x".repeat(5000) },
    });
    expect(res.status).toBe(400);
    const body = await res.json<{ error: string; param: string }>();
    expect(body.error).toBe("bad_request");
    expect(body.param).toBe("/detail");
  });

  it("[LDB-M1] a false report is recorded ok:false, and /v1/meta.last_drill reflects it", async () => {
    const res = await writeFetch("/v1/admin/drill", "POST", adminHeaders(`tok-${uniqueName("drill-fail")}`), {
      ok: false,
      detail: { step: "rehost" },
    });
    expect(res.status).toBe(200);

    const meta = await writeFetch("/v1/meta", "GET", {});
    const body = await meta.json<{ last_drill: { at: string; ok: boolean } | null }>();
    expect(body.last_drill).not.toBeNull();
    expect(body.last_drill!.ok).toBe(false);
  });

  it("GET /v1/admin/health is admin-only and carries the full last_diff/last_drill bodies", async () => {
    const anon = await writeFetch("/v1/admin/health", "GET", {});
    expect(anon.status).toBe(401);

    const user = await writeFetch("/v1/admin/health", "GET", userHeaders(`tok-${uniqueName("health-user")}`));
    expect(user.status).toBe(403);

    await writeFetch("/v1/admin/drill", "POST", adminHeaders(`tok-${uniqueName("health-seed")}`), { ok: true, detail: { note: "seed" } });

    const admin = await writeFetch("/v1/admin/health", "GET", adminHeaders(`tok-${uniqueName("health-admin")}`));
    expect(admin.status).toBe(200);
    const body = await admin.json<{ last_diff: unknown; last_drill: { ok: boolean; detail?: { note: string } } | null }>();
    expect(body.last_drill?.ok).toBe(true);
    expect(body.last_drill?.detail).toEqual({ note: "seed" });
  });
});
