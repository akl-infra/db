import type { Component } from "solid-js";
import { Show, createSignal } from "solid-js";
import { adminReopenComment, adminReopenWpm } from "../../api.ts";
import { copy } from "../../copy.ts";
import type { InboxItem } from "../../lib/inbox.ts";

export function canReopen(item: InboxItem): boolean {
  return item.kind !== "link" && (item.status === "approved" || item.status === "rejected") &&
    (item.kind !== "comment" || item.row.body !== null);
}

/** Approved content needs an explicit confirmation before being hidden. */
export const ReopenConfirmation: Component<{ kind: "comment" | "wpm"; busy: boolean; onConfirm: () => void; onCancel: () => void }> = (props) => (
  <div class="akl-reopen-confirm">
    <p>{props.kind === "comment" ? copy.admin.inbox.reopenCommentConfirm : copy.admin.inbox.reopenWpmConfirm}</p>
    <div class="akl-action-row">
      <button class="akl-btn" disabled={props.busy} onClick={props.onConfirm}>{copy.admin.inbox.reopen}</button>
      <button class="akl-btn-ghost" disabled={props.busy} onClick={props.onCancel}>{copy.actions.cancel}</button>
    </div>
  </div>
);

const ReopenReview: Component<{ item: InboxItem; onReopened: () => void; onRefresh: () => void }> = (props) => {
  const [confirming, setConfirming] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  async function reopen(): Promise<void> {
    const item = props.item;
    if (busy() || item.kind === "link" || (item.status !== "approved" && item.status !== "rejected") || !canReopen(item)) return;
    setBusy(true);
    setError(null);
    const result = item.kind === "comment"
      ? await adminReopenComment(item.id, item.status, item.row.review_version ?? 0)
      : await adminReopenWpm(item.id, item.status, item.row.review_version ?? 0);
    setBusy(false);
    if (!result.ok) {
      setError(result.error === "review_conflict" ? copy.admin.inbox.reviewConflict : result.message ?? result.error);
      return;
    }
    props.onReopened();
  }

  return (
    <Show when={canReopen(props.item)}>
      <Show when={confirming()} fallback={
        <button class="akl-btn-ghost" disabled={busy()} onClick={() => props.item.status === "approved" ? setConfirming(true) : void reopen()}>
          {copy.admin.inbox.reopen}
        </button>
      }>
        <ReopenConfirmation kind={props.item.kind === "comment" ? "comment" : "wpm"} busy={busy()} onConfirm={() => void reopen()} onCancel={() => { setConfirming(false); setError(null); }} />
      </Show>
      <Show when={error()}>
        <div class="akl-inline-error" role="alert">
          {error()}{" "}<button class="akl-btn-ghost" disabled={busy()} onClick={props.onRefresh}>{copy.admin.inbox.refresh}</button>
        </div>
      </Show>
    </Show>
  );
};

export default ReopenReview;
