// L5 moderation (design/akldb-site/01-plan.md §4.1, §4.3): bans and the
// author display-name override. `src/routes/moderation.ts` is glue only
// (LDB-W1) -- every D1 statement for these verbs lives here, same
// discipline `core/admins.ts` follows for admins-as-data. `LDB-P1`'s
// onlywriter test allows this file to write `bans`/`authors` but never
// `layouts`. (H24, 2026-09-13: the admin like-count override, §4.2, was
// removed -- mods cannot move `like_count`; see `core/events.ts`.)
import type { Actor } from "../auth/actor";
import type { Bindings } from "../env";
import { isAdmin } from "./admins";
import { cannotBanAdmin, notFound } from "./errors";
import { appendAdmin } from "./events";
import type { Source } from "./records";
import type { Clock } from "./time";

// --- §4.1 bans --------------------------------------------------------

export interface BanRow {
  user_id: string;
  name: string | null; // joined from `authors`, not stored
  by: string;
  at: string;
  reason: string | null;
}

interface BanDbRow {
  user_id: string;
  by: string;
  at: string;
  reason: string | null;
  name: string | null;
}

export async function listBans(db: Bindings["DB"]): Promise<BanRow[]> {
  const { results } = await db
    .prepare(
      `SELECT b.user_id AS user_id, b.by AS by, b.at AS at, b.reason AS reason, a.name AS name
       FROM bans b LEFT JOIN authors a ON a.user_id = b.user_id
       ORDER BY b.at ASC, b.user_id ASC`,
    )
    .all<BanDbRow>();
  return results;
}

function sourceOf(actor: Actor, version: string | null): Source {
  return { client: actor.source_client, version };
}

// PUT /v1/admin/bans/:user_id: 201 (new) | 200 (already banned; reason
// updated) -- `created` is what the route reads to pick the status.
// `409 cannot_ban_admin` before any write: an admin is never `banned` (a
// ROLE RULE, `auth/roles.ts`), so recording a ban that rule would
// immediately un-apply is refused loudly instead of silently no-op'd.
export async function ban(db: Bindings["DB"], now: Clock, actor: Actor, version: string | null, userId: string, reason?: string): Promise<{ row: BanRow; created: boolean }> {
  if (await isAdmin(db, userId)) throw cannotBanAdmin();

  const at = now();
  const existing = await db.prepare("SELECT 1 FROM bans WHERE user_id = ?").bind(userId).first();
  const created = existing === null;

  await db
    .prepare(
      `INSERT INTO bans (user_id, by, at, reason) VALUES (?, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET by = excluded.by, at = excluded.at, reason = excluded.reason`,
    )
    .bind(userId, actor.user_id, at, reason ?? null)
    .run();

  await appendAdmin(db, now, {
    kind: "admin.user_banned",
    actor: actor.user_id,
    via: actor.via,
    source: sourceOf(actor, version),
    detail: { user_id: userId, reason: reason ?? null },
  });

  const nameRow = await db.prepare("SELECT name FROM authors WHERE user_id = ?").bind(userId).first<{ name: string }>();
  return { row: { user_id: userId, name: nameRow?.name ?? null, by: actor.user_id, at, reason: reason ?? null }, created };
}

// DELETE /v1/admin/bans/:user_id: `404 not_found` if the user isn't
// currently banned -- the DELETE's own `changes` count tells the two
// cases apart (mirrors `core/admins.ts`'s `remove()` A6 pattern).
export async function unban(db: Bindings["DB"], now: Clock, actor: Actor, version: string | null, userId: string): Promise<{ seq: number }> {
  const result = await db.prepare("DELETE FROM bans WHERE user_id = ?").bind(userId).run();
  if (result.meta.changes === 0) throw notFound(`'${userId}' is not banned`, userId);

  const { seq } = await appendAdmin(db, now, {
    kind: "admin.user_unbanned",
    actor: actor.user_id,
    via: actor.via,
    source: sourceOf(actor, version),
    detail: { user_id: userId },
  });
  return { seq };
}

// --- §4.3 author display-name override ----------------------------------

export interface AuthorRow {
  user_id: string;
  name: string;
  name_source: "admin";
}

// PUT /v1/admin/authors/:user_id: `404 not_found` if there is no `authors`
// row for this id yet (an admin overrides an EXISTING identity, never
// mints a fresh one out of nothing). Sticky against sign-in
// (`auth/discord.ts`) and the cmini import (`import/authors.ts`) -- see
// each file's own §4.3 comment.
export async function renameAuthor(db: Bindings["DB"], now: Clock, actor: Actor, version: string | null, userId: string, name: string): Promise<AuthorRow> {
  const before = await db.prepare("SELECT name FROM authors WHERE user_id = ?").bind(userId).first<{ name: string }>();
  if (before === null) throw notFound(`no author '${userId}'`, userId);

  await db
    .prepare("UPDATE authors SET name = ?, name_source = 'admin', last_seen_at = ? WHERE user_id = ?")
    .bind(name, now(), userId)
    .run();

  await appendAdmin(db, now, {
    kind: "admin.author_renamed",
    actor: actor.user_id,
    via: actor.via,
    source: sourceOf(actor, version),
    detail: { user_id: userId, from: before.name, to: name },
  });

  return { user_id: userId, name, name_source: "admin" };
}
