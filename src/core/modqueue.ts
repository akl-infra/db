// Mod-queue Discord notify (saltorbit 2026-09-28, LDB-MD11/LDB-MD12): a
// pending link or WPM submission (docs/decisions/28-wpm-records.md,
// LDB-WPM8: one sweep per queue table, the same claim pattern each) is announced to a Discord channel via an
// incoming webhook, at most once ever. `MODQUEUE_DISCORD_WEBHOOK` unset or
// empty makes the whole thing a no-op (LDB-MD12) -- no fetch, no D1 write.
// Called from both the submit paths (`src/routes/links.ts` and
// `src/routes/wpm.ts`, right after a fresh `queued` submission) and the cron (`src/index.ts`'s `scheduled()`,
// every 5-minute tick): the CLAIM below (an `UPDATE ... WHERE notified_at
// IS NULL AND status = 'pending'`, `changes === 1` means THIS call won)
// is what keeps the two paths racing each other from ever
// double-announcing the same submission (LDB-MD11). A submission already
// `approved`/`rejected`/`superseded` by claim time never matches that
// WHERE clause, so it is never announced either. Both messages end in a link
// to the admin console's Inbox tab (`/admin?tab=inbox`), where the
// submission is approved or rejected. `notifyPending` never
// throws -- a candidate read failure, a claim failure, or a webhook
// failure is logged and the function returns (or moves to the next
// candidate); the cron's own `core/jobs.ts` `runJob` guard is a second,
// belt-and-suspenders layer, not the only one.
import type { Bindings } from "../env";
import type { Clock } from "./time";

const WEBHOOK_TIMEOUT_MS = 5000;
const USER_AGENT = "akl-db/1.0";
const BATCH_LIMIT = 10; // one sweep never announces more than this many at once

interface LinkCandidate {
  id: string;
  layout_id: string;
  url: string;
  submitted_by: string;
  layout_name: string;
  submitter_name: string | null; // joined from authors; null if no author row
}

interface CommentCandidate {
  id: string;
  layout_id: string;
  user_id: string;
  body: string;
  layout_name: string;
  user_name: string | null; // joined from authors; null if no author row
  has_live: number; // 1 if the user already has an approved comment here (an edit)
}

interface WpmCandidate {
  id: string;
  layout_id: string;
  user_id: string;
  wpm: number;
  proof: string;
  layout_name: string;
  user_name: string | null; // joined from authors; null if no author row
}

// Discord markdown control characters a user-sourced string (a layout
// name, a Discord display name) could carry, `[`/`]` included so a name
// can never form a masked link -- backslash-escaped so it
// renders as literal text instead of breaking out into formatting.
function escapeMarkdown(s: string): string {
  return s.replace(/[\\`*_~|>[\]]/g, (ch) => `\\${ch}`);
}

// A user-supplied URL is wrapped in `<>` (no embed); percent-encode the
// characters that could close that wrapper early or split the link, so a
// proof URL can never break out of it.
function embedSafeUrl(url: string): string {
  return url.replace(/[<>\s]/g, (ch) => encodeURIComponent(ch));
}

// Exported for the pure escaping cases in `tests/auth/modqueue.test.ts` -- no
// DB, no clock, table-tested like `core/links.ts`'s own `validateLinkUrl`.
// The layout name links to its akldb.org page (`/l/<layout_id>`, a ULID --
// what the site's router and `GET /v1/layouts/:ref` both accept) and the
// second line links straight to the admin console's Inbox tab
// (`/admin?tab=inbox`), where the submission is approved or rejected. Every
// URL is wrapped in `<>` so Discord never expands it into an embed; the
// submitter's Discord display name (when known) is escaped, the user id
// (the fallback) never needs it -- it's a numeric snowflake, never free text.
export const SITE_ORIGIN = "https://akldb.org";
const INBOX_URL = `${SITE_ORIGIN}/admin?tab=inbox`;

export function buildMessageContent(c: LinkCandidate): string {
  const who = c.submitter_name !== null ? escapeMarkdown(c.submitter_name) : c.submitted_by;
  const layout = `[${escapeMarkdown(c.layout_name)}](<${SITE_ORIGIN}/l/${c.layout_id}>)`;
  return `New link submission on **${layout}** by ${who}: <${c.url}>\n[Open the mod queue](<${INBOX_URL}>) · submission \`${c.id}\``;
}

// [LDB-WPM8] The WPM sibling: names the layout, the user whose speed it is
// and the speed, with the proof embed-suppressed.
export function buildWpmMessageContent(c: WpmCandidate): string {
  const who = c.user_name !== null ? escapeMarkdown(c.user_name) : c.user_id;
  const layout = `[${escapeMarkdown(c.layout_name)}](<${SITE_ORIGIN}/l/${c.layout_id}>)`;
  return `New WPM submission on **${layout}** by ${who}: **${c.wpm} wpm** <${embedSafeUrl(c.proof)}>\n[Open the inbox](<${INBOX_URL}>) · submission \`${c.id}\``;
}

// [LDB-CMT8] The comment sibling (docs/decisions/29-layout-comments.md):
// names the layout, the author and the length; a user's first comment shows
// the first 120 characters (escaped, `...` when cut), an edit shows only the
// length -- the text itself is in the Inbox, next to a diff against the live
// one. Code points, not UTF-16 units, so a cut never splits an emoji.
const PREVIEW_CHARS = 120;

export function buildCommentMessageContent(c: CommentCandidate): string {
  const who = c.user_name !== null ? escapeMarkdown(c.user_name) : c.user_id;
  const layout = `[${escapeMarkdown(c.layout_name)}](<${SITE_ORIGIN}/l/${c.layout_id}>)`;
  const chars = [...c.body];
  const link = `\n[Open the inbox](<${INBOX_URL}>) · submission \`${c.id}\``;
  if (c.has_live === 1) return `Edited comment on **${layout}** by ${who} (${chars.length} chars)${link}`;
  const flat = chars.slice(0, PREVIEW_CHARS).join("").replace(/\s+/g, " ");
  const preview = escapeMarkdown(flat) + (chars.length > PREVIEW_CHARS ? "…" : "");
  return `New comment on **${layout}** by ${who} (${chars.length} chars): "${preview}"${link}`;
}

// One queue table's notifier: its candidate scan and its message. The table
// name is a constant of this module, never caller input.
interface Queue<C extends { id: string }> {
  table: "link_submissions" | "wpm_submissions";
  candidateSql: string;
  build: (c: C) => string;
}

const LINK_QUEUE: Queue<LinkCandidate> = {
  table: "link_submissions",
  candidateSql: `SELECT s.id AS id, s.layout_id AS layout_id, s.url AS url, s.submitted_by AS submitted_by,
                l.name AS layout_name, a.name AS submitter_name
         FROM link_submissions s
         JOIN layouts l ON l.id = s.layout_id
         LEFT JOIN authors a ON a.user_id = s.submitted_by
         WHERE s.status = 'pending' AND s.notified_at IS NULL
         ORDER BY s.submitted_at ASC
         LIMIT ?`,
  build: buildMessageContent,
};

const WPM_QUEUE: Queue<WpmCandidate> = {
  table: "wpm_submissions",
  candidateSql: `SELECT s.id AS id, s.layout_id AS layout_id, s.user_id AS user_id, s.wpm AS wpm, s.proof AS proof,
                l.name AS layout_name, a.name AS user_name
         FROM wpm_submissions s
         JOIN layouts l ON l.id = s.layout_id
         LEFT JOIN authors a ON a.user_id = s.user_id
         WHERE s.status = 'pending' AND s.notified_at IS NULL
         ORDER BY s.submitted_at ASC
         LIMIT ?`,
  build: buildWpmMessageContent,
};

async function claim(db: Bindings["DB"], table: Queue<never>["table"], at: string, id: string): Promise<boolean> {
  const res = await db
    .prepare(`UPDATE ${table} SET notified_at = ? WHERE id = ? AND notified_at IS NULL AND status = 'pending'`)
    .bind(at, id)
    .run();
  return res.meta.changes === 1;
}

async function release(db: Bindings["DB"], table: Queue<never>["table"], id: string, claimedAt: string): Promise<void> {
  await db.prepare(`UPDATE ${table} SET notified_at = NULL WHERE id = ? AND notified_at = ?`).bind(id, claimedAt).run();
}

async function sweep<C extends { id: string }>(db: Bindings["DB"], webhook: string, now: Clock, fetchImpl: typeof fetch, queue: Queue<C>): Promise<void> {
  let candidates: C[];
  try {
    const { results } = await db.prepare(queue.candidateSql).bind(BATCH_LIMIT).all<C>();
    candidates = results;
  } catch (e) {
    console.error(`notifyPending: candidate read failed (${queue.table})`, e);
    return;
  }

  for (const candidate of candidates) {
    const claimedAt = now();
    let won: boolean;
    try {
      won = await claim(db, queue.table, claimedAt, candidate.id);
    } catch (e) {
      console.error(`notifyPending: claim failed for submission '${candidate.id}'`, e);
      continue;
    }
    if (!won) continue; // lost the race to a concurrent caller, or the submission was decided first

    try {
      const res = await fetchImpl(webhook, {
        method: "POST",
        headers: { "Content-Type": "application/json", "User-Agent": USER_AGENT },
        body: JSON.stringify({ content: queue.build(candidate), allowed_mentions: { parse: [] } }),
        signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
      });
      // A Discord 429 is just another non-2xx here (no `Retry-After`
      // parsing) -- releasing the claim is enough: the cron's next
      // 5-minute tick simply tries again, same as any other failure.
      if (!res.ok) {
        console.error(`notifyPending: webhook post for submission '${candidate.id}' failed with status ${res.status}`);
        await release(db, queue.table, candidate.id, claimedAt);
      }
    } catch (e) {
      console.error(`notifyPending: webhook post for submission '${candidate.id}' threw`, e);
      await release(db, queue.table, candidate.id, claimedAt);
    }
  }
}

export async function notifyPending(db: Bindings["DB"], env: Bindings, now: Clock, fetchImpl: typeof fetch = fetch): Promise<void> {
  const webhook = env.MODQUEUE_DISCORD_WEBHOOK;
  if (webhook === undefined || webhook === "") return; // [LDB-MD12]

  // Links first, then WPM: each table is swept (and claimed) on its own, so
  // a failure in one never starves the other.
  await sweep(db, webhook, now, fetchImpl, LINK_QUEUE);
  await sweep(db, webhook, now, fetchImpl, WPM_QUEUE);
}

// [LDB-CMT8] A pending comment is announced once, best effort, from the submit
// path only (`routes/comments.ts`, via `waitUntil`): `layout_comments` has no
// `notified_at`, so it is NOT part of the cron sweep above and nothing is
// claimed or retried. A failed post (non-2xx, thrown, timed out) is logged
// and dropped, with no D1 write. Unset or empty `MODQUEUE_DISCORD_WEBHOOK`
// is a complete no-op (no fetch, no D1 read), as for the sweeps. Never
// throws. Only a row that is still `pending` is announced.
export async function announceComment(db: Bindings["DB"], env: Bindings, id: string, fetchImpl: typeof fetch = fetch): Promise<void> {
  const webhook = env.MODQUEUE_DISCORD_WEBHOOK;
  if (webhook === undefined || webhook === "") return; // [LDB-MD12]
  try {
    const c = await db
      .prepare(
        `SELECT s.id AS id, s.layout_id AS layout_id, s.user_id AS user_id, s.body AS body,
                l.name AS layout_name, a.name AS user_name,
                EXISTS (SELECT 1 FROM layout_comments b WHERE b.layout_id = s.layout_id AND b.user_id = s.user_id AND b.status = 'approved') AS has_live
         FROM layout_comments s
         JOIN layouts l ON l.id = s.layout_id
         LEFT JOIN authors a ON a.user_id = s.user_id
         WHERE s.id = ? AND s.status = 'pending' AND s.body IS NOT NULL`,
      )
      .bind(id)
      .first<CommentCandidate>();
    if (c === null) return;
    const res = await fetchImpl(webhook, {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": USER_AGENT },
      body: JSON.stringify({ content: buildCommentMessageContent(c), allowed_mentions: { parse: [] } }),
      signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
    });
    if (!res.ok) console.error(`announceComment: webhook post for comment '${id}' failed with status ${res.status}`);
  } catch (e) {
    console.error(`announceComment: announcing comment '${id}' failed`, e);
  }
}
