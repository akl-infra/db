// D1-only (design/p1-briefs.md E).
// [LDB-MD20] The two reopening tests that need D1 itself: one gates the D1
// binding's `batch` to interleave a removal with a reopening, the other
// installs a trigger to fail an event insert. Split out of
// moderation-reopen.test.ts, which runs on every backend.
import { env, store, testStore } from "../harness";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ulid } from "ulidx";
import type { Actor } from "../../src/auth/actor";
import type { Bindings } from "../../src/env";
import { approveComment, rejectComment, reopenComment, removeComment } from "../../src/core/comments";
import { rejectWpm, reopenWpm } from "../../src/core/wpm";
import { readReviewHistory } from "../../src/core/moderation-review";
import { BOOTSTRAP_ADMIN } from "./write-support";

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

describe("[LDB-MD20] moderation reopening", () => {
  it("[LDB-MD20] a removal losing to reopening cannot clear the preserved slot likes", async () => {
    for (const reapprove of [false, true]) {
      const { layout, comment } = await seed();
      await approveComment(store, clock, actor, null, comment);
      await testStore.insert("comment_likes", { layout_id: layout, author_id: user.user_id, user_id: actor.user_id, via: "discord", created_at: at });
      // Pause the remover's batch until reopening has won, after its approved
      // pre-read: the losing SQL claim must not clear a now-pending slot's likes.
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      let entered!: () => void;
      const ready = new Promise<void>((resolve) => { entered = resolve; });
      const delayedDb = new Proxy(bindings.DB, {
        get(target, property) {
          if (property === "batch") return async (statements: D1PreparedStatement[]) => { entered(); await gate; return target.batch(statements); };
          const value = Reflect.get(target, property);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      const removal = removeComment(delayedDb, clock, actor, null, comment);
      const outcome = expect(removal).rejects.toMatchObject({ status: 404 });
      await ready;
      await reopenComment(store, clock, actor, null, comment, { status: "approved", review_version: 0 });
      if (reapprove) await approveComment(store, clock, actor, null, comment, 1);
      release();
      await outcome;
      expect(await testStore.row("comment_likes", { layout_id: layout })).not.toBeNull();
      expect(await testStore.row("layout_comments", { id: comment })).toMatchObject({ status: reapprove ? "approved" : "pending" });
    }
  });

  it("[LDB-MD20] allows exactly one competing reopen or decision and rolls all changes back on event failure", async () => {
    const { comment, wpm } = await seed();
    await rejectComment(store, clock, actor, null, comment);
    const reopenRace = await Promise.allSettled([0, 1].map(() => reopenComment(store, clock, actor, null, comment, { status: "rejected", review_version: 0 })));
    expect(reopenRace.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const decisionRace = await Promise.allSettled([
      approveComment(store, clock, actor, null, comment, 1),
      rejectComment(store, clock, actor, null, comment, "race", { reviewVersion: 1 }),
    ]);
    expect(decisionRace.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await readReviewHistory(store, "comment", comment)).toHaveLength(3);
    await rejectWpm(store, clock, actor, null, wpm, "original", { notifySubmitter: true });
    await bindings.DB.exec("CREATE TRIGGER fail_reopen_event BEFORE INSERT ON events WHEN NEW.kind = 'wpm_reopened' BEGIN SELECT RAISE(ABORT, 'test failure'); END;");
    try {
      await expect(reopenWpm(store, clock, actor, null, wpm, { status: "rejected", review_version: 0 })).rejects.toThrow();
      expect(await testStore.row("wpm_submissions", { id: wpm })).toMatchObject({ status: "rejected", review_version: 0, reason: "original" });
      expect(await readReviewHistory(store, "wpm", wpm)).toHaveLength(1);
      expect(await testStore.row("discord_rejection_dm_outbox", { submission_id: wpm })).toMatchObject({ status: "pending" });
    } finally { await bindings.DB.exec("DROP TRIGGER fail_reopen_event"); }
  });
});
