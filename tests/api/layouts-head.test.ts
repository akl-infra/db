// [LDB-R15] `layouts_head.live` (migrations/0034) is exactly the old
// `SELECT COUNT(*) FROM layouts WHERE deleted = 0` after every kind of
// layout mutation, and `/v1/meta` reads it without changing its body.
import { SELF, store, testStore } from "../harness";
import { describe, expect, it } from "vitest";
import { readHead } from "../../src/core/etag";
import { readMetaCore } from "../../src/core/meta";
import { actorFixture, AKL_PAYLOAD, ensureAuthor, register, uniqueName, writeFetch } from "./write-support";

const OWNER = "owner-head-1";
const TARGET = "40000000000000001";

async function counter(): Promise<number> {
  return (await testStore.row<{ live: number }>("layouts_head", { id: 1 }))!.live;
}
async function liveCount(): Promise<number> {
  return testStore.count("layouts", { deleted: 0 });
}
// `viaHttp: false` reads the meta core directly -- raw SQL appends no event,
// so the route's seq-keyed ETag/edge cache would (by design, LDB-P1) not move.
async function expectExact(viaHttp = true): Promise<number> {
  const n = await liveCount();
  expect(await counter()).toBe(n);
  const body = viaHttp
    ? await (await SELF.fetch("https://example.com/v1/meta")).json<{ layout_count: number; layouts_modified_at: string | null }>()
    : await readMetaCore(store, await readHead(store));
  expect(body.layout_count).toBe(n);
  const liveModified = (await testStore.rows<{ modified_at: string }>("layouts", { deleted: 0 })).map((r) => r.modified_at);
  expect(body.layouts_modified_at).toBe(liveModified.length === 0 ? null : liveModified.reduce((a, b) => (a > b ? a : b)));
  return n;
}

function headers() {
  return register(actorFixture(), `tok-${uniqueName("head")}`, OWNER);
}

async function rawLayout(id: string, deleted: number): Promise<void> {
  await testStore.insert("layouts", { id, name: uniqueName("raw-head"), owner: "o", n: 1, layout_rev: 1, created_at: "t", modified_at: "t", deleted });
}

describe("[LDB-R15] layouts_head tracks the live-layout count exactly", () => {
  it("[LDB-R15] equals COUNT(*) after create, rename, transfer, delete, restore and PUT, and /v1/meta agrees", async () => {
    await ensureAuthor(TARGET, "target", "t", "t");
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

    await testStore.patch("layouts", { id: "01HEADRAW00000000000000001" }, { deleted: 1 });
    expect(await expectExact(false)).toBe(base);
    await testStore.patch("layouts", { id: "01HEADRAW00000000000000002" }, { deleted: 0 });
    expect(await expectExact(false)).toBe(base + 1);
    await testStore.patch("layouts", { id: "01HEADRAW00000000000000002" }, { deleted: 0 }); // no-op
    for (const l of await testStore.rows<{ id: string; name: string }>("layouts")) {
      await testStore.patch("layouts", { id: l.id }, { owner: "p", name: `${l.name}x`, like_count: 3 }); // not the flag
    }
    expect(await expectExact(false)).toBe(base + 1);

    await testStore.remove("layouts", { id: "01HEADRAW00000000000000001" }); // tombstone hard delete
    expect(await expectExact(false)).toBe(base + 1);
    await testStore.remove("layouts", { id: "01HEADRAW00000000000000002" }); // live hard delete
    expect(await expectExact(false)).toBe(base);
  });
});
