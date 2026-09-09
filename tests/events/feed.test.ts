// [LDB-P6] `/v1/changes`'s backing function: seq order, `since` exclusive,
// `next` = last seq returned, `limit` capped at 1000, `kinds` filters.
// S7 extends this file's DoD clause with a restore-from-dump case; not
// testable until S7 lands the dump/restore path.
import { env } from "cloudflare:test";
import type { Bindings } from "../../src/env";
import { describe, expect, it } from "vitest";
import { appendInfo, appendLike, appendWrite, feed } from "../../src/core/events";
import { fixedClock } from "../../src/core/time";

const db = (env as unknown as Bindings).DB;

// Seeds N bare informational-shaped event rows directly (bypassing
// appendInfo's per-row round trip) so the 1000-row cap is exercised without
// 1000+ awaited D1 calls; chunked at <=100 statements/batch (07 §4).
async function seedBareEvents(n: number, kind: string): Promise<void> {
  const stmts = [];
  for (let i = 0; i < n; i++) {
    stmts.push(
      db
        .prepare(
          `INSERT INTO events (at, kind, layout_id, name, owner, rev, actor, via, admin)
           VALUES (?, ?, NULL, NULL, NULL, NULL, 'system:cmini-import', 'import:cmini', 0)`,
        )
        .bind(`2026-03-01T00:00:${String(i % 60).padStart(2, "0")}.${String(i).padStart(3, "0")}Z`, kind),
    );
  }
  for (let i = 0; i < stmts.length; i += 100) {
    await db.batch(stmts.slice(i, i + 100));
  }
}

describe("feed", () => {
  it("[LDB-P6] returns everything in seq order from since=0", async () => {
    const clock = fixedClock("2026-03-02T00:00:00.000Z");
    const a = await appendWrite(db, clock, {
      kind: "created",
      name: "feed-a",
      owner: "owner-a",
      modified_at: clock(),
      format: "cmini/1",
      payload: {},
      actor: "tester",
      via: "discord",
    });
    const b = await appendWrite(db, clock, {
      kind: "created",
      name: "feed-b",
      owner: "owner-a",
      modified_at: clock(),
      format: "cmini/1",
      payload: {},
      actor: "tester",
      via: "discord",
    });

    const { items, next } = await feed(db, 0, 1000);
    expect(items.map((e) => e.seq)).toEqual([...items.map((e) => e.seq)].sort((x, y) => x - y));
    const seqs = items.map((e) => e.seq);
    expect(seqs).toContain(a.seq);
    expect(seqs).toContain(b.seq);
    expect(next).toBe(items[items.length - 1]!.seq);
  });

  it("[LDB-P6] since is exclusive; next is the last seq returned; a cursor walk covers everything once", async () => {
    const clock = fixedClock("2026-03-03T00:00:00.000Z");
    for (let i = 0; i < 5; i++) {
      await appendWrite(db, clock, {
        kind: "created",
        name: `feed-walk-${i}-${Math.random()}`,
        owner: "owner-a",
        modified_at: clock(),
        format: "cmini/1",
        payload: {},
        actor: "tester",
        via: "discord",
      });
    }

    const all = await feed(db, 0, 1000);
    const first = await feed(db, 0, 2);
    expect(first.items.length).toBe(2);
    expect(first.next).toBe(first.items[1]!.seq);

    const second = await feed(db, first.next, 2);
    expect(second.items[0]!.seq).toBeGreaterThan(first.next); // exclusive

    // walking the whole feed in pages of 2 visits every event exactly once
    let cursor = 0;
    const walked: number[] = [];
    for (;;) {
      const page = await feed(db, cursor, 2);
      if (page.items.length === 0) break;
      walked.push(...page.items.map((e) => e.seq));
      cursor = page.next;
    }
    expect(walked).toEqual(all.items.map((e) => e.seq));
  });

  it("[LDB-P6] limit is capped at 1000 even when more is requested", async () => {
    await seedBareEvents(1005, "upstream_changed");
    const { items } = await feed(db, 0, 100000);
    expect(items.length).toBe(1000);
  });

  it("[LDB-P6] kinds filters the feed", async () => {
    const clock = fixedClock("2026-03-04T00:00:00.000Z");
    const { record } = await appendWrite(db, clock, {
      kind: "created",
      name: `feed-kinds-${Math.random()}`,
      owner: "owner-a",
      modified_at: clock(),
      format: "cmini/1",
      payload: {},
      actor: "tester",
      via: "discord",
    });
    await appendInfo(db, clock, {
      kind: "upstream_changed",
      layoutId: record.id,
      actor: "system:cmini-import",
      via: "import:cmini",
    });
    await appendLike(db, clock, { kind: "liked", layoutId: record.id, userId: "u1", via: "discord" });

    const { items } = await feed(db, 0, 1000, ["liked"]);
    expect(items.length).toBeGreaterThan(0);
    for (const e of items) expect(e.kind).toBe("liked");
  });
});
