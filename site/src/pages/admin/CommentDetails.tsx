import type { Component } from "solid-js";
import { For, Show, createMemo, createSignal } from "solid-js";
import { copy } from "../../copy.ts";
import type { CommentQueueRow } from "../../lib/types.ts";
import { clampParts, diffWords, sideOf, type DiffPart } from "../../lib/wordDiff.ts";

/** An edit: the user already has an approved comment (`live_body`) and sent a
 * new text. */
export function isCommentEdit(row: CommentQueueRow): boolean {
  return row.live_body !== null && row.body !== null && row.live_body !== row.body;
}

/** A changed part that is only line breaks: drawn with a pilcrow so the change
 * is visible (whitespace alone has nothing to colour). */
function isBreak(text: string): boolean {
  return /^[\r\n]+$/.test(text);
}

/** One block of comment text: whole text, long text clamped behind "Read all"
 * (a mark is never hidden, see `clampParts`). Rendered as text nodes with the
 * line breaks kept, never as markup. `mark` says how a changed part is drawn:
 * struck red in the Current block, green in the Proposed one. */
const TextBlock: Component<{ parts: DiffPart[]; label?: string }> = (props) => {
  const [open, setOpen] = createSignal(false);
  const clamped = createMemo(() => clampParts(props.parts));
  const shown = () => (open() ? props.parts : (clamped() ?? props.parts));
  return (
    <div class="akl-comment-block">
      <Show when={props.label}>{(l) => <div class="akl-comment-label">{l()}</div>}</Show>
      <p class="akl-comment-text">
        <For each={shown()}>
          {(part) => (
            <>
              <Show when={part.op === "eq"}>
                <span>{part.text}</span>
              </Show>
              <Show when={part.op === "del"}>
                <del>
                  <Show when={isBreak(part.text)}>
                    <span class="akl-nl" aria-hidden="true">¶</span>
                  </Show>
                  {part.text}
                </del>
              </Show>
              <Show when={part.op === "ins"}>
                <ins>
                  <Show when={isBreak(part.text)}>
                    <span class="akl-nl" aria-hidden="true">¶</span>
                  </Show>
                  {part.text}
                </ins>
              </Show>
            </>
          )}
        </For>
        <Show when={!open() && clamped() !== null}>…</Show>
      </p>
      <Show when={clamped() !== null}>
        <button type="button" class="akl-comment-more" aria-expanded={open() ? "true" : "false"} onClick={() => setOpen(!open())}>
          {open() ? copy.admin.inbox.readLess : copy.admin.inbox.readAll}
        </button>
      </Show>
    </div>
  );
};

/** The Inbox's comment text (db decision 29), shown on its own full-width
 * line under the row's metadata, at a readable measure. A first comment is
 * one block; an edit is two stacked blocks, "Current" (deletions marked) and
 * "Proposed" (insertions marked), each the whole text. */
const CommentDetails: Component<{ row: CommentQueueRow }> = (props) => {
  const parts = createMemo(() => (isCommentEdit(props.row) ? diffWords(props.row.live_body!, props.row.body!) : []));
  return (
    <div class="akl-comment-body">
      <Show when={props.row.body !== null} fallback={<p class="akl-comment-text akl-muted">{copy.admin.inbox.commentErased}</p>}>
        <Show when={isCommentEdit(props.row)} fallback={<TextBlock parts={[{ op: "eq", text: props.row.body! }]} />}>
          <TextBlock label={copy.admin.inbox.commentCurrent} parts={sideOf(parts(), "current")} />
          <TextBlock label={copy.admin.inbox.commentProposed} parts={sideOf(parts(), "proposed")} />
        </Show>
      </Show>
    </div>
  );
};

export default CommentDetails;
