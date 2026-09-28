// [SITE-39] `/admin?tab=<slug>` opens that admin tab; the mod-queue Discord
// notice (db/src/core/modqueue.ts) links to `/admin?tab=links`.
import { describe, expect, it } from "vitest";
import { adminTabFromSearch, searchForAdminTab, DEFAULT_ADMIN_TAB, type AdminTab } from "../../src/lib/adminTab.ts";

describe("[SITE-39] admin tab <-> ?tab= query", () => {
  it("?tab=links opens the link queue (the Discord notice's own URL)", () => {
    expect(adminTabFromSearch("?tab=links")).toBe("linkQueue");
  });

  it("an absent, empty or unknown tab falls back to the default tab", () => {
    for (const search of ["", "?", "?tab=", "?tab=linkQueue", "?tab=nope", "?other=links"]) {
      expect(adminTabFromSearch(search)).toBe(DEFAULT_ADMIN_TAB);
    }
  });

  it("every tab round-trips, and the default tab keeps /admin plain", () => {
    const tabs: AdminTab[] = ["layouts", "authors", "bans", "linkQueue", "admins", "clients"];
    for (const tab of tabs) expect(adminTabFromSearch(searchForAdminTab(tab))).toBe(tab);
    expect(searchForAdminTab(DEFAULT_ADMIN_TAB)).toBe("");
  });
});
