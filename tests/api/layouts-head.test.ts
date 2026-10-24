// [LDB-R15] `layouts_head.live` (migrations/0034) is exactly the old
// `SELECT COUNT(*) FROM layouts WHERE deleted = 0` after every kind of
// layout mutation, and `/v1/meta` reads it without changing its body.
import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { Bindings } from "../../src/env";
import { readHead } from "../../src/core/etag";
import { readMetaCore } from "../../src/core/meta";
import { AKL_PAYLOAD, actorFixture, register, uniqueName, writeFetch } from "./write-support";

const db = (env as unknown as Bindings).DB;
const OWNER = "owner-head-1";
const TARGET = "40000000000000001";

async function counter(): Promise<number> {
  return (await db.prepare("SELECT live FROM layouts_head WHERE id = 1").first<{ live: number }>())!.live;
}
async function liveCount(): Promise<number> {
  return (await db.prepare("SELECT COUNT(*) AS n FROM layouts WHERE deleted = 0").first<{ n: number }>())!.n;
}
// `viaHttp: false` reads the meta core directly -- raw SQL appends no event,
// so the route's seq-keyed ETag/edge cache would (by design, LDB-P1) not move.
async function expectExact(viaHttp = true): Promise<number> {
  const n = await liveCount();
  expect(await counter()).toBe(n);
  const body = viaHttp
    ? await (await SELF.fetch("https://example.com/v1/meta")).json<{ layout_count: number; layouts_modified_at: string | null }>()
    : await readMetaCore(db, await readHead(db));
  expect(body.layout_count).toBe(n);
  const old = await db
    .prepare("SELECT MAX(modified_at) AS modified FROM layouts WHERE deleted = 0")
    .first<{ modified: string | null }>();
  expect(body.layouts_modified_at).toBe(old?.modified ?? null);
  return n;
}

function headers() {
  return register(actorFixture(), `tok-${uniqueName("head")}`, OWNER);
}

async function rawLayout(id: string, deleted: number): Promise<void> {
  await db
    .prepare(
      "INSERT INTO layouts (id, name, owner, n, layout_rev, created_at, modified_at, deleted) VALUES (?, ?, 'o', 1, 1, 't', 't', ?)",
    )
    .bind(id, uniqueName("raw-head"), deleted)
    .run();
}

describe("[LDB-R15] layouts_head tracks the live-layout count exactly", () => {
  it("[LDB-R15] equals COUNT(*) after create, rename, transfer, delete, restore and PUT, and /v1/meta agrees", async () => {
    await db.prepare("INSERT OR IGNORE INTO authors (user_id, name, first_seen_at, last_seen_at) VALUES (?, 'target', 't', 't')").bind(TARGET).run();
    const h = headers();
    let n = await expectExact();

    const created = await writeFetch("/v1/layouts", "POST", h, { name: uniqueName("head-create"), format: "spark/1", payload: AKL_PAYLOAD });
    expect(created.status).toBe(201);
    const rec = await created.json<{ id: string; layout_rev?: number }>();
    expect(await expectExact()).toBe(n + 1);
    n += 1;

    const renamed = await writeFetch(`/v1/layouts/${rec.id}`, "PATCH", { ...h, "If-Match": "*" }, { name: uniqueName("head-renamed") });
    expect(renamed.status).toBe(200);
    expect(await expectExact()).toBe(n);

    const put = await writeFetch(`/v1/layouts/${rec.id}`, "PUT", { ...h, "If-Match": "*" }, { format: "spark/1", payload: AKL_PAYLOAD });
    expect([200, 201]).toContain(put.status);
    expect(await expectExact()).toBe(n);

    const transferred = await writeFetch(`/v1/layouts/${rec.id}/transfer`, "POST", { ...h, "If-Match": "*" }, { to: TARGET });
    expect(transferred.status).toBe(200);
    expect(await expectExact()).toBe(n);

    // The transfer target has no token here, so delete and restore as admin.
    const admin = register(actorFixture(), `tok-${uniqueName("head-admin")}`, "184412255822020608");
    const deleted = await writeFetch(`/v1/layouts/${rec.id}`, "DELETE", { ...admin, "If-Match": "*" });
    expect(deleted.status).toBe(200);
    expect(await expectExact()).toBe(n - 1);

    const restored = await writeFetch(`/v1/layouts/${rec.id}/restore`, "POST", { ...admin, "If-Match": "*" });
    expect(restored.status).toBe(200);
    expect(await expectExact()).toBe(n);
  });

  it("[LDB-R15] equals COUNT(*) after raw inserts, deleted flips and hard deletes", async () => {
    const base = await expectExact(false);
    await rawLayout("01HEADRAW00000000000000001", 0);
    await rawLayout("01HEADRAW00000000000000002", 1); // a tombstone insert does not count
    expect(await expectExact(false)).toBe(base + 1);

    await db.prepare("UPDATE layouts SET deleted = 1 WHERE id = '01HEADRAW00000000000000001'").run();
    expect(await expectExact(false)).toBe(base);
    await db.prepare("UPDATE layouts SET deleted = 0 WHERE id = '01HEADRAW00000000000000002'").run();
    expect(await expectExact(false)).toBe(base + 1);
    await db.prepare("UPDATE layouts SET deleted = 0 WHERE id = '01HEADRAW00000000000000002'").run(); // no-op
    await db.prepare("UPDATE layouts SET owner = 'p', name = name || 'x', like_count = 3").run(); // not the flag
    expect(await expectExact(false)).toBe(base + 1);

    await db.prepare("DELETE FROM layouts WHERE id = '01HEADRAW00000000000000001'").run(); // tombstone hard delete
    expect(await expectExact(false)).toBe(base + 1);
    await db.prepare("DELETE FROM layouts WHERE id = '01HEADRAW00000000000000002'").run(); // live hard delete
    expect(await expectExact(false)).toBe(base);
  });
});
