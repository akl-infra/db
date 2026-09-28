// Mod-queue Discord notify (saltorbit 2026-09-28, LDB-MD11/LDB-MD12): a
// pending link submission is announced to a Discord channel via an
// incoming webhook, at most once ever. `MODQUEUE_DISCORD_WEBHOOK` unset or
// empty makes the whole thing a no-op (LDB-MD12) -- no fetch, no D1 write.
// Called from both the submit path (`src/routes/links.ts`, right after a
// fresh `queued` submission) and the cron (`src/index.ts`'s `scheduled()`,
// every 5-minute tick): the CLAIM below (an `UPDATE ... WHERE notified_at
// IS NULL AND status = 'pending'`, `changes === 1` means THIS call won)
// is what keeps the two paths racing each other from ever
// double-announcing the same submission (LDB-MD11). A submission already
// `approved`/`rejected`/`superseded` by claim time never matches that
// WHERE clause, so it is never announced either. `notifyPending` never
// throws -- a candidate read failure, a claim failure, or a webhook
// failure is logged and the function returns (or moves to the next
// candidate); the cron's own `core/jobs.ts` `runJob` guard is a second,
// belt-and-suspenders layer, not the only one.
import type { Bindings } from "../env";
import type { Clock } from "./time";

const WEBHOOK_TIMEOUT_MS = 5000;
const USER_AGENT = "akl-db/1.0";
const BATCH_LIMIT = 10; // one sweep never announces more than this many at once

interface Candidate {
  id: string;
  layout_id: string;
  url: string;
  submitted_by: string;
  layout_name: string;
  submitter_name: string | null; // joined from authors; null if no author row
}

// Discord markdown control characters a user-sourced string (a layout
// name, a Discord display name) could carry, `[`/`]` included so a name
// can never form a masked link -- backslash-escaped so it
// renders as literal text instead of breaking out into formatting.
function escapeMarkdown(s: string): string {
  return s.replace(/[\\`*_~|>[\]]/g, (ch) => `\\${ch}`);
}

// Exported for the pure escaping cases in `tests/auth/modqueue.test.ts` -- no
// DB, no clock, table-tested like `core/links.ts`'s own `validateLinkUrl`.
// `layout_id` is the message's "ref" -- a ULID, exactly what `GET /v1/
// layouts/:ref` accepts (`core/records.ts`'s `isUlidShaped`), so a
// moderator can look the layout up directly. The url is wrapped in `<>`
// so Discord never expands it into an embed; the submitter's Discord
// display name (when known) is escaped, the submitted-by user id (the
// fallback) never needs it -- it's a numeric snowflake, never free text.
export function buildMessageContent(c: Candidate): string {
  const who = c.submitter_name !== null ? escapeMarkdown(c.submitter_name) : c.submitted_by;
  return `Pending link submission on **${escapeMarkdown(c.layout_name)}** (\`${c.layout_id}\`) by ${who}: <${c.url}> -- submission \`${c.id}\``;
}

async function claim(db: Bindings["DB"], at: string, id: string): Promise<boolean> {
  const res = await db
    .prepare("UPDATE link_submissions SET notified_at = ? WHERE id = ? AND notified_at IS NULL AND status = 'pending'")
    .bind(at, id)
    .run();
  return res.meta.changes === 1;
}

async function release(db: Bindings["DB"], id: string, claimedAt: string): Promise<void> {
  await db.prepare("UPDATE link_submissions SET notified_at = NULL WHERE id = ? AND notified_at = ?").bind(id, claimedAt).run();
}

export async function notifyPending(db: Bindings["DB"], env: Bindings, now: Clock, fetchImpl: typeof fetch = fetch): Promise<void> {
  const webhook = env.MODQUEUE_DISCORD_WEBHOOK;
  if (webhook === undefined || webhook === "") return; // [LDB-MD12]

  let candidates: Candidate[];
  try {
    const { results } = await db
      .prepare(
        `SELECT s.id AS id, s.layout_id AS layout_id, s.url AS url, s.submitted_by AS submitted_by,
                l.name AS layout_name, a.name AS submitter_name
         FROM link_submissions s
         JOIN layouts l ON l.id = s.layout_id
         LEFT JOIN authors a ON a.user_id = s.submitted_by
         WHERE s.status = 'pending' AND s.notified_at IS NULL
         ORDER BY s.submitted_at ASC
         LIMIT ?`,
      )
      .bind(BATCH_LIMIT)
      .all<Candidate>();
    candidates = results;
  } catch (e) {
    console.error("notifyPending: candidate read failed", e);
    return;
  }

  for (const candidate of candidates) {
    const claimedAt = now();
    let won: boolean;
    try {
      won = await claim(db, claimedAt, candidate.id);
    } catch (e) {
      console.error(`notifyPending: claim failed for submission '${candidate.id}'`, e);
      continue;
    }
    if (!won) continue; // lost the race to a concurrent caller, or the submission was decided first

    try {
      const res = await fetchImpl(webhook, {
        method: "POST",
        headers: { "Content-Type": "application/json", "User-Agent": USER_AGENT },
        body: JSON.stringify({ content: buildMessageContent(candidate), allowed_mentions: { parse: [] } }),
        signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
      });
      // A Discord 429 is just another non-2xx here (no `Retry-After`
      // parsing) -- releasing the claim is enough: the cron's next
      // 5-minute tick simply tries again, same as any other failure.
      if (!res.ok) {
        console.error(`notifyPending: webhook post for submission '${candidate.id}' failed with status ${res.status}`);
        await release(db, candidate.id, claimedAt);
      }
    } catch (e) {
      console.error(`notifyPending: webhook post for submission '${candidate.id}' threw`, e);
      await release(db, candidate.id, claimedAt);
    }
  }
}
