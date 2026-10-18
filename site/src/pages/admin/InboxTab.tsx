import type { Component } from "solid-js";
import { For, Show, createSignal } from "solid-js";
import { copy } from "../../copy.ts";
import { adminApproveLink, adminApproveWpm, adminRejectLink, adminRejectWpm } from "../../api.ts";
import type { LinkSubmissionStatus } from "../../lib/types.ts";
import { loadInbox, type InboxItem } from "../../lib/inbox.ts";
import { createAsync } from "../../lib/asyncData.ts";
import { loadErrorMessage } from "../../lib/apiError.ts";
import { safeProofLink } from "../../lib/safelink.ts";
import { formatWhen } from "../../lib/time.ts";
import { authorName } from "../../lib/authorNames.ts";
import AuthorRef from "../../ui/AuthorRef.tsx";
import { onLinkClick } from "../../router.ts";

const STATUSES: LinkSubmissionStatus[] = ["pending", "approved", "rejected", "superseded"];

function statusLabel(status: LinkSubmissionStatus): string {
  switch (status) {
    case "pending":
      return copy.admin.inbox.statusPending;
    case "approved":
      return copy.admin.inbox.statusApproved;
    case "rejected":
      return copy.admin.inbox.statusRejected;
    case "superseded":
      return copy.admin.inbox.statusSuperseded;
  }
}

/** A WPM row's proof: the visible text is the hostname and the href is used
 * only if it re-parses as http(s) here (`safeProofLink`), opened in a new
 * tab with `noopener` -- the proof is a stranger's page. */
const ProofLink: Component<{ proof: string }> = (props) => {
  const link = () => safeProofLink(props.proof);
  return (
    <Show when={link()} fallback={<span class="akl-muted">{props.proof}</span>} keyed>
      {(l) => (
        <a href={l.href} target="_blank" rel="noopener" title={l.href}>
          {l.hostname}
        </a>
      )}
    </Show>
  );
};

/** Admin console, Inbox tab (db/docs/adoption.md §10; db decision 28): every
 * submission waiting on a moderator -- layout links and WPM records -- in one
 * list, newest first. Status filter chips keep the history reachable
 * (pending by default). Approve / reject-with-optional-reason inline on a
 * `pending` row; each row's action goes to its own queue. Rows link to the
 * LAYOUT's page by `layout_id` (a ULID, resolves even for a tombstoned
 * layout), never to akl.gg (SITE-12). */
const InboxTab: Component = () => {
  const [status, setStatus] = createSignal<LinkSubmissionStatus>("pending");
  const [refreshTick, setRefreshTick] = createSignal(0);
  const inbox = createAsync(
    () => [status(), refreshTick()] as const,
    ([s]) => loadInbox(s),
  );
  const rows = (): InboxItem[] => {
    const r = inbox.data();
    return r?.ok ? r.data : [];
  };
  const loadError = (): string | null => loadErrorMessage(inbox.data(), copy.admin.inbox.loadError);

  const [pendingId, setPendingId] = createSignal<string | null>(null);
  const [rejectOpenId, setRejectOpenId] = createSignal<string | null>(null);
  const [rejectReason, setRejectReason] = createSignal("");
  const [rowError, setRowError] = createSignal<{ id: string; message: string } | null>(null);

  async function approve(item: InboxItem): Promise<void> {
    setPendingId(item.id);
    const result = item.kind === "link" ? await adminApproveLink(item.id) : await adminApproveWpm(item.id);
    setPendingId(null);
    if (!result.ok) {
      setRowError({ id: item.id, message: result.message ?? result.error });
      return;
    }
    setRowError(null);
    setRefreshTick((t) => t + 1);
  }

  async function reject(item: InboxItem): Promise<void> {
    setPendingId(item.id);
    const reason = rejectReason().trim() || undefined;
    const result = item.kind === "link" ? await adminRejectLink(item.id, reason) : await adminRejectWpm(item.id, reason);
    setPendingId(null);
    if (!result.ok) {
      setRowError({ id: item.id, message: result.message ?? result.error });
      return;
    }
    setRowError(null);
    setRejectOpenId(null);
    setRejectReason("");
    setRefreshTick((t) => t + 1);
  }

  return (
    <div>
      <div class="akl-status-chips">
        <For each={STATUSES}>
          {(s) => (
            <button aria-current={status() === s ? "true" : undefined} onClick={() => setStatus(s)}>
              {statusLabel(s)}
            </button>
          )}
        </For>
      </div>

      <Show when={inbox.error() || loadError()}>
        <div class="akl-error">{loadError() ?? copy.admin.inbox.loadError}</div>
      </Show>
      <Show when={!inbox.loading() && !inbox.error() && !loadError()}>
        <Show when={rows().length > 0} fallback={<div class="akl-empty">{copy.admin.inbox.empty}</div>}>
          <table class="akl-table">
            <thead>
              <tr>
                <th>{copy.admin.inbox.colKind}</th>
                <th>{copy.admin.inbox.colLayout}</th>
                <th>{copy.admin.inbox.colUser}</th>
                <th>{copy.admin.inbox.colDetails}</th>
                <th>{copy.admin.inbox.colSubmittedAt}</th>
                <th>{copy.admin.inbox.colStatus}</th>
                <Show when={status() === "pending"}>
                  <th />
                </Show>
              </tr>
            </thead>
            <tbody>
              <For each={rows()}>
                {(item) => {
                  const layoutHref = `/l/${encodeURIComponent(item.row.layout_id)}`;
                  return (
                    <tr>
                      <td class="akl-nowrap" data-col={copy.admin.inbox.colKind}>{item.kind === "link" ? copy.admin.inbox.kindLink : copy.admin.inbox.kindWpm}</td>
                      <td data-col={copy.admin.inbox.colLayout}>
                        <a href={layoutHref} onClick={(e) => onLinkClick(e, layoutHref)}>
                          {item.row.layout_name}
                        </a>
                      </td>
                      <td data-col={copy.admin.inbox.colUser}>
                        <Show
                          when={item.kind === "wpm" ? item.row : null}
                          fallback={
                            <>
                              <AuthorRef userId={item.row.submitted_by} linked />
                              <Show when={item.kind === "link" ? item.row.submitter_name : null}>{(n) => <span class="akl-muted"> {n()}</span>}</Show>
                            </>
                          }
                          keyed
                        >
                          {(w) => (
                            <>
                              <span>{w.user_name ?? authorName(w.user_id)}</span> <span class="akl-muted">{w.user_id}</span>
                            </>
                          )}
                        </Show>
                      </td>
                      <td data-col={copy.admin.inbox.colDetails}>
                        <Show when={item.kind === "wpm" ? item.row : null} fallback={item.kind === "link" ? item.row.url : ""} keyed>
                          {(w) => (
                            <>
                              <strong>{copy.admin.inbox.wpmValue(w.wpm)}</strong> <ProofLink proof={w.proof} />
                            </>
                          )}
                        </Show>
                      </td>
                      <td class="akl-nowrap" data-col={copy.admin.inbox.colSubmittedAt} title={item.submitted_at}>
                        {formatWhen(item.submitted_at)}
                      </td>
                      <td class="akl-nowrap" data-col={copy.admin.inbox.colStatus}>
                        {statusLabel(item.status)}
                        <Show when={item.status !== "pending" && item.row.decided_at}>
                          {(at) => (
                            <div class="akl-muted">
                              {copy.admin.inbox.decidedBy} <Show when={item.row.decided_by}>{(who) => <AuthorRef userId={who()} />}</Show>{" "}
                              <span title={at()}>{formatWhen(at())}</span>
                            </div>
                          )}
                        </Show>
                        <Show when={item.status !== "pending" ? item.row.reason : null}>
                          {(reason) => (
                            <div class="akl-muted">
                              {copy.admin.inbox.reasonLabel}: {reason()}
                            </div>
                          )}
                        </Show>
                      </td>
                      <Show when={status() === "pending"}>
                      <td>
                        <Show when={item.status === "pending"}>
                          <div class="akl-action-row">
                            <button class="akl-btn" disabled={pendingId() === item.id} onClick={() => void approve(item)}>
                              {copy.admin.inbox.approve}
                            </button>
                            <Show
                              when={rejectOpenId() === item.id}
                              fallback={
                                <button class="akl-btn-ghost" disabled={pendingId() === item.id} onClick={() => setRejectOpenId(item.id)}>
                                  {copy.admin.inbox.reject}
                                </button>
                              }
                            >
                              <input
                                type="text"
                                placeholder={copy.admin.inbox.rejectReasonPrompt}
                                value={rejectReason()}
                                onInput={(e) => setRejectReason(e.currentTarget.value)}
                              />
                              <button class="akl-btn akl-btn-danger" disabled={pendingId() === item.id} onClick={() => void reject(item)}>
                                {copy.actions.confirm}
                              </button>
                              <button class="akl-btn-ghost" onClick={() => setRejectOpenId(null)}>
                                {copy.actions.cancel}
                              </button>
                            </Show>
                          </div>
                        </Show>
                        <Show when={rowError()?.id === item.id}>
                          <span class="akl-inline-error">{rowError()?.message}</span>
                        </Show>
                      </td>
                      </Show>
                    </tr>
                  );
                }}
              </For>
            </tbody>
          </table>
        </Show>
      </Show>
    </div>
  );
};

export default InboxTab;
