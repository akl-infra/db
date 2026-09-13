import type { Component } from "solid-js";
import { Show, createSignal } from "solid-js";
import { copy } from "../copy.ts";
import { meResource } from "../session.ts";
import { canSeeAdmin } from "../lib/adminGate.ts";
import LayoutsTab from "./admin/LayoutsTab.tsx";
import AuthorsTab from "./admin/AuthorsTab.tsx";
import BansTab from "./admin/BansTab.tsx";
import LinkQueueTab from "./admin/LinkQueueTab.tsx";
import AdminsTab from "./admin/AdminsTab.tsx";
import ImportTab from "./admin/ImportTab.tsx";

type Tab = "layouts" | "authors" | "bans" | "linkQueue" | "admins" | "import";

/** Route `/admin` (design/akldb-site/01-plan.md §5): the real moderation
 * console. The gate is unchanged from W1a and stays the security-relevant
 * courtesy it always was -- the DB re-checks `admin` on every call through
 * the proxy regardless ([SITE-6]) -- but now, when `canSeeAdmin` is false,
 * NONE of the tab components below are even instantiated: the whole
 * `<Show>` branch they live in never mounts, so there is no moderation
 * markup anywhere in the DOM for a non-admin, not just a CSS-hidden one
 * ([SITE-18]). `meResource()` always comes from a fresh `/auth/me` ->
 * `/v1/me` round trip (server/discord.ts), never a cached admin flag. */
const Admin: Component = () => {
  const [tab, setTab] = createSignal<Tab>("layouts");

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
            <div class="akl-admin-tabs">
              <button aria-current={tab() === "layouts" ? "true" : undefined} onClick={() => setTab("layouts")}>
                {copy.admin.tabLayouts}
              </button>
              <button aria-current={tab() === "authors" ? "true" : undefined} onClick={() => setTab("authors")}>
                {copy.admin.tabAuthors}
              </button>
              <button aria-current={tab() === "bans" ? "true" : undefined} onClick={() => setTab("bans")}>
                {copy.admin.tabBans}
              </button>
              <button aria-current={tab() === "linkQueue" ? "true" : undefined} onClick={() => setTab("linkQueue")}>
                {copy.admin.tabLinkQueue}
              </button>
              <button aria-current={tab() === "admins" ? "true" : undefined} onClick={() => setTab("admins")}>
                {copy.admin.tabAdmins}
              </button>
              <button aria-current={tab() === "import" ? "true" : undefined} onClick={() => setTab("import")}>
                {copy.admin.tabImport}
              </button>
            </div>

            <Show when={tab() === "layouts"}>
              <LayoutsTab />
            </Show>
            <Show when={tab() === "authors"}>
              <AuthorsTab />
            </Show>
            <Show when={tab() === "bans"}>
              <BansTab />
            </Show>
            <Show when={tab() === "linkQueue"}>
              <LinkQueueTab />
            </Show>
            <Show when={tab() === "admins"}>
              <AdminsTab />
            </Show>
            <Show when={tab() === "import"}>
              <ImportTab />
            </Show>
          </div>
        </Show>
      )}
    </Show>
  );
};

export default Admin;
