import type { Component } from "solid-js";
import { For, Show, createMemo, createSignal } from "solid-js";
import { copy } from "../copy.ts";
import { listLayouts } from "../api.ts";
import { onLinkClick } from "../router.ts";
import { rowClick } from "../lib/rowclick.ts";
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
                      <tr onClick={(e) => rowClick(e, layoutHref)}>
                        {/* saltorbit, 2026-09-13: the whole row opens the layout.
                            The name cell keeps a real <a> (tab order, Enter,
                            middle/modified click open a new tab); a plain
                            click anywhere ELSE in the row is delegated by
                            `rowClick` (src/lib/rowclick.ts) to the same
                            `onLinkClick`, unless it landed on another link
                            (the Owner column). No positioned overlay -- see
                            rowclick.ts for the Safari bug that ruled it out
                            ([SITE-20]). */}
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
