import type { Component } from "solid-js";
import { For, Show, createSignal } from "solid-js";
import { copy } from "../copy.ts";
import type { EndpointGroup } from "../generated/docs.html.ts";
import AuthOwnership from "../ui/diagrams/AuthOwnership.tsx";
import TrustedClient from "../ui/diagrams/TrustedClient.tsx";

// Generated at build time by scripts/build-docs.mjs from db/docs/
// adoption.md (S8, W1c) -- gitignored; the `predev`/`prebuild`/`pretest`/
// `pretypecheck` npm hooks (package.json) always run that script first, so
// this module exists by the time anything imports it.
//
// Loaded with a DYNAMIC `import()` (below, `loadGeneratedDocs`), not a
// static one: this module carries db/docs/adoption.md's full rendered
// content -- 140KB+, the real akl-db hostname included -- and a dynamic
// import is what actually guarantees Rollup ships it as its own
// network-fetched chunk, loaded only once someone visits /docs, rather
// than folding it into every page's own bundle (SITE-7's hostname
// isolation depends on there being exactly one copy of this content in
// the whole build; `vite.config.ts`'s `manualChunks` alone was not
// sufficient once this page needed more than one of this module's
// exports -- see this slice's own git history for the measurement).
function loadGeneratedDocs() {
  return import("../generated/docs.html.ts");
}
type GeneratedDocs = Awaited<ReturnType<typeof loadGeneratedDocs>>;

// Exported (not just used internally) so tests/src/docs-copy.test.ts can
// call it directly with a fake clipboard, under vitest's plain "node"
// environment -- no DOM/Solid mount needed to prove SITE-32 ("the copy
// button's payload equals the served markdown").
export type CopyOutcome = "copied" | "unsupported";
export interface ClipboardLike {
  writeText(text: string): Promise<void>;
}
export async function copyMarkdownToClipboard(markdown: string, clipboard: ClipboardLike | undefined | null): Promise<CopyOutcome> {
  if (clipboard === undefined || clipboard === null) return "unsupported";
  await clipboard.writeText(markdown);
  return "copied";
}

const GROUP_ORDER: EndpointGroup[] = ["read", "write", "likes", "link", "admin"];

function groupLabel(g: EndpointGroup): string {
  switch (g) {
    case "read":
      return copy.docs.groupRead;
    case "write":
      return copy.docs.groupWrite;
    case "likes":
      return copy.docs.groupLikes;
    case "link":
      return copy.docs.groupLink;
    case "admin":
      return copy.docs.groupAdmin;
  }
}

function statuses(success: string, errors: string): string {
  const trimmedErrors = errors.trim();
  if (trimmedErrors === "" || trimmedErrors === "—") return success;
  return `${success} / ${trimmedErrors}`;
}

// The Docs page's one and only top-level heading (SITE-34) -- db/docs/
// adoption.md's own leading heading is demoted one level by build-docs.mjs
// (`demoteLeadingH1`) specifically so embedding the rendered guide here
// never creates a second one, collapsed or not.
const Docs: Component = () => {
  // No createResource in this Solid build (2.0.0-rc.1's async story is
  // still `@solidjs/signals`' own pending/suspense primitives, not the
  // classic API) -- a plain signal, set once the dynamic import resolves,
  // is all this page needs (one fetch, no refetching, no arguments).
  const [docsModule, setDocsModule] = createSignal<GeneratedDocs | undefined>(undefined);
  const [docsLoadFailed, setDocsLoadFailed] = createSignal(false);
  loadGeneratedDocs()
    .then(setDocsModule)
    .catch(() => setDocsLoadFailed(true));
  const [showGuide, setShowGuide] = createSignal(false);
  const [copyStatus, setCopyStatus] = createSignal<"idle" | "copied" | "failed">("idle");
  let fallbackRef: HTMLTextAreaElement | undefined;

  function revealFallback(): void {
    setCopyStatus("failed");
    if (fallbackRef !== undefined) {
      fallbackRef.hidden = false;
      fallbackRef.focus();
      fallbackRef.select();
    }
  }

  async function handleCopy(markdown: string): Promise<void> {
    try {
      const clipboard = typeof navigator === "undefined" ? undefined : navigator.clipboard;
      const outcome = await copyMarkdownToClipboard(markdown, clipboard);
      if (outcome === "copied") setCopyStatus("copied");
      else revealFallback();
    } catch {
      revealFallback();
    }
  }

  return (
    <div class="akl-docs-page">
      <h1>{copy.docs.title}</h1>

      <nav class="akl-docs-toc">
        <a href="#docs-brief">{copy.docs.tocBrief}</a>
        <a href="#docs-auth">{copy.docs.tocAuth}</a>
        <a href="#docs-trusted-clients">{copy.docs.tocTrustedClients}</a>
        <a href="#docs-adoption-guide">{copy.docs.tocGuide}</a>
        <a href="#docs-errors">{copy.docs.tocErrors}</a>
      </nav>

      <section id="docs-brief" class="akl-docs-brief">
        <h2>{copy.docs.briefHeading}</h2>
        <Show when={docsModule()} keyed fallback={<p class={docsLoadFailed() ? "akl-error" : "akl-muted"}>{docsLoadFailed() ? copy.docs.loadError : copy.docs.loading}</p>}>
          {(mod) => (
            <>
              <p>
                <strong>{copy.docs.baseUrlLabel}</strong> <code>{mod.baseUrl}</code>
              </p>

              <div class="akl-docs-scroll">
                <table class="akl-docs-lanes">
                  <thead>
                    <tr>
                      <th>{copy.docs.colAuth}</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    <tr>
                      <td>{copy.docs.laneUserName}</td>
                      <td>{copy.docs.laneUserSummary}</td>
                    </tr>
                    <tr>
                      <td>{copy.docs.laneClientName}</td>
                      <td>{copy.docs.laneClientSummary}</td>
                    </tr>
                  </tbody>
                </table>
              </div>

              <h3>{copy.docs.endpointsHeading}</h3>
              <For each={GROUP_ORDER}>
                {(g) => {
                  const rows = mod.endpoints.filter((e) => e.group === g);
                  return (
                    <div class="akl-docs-endpoint-group">
                      <h4>{groupLabel(g)}</h4>
                      <div class="akl-docs-scroll">
                        <table class="akl-docs-endpoints">
                          <thead>
                            <tr>
                              <th>{copy.docs.colMethod}</th>
                              <th>{copy.docs.colPath}</th>
                              <th>{copy.docs.colAuth}</th>
                              <th>{copy.docs.colPurpose}</th>
                              <th>{copy.docs.colStatuses}</th>
                            </tr>
                          </thead>
                          <tbody>
                            <For each={rows}>
                              {(ep) => (
                                <tr>
                                  <td>{ep.method}</td>
                                  <td>
                                    <code>{ep.path}</code>
                                  </td>
                                  <td>{ep.auth}</td>
                                  <td>{ep.purpose}</td>
                                  <td>{statuses(ep.success, ep.errors)}</td>
                                </tr>
                              )}
                            </For>
                          </tbody>
                        </table>
                      </div>
                    </div>
                  );
                }}
              </For>

              <dl class="akl-docs-notes">
                <dt>{copy.docs.ifMatchHeading}</dt>
                <dd>{copy.docs.ifMatchBody}</dd>
                <dt>{copy.docs.idempotencyHeading}</dt>
                <dd>{copy.docs.idempotencyBody}</dd>
                <dt>{copy.docs.rateLimitsHeading}</dt>
                <dd>{copy.docs.rateLimitsBody}</dd>
                <dt>{copy.docs.formatParamHeading}</dt>
                <dd>{copy.docs.formatParamBody}</dd>
                <dt>{copy.docs.moderationHeading}</dt>
                <dd>{copy.docs.moderationBody}</dd>
              </dl>
            </>
          )}
        </Show>
      </section>

      <section id="docs-auth" class="akl-docs-diagram-section">
        <h2>{copy.docs.authDiagramHeading}</h2>
        <p class="akl-muted">{copy.docs.authDiagramCaption}</p>
        <div class="akl-diagram-frame">
          <AuthOwnership ariaLabel={copy.docs.authDiagramAriaLabel} />
        </div>
      </section>

      <section id="docs-trusted-clients" class="akl-docs-diagram-section">
        <h2>{copy.docs.trustedClientHeading}</h2>
        <p class="akl-muted">{copy.docs.trustedClientCaption}</p>
        <div class="akl-diagram-frame">
          <TrustedClient ariaLabel={copy.docs.trustedClientAriaLabel} />
        </div>
      </section>

      <section id="docs-adoption-guide" class="akl-docs-guide-section">
        <h2>{copy.docs.tocGuide}</h2>
        <Show when={docsModule()} keyed fallback={<p class={docsLoadFailed() ? "akl-error" : "akl-muted"}>{docsLoadFailed() ? copy.docs.loadError : copy.docs.loading}</p>}>
          {(mod) => (
            <>
              <div class="akl-docs-guide-actions">
                <button type="button" onClick={() => handleCopy(mod.adoptionMarkdown)}>
                  {copy.docs.copyButtonLabel}
                </button>
                <a href="/adoption.md">{copy.docs.rawLinkLabel}</a>
                <button type="button" onClick={() => setShowGuide((v) => !v)}>
                  {showGuide() ? copy.docs.hideGuideLabel : copy.docs.showGuideLabel}
                </button>
              </div>
              <Show when={copyStatus() === "copied"}>
                <p class="akl-docs-copy-status">{copy.docs.copyButtonCopied}</p>
              </Show>
              <Show when={copyStatus() === "failed"}>
                <p class="akl-docs-copy-status akl-error">{copy.docs.copyButtonFailed}</p>
              </Show>
              <textarea ref={fallbackRef} class="akl-docs-copy-fallback" hidden readonly value={mod.adoptionMarkdown} />
              <Show when={showGuide()}>
                <div class="akl-docs" innerHTML={mod.docsHtml} />
              </Show>
            </>
          )}
        </Show>
      </section>

      <section id="docs-errors" class="akl-docs-errors">
        <h2>{copy.docs.errorShapeHeading}</h2>
        <p>{copy.docs.errorShapeBody}</p>
        <a href="#docs-adoption-guide" class="akl-docs-link-button" onClick={() => setShowGuide(true)}>
          {copy.docs.errorTableLinkLabel}
        </a>
      </section>
    </div>
  );
};

export default Docs;
