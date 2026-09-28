// [SITE-39] `/admin?tab=<slug>` opens that tab of the admin console
// directly -- the mod-queue Discord notice (db/src/core/modqueue.ts, LDB-MD11)
// links to `/admin?tab=links`. Pure (no DOM) so it's testable without
// mounting pages/Admin.tsx. An absent or unknown slug is the default tab,
// never an error: the link is a convenience, not a route of its own.
export type AdminTab = "layouts" | "authors" | "bans" | "linkQueue" | "admins" | "clients";

export const DEFAULT_ADMIN_TAB: AdminTab = "layouts";

const SLUGS: Record<AdminTab, string> = {
  layouts: "layouts",
  authors: "authors",
  bans: "bans",
  linkQueue: "links",
  admins: "admins",
  clients: "clients",
};

export function adminTabFromSearch(search: string): AdminTab {
  const slug = new URLSearchParams(search).get("tab");
  const hit = (Object.keys(SLUGS) as AdminTab[]).find((tab) => SLUGS[tab] === slug);
  return hit ?? DEFAULT_ADMIN_TAB;
}

/** The `location.search` for `tab` -- empty for the default tab, so a plain
 * `/admin` stays plain. */
export function searchForAdminTab(tab: AdminTab): string {
  return tab === DEFAULT_ADMIN_TAB ? "" : `?tab=${SLUGS[tab]}`;
}
