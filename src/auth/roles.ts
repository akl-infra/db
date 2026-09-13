// [LDB-MD1] [LDB-MD10] The one role read every auth lane makes (§4.1): a
// single statement answering both `admin` and `banned` for a user id, so
// there is exactly one place either lane can drift from the other.
// Deliberately never cached (mirrors `auth/discord.ts`'s own admin read,
// never stored in `auth_cache` -- `Actor.admin`/`Actor.banned` are proven
// fresh on every request, LDB-MD10): a promotion, demotion, ban or unban
// takes effect on the very next request, no cache window.
//
// An admin is never `banned`, whatever the `bans` table holds -- so
// promoting a banned user un-bans them by rule, and `PUT /v1/admin/admins`
// needs no second error kind for "this user is banned".
import type { Bindings } from "../env";

export interface Roles {
  admin: boolean;
  banned: boolean;
}

interface RoleRow {
  admin: number;
  banned: number;
}

export async function roleOf(db: Bindings["DB"], userId: string): Promise<Roles> {
  const row = await db
    .prepare(
      `SELECT EXISTS(SELECT 1 FROM admins WHERE user_id = ?1) AS admin,
              EXISTS(SELECT 1 FROM bans WHERE user_id = ?1) AS banned`,
    )
    .bind(userId)
    .first<RoleRow>();
  const admin = row?.admin === 1;
  const banned = row?.banned === 1 && !admin;
  return { admin, banned };
}
