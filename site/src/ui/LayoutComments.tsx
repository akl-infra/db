import type { Component } from "solid-js";
import { For, Show, createSignal } from "solid-js";
import { copy } from "../copy.ts";
import { adminRemoveComment, getComments } from "../api.ts";
import type { PublicComment } from "../lib/types.ts";
import { createAsync } from "../lib/asyncData.ts";
import { formatWhen } from "../lib/time.ts";
import { loadErrorMessage } from "../lib/apiError.ts";
import AuthorRef from "./AuthorRef.tsx";

/** The approved comments on a layout (db decision 29), read-only for
 * everyone; the site never writes a comment (clients do, over the API). An
 * admin additionally sees Remove on each: it asks for a reason in place
 * (never a browser dialog, SITE-15), then takes the comment down -- the
 * reason is kept for its author. */
export const CommentList: Component<{ comments: PublicComment[]; isAdmin: boolean; onRemoved: () => void }> = (props) => {
  const [removeOpenId, setRemoveOpenId] = createSignal<string | null>(null);
  const [reason, setReason] = createSignal("");
  const [pendingId, setPendingId] = createSignal<string | null>(null);
  const [rowError, setRowError] = createSignal<{ id: string; message: string } | null>(null);

  async function remove(id: string): Promise<void> {
    setPendingId(id);
    const result = await adminRemoveComment(id, reason().trim() || undefined);
    setPendingId(null);
    if (!result.ok) {
      setRowError({ id, message: result.message ?? result.error });
      return;
    }
    setRowError(null);
    setRemoveOpenId(null);
    setReason("");
    props.onRemoved();
  }

  return (
    <ul class="akl-comments">
      <For each={props.comments}>
        {(c) => (
          <li class="akl-comment">
            <div class="akl-comment-meta">
              <AuthorRef userId={c.user_id} linked />
              <span title={c.approved_at}>{formatWhen(c.approved_at)}</span>
              <span class="akl-comment-likes">{copy.layout.commentLikes(c.likes)}</span>
              <Show when={c.is_author}>
                <span class="akl-badge">{copy.layout.commentAuthor}</span>
              </Show>
              <Show when={c.edited}>
                <span class="akl-badge">{copy.layout.commentEdited}</span>
              </Show>
            </div>
            <p class="akl-comment-text">{c.body}</p>
            <Show when={props.isAdmin}>
              <div class="akl-action-row">
                <Show
                  when={removeOpenId() === c.id}
                  fallback={
                    <button type="button" class="akl-btn-ghost" onClick={() => setRemoveOpenId(c.id)}>
                      {copy.layout.commentRemove}
                    </button>
                  }
                >
                  <input type="text" placeholder={copy.layout.commentRemoveReasonPrompt} value={reason()} onInput={(e) => setReason(e.currentTarget.value)} />
                  <button type="button" class="akl-btn akl-btn-danger" disabled={pendingId() === c.id} onClick={() => void remove(c.id)}>
                    {copy.layout.commentRemoveConfirm}
                  </button>
                  <button type="button" class="akl-btn-ghost" onClick={() => setRemoveOpenId(null)}>
                    {copy.actions.cancel}
                  </button>
                </Show>
                <Show when={rowError()?.id === c.id}>
                  <span class="akl-inline-error">{rowError()?.message}</span>
                </Show>
              </div>
            </Show>
          </li>
        )}
      </For>
    </ul>
  );
};

const LayoutComments: Component<{ layoutId: string; isAdmin: boolean }> = (props) => {
  const [tick, setTick] = createSignal(0);
  const loaded = createAsync(
    () => [props.layoutId, tick()] as const,
    ([id]) => getComments(id),
  );
  const comments = (): PublicComment[] => {
    const r = loaded.data();
    return r?.ok ? r.data.comments : [];
  };
  const loadError = (): string | null => loadErrorMessage(loaded.data(), copy.layout.commentsLoadError);

  return (
    <section>
      <h2>{copy.layout.commentsTitle}</h2>
      <Show when={loaded.error() || loadError()}>
        <div class="akl-error">{loadError() ?? copy.layout.commentsLoadError}</div>
      </Show>
      <Show when={!loaded.loading() && !loaded.error() && !loadError()}>
        <Show when={comments().length > 0} fallback={<div class="akl-empty">{copy.layout.commentsEmpty}</div>}>
          <CommentList comments={comments()} isAdmin={props.isAdmin} onRemoved={() => setTick((t) => t + 1)} />
        </Show>
      </Show>
    </section>
  );
};

export default LayoutComments;
