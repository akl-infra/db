import type { Component } from "solid-js";
import { For, Show, createEffect, createMemo, createSignal } from "solid-js";
import { copy } from "../copy.ts";
import { getLayout, getLayoutHistory, getLikes } from "../api.ts";
import { onLinkClick } from "../router.ts";
import { safeExternalLink } from "../lib/safelink.ts";
import { createAsync } from "../lib/asyncData.ts";
import { meResource } from "../session.ts";
import { canSeeAdmin } from "../lib/adminGate.ts";
import AuthorRef from "../ui/AuthorRef.tsx";
import OwnerActions from "../ui/OwnerActions.tsx";

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
  // Once loaded, every re-fetch below (after an owner/admin action, or a
  // manual reload after a 409 `stale`) addresses the layout by its OWN
  // `id`, not the ref the URL happened to use -- `byRef` resolves an id
  // first and, unlike its name lookup, doesn't filter `deleted = 0`, so a
  // rename or a delete never strands this page on a ref that stops
  // resolving (OwnerActions.tsx carries the same reasoning for the writes
  // themselves).
  const [refreshRef, setRefreshRef] = createSignal<string | undefined>(undefined);
  const [refreshTick, setRefreshTick] = createSignal(0);
  function refresh(): void {
    setRefreshTick((t) => t + 1);
  }

  const record = createAsync(
    () => [refreshRef() ?? props.layoutRef, refreshTick()] as const,
    ([ref]) => getLayout(ref),
  );
  const history = createAsync(() => props.layoutRef, (ref) => getLayoutHistory(ref));

  const recordData = createMemo(() => {
    const r = record.data();
    return r?.ok ? r.data : undefined;
  });

  // Split effect (design/SOLID-CONVENTIONS.md rule 8a): `compute` is the
  // only place that reads the reactive `id` (establishing the dependency);
  // `apply` runs untracked and does the one-time imperative pin -- reading
  // `refreshRef()` there is a plain snapshot, not a subscription, so
  // pinning doesn't re-trigger itself.
  createEffect(
    () => recordData()?.id,
    (id) => {
      if (id !== undefined && refreshRef() === undefined) setRefreshRef(id);
    },
  );

  const likes = createAsync(
    () => recordData()?.id,
    (id) => (id ? getLikes(id) : Promise.resolve({ ok: true as const, data: { likes: [] } })),
  );

  const me = () => meResource();
  const liked = createMemo<boolean | undefined>(() => {
    const userId = me()?.user?.user_id;
    if (!userId) return undefined;
    const l = likes.data();
    if (!l?.ok) return undefined;
    return l.data.likes.includes(userId);
  });
  const isOwner = createMemo(() => {
    const userId = me()?.user?.user_id;
    const data = recordData();
    return !!userId && !!data && userId === data.owner;
  });
  const isAdmin = createMemo(() => canSeeAdmin(me()));
  const canManage = createMemo(() => isOwner() || isAdmin());

  const formatIds = createMemo(() => {
    const r = record.data();
    return r?.ok ? Object.keys(r.data.formats) : [];
  });
  const link = createMemo(() => {
    const r = record.data();
    return r?.ok ? safeExternalLink(r.data.link) : null;
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
              <dl class="akl-meta-list">
                <dt>{copy.layout.owner}</dt>
                <dd>
                  <AuthorRef userId={data.owner} linked />
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
              </dl>
            </div>

            {/* saltorbit, 2026-09-13: the site is not a layout renderer -- the
                stored format is shown as plain text, exactly as the DB
                holds it (canonical JSON), and nothing links out to akl.gg. */}
            <Show when={data.payload}>
              {(payload) => {
                // saltorbit, 2026-09-13: collapsed by default, with a copy button.
                const text = () => JSON.stringify(payload(), null, 2);
                const [open, setOpen] = createSignal(false);
                const [copied, setCopied] = createSignal(false);
                const copyText = async () => {
                  try {
                    await navigator.clipboard.writeText(text());
                    setCopied(true);
                    setTimeout(() => setCopied(false), 1500);
                  } catch {
                    setCopied(false);
                  }
                };
                return (
                  <div class="akl-payload-block">
                    <div class="akl-payload-bar">
                      <button type="button" class="akl-payload-toggle" aria-expanded={open() ? "true" : "false"} onClick={() => { setOpen(!open()); }}>
                        <span class="akl-payload-caret" aria-hidden="true">{open() ? "▾" : "▸"}</span> {data.format}
                      </button>
                      <button type="button" class="akl-payload-copy" onClick={copyText}>
                        {copied() ? copy.layout.copied : copy.layout.copyPayload}
                      </button>
                    </div>
                    <Show when={open()}>
                      <pre class="akl-payload">{text()}</pre>
                    </Show>
                  </div>
                );
              }}
            </Show>

            <Show when={me()} keyed>
              {(m) => (
                <Show when={m.user} fallback={<p class="akl-muted">{copy.actions.signInToManage}</p>}>
                  <OwnerActions layout={data} liked={liked()} canManage={canManage()} isAdmin={isAdmin()} onChanged={refresh} />
                </Show>
              )}
            </Show>

            <h2>{copy.layout.historyTitle}</h2>
            <Show when={historyItems().length > 0} fallback={<div class="akl-empty">{copy.layout.historyEmpty}</div>}>
              <ul class="akl-history-list">
                <For each={historyItems()}>
                  {(ev) => (
                    <li>
                      <span class="akl-history-when">{ev.at}</span>
                      <span>{ev.kind}</span>
                      {/* saltorbit, 2026-09-13: "liked"/"unliked" rows may keep
                          showing the raw actor id -- every other kind shows
                          the resolved display name. */}
                      <Show when={ev.kind !== "liked" && ev.kind !== "unliked"} fallback={<span class="akl-muted">{ev.actor}</span>}>
                        <span class="akl-muted">
                          <AuthorRef userId={ev.actor} linked />
                        </span>
                      </Show>
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
