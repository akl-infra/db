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
import { toStore, type StoreArg } from "../store/arg";

// --- §4.1 bans --------------------------------------------------------

export interface BanRow {
  user_id: string;
  name: string | null; // joined from `authors`, not stored
  by: string;
  at: string;
  reason: string | null;
}

export async function listBans(dbArg: StoreArg): Promise<BanRow[]> {
  const store = toStore(dbArg);
  return await store.admin.listBans();
}

function sourceOf(actor: Actor, version: string | null): Source {
  return { client: actor.source_client, version };
}

// PUT /v1/admin/bans/:user_id: 201 (new) | 200 (already banned; reason
// updated) -- `created` is what the route reads to pick the status.
// `409 cannot_ban_admin` before any write: an admin is never `banned` (a
// ROLE RULE, `auth/roles.ts`), so recording a ban that rule would
// immediately un-apply is refused loudly instead of silently no-op'd.
export async function ban(dbArg: StoreArg, now: Clock, actor: Actor, version: string | null, userId: string, reason?: string): Promise<{ row: BanRow; created: boolean }> {
  const store = toStore(dbArg);
  if (await isAdmin(store, userId)) throw cannotBanAdmin();

  const at = now();
  const created = !(await store.admin.banExists(userId));

  await store.admin.upsertBan({ user_id: userId, by: actor.user_id, at, reason: reason ?? null });

  await appendAdmin(store, now, {
    kind: "admin.user_banned",
    actor: actor.user_id,
    via: actor.via,
    source: sourceOf(actor, version),
    detail: { user_id: userId, reason: reason ?? null },
  });

  const authorName = await store.auth.authorName(userId);
  return { row: { user_id: userId, name: authorName, by: actor.user_id, at, reason: reason ?? null }, created };
}

// DELETE /v1/admin/bans/:user_id: `404 not_found` if the user isn't
// currently banned -- the DELETE's own `changes` count tells the two
// cases apart (mirrors `core/admins.ts`'s `remove()` A6 pattern).
export async function unban(dbArg: StoreArg, now: Clock, actor: Actor, version: string | null, userId: string): Promise<{ seq: number }> {
  const store = toStore(dbArg);
  if (!(await store.admin.deleteBan(userId))) throw notFound(`'${userId}' is not banned`, userId);

  const { seq } = await appendAdmin(store, now, {
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
export async function renameAuthor(dbArg: StoreArg, now: Clock, actor: Actor, version: string | null, userId: string, name: string): Promise<AuthorRow> {
  const store = toStore(dbArg);
  const beforeName = await store.auth.authorName(userId);
  if (beforeName === null) throw notFound(`no author '${userId}'`, userId);

  await store.admin.setAuthorNameByAdmin(userId, name, now());

  await appendAdmin(store, now, {
    kind: "admin.author_renamed",
    actor: actor.user_id,
    via: actor.via,
    source: sourceOf(actor, version),
    detail: { user_id: userId, from: beforeName, to: name },
  });

  return { user_id: userId, name, name_source: "admin" };
}
