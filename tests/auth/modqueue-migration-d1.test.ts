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
