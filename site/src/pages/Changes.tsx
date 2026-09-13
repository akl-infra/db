import type { Component } from "solid-js";
import { For, Show, createSignal, onSettled } from "solid-js";
import { copy } from "../copy.ts";
import { getChanges } from "../api.ts";
import type { ChangeEvent } from "../lib/types.ts";

const PAGE_SIZE = 50;

const Changes: Component = () => {
  const [items, setItems] = createSignal<ChangeEvent[]>([]);
  const [cursor, setCursor] = createSignal(0);
  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal(false);
  const [done, setDone] = createSignal(false);

  const loadMore = async () => {
    setLoading(true);
    const result = await getChanges(cursor(), PAGE_SIZE);
    setLoading(false);
    if (!result.ok) {
      setError(true);
      return;
    }
    // Newest first for display: /v1/changes pages oldest-to-newest by seq,
    // so each page is reversed and appended after the previous (already-
    // reversed, already-newer) pages.
    setItems((prev) => [...prev, ...result.data.items.slice().reverse()]);
    if (result.data.items.length < PAGE_SIZE) setDone(true);
    setCursor(result.data.next);
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
                {(ev) => (
                  <tr>
                    <td data-col={copy.changes.whenColumn}>{ev.at}</td>
                    <td data-col={copy.changes.kindColumn}>{ev.kind}</td>
                    <td data-col={copy.changes.scopeColumn}>{ev.format ?? copy.changes.scopeLayout}</td>
                    <td data-col={copy.changes.layoutColumn}>{ev.name ?? ev.layout_id}</td>
                    <td data-col={copy.changes.actorColumn}>{ev.actor}</td>
                  </tr>
                )}
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
