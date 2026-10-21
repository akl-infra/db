// [LDB-MD20] Reopening is a new review cycle, never an event-log rewind.
import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ulid } from "ulidx";
import type { Actor } from "../../src/auth/actor";
import type { Bindings } from "../../src/env";
import { approveComment, rejectComment, reopenComment, deleteOwnComment, listCommentCounts, removeComment } from "../../src/core/comments";
import { approveWpm, rejectWpm, reopenWpm, listWpmRecords } from "../../src/core/wpm";
import { readReviewHistory } from "../../src/core/moderation-review";
import { dispatchRejectionDms } from "../../src/core/rejection-dm";
import { buildDump } from "../../src/dump/write";
import { restoreSql } from "../../src/dump/restore";
import { BOOTSTRAP_ADMIN, actorFixture, register, writeFetch } from "./write-support";

const bindings = env as unknown as Bindings;
const db = bindings.DB;
const actor: Actor = { user_id: BOOTSTRAP_ADMIN, name: "mod", via: "discord", admin: true, banned: false, source_client: "discord-app:test" };
const user = { ...actor, user_id: "900000000000000002", admin: false };
const at = "2026-10-18T01:00:00.000Z";
const clock = () => at;
afterEach(() => vi.unstubAllGlobals());

async function seed() {
  await db.prepare("DELETE FROM discord_rejection_dm_outbox").run();
  const layout = ulid(), comment = ulid(), wpm = ulid();
  await db.prepare(`INSERT INTO layouts (id, name, owner, n, layout_rev, created_at, modified_at)
    VALUES (?, ?, ?, 1, 1, ?, ?)`).bind(layout, `reopen-${layout.toLowerCase()}`, user.user_id, at, at).run();
  await db.batch([
    db.prepare(`INSERT INTO layout_comments (id, layout_id, user_id, body, via, submitted_at, status)
      VALUES (?, ?, ?, 'private comment', 'discord', ?, 'pending')`).bind(comment, layout, user.user_id, at),
    db.prepare(`INSERT INTO wpm_submissions (id, layout_id, user_id, wpm, proof, submitted_by, via, submitted_at, status)
      VALUES (?, ?, ?, 120, 'https://example.org/proof', ?, 'discord', ?, 'pending')`).bind(wpm, layout, user.user_id, user.user_id, at),
  ]);
  return { layout, comment, wpm };
}
const conflict = { status: 409, body: { error: "review_conflict" } };

describe("[LDB-MD20] moderation reopening", () => {
  it("[LDB-MD23] REST approval routes gate the private DM enqueue for WPM and comments", async () => {
    const { comment, wpm } = await seed();
    const fake = actorFixture();
    const admin = register(fake, `approval-dm-admin-${comment}`, actor.user_id);
    const oldGate = bindings.MODQUEUE_DISCORD_DMS;
    const oldToken = bindings.MODQUEUE_DISCORD_BOT_TOKEN;
    try {
      bindings.MODQUEUE_DISCORD_DMS = "true";
      bindings.MODQUEUE_DISCORD_BOT_TOKEN = undefined;
      for (const [kind, id] of [["comment", comment], ["wpm", wpm]] as const) {
        expect((await writeFetch(`/v1/admin/${kind}-queue/${id}/approve`, "POST", admin)).status).toBe(200);
        expect(await db.prepare("SELECT decision, status FROM discord_rejection_dm_outbox WHERE submission_id = ?").bind(id).first())
          .toEqual({ decision: "approval", status: "pending" });
      }
    } finally {
      bindings.MODQUEUE_DISCORD_DMS = oldGate;
      bindings.MODQUEUE_DISCORD_BOT_TOKEN = oldToken;
    }
  });
  it("[LDB-MD20] repeats rejection cycles, cancels delivery and preserves private decisions without rewinding events", async () => {
    const { comment } = await seed();
    await rejectComment(db, clock, actor, null, comment, "private reason one", { notifySubmitter: true });
    const first = await reopenComment(db, clock, actor, null, comment, { status: "rejected", review_version: 0 });
    expect(first).toMatchObject({ status: "pending", review_version: 1, decided_at: null, decided_by: null, reason: null, body: "private comment" });
    await expect(approveComment(db, clock, actor, null, comment)).rejects.toMatchObject(conflict);
    await expect(rejectComment(db, clock, actor, null, comment, "stale")).rejects.toMatchObject(conflict);
    await rejectComment(db, clock, actor, null, comment, "private reason two", { reviewVersion: 1, notifySubmitter: true });
    const deliveries = await db.prepare("SELECT delivery_key, status, review_version, nonce FROM discord_rejection_dm_outbox WHERE submission_id = ? ORDER BY review_version").bind(comment).all();
    expect(deliveries.results).toMatchObject([
      { delivery_key: `rejection:comment:${comment}`, status: "expired", review_version: 0 },
      { delivery_key: `rejection:comment:${comment}:1`, status: "pending", review_version: 1 },
    ]);
    expect(deliveries.results[0]!.nonce).not.toBe(deliveries.results[1]!.nonce);
    await expect(reopenComment(db, clock, actor, null, comment, { status: "rejected", review_version: 0 })).rejects.toMatchObject(conflict);
    await reopenComment(db, clock, actor, null, comment, { status: "rejected", review_version: 1 });
    await approveComment(db, clock, actor, null, comment, 2);
    const history = await readReviewHistory(db, "comment", comment);
    expect(history.map(({ action, review_version, reason }) => ({ action, review_version, reason }))).toEqual([
      { action: "rejected", review_version: 0, reason: "private reason one" },
      { action: "reopened", review_version: 1, reason: null },
      { action: "rejected", review_version: 1, reason: "private reason two" },
      { action: "reopened", review_version: 2, reason: null },
      { action: "approved", review_version: 2, reason: null },
    ]);
    const events = await db.prepare("SELECT kind, detail_json FROM events WHERE detail_json LIKE ? ORDER BY seq").bind(`%${comment}%`).all<{ kind: string; detail_json: string }>();
    expect(events.results.map((e) => e.kind)).toEqual(["comment_rejected", "comment_reopened", "comment_rejected", "comment_reopened", "comment_approved"]);
    expect(JSON.stringify(events.results)).not.toContain("private reason");
    expect(JSON.stringify(events.results)).not.toContain("private comment");
    const dump = await buildDump(bindings, clock);
    expect(JSON.stringify(dump)).not.toContain("private reason");
    expect(Object.keys(dump)).not.toContain("moderation_review_history");
    expect(restoreSql(dump).join("\n")).toContain("DELETE FROM moderation_review_history");
    expect(restoreSql(dump).join("\n")).not.toContain("INSERT INTO moderation_review_history");
    expect(dump.layout_comments.find((c) => c.id === comment)?.review_version).toBe(2);
  });

  it("[LDB-MD20] withdraws approval publicly, preserves slot likes and falls back to the previous WPM best", async () => {
    const { layout, comment, wpm } = await seed();
    const olderWpm = ulid();
    await db.prepare(`INSERT INTO wpm_submissions (id, layout_id, user_id, wpm, proof, submitted_by, via, submitted_at, status, decided_by, decided_at)
      VALUES (?, ?, ?, 100, 'https://example.org/older', ?, 'discord', '2026-10-17T00:00:00.000Z', 'approved', ?, ?)`)
      .bind(olderWpm, layout, user.user_id, user.user_id, actor.user_id, at).run();
    await approveComment(db, clock, actor, null, comment);
    await approveWpm(db, clock, actor, null, wpm);
    await db.prepare("INSERT INTO comment_likes (layout_id, author_id, user_id, via, created_at) VALUES (?, ?, ?, 'discord', ?)").bind(layout, user.user_id, actor.user_id, at).run();
    expect((await listWpmRecords(db, { layoutId: layout }))[0]?.wpm).toBe(120);
    await reopenComment(db, clock, actor, null, comment, { status: "approved", review_version: 0 });
    await reopenWpm(db, clock, actor, null, wpm, { status: "approved", review_version: 0 });
    expect((await listCommentCounts(db)).filter((c) => c.layout_id === layout)).toEqual([]);
    expect((await listWpmRecords(db, { layoutId: layout }))[0]?.wpm).toBe(100);
    expect(await db.prepare("SELECT 1 FROM comment_likes WHERE layout_id = ?").bind(layout).first()).not.toBeNull();
    await approveComment(db, clock, actor, null, comment, 1);
    expect((await listCommentCounts(db)).find((c) => c.layout_id === layout)?.count).toBe(1);
  });

  it("[LDB-MD20] a removal losing to reopening cannot clear the preserved slot likes", async () => {
    for (const reapprove of [false, true]) {
      const { layout, comment } = await seed();
      await approveComment(db, clock, actor, null, comment);
      await db.prepare("INSERT INTO comment_likes (layout_id, author_id, user_id, via, created_at) VALUES (?, ?, ?, 'discord', ?)").bind(layout, user.user_id, actor.user_id, at).run();
      // Pause the remover's batch until reopening has won, after its approved
      // pre-read: the losing SQL claim must not clear a now-pending slot's likes.
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      let entered!: () => void;
      const ready = new Promise<void>((resolve) => { entered = resolve; });
      const delayedDb = new Proxy(db, {
        get(target, property) {
          if (property === "batch") return async (statements: D1PreparedStatement[]) => { entered(); await gate; return target.batch(statements); };
          const value = Reflect.get(target, property);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      const removal = removeComment(delayedDb, clock, actor, null, comment);
      const outcome = expect(removal).rejects.toMatchObject({ status: 404 });
      await ready;
      await reopenComment(db, clock, actor, null, comment, { status: "approved", review_version: 0 });
      if (reapprove) await approveComment(db, clock, actor, null, comment, 1);
      release();
      await outcome;
      expect(await db.prepare("SELECT 1 FROM comment_likes WHERE layout_id = ?").bind(layout).first()).not.toBeNull();
      expect(await db.prepare("SELECT status FROM layout_comments WHERE id = ?").bind(comment).first()).toEqual({ status: reapprove ? "approved" : "pending" });
    }
  });

  it("[LDB-MD20] refuses erased, superseded, replaced, removed, tombstoned and newer-slot work", async () => {
    for (const status of ["superseded", "replaced", "removed", "deleted"]) {
      const { comment } = await seed();
      await db.prepare("UPDATE layout_comments SET status = ? WHERE id = ?").bind(status, comment).run();
      await expect(reopenComment(db, clock, actor, null, comment, { status: "approved", review_version: 0 })).rejects.toMatchObject(conflict);
    }
    const erased = await seed();
    await rejectComment(db, clock, actor, null, erased.comment);
    await deleteOwnComment(db, clock, user, null, erased.layout);
    await expect(reopenComment(db, clock, actor, null, erased.comment, { status: "rejected", review_version: 0 })).rejects.toMatchObject(conflict);
    const deleted = await seed();
    await approveWpm(db, clock, actor, null, deleted.wpm);
    await db.prepare("UPDATE layouts SET deleted = 1 WHERE id = ?").bind(deleted.layout).run();
    await expect(reopenWpm(db, clock, actor, null, deleted.wpm, { status: "approved", review_version: 0 })).rejects.toMatchObject(conflict);
    const newer = await seed();
    await rejectComment(db, clock, actor, null, newer.comment);
    await db.prepare(`INSERT INTO layout_comments (id, layout_id, user_id, body, via, submitted_at, status)
      VALUES (?, ?, ?, 'newer work', 'discord', '2026-10-19T00:00:00.000Z', 'rejected')`).bind(ulid(), newer.layout, user.user_id).run();
    await expect(reopenComment(db, clock, actor, null, newer.comment, { status: "rejected", review_version: 0 })).rejects.toMatchObject(conflict);
    expect(await db.prepare("SELECT status FROM layout_comments WHERE id = ?").bind(newer.comment).first()).toEqual({ status: "rejected" });
  });

  it("[LDB-MD20] allows exactly one competing reopen or decision and rolls all changes back on event failure", async () => {
    const { comment, wpm } = await seed();
    await rejectComment(db, clock, actor, null, comment);
    const reopenRace = await Promise.allSettled([0, 1].map(() => reopenComment(db, clock, actor, null, comment, { status: "rejected", review_version: 0 })));
    expect(reopenRace.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const decisionRace = await Promise.allSettled([
      approveComment(db, clock, actor, null, comment, 1),
      rejectComment(db, clock, actor, null, comment, "race", { reviewVersion: 1 }),
    ]);
    expect(decisionRace.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await readReviewHistory(db, "comment", comment)).toHaveLength(3);
    await rejectWpm(db, clock, actor, null, wpm, "original", { notifySubmitter: true });
    await db.exec("CREATE TRIGGER fail_reopen_event BEFORE INSERT ON events WHEN NEW.kind = 'wpm_reopened' BEGIN SELECT RAISE(ABORT, 'test failure'); END;");
    try {
      await expect(reopenWpm(db, clock, actor, null, wpm, { status: "rejected", review_version: 0 })).rejects.toThrow();
      expect(await db.prepare("SELECT status, review_version, reason FROM wpm_submissions WHERE id = ?").bind(wpm).first()).toEqual({ status: "rejected", review_version: 0, reason: "original" });
      expect(await readReviewHistory(db, "wpm", wpm)).toHaveLength(1);
      expect(await db.prepare("SELECT status FROM discord_rejection_dm_outbox WHERE submission_id = ?").bind(wpm).first()).toEqual({ status: "pending" });
    } finally { await db.exec("DROP TRIGGER fail_reopen_event"); }
  });

  it("[LDB-MD20] keeps preexisting decision reasons and fences an in-flight denial-channel request", async () => {
    const { comment, wpm } = await seed();
    await db.prepare("UPDATE wpm_submissions SET status = 'rejected', decided_by = ?, decided_at = ?, reason = 'legacy reason' WHERE id = ?").bind(actor.user_id, at, wpm).run();
    expect(await readReviewHistory(db, "wpm", wpm)).toMatchObject([{ action: "rejected", reason: "legacy reason" }]);
    await reopenWpm(db, clock, actor, null, wpm, { status: "rejected", review_version: 0 });
    expect(await readReviewHistory(db, "wpm", wpm)).toMatchObject([{ action: "rejected", reason: "legacy reason" }, { action: "reopened" }]);
    await rejectComment(db, clock, actor, null, comment, "first", { notifySubmitter: true });
    let posted = false;
    await dispatchRejectionDms(db, { DB: db, MODQUEUE_DISCORD_DMS: "true", MODQUEUE_DISCORD_BOT_TOKEN: "test-token" }, clock, async (url) => {
      if (String(url).endsWith("/users/@me/channels")) {
        await reopenComment(db, clock, actor, null, comment, { status: "rejected", review_version: 0 });
        await rejectComment(db, clock, actor, null, comment, "second", { reviewVersion: 1 });
        return Response.json({ id: "900000000000000101" });
      }
      posted = true;
      return Response.json({ id: "900000000000000102" });
    });
    expect(posted).toBe(false);
  });

  it("[LDB-MD20] authenticates reopening/history, validates expected cycles, and returns usable current submissions", async () => {
    const { comment, wpm } = await seed();
    const fake = actorFixture();
    const admin = register(fake, `review-admin-${comment}`, actor.user_id);
    const nonadmin = register(fake, `review-user-${comment}`, user.user_id);
    for (const [kind, id] of [["comment", comment], ["wpm", wpm]]) {
      const route = `/v1/admin/${kind}-queue/${id}`;
      expect((await writeFetch(`${route}/history`, "GET")).status).toBe(401);
      expect((await writeFetch(`${route}/history`, "GET", nonadmin)).status).toBe(403);
      expect((await writeFetch(`${route}/reopen`, "POST", nonadmin, { status: "rejected", review_version: 0 })).status).toBe(403);
      expect((await writeFetch(`${route}/reopen`, "POST", admin, { status: "rejected" })).status).toBe(400);
      expect((await writeFetch(`${route}/reopen`, "POST", admin, { status: "pending", review_version: 0 })).status).toBe(400);
      expect((await writeFetch(`${route}/reject`, "POST", admin, { reason: "reason" })).status).toBe(200);
      const reopened = await writeFetch(`${route}/reopen`, "POST", admin, { status: "rejected", review_version: 0 });
      expect(reopened.status).toBe(200);
      expect(await reopened.json()).toMatchObject({ submission: { id, status: "pending", review_version: 1 } });
      expect((await writeFetch(`${route}/approve`, "POST", admin)).status).toBe(409);
      expect((await writeFetch(`${route}/approve`, "POST", admin, { review_version: 1 })).status).toBe(200);
      const history = await writeFetch(`${route}/history`, "GET", admin);
      expect(history.headers.get("Cache-Control")).toBe("private, no-store");
      expect(await history.json()).toMatchObject({ history: [{ action: "rejected", reason: "reason" }, { action: "reopened" }, { action: "approved" }] });
    }
  });
});
