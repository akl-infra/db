import type { Component } from "solid-js";
import { Show } from "solid-js";
import { copy } from "../copy.ts";
import { currentRoute, navigate, onLinkClick } from "../router.ts";
import { logout } from "../api.ts";
import { meResource, refreshMe } from "../session.ts";
import { canSeeAdmin } from "../lib/adminGate.ts";

const Header: Component = () => {
  const isHomeArea = () => ["home", "layout", "author"].includes(currentRoute().name);
  const isChanges = () => currentRoute().name === "changes";
  const isDocs = () => currentRoute().name === "docs";
  const isAdmin = () => currentRoute().name === "admin";
  const me = () => meResource();

  const handleSignOut = async () => {
    await logout();
    await refreshMe();
    navigate({ name: "home" });
  };

  return (
    <header class="akl-header">
      <div class="akl-brand">
        <a href="/" class="akl-brand-name" onClick={(e) => onLinkClick(e, "/")}>
          {copy.siteName}
        </a>
        <span class="akl-brand-tagline">{copy.header.tagline}</span>
      </div>
      <nav class="akl-nav">
        <a href="/" aria-current={isHomeArea() ? "page" : undefined} onClick={(e) => onLinkClick(e, "/")}>
          {copy.header.navHome}
        </a>
        <a href="/changes" aria-current={isChanges() ? "page" : undefined} onClick={(e) => onLinkClick(e, "/changes")}>
          {copy.header.navChanges}
        </a>
        <a href="/docs" aria-current={isDocs() ? "page" : undefined} onClick={(e) => onLinkClick(e, "/docs")}>
          {copy.header.navDocs}
        </a>
        <Show when={canSeeAdmin(me())}>
          <a href="/admin" aria-current={isAdmin() ? "page" : undefined} onClick={(e) => onLinkClick(e, "/admin")}>
            {copy.header.navAdmin}
          </a>
        </Show>
        <Show
          when={me()}
          fallback={<span class="akl-muted">…</span>}
        >
          {(m) => (
            <Show
              when={m().signin}
              fallback={
                <button class="akl-signin" disabled title={copy.header.signInUnavailable}>
                  {copy.header.signInUnavailable}
                </button>
              }
            >
              <Show
                when={m().user}
                fallback={
                  <a class="akl-signin" href="/auth/login">
                    {copy.header.signIn}
                  </a>
                }
              >
                {(user) => (
                  <div class="akl-signed-in">
                    <span>{copy.header.signedInAs(user().name)}</span>
                    <button onClick={handleSignOut}>{copy.header.signOut}</button>
                  </div>
                )}
              </Show>
            </Show>
          )}
        </Show>
      </nav>
    </header>
  );
};

export default Header;
