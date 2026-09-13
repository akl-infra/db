// A tiny history-based router (design/akldb-site/01-plan.md §5: "hand-
// rolled history router, no router dependency"). Five routes, no nesting,
// no data loaders -- not worth a dependency.
import { createSignal } from "solid-js";

export type Route =
  | { name: "home" }
  | { name: "layout"; ref: string }
  | { name: "author"; userId: string }
  | { name: "changes" }
  | { name: "docs" }
  | { name: "admin" }
  | { name: "notFound" };

export function parsePath(pathname: string): Route {
  const parts = pathname.split("/").filter(Boolean);
  if (parts.length === 0) return { name: "home" };
  if (parts[0] === "l" && parts[1]) return { name: "layout", ref: decodeURIComponent(parts[1]) };
  if (parts[0] === "a" && parts[1]) return { name: "author", userId: decodeURIComponent(parts[1]) };
  if (parts[0] === "changes" && parts.length === 1) return { name: "changes" };
  if (parts[0] === "docs" && parts.length === 1) return { name: "docs" };
  if (parts[0] === "admin" && parts.length === 1) return { name: "admin" };
  return { name: "notFound" };
}

export function pathFor(route: Route): string {
  switch (route.name) {
    case "home":
      return "/";
    case "layout":
      return `/l/${encodeURIComponent(route.ref)}`;
    case "author":
      return `/a/${encodeURIComponent(route.userId)}`;
    case "changes":
      return "/changes";
    case "docs":
      return "/docs";
    case "admin":
      return "/admin";
    case "notFound":
      return "/404";
  }
}

// `typeof window` guarded: this module is imported by tests/src/router.test.ts
// under a plain Node environment (testing parsePath/pathFor, not the DOM
// wiring below), which has no global `location`.
const initialPath = typeof location !== "undefined" ? location.pathname : "/";
const [route, setRoute] = createSignal<Route>(parsePath(initialPath));

if (typeof window !== "undefined") {
  window.addEventListener("popstate", () => setRoute(parsePath(location.pathname)));
}

export function currentRoute() {
  return route();
}

export function navigate(next: Route, { replace = false }: { replace?: boolean } = {}): void {
  const path = pathFor(next);
  if (replace) history.replaceState(null, "", path);
  else history.pushState(null, "", path);
  setRoute(next);
}

/** For `<a href>` clicks: intercept a same-origin, unmodified left click so
 * the SPA router handles it instead of a full page load. */
export function onLinkClick(e: MouseEvent, href: string): void {
  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  e.preventDefault();
  navigate(parsePath(new URL(href, location.origin).pathname));
}
