import type { Component } from "solid-js";
import { Show } from "solid-js";
import { copy } from "../copy.ts";
// Generated at build time by scripts/build-docs.mjs from db/docs/
// adoption.md (S8) -- gitignored; the `predev`/`prebuild`/`pretest`/
// `pretypecheck` npm hooks (package.json) always run that script first, so
// this file exists by the time anything imports it.
import { docsHtml } from "../generated/docs.html.ts";

const Docs: Component = () => {
  // No page-level <h1> here: db/docs/adoption.md brings its own ("Adopting
  // the layout database API") as the rendered content's first heading --
  // adding a second would be a duplicate H1 on the page (accessibility and
  // visual QA both flagged the first draft's version of this).
  return (
    <Show when={docsHtml} fallback={<div class="akl-error">{copy.docs.loadError}</div>}>
      <div class="akl-docs" innerHTML={docsHtml} />
    </Show>
  );
};

export default Docs;
