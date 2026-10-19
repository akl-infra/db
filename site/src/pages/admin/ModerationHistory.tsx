import type { Component } from "solid-js";
import { For, Show, createSignal } from "solid-js";
import { adminCommentHistory, adminWpmHistory } from "../../api.ts";
import { copy } from "../../copy.ts";
import type { ModerationHistoryEntry } from "../../lib/types.ts";
import { formatWhen } from "../../lib/time.ts";
import AuthorRef from "../../ui/AuthorRef.tsx";

export const HistoryEntries: Component<{ entries: ModerationHistoryEntry[] }> = (props) => (
  <Show when={props.entries.length > 0} fallback={<p class="akl-muted">{copy.admin.inbox.historyEmpty}</p>}>
    <ol class="akl-review-history-list">
      <For each={props.entries}>
        {(entry) => (
          <li>
            {entry.action === "reopened" ? copy.admin.inbox.historyReopened : entry.action === "approved" ? copy.admin.inbox.statusApproved : copy.admin.inbox.statusRejected}
            {" · "}<AuthorRef userId={entry.actor} />{" · "}<span title={entry.at}>{formatWhen(entry.at)}</span>
            <Show when={entry.reason}>{(reason) => <div class="akl-muted">{reason()}</div>}</Show>
          </li>
        )}
      </For>
    </ol>
  </Show>
);

/** Load private history only when requested, never via the public event feed. */
const ModerationHistory: Component<{ kind: "comment" | "wpm"; id: string }> = (props) => {
  const [entries, setEntries] = createSignal<ModerationHistoryEntry[] | null>(null);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  async function load(): Promise<void> {
    if (busy()) return;
    setBusy(true);
    setError(null);
    const result = props.kind === "comment" ? await adminCommentHistory(props.id) : await adminWpmHistory(props.id);
    if (result.ok) setEntries(result.data.history);
    else setError(result.message ?? copy.admin.inbox.historyLoadError);
    setBusy(false);
  }

  return (
    <details class="akl-review-history" onToggle={(event) => { if (event.currentTarget.open && entries() === null) void load(); }}>
      <summary>{copy.admin.inbox.history}</summary>
      <Show when={busy()}><p class="akl-muted">{copy.admin.inbox.loading}</p></Show>
      <Show when={error()}>
        <div class="akl-inline-error" role="alert">{error()}{" "}<button class="akl-btn-ghost" onClick={() => void load()}>{copy.admin.inbox.refresh}</button></div>
      </Show>
      <Show when={entries()} keyed>{(history) => <HistoryEntries entries={history} />}</Show>
    </details>
  );
};

export default ModerationHistory;
