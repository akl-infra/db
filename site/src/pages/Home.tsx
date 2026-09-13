import type { Component } from "solid-js";
import { For, Show, createMemo, createSignal } from "solid-js";
import { copy } from "../copy.ts";
import { listLayouts } from "../api.ts";
import { onLinkClick } from "../router.ts";
import { createAsync } from "../lib/asyncData.ts";
import type { LayoutRecord } from "../lib/types.ts";
import AuthorRef from "../ui/AuthorRef.tsx";

type MagicFilter = "any" | "only" | "none";
type SortKey = "likes" | "modified" | "name";

async function fetchAllLayouts(): Promise<LayoutRecord[]> {
  const items: LayoutRecord[] = [];
  let cursor: string | undefined;
  do {
    const result = await listLayouts({ limit: 1000, cursor });
    if (!result.ok) throw new Error(result.error);
    items.push(...result.data.items);
    cursor = result.data.next ?? undefined;
  } while (cursor);
  return items;
}

const Home: Component = () => {
  const rows = createAsync(() => true, fetchAllLayouts);
  const [query, setQuery] = createSignal("");
  const [author, setAuthor] = createSignal("");
  const [magic, setMagic] = createSignal<MagicFilter>("any");
  const [sortKey, setSortKey] = createSignal<SortKey>("likes");

  const filtered = createMemo(() => {
    const all = rows.data() ?? [];
    const q = query().trim().toLowerCase();
    const a = author().trim().toLowerCase();
    const m = magic();
    let out = all.filter((r) => !r.deleted);
    if (q) out = out.filter((r) => r.name.toLowerCase().includes(q));
    if (a) out = out.filter((r) => r.owner.toLowerCase().includes(a));
    if (m !== "any") {
      out = out.filter((r) => {
        const hasMagic = Object.values(r.formats).some((f) => f.has_magic);
        return m === "only" ? hasMagic : !hasMagic;
      });
    }
    const sorted = out.slice();
    const key = sortKey();
    if (key === "likes") sorted.sort((x, y) => y.like_count - x.like_count);
    else if (key === "modified") sorted.sort((x, y) => y.modified_at.localeCompare(x.modified_at));
    else sorted.sort((x, y) => x.name.localeCompare(y.name));
    return sorted;
  });

  return (
    <div>
      <h1>{copy.home.title}</h1>
      <div class="akl-filters">
        <input
          type="text"
          placeholder={copy.home.searchPlaceholder}
          value={query()}
          onInput={(e) => setQuery(e.currentTarget.value)}
        />
        <input
          type="text"
          placeholder={copy.home.authorPlaceholder}
          value={author()}
          onInput={(e) => setAuthor(e.currentTarget.value)}
        />
        <select value={magic()} onChange={(e) => setMagic(e.currentTarget.value as MagicFilter)}>
          <option value="any">{copy.home.magicAny}</option>
          <option value="only">{copy.home.magicOnly}</option>
          <option value="none">{copy.home.magicNone}</option>
        </select>
        <select value={sortKey()} onChange={(e) => setSortKey(e.currentTarget.value as SortKey)}>
          <option value="likes">{copy.home.sortLikes}</option>
          <option value="modified">{copy.home.sortModified}</option>
          <option value="name">{copy.home.sortName}</option>
        </select>
      </div>

      <Show when={!rows.loading()} fallback={<p class="akl-muted">{copy.home.loading}</p>}>
        <Show when={!rows.error()} fallback={<div class="akl-error">{copy.home.loadError}</div>}>
          <p class="akl-count">{copy.home.countSuffix(filtered().length)}</p>
          <Show when={filtered().length > 0} fallback={<div class="akl-empty">{copy.home.empty}</div>}>
            <table class="akl-table">
              <thead>
                <tr>
                  <th>{copy.home.colName}</th>
                  <th>{copy.home.colOwner}</th>
                  <th>{copy.home.colLikes}</th>
                  <th>{copy.home.colModified}</th>
                </tr>
              </thead>
              <tbody>
                <For each={filtered()}>
                  {(row) => {
                    const layoutHref = `/l/${encodeURIComponent(row.name)}`;
                    return (
                      <tr>
                        {/* saltorbit, 2026-09-13: the whole row opens the layout.
                            `akl-row-link` is a real <a> stretched over the
                            entire <tr> by styles.css's `::after` overlay
                            (`position: relative` on the row, `inset: 0` on
                            the pseudo-element) -- native anchor semantics do
                            the rest for free: it's in the tab order and
                            Enter activates it (keyboard), and a middle-click
                            or a modified click (cmd/ctrl/shift) opens a new
                            tab exactly as any other link would, because
                            `onLinkClick` (router.ts) returns before calling
                            `preventDefault()` for anything but a plain,
                            unmodified left click ([SITE-20]). The Owner
                            column's own link stacks above the overlay
                            (styles.css: any non-`akl-row-link` anchor inside
                            `.akl-table` gets `z-index: 1`) so clicking an
                            owner's name still goes to their author page. */}
                        <td data-col={copy.home.colName}>
                          <a href={layoutHref} class="akl-row-link" onClick={(e) => onLinkClick(e, layoutHref)}>
                            {row.name}
                          </a>
                        </td>
                        <td data-col={copy.home.colOwner}>
                          <AuthorRef userId={row.owner} linked />
                        </td>
                        <td data-col={copy.home.colLikes}>{row.like_count}</td>
                        <td data-col={copy.home.colModified}>{row.modified_at.slice(0, 10)}</td>
                      </tr>
                    );
                  }}
                </For>
              </tbody>
            </table>
          </Show>
        </Show>
      </Show>
    </div>
  );
};

export default Home;
