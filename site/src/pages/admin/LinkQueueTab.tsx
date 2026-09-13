import type { Component } from "solid-js";
import { For, Show, createSignal } from "solid-js";
import { copy } from "../../copy.ts";
import { adminApproveLink, adminLinkQueue, adminRejectLink } from "../../api.ts";
import type { LinkSubmission, LinkSubmissionStatus } from "../../lib/types.ts";
import { createAsync } from "../../lib/asyncData.ts";
import AuthorRef from "../../ui/AuthorRef.tsx";
import { onLinkClick } from "../../router.ts";

const STATUSES: LinkSubmissionStatus[] = ["pending", "approved", "rejected", "superseded"];

function statusLabel(status: LinkSubmissionStatus): string {
  switch (status) {
    case "pending":
      return copy.admin.linkQueue.statusPending;
    case "approved":
      return copy.admin.linkQueue.statusApproved;
    case "rejected":
      return copy.admin.linkQueue.statusRejected;
    case "superseded":
      return copy.admin.linkQueue.statusSuperseded;
  }
}

/** Admin console, Link queue tab (db/docs/adoption.md §10): status filter
 * chips, approve/reject-with-reason on a `pending` row, a link back to the
 * layout (by `layout_id` -- a ULID, resolves even for a tombstoned
 * layout). Linking to the SUBMITTER's own layout page here, never to
 * akl.gg (SITE-12). */
const LinkQueueTab: Component = () => {
  const [status, setStatus] = createSignal<LinkSubmissionStatus>("pending");
  const [refreshTick, setRefreshTick] = createSignal(0);
  const queue = createAsync(
    () => [status(), refreshTick()] as const,
    ([s]) => adminLinkQueue(s),
  );
  const rows = (): LinkSubmission[] => {
    const r = queue.data();
    return r?.ok ? r.data.submissions : [];
  };

  const [pendingId, setPendingId] = createSignal<string | null>(null);
  const [rejectOpenId, setRejectOpenId] = createSignal<string | null>(null);
  const [rejectReason, setRejectReason] = createSignal("");
  const [rowError, setRowError] = createSignal<{ id: string; message: string } | null>(null);

  async function approve(id: string): Promise<void> {
    setPendingId(id);
    const result = await adminApproveLink(id);
    setPendingId(null);
    if (!result.ok) {
      setRowError({ id, message: result.message ?? result.error });
      return;
    }
    setRowError(null);
    setRefreshTick((t) => t + 1);
  }

  async function reject(id: string): Promise<void> {
    setPendingId(id);
    const result = await adminRejectLink(id, rejectReason().trim() || undefined);
    setPendingId(null);
    if (!result.ok) {
      setRowError({ id, message: result.message ?? result.error });
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

      <Show when={queue.error()}>
        <div class="akl-error">{copy.admin.linkQueue.loadError}</div>
      </Show>
      <Show when={!queue.loading() && !queue.error()}>
        <Show when={rows().length > 0} fallback={<div class="akl-empty">{copy.admin.linkQueue.empty}</div>}>
          <table class="akl-table">
            <thead>
              <tr>
                <th>{copy.admin.linkQueue.colUrl}</th>
                <th>{copy.admin.linkQueue.colLayout}</th>
                <th>{copy.admin.linkQueue.colSubmittedBy}</th>
                <th>{copy.admin.linkQueue.colSubmittedAt}</th>
                <th>{copy.admin.linkQueue.colStatus}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              <For each={rows()}>
                {(sub) => {
                  const layoutHref = `/l/${encodeURIComponent(sub.layout_id)}`;
                  return (
                    <tr>
                      <td data-col={copy.admin.linkQueue.colUrl}>{sub.url}</td>
                      <td data-col={copy.admin.linkQueue.colLayout}>
                        <a href={layoutHref} onClick={(e) => onLinkClick(e, layoutHref)}>
                          {sub.layout_id}
                        </a>
                      </td>
                      <td data-col={copy.admin.linkQueue.colSubmittedBy}>
                        <AuthorRef userId={sub.submitted_by} linked />
                      </td>
                      <td data-col={copy.admin.linkQueue.colSubmittedAt}>{sub.submitted_at}</td>
                      <td data-col={copy.admin.linkQueue.colStatus}>{statusLabel(sub.status)}</td>
                      <td>
                        <Show when={sub.status === "pending"}>
                          <div class="akl-action-row">
                            <button class="akl-btn" disabled={pendingId() === sub.id} onClick={() => void approve(sub.id)}>
                              {copy.admin.linkQueue.approve}
                            </button>
                            <Show
                              when={rejectOpenId() === sub.id}
                              fallback={
                                <button class="akl-btn-ghost" disabled={pendingId() === sub.id} onClick={() => setRejectOpenId(sub.id)}>
                                  {copy.admin.linkQueue.reject}
                                </button>
                              }
                            >
                              <input
                                type="text"
                                placeholder={copy.admin.linkQueue.rejectReasonPrompt}
                                value={rejectReason()}
                                onInput={(e) => setRejectReason(e.currentTarget.value)}
                              />
                              <button class="akl-btn akl-btn-danger" disabled={pendingId() === sub.id} onClick={() => void reject(sub.id)}>
                                {copy.actions.confirm}
                              </button>
                              <button class="akl-btn-ghost" onClick={() => setRejectOpenId(null)}>
                                {copy.actions.cancel}
                              </button>
                            </Show>
                          </div>
                        </Show>
                        <Show when={rowError()?.id === sub.id}>
                          <span class="akl-inline-error">{rowError()?.message}</span>
                        </Show>
                      </td>
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

export default LinkQueueTab;
