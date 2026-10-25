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
import { toStore, type StoreArg } from "../store/arg";

export interface Roles {
  admin: boolean;
  banned: boolean;
}

export async function roleOf(dbArg: StoreArg, userId: string): Promise<Roles> {
  const store = toStore(dbArg);
  const raw = await store.auth.rolesOf(userId);
  const admin = raw.admin;
  const banned = raw.banned && !admin;
  return { admin, banned };
}
