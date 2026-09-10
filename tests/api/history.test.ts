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
  source_client: string | null;
  source_version: string | null;
}

interface HistoryItem {
  seq: number;
  rev: number | null;
  at: string;
  actor: string;
  via: string;
  kind: string;
  admin: boolean;
  source: { client: string; version: string | null };
}

beforeAll(async () => {
  await seedUpstream100();
});

describe("[LDB-R5] /history equals a record's own events, for every seed record", () => {
  it("[LDB-R5] [LDB-P15] matches the events table row for row, source included", async () => {
    const { results: ids } = await db.prepare("SELECT id FROM layouts").all<{ id: string }>();
    expect(ids.length).toBeGreaterThan(0);

    for (const { id } of ids) {
      const res = await SELF.fetch(`https://example.com/v1/layouts/${id}/history`);
      expect(res.status).toBe(200);
      const items = await res.json<HistoryItem[]>();

      const { results: rows } = await db
        .prepare("SELECT seq, rev, at, actor, via, kind, admin, source_client, source_version FROM events WHERE layout_id = ? ORDER BY seq ASC")
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
          // 20-spark.md S3s (LDB-P15): a NULL `source_client` (written
          // before 0005) reads `legacy:<via>` -- the same rule
          // `core/events.ts`'s `sourceOfEvent` applies, recomputed here
          // independently off the raw row rather than imported.
          source: row.source_client === null ? { client: `legacy:${row.via}`, version: null } : { client: row.source_client, version: row.source_version },
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
      // `tag` (a real cmini/1 schema field, round-trips through `x.cmini`)
      // distinguishes each revision's payload -- NOT a bare out-of-schema
      // marker key like an earlier version of this test used. Since
      // 20-spark.md S1 (LDB-F21), every read of a legacy-stored row --
      // `/rev/{n}` included, even at the row's OWN format -- normalizes
      // through `storedAsSpark` first (no raw-identity shortcut for a
      // legacy format), which round-trips a real cmini/1 payload exactly
      // but would silently drop an unknown top-level key the same way
      // `fromCmini`/`toCmini` always have for any field with no cmini
      // idiom (01 §6.1/§6.2, LDB-F10).
      const payload = { ...(originalPayload as Record<string, unknown>), tag: `rev-${i}` };
      await appendWrite(db, fixedClock(`2026-06-09T00:0${i}:00.000Z`), {
      upstream: null,
        kind: "updated",
        layoutId: seed.id,
        name: seed.name,
        owner: seed.owner,
        modified_at: `2026-06-09T00:0${i}:00.000Z`,
        format: seed.format,
        payload,
        actor: seed.owner,
        via: "discord",
        source: { client: "discord-app:test", version: null },
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
