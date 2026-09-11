// [LDB-R5] `/history` (every event for the id, oldest first, naming its
// scope's `format`) and `/rev/{n}?format=F` (that format's payload as of
// its own rev n; out-of-range 404s) -- 21-formats.md §2.4.
import { SELF } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { commitWrite, type CommitInput } from "../../src/core/events";
import { formatsForLayout, readById } from "../../src/core/records";
import { fixedClock } from "../../src/core/time";
import { db, seedUpstream100 } from "./support";

interface EventRow {
  seq: number;
  rev: number | null;
  format: string | null;
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
  format: string | null;
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
  it("[LDB-R5] [LDB-P15] matches the events table row for row, source and format included", async () => {
    const { results: ids } = await db.prepare("SELECT id FROM layouts").all<{ id: string }>();
    expect(ids.length).toBeGreaterThan(0);

    for (const { id } of ids) {
      const res = await SELF.fetch(`https://example.com/v1/layouts/${id}/history`);
      expect(res.status).toBe(200);
      const items = await res.json<HistoryItem[]>();

      const { results: rows } = await db
        .prepare("SELECT seq, rev, format, at, actor, via, kind, admin, source_client, source_version FROM events WHERE layout_id = ? ORDER BY seq ASC")
        .bind(id)
        .all<EventRow>();

      expect(items.length).toBe(rows.length);
      for (let i = 0; i < items.length; i++) {
        const item = items[i]!;
        const row = rows[i]!;
        expect(item).toEqual({
          seq: row.seq,
          rev: row.rev,
          format: row.format,
          at: row.at,
          actor: row.actor,
          via: row.via,
          kind: row.kind,
          admin: row.admin !== 0,
          source: row.source_client === null ? { client: `legacy:${row.via}`, version: null } : { client: row.source_client, version: row.source_version },
        });
      }
    }
  });
});

describe("[LDB-R5] /rev/{n}?format=F reproduces that format's payload at rev n; rev+1 404s", () => {
  it("[LDB-R5] across several revisions of one record's spark/1 format", async () => {
    const seed = await db.prepare("SELECT id FROM layouts WHERE deleted = 0 LIMIT 1").first<{ id: string }>();
    if (seed === null) throw new Error("no live record to revise");

    const initialFormats = await formatsForLayout(db, seed.id);
    const originalPayload = initialFormats.get("spark")!.payload;
    const payloadsByRev: unknown[] = [originalPayload]; // index 0 == rev 1

    for (let i = 0; i < 3; i++) {
      const payload = { ...(originalPayload as Record<string, unknown>), magic: { notes: `rev-${i}` } };
      const current = (await readById(db, seed.id))!;
      const formats = await formatsForLayout(db, seed.id);
      const input: CommitInput = {
        layoutId: seed.id,
        creating: false,
        currentN: current.n,
        currentLayout: current,
        currentFormats: formats,
        format: { kind: "updated", lineage: "spark", format: "spark/1", payload, hasMagic: true },
        modified_at: `2026-06-09T00:0${i}:00.000Z`,
        actor: current.owner,
        via: "discord",
        source: { client: "discord-app:test", version: null },
        upstream: current.upstream,
      };
      await commitWrite(db, fixedClock(`2026-06-09T00:0${i}:00.000Z`), input);
      payloadsByRev.push(payload);
    }

    const finalFormats = await formatsForLayout(db, seed.id);
    expect(finalFormats.get("spark")!.rev).toBe(payloadsByRev.length); // 1 (import) + 3 updates

    for (let n = 1; n <= payloadsByRev.length; n++) {
      const res = await SELF.fetch(`https://example.com/v1/layouts/${seed.id}/rev/${n}?format=spark/1`);
      expect(res.status, `rev ${n}`).toBe(200);
      const body = await res.json<{ rev: number; payload: unknown }>();
      expect(body.rev).toBe(n);
      expect(body.payload).toEqual(payloadsByRev[n - 1]);
    }

    const outOfRange = await SELF.fetch(`https://example.com/v1/layouts/${seed.id}/rev/${payloadsByRev.length + 1}?format=spark/1`);
    expect(outOfRange.status).toBe(404);
  });
});
