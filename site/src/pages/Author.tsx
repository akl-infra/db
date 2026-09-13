import type { Component } from "solid-js";
import { For, Show, createMemo } from "solid-js";
import { copy } from "../copy.ts";
import { getAuthor, listLayouts } from "../api.ts";
import { onLinkClick } from "../router.ts";
import { createAsync } from "../lib/asyncData.ts";

interface AuthorPageProps {
  userId: string;
}

const AuthorPage: Component<AuthorPageProps> = (props) => {
  const author = createAsync(() => props.userId, getAuthor);
  const layouts = createAsync(() => props.userId, (owner) => listLayouts({ owner, limit: 1000 }));

  const authorData = createMemo(() => {
    const a = author.data();
    return a?.ok ? a.data : undefined;
  });
  const authorErrorMessage = createMemo(() => {
    const a = author.data();
    if (!a || a.ok) return null;
    return a.status === 404 ? copy.author.notFound : copy.author.loadError;
  });
  const layoutRows = createMemo(() => {
    const l = layouts.data();
    return l?.ok ? l.data.items.filter((r) => !r.deleted) : undefined;
  });

  return (
    <div>
      <a href="/" class="akl-muted" onClick={(e) => onLinkClick(e, "/")}>
        ← {copy.layout.backToHome}
      </a>

      <Show when={author.loading()}>
        <p class="akl-muted">…</p>
      </Show>
      <Show when={authorErrorMessage()}>{(msg) => <div class="akl-error">{msg()}</div>}</Show>
      <Show when={authorData()} keyed>
        {(data) => (
          <h1 title={data.user_id}>{copy.author.title(data.name)}</h1>
        )}
      </Show>

      <Show when={layoutRows()} keyed>
        {(rows) => (
          <Show when={rows.length > 0} fallback={<div class="akl-empty">{copy.author.empty}</div>}>
            <table class="akl-table">
              <thead>
                <tr>
                  <th>{copy.home.colName}</th>
                  <th>{copy.home.colLikes}</th>
                  <th>{copy.home.colModified}</th>
                </tr>
              </thead>
              <tbody>
                <For each={rows}>
                  {(row) => {
                    const href = `/l/${encodeURIComponent(row.name)}`;
                    return (
                      <tr>
                        <td data-col={copy.home.colName}>
                          <a href={href} onClick={(e) => onLinkClick(e, href)}>
                            {row.name}
                          </a>
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
        )}
      </Show>
    </div>
  );
};

export default AuthorPage;
