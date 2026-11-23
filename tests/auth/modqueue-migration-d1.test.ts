// D1-only (design/p1-briefs.md F): applies migrations/0031 itself.
import type { D1Migration } from "@cloudflare/vitest-pool-workers";
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

const db = (env as unknown as { DB: D1Database }).DB;

describe("[LDB-MD23] migration 0031 reconciles tracked cards", () => {
  it("resets every modqueue_notifications.shown_review_version to -1", async () => {
    const migrations = (env as unknown as { TEST_MIGRATIONS: D1Migration[] }).TEST_MIGRATIONS;
    const migration = migrations.find((m) => m.name.startsWith("0031_"))!;
    expect(migration).toBeDefined();
    await db.batch([
      db.prepare("INSERT INTO modqueue_notifications (kind, submission_id, message_id, shown_status, shown_review_version) VALUES ('link', 'mig0031-a', 'm-a', 'pending', 3)"),
      db.prepare("INSERT INTO modqueue_notifications (kind, submission_id, message_id, shown_status, shown_review_version) VALUES ('wpm', 'mig0031-b', 'm-b', 'approved', 0)"),
    ]);
    try {
      await db.batch(migration.queries.map((query) => db.prepare(query)));
      const { results } = await db.prepare("SELECT shown_review_version AS v FROM modqueue_notifications WHERE submission_id IN ('mig0031-a', 'mig0031-b')").all<{ v: number }>();
      expect(results.map((r) => r.v)).toEqual([-1, -1]);
      expect((await db.prepare("SELECT COUNT(*) AS n FROM modqueue_notifications WHERE shown_review_version != -1").first<{ n: number }>())!.n).toBe(0);
    } finally {
      await db.prepare("DELETE FROM modqueue_notifications WHERE submission_id IN ('mig0031-a', 'mig0031-b')").run();
    }
  });
});

describe("[LDB-MD26] migration 0039 un-parks cards parked for the media-url error", () => {
  it("[LDB-MD26] un-parks exactly the cards parked for UNFURLED_MEDIA_ITEM_MUST_USE_ATTACHMENT_PROTOCOL", async () => {
    const insert = (id: string, err: string) => db.prepare("INSERT INTO modqueue_notifications (kind, submission_id, message_id, shown_status, failed_attempts, parked_at, parked_key, parked_error) VALUES ('comment', ?, 'm', 'pending', 1, '2026-11-23T00:00:00.000Z', 'approved:0:', ?)").bind(id, err);
    await db.batch([
      insert("mig0039-a", 'status edit status 400 {"errors":{"file":{"url":{"_errors":[{"code":"UNFURLED_MEDIA_ITEM_MUST_USE_ATTACHMENT_PROTOCOL"}]}}}}'),
      insert("mig0039-b", "status edit status 403 Missing Permissions"),
    ]);
    try {
      const migrations = (env as unknown as { TEST_MIGRATIONS: D1Migration[] }).TEST_MIGRATIONS;
      const migration = migrations.find((m) => m.name.startsWith("0039_"))!;
      await db.batch(migration.queries.map((query) => db.prepare(query)));
      const { results } = await db.prepare("SELECT submission_id AS id, parked_at, failed_attempts AS f FROM modqueue_notifications WHERE submission_id IN ('mig0039-a', 'mig0039-b') ORDER BY submission_id").all<{ id: string; parked_at: string | null; f: number }>();
      expect(results).toEqual([{ id: "mig0039-a", parked_at: null, f: 0 }, { id: "mig0039-b", parked_at: "2026-11-23T00:00:00.000Z", f: 1 }]);
    } finally {
      await db.prepare("DELETE FROM modqueue_notifications WHERE submission_id IN ('mig0039-a', 'mig0039-b')").run();
    }
  });
});
