import type { Component } from "solid-js";
import { For, Show, createMemo } from "solid-js";
import { copy } from "../copy.ts";
import { getLayout, getLayoutHistory } from "../api.ts";
import { onLinkClick } from "../router.ts";
import { aklggAnalyzeUrl } from "../lib/aklgg.ts";
import { safeExternalLink } from "../lib/safelink.ts";
import { createAsync } from "../lib/asyncData.ts";
import Board from "../ui/Board.tsx";

interface LayoutPageProps {
  // NOT named `ref`: that's a reserved JSX attribute name on components in
  // Solid (ref-forwarding) -- a plain string passed as that prop name gets
  // intercepted by the compiler instead of arriving as a normal prop (a
  // real bug caught in the Chrome QA pass: the DB got Solid's own compiled
  // ref-setter function source, stringified, as the layout name;
  // tests/tools/no-component-ref-prop.test.ts guards against it recurring).
  layoutRef: string;
}

const LayoutPage: Component<LayoutPageProps> = (props) => {
  const record = createAsync(() => props.layoutRef, getLayout);
  const history = createAsync(() => props.layoutRef, (ref) => getLayoutHistory(ref));

  const formatIds = createMemo(() => {
    const r = record.data();
    return r?.ok ? Object.keys(r.data.formats) : [];
  });
  const link = createMemo(() => {
    const r = record.data();
    return r?.ok ? safeExternalLink(r.data.link) : null;
  });
  const analyzeHref = createMemo(() => {
    const r = record.data();
    return r?.ok ? aklggAnalyzeUrl(r.data.name) : "https://akl.gg/";
  });
  const historyItems = createMemo(() => {
    const h = history.data();
    if (!h?.ok) return [];
    return h.data.slice().reverse(); // newest first
  });
  const loadErrorMessage = createMemo(() => {
    const r = record.data();
    if (!r || r.ok) return null;
    return r.status === 404 ? copy.layout.notFound : copy.layout.loadError;
  });
  const recordData = createMemo(() => {
    const r = record.data();
    return r?.ok ? r.data : undefined;
  });

  return (
    <div>
      <a href="/" class="akl-muted" onClick={(e) => onLinkClick(e, "/")}>
        ← {copy.layout.backToHome}
      </a>

      <Show when={record.loading()}>
        <p class="akl-muted">…</p>
      </Show>

      <Show when={loadErrorMessage()}>{(msg) => <div class="akl-error">{msg()}</div>}</Show>

      <Show when={recordData()} keyed>
        {(data) => (
          <>
            <h1>{data.name}</h1>
            <div class="akl-layout-head">
              <Show when={data.payload}>{(payload) => <Board payload={payload()} />}</Show>
              <dl class="akl-meta-list">
                <dt>{copy.layout.owner}</dt>
                <dd>
                  <a href={`/a/${encodeURIComponent(data.owner)}`} onClick={(e) => onLinkClick(e, `/a/${encodeURIComponent(data.owner)}`)}>
                    {data.owner}
                  </a>
                </dd>
                <dt>{copy.layout.likes}</dt>
                <dd>{data.like_count}</dd>
                <dt>{copy.layout.created}</dt>
                <dd>{data.created_at}</dd>
                <dt>{copy.layout.modified}</dt>
                <dd>{data.modified_at}</dd>
                <dt>{copy.layout.formats}</dt>
                <dd>
                  <For each={formatIds()}>{(id) => <span class="akl-badge">{id}</span>}</For>
                </dd>
                <dt>{copy.layout.linkLabel}</dt>
                <dd>
                  <Show when={link()} fallback={<span class="akl-muted">{copy.layout.noLink}</span>}>
                    {(l) => (
                      <a href={l().href} rel="nofollow noopener ugc" target="_blank">
                        {l().hostname}
                      </a>
                    )}
                  </Show>
                </dd>
                <dt></dt>
                <dd>
                  <a class="akl-link-btn" href={analyzeHref()} target="_blank" rel="noopener">
                    {copy.layout.analyzeOnAklgg}
                  </a>
                </dd>
              </dl>
            </div>

            <h2>{copy.layout.historyTitle}</h2>
            <Show when={historyItems().length > 0} fallback={<div class="akl-empty">{copy.layout.historyEmpty}</div>}>
              <ul class="akl-history-list">
                <For each={historyItems()}>
                  {(ev) => (
                    <li>
                      <span class="akl-history-when">{ev.at}</span>
                      <span>{ev.kind}</span>
                      <span class="akl-muted">{ev.actor}</span>
                    </li>
                  )}
                </For>
              </ul>
            </Show>
          </>
        )}
      </Show>
    </div>
  );
};

export default LayoutPage;
