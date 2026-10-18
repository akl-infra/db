// [SITE-39] `/admin?tab=<slug>` opens that tab of the admin console
// directly -- the mod-queue Discord notice (db/src/core/modqueue.ts, LDB-MD11,
// LDB-WPM8) links to `/admin?tab=inbox`. Pure (no DOM) so it's testable
// without mounting pages/Admin.tsx. An absent or unknown slug is the default
// tab, never an error: the link is a convenience, not a route of its own.
export type AdminTab = "inbox" | "layouts" | "users" | "clients";

export const DEFAULT_ADMIN_TAB: AdminTab = "inbox";

const SLUGS: Record<AdminTab, string> = {
  inbox: "inbox",
  layouts: "layouts",
  users: "users",
  clients: "clients",
};

// Slugs of tabs that were merged away (the Links tab became the Inbox;
// Authors, Bans and Admins became sections of Users). Old Discord notices
// and bookmarks still carry them, so they keep landing somewhere sensible.
const LEGACY_SLUGS = new Map<string, AdminTab>([
  ["links", "inbox"],
  ["authors", "users"],
  ["bans", "users"],
  ["admins", "users"],
]);

export function adminTabFromSearch(search: string): AdminTab {
  const slug = new URLSearchParams(search).get("tab");
  const hit = (Object.keys(SLUGS) as AdminTab[]).find((tab) => SLUGS[tab] === slug);
  if (hit !== undefined) return hit;
  return (slug !== null ? LEGACY_SLUGS.get(slug) : undefined) ?? DEFAULT_ADMIN_TAB;
}

/** The `location.search` for `tab` -- empty for the default tab, so a plain
 * `/admin` stays plain. */
export function searchForAdminTab(tab: AdminTab): string {
  return tab === DEFAULT_ADMIN_TAB ? "" : `?tab=${SLUGS[tab]}`;
}
