// [LDB-MD20] Reopening is a new review cycle, never an event-log rewind.
import { env, store, testStore } from "../harness";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ulid } from "ulidx";
import type { Actor } from "../../src/auth/actor";
import type { Bindings } from "../../src/env";
import { approveComment, rejectComment, reopenComment, deleteOwnComment, listCommentCounts } from "../../src/core/comments";
import { approveWpm, reopenWpm, listWpmRecords } from "../../src/core/wpm";
import { readReviewHistory } from "../../src/core/moderation-review";
import { dispatchRejectionDms } from "../../src/core/rejection-dm";
import { buildDump } from "../../src/dump/write";
import { restoreSql } from "../../src/dump/restore";
import { BOOTSTRAP_ADMIN, actorFixture, register, writeFetch } from "./write-support";

const bindings = env as unknown as Bindings;
const actor: Actor = { user_id: BOOTSTRAP_ADMIN, name: "mod", via: "discord", admin: true, banned: false, source_client: "discord-app:test" };
const user = { ...actor, user_id: "900000000000000002", admin: false };
const at = "2026-10-18T01:00:00.000Z";
const clock = () => at;
afterEach(() => vi.unstubAllGlobals());

async function seed() {
  await testStore.remove("discord_rejection_dm_outbox", {});
  const layout = ulid(), comment = ulid(), wpm = ulid();
  await testStore.insert("layouts", { id: layout, name: `reopen-${layout.toLowerCase()}`, owner: user.user_id, n: 1, layout_rev: 1, created_at: at, modified_at: at });
  await testStore.insert(
    "layout_comments",
    { id: comment, layout_id: layout, user_id: user.user_id, body: "private comment", via: "discord", submitted_at: at, status: "pending" },
  );
  await testStore.insert(
    "wpm_submissions",
    { id: wpm, layout_id: layout, user_id: user.user_id, wpm: 120, proof: "https://example.org/proof", submitted_by: user.user_id, via: "discord", submitted_at: at, status: "pending" },
  );
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
        expect(await testStore.row("discord_rejection_dm_outbox", { submission_id: id }))
          .toMatchObject({ decision: "approval", status: "pending" });
      }
    } finally {
      bindings.MODQUEUE_DISCORD_DMS = oldGate;
      bindings.MODQUEUE_DISCORD_BOT_TOKEN = oldToken;
    }
  });
  it("[LDB-MD20] repeats rejection cycles, cancels delivery and preserves private decisions without rewinding events", async () => {
    const { comment } = await seed();
    await rejectComment(store, clock, actor, null, comment, "private reason one", { notifySubmitter: true });
    const first = await reopenComment(store, clock, actor, null, comment, { status: "rejected", review_version: 0 });
    expect(first).toMatchObject({ status: "pending", review_version: 1, decided_at: null, decided_by: null, reason: null, body: "private comment" });
    await expect(approveComment(store, clock, actor, null, comment)).rejects.toMatchObject(conflict);
    await expect(rejectComment(store, clock, actor, null, comment, "stale")).rejects.toMatchObject(conflict);
    await rejectComment(store, clock, actor, null, comment, "private reason two", { reviewVersion: 1, notifySubmitter: true });
    const deliveries = await testStore.rows("discord_rejection_dm_outbox", { submission_id: comment }, ["review_version"]);
    expect(deliveries).toMatchObject([
      { delivery_key: `rejection:comment:${comment}`, status: "expired", review_version: 0 },
      { delivery_key: `rejection:comment:${comment}:1`, status: "pending", review_version: 1 },
    ]);
    expect(deliveries[0]!.nonce).not.toBe(deliveries[1]!.nonce);
    await expect(reopenComment(store, clock, actor, null, comment, { status: "rejected", review_version: 0 })).rejects.toMatchObject(conflict);
    await reopenComment(store, clock, actor, null, comment, { status: "rejected", review_version: 1 });
    await approveComment(store, clock, actor, null, comment, 2);
    const history = await readReviewHistory(store, "comment", comment);
    expect(history.map(({ action, review_version, reason }) => ({ action, review_version, reason }))).toEqual([
      { action: "rejected", review_version: 0, reason: "private reason one" },
      { action: "reopened", review_version: 1, reason: null },
      { action: "rejected", review_version: 1, reason: "private reason two" },
      { action: "reopened", review_version: 2, reason: null },
      { action: "approved", review_version: 2, reason: null },
    ]);
    const events = (await testStore.rows<{ kind: string; detail_json: string | null }>("events", {}, ["seq"]))
      .filter((e) => e.detail_json?.includes(comment))
      .map((e) => ({ kind: e.kind, detail_json: e.detail_json }));
    expect(events.map((e) => e.kind)).toEqual(["comment_rejected", "comment_reopened", "comment_rejected", "comment_reopened", "comment_approved"]);
    expect(JSON.stringify(events)).not.toContain("private reason");
    expect(JSON.stringify(events)).not.toContain("private comment");
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
    await testStore.insert("wpm_submissions", {
      id: olderWpm,
      layout_id: layout,
      user_id: user.user_id,
      wpm: 100,
      proof: "https://example.org/older",
      submitted_by: user.user_id,
      via: "discord",
      submitted_at: "2026-10-17T00:00:00.000Z",
      status: "approved",
      decided_by: actor.user_id,
      decided_at: at,
    });
    await approveComment(store, clock, actor, null, comment);
    await approveWpm(store, clock, actor, null, wpm);
    await testStore.insert("comment_likes", { layout_id: layout, author_id: user.user_id, user_id: actor.user_id, via: "discord", created_at: at });
    expect((await listWpmRecords(store, { layoutId: layout }))[0]?.wpm).toBe(120);
    await reopenComment(store, clock, actor, null, comment, { status: "approved", review_version: 0 });
    await reopenWpm(store, clock, actor, null, wpm, { status: "approved", review_version: 0 });
    expect((await listCommentCounts(store)).filter((c) => c.layout_id === layout)).toEqual([]);
    expect((await listWpmRecords(store, { layoutId: layout }))[0]?.wpm).toBe(100);
    expect(await testStore.row("comment_likes", { layout_id: layout })).not.toBeNull();
    await approveComment(store, clock, actor, null, comment, 1);
    expect((await listCommentCounts(store)).find((c) => c.layout_id === layout)?.count).toBe(1);
  });

  it("[LDB-MD20] refuses erased, superseded, replaced, removed, tombstoned and newer-slot work", async () => {
    for (const status of ["superseded", "replaced", "removed", "deleted"]) {
      const { comment } = await seed();
      await testStore.patch("layout_comments", { id: comment }, { status });
      await expect(reopenComment(store, clock, actor, null, comment, { status: "approved", review_version: 0 })).rejects.toMatchObject(conflict);
    }
    const erased = await seed();
    await rejectComment(store, clock, actor, null, erased.comment);
    await deleteOwnComment(store, clock, user, null, erased.layout);
    await expect(reopenComment(store, clock, actor, null, erased.comment, { status: "rejected", review_version: 0 })).rejects.toMatchObject(conflict);
    const deleted = await seed();
    await approveWpm(store, clock, actor, null, deleted.wpm);
    await testStore.patch("layouts", { id: deleted.layout }, { deleted: 1 });
    await expect(reopenWpm(store, clock, actor, null, deleted.wpm, { status: "approved", review_version: 0 })).rejects.toMatchObject(conflict);
    const newer = await seed();
    await rejectComment(store, clock, actor, null, newer.comment);
    await testStore.insert("layout_comments", { id: ulid(), layout_id: newer.layout, user_id: user.user_id, body: "newer work", via: "discord", submitted_at: "2026-10-19T00:00:00.000Z", status: "rejected" });
    await expect(reopenComment(store, clock, actor, null, newer.comment, { status: "rejected", review_version: 0 })).rejects.toMatchObject(conflict);
    expect(await testStore.row("layout_comments", { id: newer.comment })).toMatchObject({ status: "rejected" });
  });

  it("[LDB-MD20] keeps preexisting decision reasons and fences an in-flight denial-channel request", async () => {
    const { comment, wpm } = await seed();
    await testStore.patch("wpm_submissions", { id: wpm }, { status: "rejected", decided_by: actor.user_id, decided_at: at, reason: "legacy reason" });
    expect(await readReviewHistory(store, "wpm", wpm)).toMatchObject([{ action: "rejected", reason: "legacy reason" }]);
    await reopenWpm(store, clock, actor, null, wpm, { status: "rejected", review_version: 0 });
    expect(await readReviewHistory(store, "wpm", wpm)).toMatchObject([{ action: "rejected", reason: "legacy reason" }, { action: "reopened" }]);
    await rejectComment(store, clock, actor, null, comment, "first", { notifySubmitter: true });
    let posted = false;
    await dispatchRejectionDms(store, { ...bindings, MODQUEUE_DISCORD_DMS: "true", MODQUEUE_DISCORD_BOT_TOKEN: "test-token" }, clock, async (url) => {
      if (String(url).endsWith("/users/@me/channels")) {
        await reopenComment(store, clock, actor, null, comment, { status: "rejected", review_version: 0 });
        await rejectComment(store, clock, actor, null, comment, "second", { reviewVersion: 1 });
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
