import type { Component } from "solid-js";
import { Errored, Show } from "solid-js";
import { copy } from "./copy.ts";
import Header from "./ui/Header.tsx";
import Home from "./pages/Home.tsx";
import Layout from "./pages/Layout.tsx";
import Author from "./pages/Author.tsx";
import Changes from "./pages/Changes.tsx";
import Docs from "./pages/Docs.tsx";
import Admin from "./pages/Admin.tsx";
import NotFound from "./pages/NotFound.tsx";
import { currentRoute } from "./router.ts";
import type { Route } from "./router.ts";

// Route names are mutually exclusive, so a stack of independent <Show>s
// behaves exactly like a switch here -- and, unlike <Switch>/<Match>, needs
// no generic gymnastics to hand a narrowed route (its `ref`/`userId`) down
// to the one page that needs it.
const App: Component = () => {
  return (
    <div class="akl-app">
      <Header />
      <main>
        {/* SITE-22 (Solid 2's `Errored`, the old ErrorBoundary): a throw anywhere inside a page (a wire-shape surprise,
            a bad record) must never take the header/nav down with it --
            Solid disposes the whole root on an uncaught error otherwise
            (production 2026-09-13). The boundary is keyed on the route so
            navigating away always resets it. */}
        <Errored
          fallback={(err, reset) => (
            <div class="akl-error">
              {copy.app.pageError} <code>{String((err() as { message?: string })?.message ?? err())}</code>{" "}
              <button class="akl-btn-ghost" onClick={() => reset()}>
                {copy.app.retry}
              </button>
            </div>
          )}
        >
        <Show when={currentRoute().name === "home"}>
          <Home />
        </Show>
        <Show when={currentRoute().name === "layout" && (currentRoute() as Extract<Route, { name: "layout" }>)} keyed>
          {(r) => <Layout layoutRef={r.ref} />}
        </Show>
        <Show when={currentRoute().name === "author" && (currentRoute() as Extract<Route, { name: "author" }>)} keyed>
          {(r) => <Author userId={r.userId} />}
        </Show>
        <Show when={currentRoute().name === "changes"}>
          <Changes />
        </Show>
        <Show when={currentRoute().name === "docs"}>
          <Docs />
        </Show>
        <Show when={currentRoute().name === "admin"}>
          <Admin />
        </Show>
        <Show when={currentRoute().name === "notFound"}>
          <NotFound />
        </Show>
        </Errored>
      </main>
    </div>
  );
};

export default App;
