// [SITE-6] The one place that decides "can this viewer see the admin UI" --
// pulled out of pages/Admin.tsx so it's testable without mounting a
// component. The real enforcement is server-side (every admin route is
// re-checked by the DB itself, `db/docs/adoption.md` §9's `admin` auth
// column) -- this gate only controls whether the PLACEHOLDER panel renders;
// hiding it for a non-admin is a courtesy, not the security boundary.
import type { MeResponse } from "./types.ts";

export function canSeeAdmin(me: MeResponse | undefined): boolean {
  return !!me?.user?.admin;
}
