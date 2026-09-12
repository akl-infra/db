// [LDB-P6] `/v1/changes`'s backing function: seq order, `since` exclusive,
// `next` = last seq returned, `limit` capped at 1000, `kinds` filters.
import { env } from "cloudflare:test";
import type { Bindings } from "../../src/env";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { canonical } from "../../src/core/canonical";
import { headSeq } from "../../src/core/etag";
import { appendAdmin, appendInfo, appendLike, commitWrite, feed, type CommitInput, type EventSnapshot } from "../../src/core/events";
import { formatsForLayout, readById } from "../../src/core/records";
import { fixedClock, steppingClock } from "../../src/core/time";
import { ulid } from "ulidx";

const db = (env as unknown as Bindings).DB;
const bindings = env as unknown as Bindings;
const SOURCE = { client: "discord-app:test", version: null };

function create(clock: () => string, name: string, owner = "owner-a") {
  const input: CommitInput = {
    layoutId: ulid(),
    creating: true,
    currentN: 0,
    currentLayout: null,
    currentFormats: new Map(),
    layout: { kind: "created", name, owner, created_at: clock(), deleted: false },
    format: { kind: "format_added", lineage: "spark", format: "spark/1", payload: {}, hasMagic: false },
    modified_at: clock(),
    actor: "tester",
    via: "discord",
    source: SOURCE,
    upstream: null,
  };
  return commitWrite(db, clock, input);
}

// Seeds N bare informational-shaped event rows directly (bypassing
// appendInfo's per-row round trip) so the 1000-row cap is exercised without
// 1000+ awaited D1 calls; chunked at <=100 statements/batch.
async function seedBareEvents(n: number, kind: string): Promise<void> {
  const stmts = [];
  for (let i = 0; i < n; i++) {
    stmts.push(
      db
        .prepare(
          `INSERT INTO events (at, kind, layout_id, name, owner, format, rev, actor, via, admin)
           VALUES (?, ?, NULL, NULL, NULL, NULL, NULL, 'system:cmini-import', 'import:cmini', 0)`,
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
    const a = await create(clock, "feed-a");
    const b = await create(clock, "feed-b");

    const { items, next } = await feed(db, 0, 1000);
    expect(items.map((e) => e.seq)).toEqual([...items.map((e) => e.seq)].sort((x, y) => x - y));
    const seqs = items.map((e) => e.seq);
    expect(seqs).toContain(a.seqs[0]);
    expect(seqs).toContain(b.seqs[0]);
    expect(next).toBe(items[items.length - 1]!.seq);
  });

  it("[LDB-P6] since is exclusive; next is the last seq returned; a cursor walk covers everything once", async () => {
    const clock = fixedClock("2026-03-03T00:00:00.000Z");
    for (let i = 0; i < 5; i++) {
      await create(clock, `feed-walk-${i}-${Math.random()}`);
    }

    const all = await feed(db, 0, 1000);
    const first = await feed(db, 0, 2);
    expect(first.items.length).toBe(2);
    expect(first.next).toBe(first.items[1]!.seq);

    const second = await feed(db, first.next, 2);
    expect(second.items[0]!.seq).toBeGreaterThan(first.next); // exclusive

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
    const { layout } = await create(clock, `feed-kinds-${Math.random()}`);
    await appendInfo(db, clock, { kind: "upstream_changed", layoutId: layout.id, actor: "system:cmini-import", via: "import:cmini", source: { client: "system:cmini-import", version: null } });
    await appendLike(db, clock, { kind: "liked", layoutId: layout.id, userId: "u1", via: "discord", source: SOURCE });

    const { items } = await feed(db, 0, 1000, ["liked"]);
    expect(items.length).toBeGreaterThan(0);
    for (const e of items) expect(e.kind).toBe("liked");
  });

  it("[LDB-P6] admin events (NULL layout_id) round-trip through feed()/rowToEvent", async () => {
    const clock = fixedClock("2026-03-05T00:00:00.000Z");
    const { seq } = await appendAdmin(db, clock, { kind: "admin.added", actor: "admin-tester", detail: { user_id: "30000000000000099", note: "x" } });

    const { items } = await feed(db, seq - 1, 1);
    expect(items).toHaveLength(1);
    const e = items[0]!;
    expect(e.seq).toBe(seq);
    expect(e.kind).toBe("admin.added");
    expect(e.layout_id).toBeNull();
    expect(e.name).toBeNull();
    expect(e.owner).toBeNull();
    expect(e.format).toBeNull();
    expect(e.rev).toBeNull();
    expect(e.admin).toBe(true);
    expect(e.via).toBe("discord");
    expect(e.detail).toEqual({ user_id: "30000000000000099", note: "x" });
  });
});

