// [SITE-39] `/admin?tab=<slug>` opens that admin tab; the mod-queue Discord
// notice (db/src/core/modqueue.ts) links to `/admin?tab=inbox`. The slugs of
// the tabs merged into Inbox/Users keep working.
import { describe, expect, it } from "vitest";
import { adminTabFromSearch, searchForAdminTab, DEFAULT_ADMIN_TAB, type AdminTab } from "../../src/lib/adminTab.ts";

describe("[SITE-39] admin tab <-> ?tab= query", () => {
  it("?tab=inbox opens the Inbox (the Discord notice's own URL), and the Inbox is the default tab", () => {
    expect(adminTabFromSearch("?tab=inbox")).toBe("inbox");
    expect(DEFAULT_ADMIN_TAB).toBe("inbox");
  });

  it("the retired slugs map onto the tabs that absorbed them", () => {
    expect(adminTabFromSearch("?tab=links")).toBe("inbox");
    expect(adminTabFromSearch("?tab=authors")).toBe("users");
    expect(adminTabFromSearch("?tab=bans")).toBe("users");
    expect(adminTabFromSearch("?tab=admins")).toBe("users");
  });

  it("an absent, empty or unknown tab falls back to the default tab (inherited object keys included)", () => {
    for (const search of ["", "?", "?tab=", "?tab=linkQueue", "?tab=nope", "?other=links", "?tab=constructor", "?tab=__proto__", "?tab=toString"]) {
      expect(adminTabFromSearch(search)).toBe(DEFAULT_ADMIN_TAB);
    }
  });

  it("every tab round-trips, and the default tab keeps /admin plain", () => {
    const tabs: AdminTab[] = ["inbox", "layouts", "users", "clients"];
    for (const tab of tabs) expect(adminTabFromSearch(searchForAdminTab(tab))).toBe(tab);
    expect(searchForAdminTab(DEFAULT_ADMIN_TAB)).toBe("");
    expect(searchForAdminTab("users")).toBe("?tab=users");
  });
});
