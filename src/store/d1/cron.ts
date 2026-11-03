// D1 implementation of `CronStore` (src/store/port.ts) [LDB-J1]: the
// five-minute tick's work, read in ONE statement so an idle tick (almost
// every tick) costs one D1 round trip instead of sixteen.
//
// Each flag is the EXISTS of a superset of the rows the job behind it would
// touch -- the same tables and the same WHERE as that job's own statements,
// minus the joins and ORDER BY/LIMIT that only narrow or order them -- so a
// false flag proves the job has nothing to do, and a true one just runs the
// job as before. The jobs' own statements are in store/d1/modqueue.ts
// (linkCandidates, wpmCandidates, staleNotifications), store/d1/discord.ts
// (deleteExpiredConfirmations, expireActions, claimAction, pendingCallbacks)
// and store/d1/outbox.ts (due); tests/api/cron-probe.test.ts holds each
// flag to them.
import type { CronStore, CronWork } from "../port";

const ACTION_TABLES = ["discord_pending_actions", "discord_reopen_actions"] as const;

const discordWork = [
  "EXISTS (SELECT 1 FROM discord_reopen_confirmations WHERE expires_at <= ?1)",
  "EXISTS (SELECT 1 FROM discord_deny_modals WHERE expires_at <= ?1)",
  ...ACTION_TABLES.flatMap((t) => [
    // expireActions' UPDATE and DELETE: any row whose time is up
    `EXISTS (SELECT 1 FROM ${t} WHERE expires_at <= ?1)`,
    // claimAction
    `EXISTS (SELECT 1 FROM ${t} WHERE expires_at > ?1 AND (state = 'pending' OR (state = 'working' AND lease_until < ?1)))`,
    // pendingCallbacks
    `EXISTS (SELECT 1 FROM ${t} WHERE state = 'complete' AND token != '' AND expires_at > ?1)`,
  ]),
].join(" OR ");

const SQL = `SELECT
  (EXISTS (SELECT 1 FROM link_submissions WHERE status = 'pending' AND notified_at IS NULL)
    OR EXISTS (SELECT 1 FROM wpm_submissions WHERE status = 'pending' AND notified_at IS NULL)) AS announce,
  (EXISTS (SELECT 1 FROM modqueue_notifications n JOIN link_submissions s ON n.kind = 'link' AND s.id = n.submission_id
      WHERE n.shown_status != s.status OR n.shown_review_version != 0)
    OR EXISTS (SELECT 1 FROM modqueue_notifications n JOIN wpm_submissions s ON n.kind = 'wpm' AND s.id = n.submission_id
      WHERE n.shown_status != s.status OR n.shown_review_version != s.review_version OR n.shown_source_message_url IS NOT s.source_message_url)
    OR EXISTS (SELECT 1 FROM modqueue_notifications n JOIN layout_comments s ON n.kind = 'comment' AND s.id = n.submission_id
      WHERE n.shown_status != s.status OR n.shown_review_version != s.review_version)) AS reconcile,
  (${discordWork}) AS discord,
  EXISTS (SELECT 1 FROM discord_rejection_dm_outbox WHERE (status = 'pending' AND next_attempt_at <= ?1) OR (status = 'leased' AND lease_until <= ?1)) AS dms,
  (SELECT value FROM import_state WHERE key = 'dump.last_at') AS dump_state,
  (SELECT value FROM import_state WHERE key = 'cutover.mode') AS cutover_mode`;

export function d1CronStore(db: D1Database): CronStore {
  return {
    async work(nowIso): Promise<CronWork> {
      const row = await db.prepare(SQL).bind(nowIso).first<{ announce: number; reconcile: number; discord: number; dms: number; dump_state: string | null; cutover_mode: string | null }>();
      return {
        announce: row?.announce === 1,
        reconcile: row?.reconcile === 1,
        discord: row?.discord === 1,
        dms: row?.dms === 1,
        dumpState: row?.dump_state ?? null,
        cutoverMode: row?.cutover_mode === "read_only" ? "read_only" : null,
      };
    },
  };
}
