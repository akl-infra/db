import type { Component } from "solid-js";
import { For, Show, createMemo, createSignal } from "solid-js";
import { copy } from "../../copy.ts";
import type { CommentQueueRow } from "../../lib/types.ts";
import { collapsedPreview, diffWords } from "../../lib/wordDiff.ts";

/** The Inbox's "Details" cell for a comment (db decision 29). A user's first
 * comment shows its whole text, a long one collapsed behind "Read all"; an
 * edit (the user already has an approved comment, `live_body`) shows the
 * word-level diff of that live text to the pending one -- deletions red,
 * insertions green -- so a moderator sees what changed. The text is always
 * rendered as a text node (never markup) with its line breaks kept. */
const CommentDetails: Component<{ row: CommentQueueRow }> = (props) => {
  const [open, setOpen] = createSignal(false);
  const isEdit = () => props.row.live_body !== null && props.row.body !== null;
  const parts = createMemo(() => (isEdit() ? diffWords(props.row.live_body!, props.row.body!) : []));
  const preview = createMemo(() => (props.row.body === null ? null : collapsedPreview(props.row.body)));

  return (
    <div>
      <span class="akl-badge">{isEdit() ? copy.admin.inbox.commentEdit : copy.admin.inbox.commentNew}</span>
      <Show when={props.row.body !== null} fallback={<p class="akl-comment-text akl-muted">{copy.admin.inbox.commentErased}</p>}>
        <Show
          when={isEdit()}
          fallback={
            <>
              <p class="akl-comment-text">{open() || preview() === null ? props.row.body : `${preview()}…`}</p>
              <Show when={preview() !== null}>
                <button type="button" class="akl-comment-more" aria-expanded={open() ? "true" : "false"} onClick={() => setOpen(!open())}>
                  {open() ? copy.admin.inbox.readLess : copy.admin.inbox.readAll}
                </button>
              </Show>
            </>
          }
        >
          <p class="akl-comment-text">
            <For each={parts()}>
              {(part) => (
                <>
                  <Show when={part.op === "eq"}>
                    <span>{part.text}</span>
                  </Show>
                  <Show when={part.op === "del"}>
                    <del>{part.text}</del>
                  </Show>
                  <Show when={part.op === "ins"}>
                    <ins>{part.text}</ins>
                  </Show>
                </>
              )}
            </For>
          </p>
        </Show>
      </Show>
    </div>
  );
};

export default CommentDetails;
