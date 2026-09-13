import type { Component } from "solid-js";
import { Show } from "solid-js";
import { copy } from "../copy.ts";
import { meResource } from "../session.ts";
import { canSeeAdmin } from "../lib/adminGate.ts";

/** Route `/admin` (design/akldb-site/01-plan.md §5): a placeholder here --
 * the real moderation console (Layouts/Authors/Bans/Link queue/Admins/
 * Import tabs, wired to api.ts's admin* functions) is W1b. The gate itself
 * (admin-only, DB re-checked on every call through the proxy) is real: this
 * page never trusts a cached admin flag, `meResource()` always comes from a
 * fresh `/auth/me` -> `/v1/me` round trip (server/discord.ts). */
const Admin: Component = () => {
  return (
    <Show when={meResource()} keyed>
      {(me) => (
        <Show
          when={canSeeAdmin(me)}
          fallback={
            <div>
              <h1>{copy.notFound.title}</h1>
              <p class="akl-muted">{copy.admin.notAdmin}</p>
            </div>
          }
        >
          <div>
            <h1>{copy.admin.title}</h1>
            <p class="akl-muted">{copy.admin.comingSoon}</p>
            <p>{copy.admin.tabsIntro}</p>
            <ul class="akl-admin-tabs">
              <li>{copy.admin.tabLayouts}</li>
              <li>{copy.admin.tabAuthors}</li>
              <li>{copy.admin.tabBans}</li>
              <li>{copy.admin.tabLinkQueue}</li>
              <li>{copy.admin.tabAdmins}</li>
              <li>{copy.admin.tabImport}</li>
            </ul>
          </div>
        </Show>
      )}
    </Show>
  );
};

export default Admin;
