// D1-only (design/p1-briefs.md F): the fault injection is a D1 trigger.
// [LDB-MD18] Private rejection Discord DMs: atomic winner/enqueue,
// durable lease fencing, nonce retry suppression, and public dump exclusion.
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { ulid } from "ulidx";
import type { Actor } from "../../src/auth/actor";
import { rejectComment } from "../../src/core/comments";
import { rejectSubmission } from "../../src/core/links";
import { buildApprovalDmMessage, buildRejectionDmMessage, dispatchRejectionDms } from "../../src/core/rejection-dm";
import { approveWpm, rejectWpm } from "../../src/core/wpm";
import type { Bindings } from "../../src/env";
import { buildDump } from "../../src/dump/write";
import { restoreSql } from "../../src/dump/restore";

const db = (env as unknown as Bindings).DB;
const actor: Actor = {
  user_id: "900000000000000001", name: "moderator", via: "discord", admin: true, banned: false,
  source_client: "discord-app:test",
};
const t0 = "2026-10-18T00:00:00.000Z";
const clock = () => t0;
const recipient = "900000000000000002";
const ids = { layout: "", comment: "", link: "", wpm: "" };

async function setup(): Promise<string> {
  // This file intentionally tests queued rows across several dispatches;
  // start each case with no delivery work left by the previous case.
  await db.prepare("DELETE FROM discord_rejection_dm_outbox").run();
  const layoutId = ulid();
  const name = `dm-test-${layoutId.toLowerCase()}`;
  await db.prepare(
    `INSERT INTO layouts (id, name, owner, n, layout_rev, created_at, modified_at)
     VALUES (?, ?, ?, 1, 1, ?, ?)`,
  ).bind(layoutId, name, actor.user_id, t0, t0).run();
  const commentId = ulid();
  const linkId = ulid();
  const wpmId = ulid();
  await db.batch([
    db.prepare(`INSERT INTO layout_comments (id, layout_id, user_id, body, via, submitted_at, status)
      VALUES (?, ?, ?, 'private text', 'discord', ?, 'pending')`).bind(commentId, layoutId, recipient, t0),
    db.prepare(`INSERT INTO link_submissions (id, layout_id, url, submitted_by, submitted_at, status)
      VALUES (?, ?, 'https://example.org/submitted-link', ?, ?, 'pending')`).bind(linkId, layoutId, recipient, t0),
    db.prepare(`INSERT INTO wpm_submissions (id, layout_id, user_id, wpm, proof, submitted_by, via, submitted_at, status)
      VALUES (?, ?, ?, 84, 'https://example.org/proof', ?, 'discord', ?, 'pending')`).bind(wpmId, layoutId, recipient, recipient, t0),
  ]);
  ids.layout = layoutId;
  ids.comment = commentId;
  ids.link = linkId;
  ids.wpm = wpmId;
  return layoutId;
}

async function outbox(id: string) {
  return db.prepare("SELECT * FROM discord_rejection_dm_outbox WHERE submission_id = ?").bind(id).first<Record<string, unknown>>();
}

describe("[LDB-MD18] rejection DM outbox (D1 trigger fault injection)", () => {
  it("rolls back rejection state, event, and enqueue together if event insertion fails", async () => {
    await setup();
    await db.prepare(`CREATE TRIGGER rejection_event_abort BEFORE INSERT ON events
      WHEN NEW.kind = 'comment_rejected' BEGIN SELECT RAISE(ABORT, 'test event failure'); END`).run();
    try {
      await expect(rejectComment(db, clock, actor, null, ids.comment, "reason", { notifySubmitter: true })).rejects.toThrow();
      const row = await db.prepare("SELECT status FROM layout_comments WHERE id = ?").bind(ids.comment).first<{ status: string }>();
      expect(row?.status).toBe("pending");
      expect(await outbox(ids.comment)).toBeNull();
      const event = await db.prepare("SELECT COUNT(*) AS n FROM events WHERE kind = 'comment_rejected' AND layout_id = ?").bind(ids.layout).first<{ n: number }>();
      expect(event?.n).toBe(0);
    } finally {
      await db.prepare("DROP TRIGGER IF EXISTS rejection_event_abort").run();
    }
  });

  it("rolls back claim and public event when the final outbox statement fails", async () => {
    await setup();
    await db.prepare(`CREATE TRIGGER rejection_outbox_abort BEFORE INSERT ON discord_rejection_dm_outbox
      BEGIN SELECT RAISE(ABORT, 'test outbox failure'); END`).run();
    try {
      await expect(rejectWpm(db, clock, actor, null, ids.wpm, "reason", { notifySubmitter: true })).rejects.toThrow();
      const row = await db.prepare("SELECT status FROM wpm_submissions WHERE id = ?").bind(ids.wpm).first<{ status: string }>();
      expect(row?.status).toBe("pending");
      expect(await outbox(ids.wpm)).toBeNull();
      const event = await db.prepare("SELECT COUNT(*) AS n FROM events WHERE kind = 'wpm_rejected' AND layout_id = ?").bind(ids.layout).first<{ n: number }>();
      expect(event?.n).toBe(0);
    } finally {
      await db.prepare("DROP TRIGGER IF EXISTS rejection_outbox_abort").run();
    }
  });
});

describe("[LDB-MD23] approval DMs (D1 trigger fault injection)", () => {
  it("[LDB-MD23] rolls back an approval and its event when private enqueue fails", async () => {
    await setup();
    await db.prepare(`CREATE TRIGGER approval_outbox_abort BEFORE INSERT ON discord_rejection_dm_outbox
      WHEN NEW.decision = 'approval' BEGIN SELECT RAISE(ABORT, 'approval enqueue failed'); END`).run();
    try {
      await expect(approveWpm(db, clock, actor, null, ids.wpm, 0, true)).rejects.toBeTruthy();
      expect(await db.prepare("SELECT status FROM wpm_submissions WHERE id = ?").bind(ids.wpm).first()).toEqual({ status: "pending" });
      expect(await outbox(ids.wpm)).toBeNull();
      expect((await db.prepare("SELECT COUNT(*) AS n FROM events WHERE kind = 'wpm_approved' AND detail_json LIKE ?")
        .bind(`%${ids.wpm}%`).first<{ n: number }>())?.n).toBe(0);
    } finally {
      await db.prepare("DROP TRIGGER approval_outbox_abort").run();
    }
  });
});
