// D1-only (design/p1-briefs.md A). The port methods whose SQL text differs
// from the per-caller queries they replaced must return exactly what those
// queries returned: same rows, same order, same column types.
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { ulid } from "ulidx";
import type { Bindings } from "../../src/env";
import { appendLike, commitWrite, type CommitInput } from "../../src/core/events";
import { fixedClock } from "../../src/core/time";
import { createD1Store } from "../../src/store/d1";
import { AKL_PAYLOAD, uniqueName } from "./write-support";

const db = (env as unknown as Bindings).DB;
const store = createD1Store(db);
const clock = fixedClock("2026-07-09T00:00:00.000Z");
const SOURCE = { client: "discord-app:test", version: null };

async function seed(owner: string, name = uniqueName("p1a")) {
  const input: CommitInput = {
    layoutId: ulid(),
    creating: true,
    currentN: 0,
    currentLayout: null,
    currentFormats: new Map(),
    layout: { kind: "created", name, owner, created_at: clock(), deleted: false },
    format: { kind: "format_added", lineage: "spark", format: "spark/1", payload: AKL_PAYLOAD, hasMagic: false },
    modified_at: clock(),
    actor: owner,
    via: "discord",
    source: SOURCE,
    upstream: null,
  };
  return (await commitWrite(db, clock, input)).layout;
}

async function like(layoutId: string, userId: string) {
  await appendLike(db, clock, { kind: "liked", layoutId, userId, via: "discord", source: SOURCE });
}

describe("P1 A: port methods equal the queries they replaced", () => {
  it("likers == the /likes route's SELECT user_id ... ORDER BY user_id, and the multi-id likesByLayout", async () => {
    const a = await seed("own-1");
    const b = await seed("own-1");
    const empty = await seed("own-1");
    for (const u of ["u-c", "u-a", "u-b"]) await like(a.id, u);
    await like(b.id, "u-z");
    await like(b.id, "u-a");

    for (const l of [a, b, empty]) {
      const old = await db.prepare("SELECT user_id FROM likes WHERE layout_id = ? ORDER BY user_id ASC").bind(l.id).all<{ user_id: string }>();
      const got = await store.layouts.likers([l.id]);
      expect(got.get(l.id)).toStrictEqual(old.results.map((r) => r.user_id));
    }
    const ids = [a.id, b.id, empty.id];
    const many = await db
      .prepare(`SELECT layout_id, user_id FROM likes WHERE layout_id IN (${ids.map(() => "?").join(",")}) ORDER BY layout_id, user_id ASC`)
      .bind(...ids)
      .all<{ layout_id: string; user_id: string }>();
    const expected = new Map<string, string[]>(ids.map((id) => [id, []]));
    for (const r of many.results) expected.get(r.layout_id)!.push(r.user_id);
    expect(await store.layouts.likers(ids)).toStrictEqual(expected);
  });

  it("layoutPresence == the SELECT id FROM layouts [AND deleted = 0] checks", async () => {
    const live = await seed("own-2");
    const dead = await seed("own-2");
    await db.prepare("UPDATE layouts SET deleted = 1 WHERE id = ?").bind(dead.id).run();
    for (const id of [live.id, dead.id, ulid()]) {
      const exists = (await db.prepare("SELECT id FROM layouts WHERE id = ?").bind(id).first()) !== null;
      const isLive = (await db.prepare("SELECT id FROM layouts WHERE id = ? AND deleted = 0").bind(id).first()) !== null;
      expect(await store.layouts.layoutPresence(id)).toStrictEqual({ exists, live: isLive });
    }
  });

  it("approvedLink / liveCountByOwner / likeCountByUser == the old SELECTs", async () => {
    const l = await seed("own-3");
    await seed("own-3");
    await like(l.id, "u-count");
    expect(await store.layouts.approvedLink(l.id)).toStrictEqual(await db.prepare("SELECT link FROM layouts WHERE id = ?").bind(l.id).first());
    expect(await store.layouts.approvedLink(ulid())).toBeNull();
    const n = await db.prepare("SELECT COUNT(*) AS n FROM layouts WHERE owner = ? AND deleted = 0").bind("own-3").first<{ n: number }>();
    expect(await store.layouts.liveCountByOwner("own-3")).toBe(n!.n);
    const m = await db.prepare("SELECT COUNT(*) AS n FROM likes WHERE user_id = ?").bind("u-count").first<{ n: number }>();
    expect(await store.layouts.likeCountByUser("u-count")).toBe(m!.n);
  });
});
