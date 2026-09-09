// [LDB-R5] `/history` (every event for the id, oldest first) and
// `/rev/{n}` (the record as of rev n; out-of-range 404s) -- 03 §2, 07 §6
// S6.
import { SELF } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { appendWrite } from "../../src/core/events";
import { fixedClock } from "../../src/core/time";
import { db, seedUpstream100 } from "./support";

interface EventRow {
  seq: number;
  rev: number | null;
  at: string;
  actor: string;
  via: string;
  kind: string;
  admin: number;
}

interface HistoryItem {
  seq: number;
  rev: number | null;
  at: string;
  actor: string;
  via: string;
  kind: string;
  admin: boolean;
}

beforeAll(async () => {
  await seedUpstream100();
});

describe("[LDB-R5] /history equals a record's own events, for every seed record", () => {
  it("[LDB-R5] matches the events table row for row", async () => {
    const { results: ids } = await db.prepare("SELECT id FROM layouts").all<{ id: string }>();
    expect(ids.length).toBeGreaterThan(0);

    for (const { id } of ids) {
      const res = await SELF.fetch(`https://example.com/v1/layouts/${id}/history`);
      expect(res.status).toBe(200);
      const items = await res.json<HistoryItem[]>();

      const { results: rows } = await db
        .prepare("SELECT seq, rev, at, actor, via, kind, admin FROM events WHERE layout_id = ? ORDER BY seq ASC")
        .bind(id)
        .all<EventRow>();

      expect(items.length).toBe(rows.length);
      for (let i = 0; i < items.length; i++) {
        const item = items[i]!;
        const row = rows[i]!;
        expect(item).toEqual({
          seq: row.seq,
          rev: row.rev,
          at: row.at,
          actor: row.actor,
          via: row.via,
          kind: row.kind,
          admin: row.admin !== 0,
        });
      }
    }
  });
});

describe("[LDB-R5] /rev/{n} reproduces the payload stored at rev n; rev+1 404s", () => {
  it("[LDB-R5] across several revisions of one record", async () => {
    const seed = await db
      .prepare("SELECT id, name, owner, format, payload_json FROM layouts WHERE deleted = 0 LIMIT 1")
      .first<{ id: string; name: string; owner: string; format: string; payload_json: string }>();
    if (seed === null) throw new Error("no live record to revise");

    const originalPayload: unknown = JSON.parse(seed.payload_json);
    const payloadsByRev: unknown[] = [originalPayload]; // index 0 == rev 1

    for (let i = 0; i < 3; i++) {
      const payload = { ...(originalPayload as Record<string, unknown>), _rev_marker: i };
      await appendWrite(db, fixedClock(`2026-06-09T00:0${i}:00.000Z`), {
        kind: "updated",
        layoutId: seed.id,
        name: seed.name,
        owner: seed.owner,
        modified_at: `2026-06-09T00:0${i}:00.000Z`,
        format: seed.format,
        payload,
        actor: seed.owner,
        via: "discord",
      });
      payloadsByRev.push(payload);
    }

    const current = await db.prepare("SELECT rev FROM layouts WHERE id = ?").bind(seed.id).first<{ rev: number }>();
    expect(current?.rev).toBe(payloadsByRev.length); // 1 (import) + 3 updates

    for (let n = 1; n <= payloadsByRev.length; n++) {
      const res = await SELF.fetch(`https://example.com/v1/layouts/${seed.id}/rev/${n}?as=${seed.format}`);
      expect(res.status, `rev ${n}`).toBe(200);
      const body = await res.json<{ rev: number; payload: unknown }>();
      expect(body.rev).toBe(n);
      expect(body.payload).toEqual(payloadsByRev[n - 1]);
    }

    const outOfRange = await SELF.fetch(`https://example.com/v1/layouts/${seed.id}/rev/${payloadsByRev.length + 1}`);
    expect(outOfRange.status).toBe(404);
  });
});
