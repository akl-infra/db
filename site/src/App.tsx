import type { Component } from "solid-js";
import { Show } from "solid-js";
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
      </main>
    </div>
  );
};

export default App;
