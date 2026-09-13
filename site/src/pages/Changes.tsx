import type { Component } from "solid-js";
import { For, Show, createSignal, onSettled } from "solid-js";
import { copy } from "../copy.ts";
import { getChanges, getHeadSeq } from "../api.ts";
import { windowBelow } from "../lib/eventlog.ts";
import type { ChangeEvent } from "../lib/types.ts";
import AuthorRef from "../ui/AuthorRef.tsx";
import { onLinkClick } from "../router.ts";

type KnownKind = keyof typeof copy.changes.kinds;

function kindLabel(kind: string): string {
  return Object.prototype.hasOwnProperty.call(copy.changes.kinds, kind) ? copy.changes.kinds[kind as KnownKind] : kind;
}

const PAGE_SIZE = 50;

const Changes: Component = () => {
  const [items, setItems] = createSignal<ChangeEvent[]>([]);
  // `hi` = the exclusive-upper edge of the next window to fetch, walking
  // DOWN from the head seq (src/lib/eventlog.ts, SITE-19). null until
  // /v1/meta has told us where the head is.
  const [hi, setHi] = createSignal<number | null>(null);
  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal(false);
  const [done, setDone] = createSignal(false);

  const loadMore = async () => {
    setLoading(true);
    let top = hi();
    if (top === null) {
      const meta = await getHeadSeq();
      if (!meta.ok) {
        setLoading(false);
        setError(true);
        return;
      }
      top = meta.data.seq;
    }
    const w = windowBelow(top, PAGE_SIZE);
    if (w.limit === 0) {
      setLoading(false);
      setHi(0);
      setDone(true);
      return;
    }
    const result = await getChanges(w.since, w.limit);
    setLoading(false);
    if (!result.ok) {
      setError(true);
      return;
    }
    // Newest first for display: /v1/changes answers the window (since, hi]
    // oldest-to-newest, so each window is reversed and appended after the
    // previous (already-reversed, already-newer) windows.
    setItems((prev) => [...prev, ...result.data.items.slice().reverse()]);
    setHi(w.nextHi);
    if (w.nextHi === 0) setDone(true);
  };

  onSettled(() => {
    void loadMore();
  });

  return (
    <div>
      <h1>{copy.changes.title}</h1>
      <Show when={!error()} fallback={<div class="akl-error">{copy.changes.loadError}</div>}>
        <Show when={items().length > 0} fallback={<Show when={!loading()}><div class="akl-empty">{copy.changes.empty}</div></Show>}>
          <table class="akl-table">
            <thead>
              <tr>
                <th>{copy.changes.whenColumn}</th>
                <th>{copy.changes.kindColumn}</th>
                <th>{copy.changes.scopeColumn}</th>
                <th>{copy.changes.layoutColumn}</th>
                <th>{copy.changes.actorColumn}</th>
              </tr>
            </thead>
            <tbody>
              {/* A brand-new layout appends TWO events in one batch, one per
                  scope (db/docs/adoption.md §4): a layout-scope row
                  (`format: null`) and a format-scope row (`format:
                  "spark/1"`), same seq-adjacent timestamp/kind/layout/actor.
                  These are NOT duplicates -- the Scope column is what tells
                  them apart. */}
              <For each={items()}>
                {(ev) => {
                  // Always link by `layout_id` (a stable ULID) rather than
                  // `ev.name` (the name AT THAT EVENT, which a later rename
                  // or delete can leave un-resolvable) -- GET /v1/layouts/:id
                  // finds a layout by id even across a rename, and even a
                  // deleted one (db/src/core/records.ts's id-first `byRef`
                  // skips the `deleted = 0` filter name lookups apply).
                  const layoutHref = `/l/${encodeURIComponent(ev.layout_id)}`;
                  return (
                    <tr>
                      <td class="akl-nowrap" data-col={copy.changes.whenColumn}>{ev.at}</td>
                      <td class="akl-nowrap" data-col={copy.changes.kindColumn} title={ev.kind}>
                        {kindLabel(ev.kind)}
                      </td>
                      <td class="akl-nowrap" data-col={copy.changes.scopeColumn}>{ev.format ?? copy.changes.scopeLayout}</td>
                      <td data-col={copy.changes.layoutColumn}>
                        {/* `ev.name` is only carried on layout-scope rows (db/docs/adoption.md
                            §4); `ev.layout_id` (a ULID) always resolves via GET /v1/layouts/:ref's
                            id-first lookup even for a tombstoned layout, unlike its name. */}
                        <a href={layoutHref} title={ev.layout_id} onClick={(e) => onLinkClick(e, layoutHref)}>
                          {ev.name ?? ev.layout_id}
                        </a>
                      </td>
                      <td class="akl-nowrap" data-col={copy.changes.actorColumn}>
                        {/* saltorbit, 2026-09-13: "liked" rows may keep showing
                            the raw actor id -- every other kind shows the
                            resolved display name. */}
                        <Show when={ev.kind !== "liked" && ev.kind !== "unliked"} fallback={<span title={ev.actor}>{ev.actor}</span>}>
                          <AuthorRef userId={ev.actor} linked />
                        </Show>
                      </td>
                    </tr>
                  );
                }}
              </For>
            </tbody>
          </table>
        </Show>
        <Show when={!done() && items().length > 0}>
          <button class="akl-link-btn" onClick={loadMore} disabled={loading()}>
            {copy.changes.loadMore}
          </button>
        </Show>
      </Show>
    </div>
  );
};

export default Changes;
