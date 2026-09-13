import type { Component } from "solid-js";
import { For, Show, createSignal } from "solid-js";
import { copy } from "../../copy.ts";
import { adminListClients, adminReactivateClient, adminRevokeClient, adminSuspendClient, getMetaHealthClients } from "../../api.ts";
import type { ApiResult } from "../../api.ts";
import type { ClientStatus } from "../../lib/types.ts";
import { createAsync } from "../../lib/asyncData.ts";
import { loadErrorMessage } from "../../lib/apiError.ts";
import { sortAndMergeClients, type ClientsData, type ClientTableRow } from "../../lib/clients.ts";
import AuthorRef from "../../ui/AuthorRef.tsx";

function statusLabel(status: ClientStatus): string {
  switch (status) {
    case "active":
      return copy.admin.clients.statusActive;
    case "suspended":
      return copy.admin.clients.statusSuspended;
    case "revoked":
      return copy.admin.clients.statusRevoked;
  }
}

/** Admin console, Clients tab (LDB-A10..A14 "rogue trusted client"
 * hardening, `db/INVARIANTS.md`): every registered client, its status, and
 * the moderation actions on it. `GET /v1/admin/clients` itself carries no
 * `suspended_at`/`reason` (`ClientRow`'s own comment) -- those come from
 * the PUBLIC `GET /v1/meta`'s `health.clients.suspended` and are merged in
 * here by id. No revert UI in this slice (follow-up); no link to the
 * Changes/event-log page either -- it has no actor/source filter to link
 * into (`pages/Changes.tsx`).
 *
 * LDB-A14: the destructive-write budget/threshold that trips an automatic
 * suspension is NEVER fetched, computed, or shown anywhere in this
 * component -- only the fact and reason of a suspension, exactly what
 * `health.clients.suspended` already makes public. */
const ClientsTab: Component = () => {
  const [refreshTick, setRefreshTick] = createSignal(0);
  const clients = createAsync(
    () => refreshTick(),
    async (): Promise<ApiResult<ClientsData>> => {
      const [c, h] = await Promise.all([adminListClients(), getMetaHealthClients()]);
      if (!c.ok) return c;
      // A failed health fetch degrades to "no suspended detail" rather than
      // failing the whole tab -- the client list itself (status included)
      // still renders from the admin-only route either way.
      return { ok: true, data: { clients: c.data, suspended: h.ok ? h.data.suspended : [] } };
    },
  );

  const rows = (): ClientTableRow[] => {
    const r = clients.data();
    return r?.ok ? sortAndMergeClients(r.data) : [];
  };
  const loadError = (): string | null => loadErrorMessage(clients.data(), copy.admin.clients.loadError);

  const [actionPending, setActionPending] = createSignal<string | null>(null);
  const [rowError, setRowError] = createSignal<{ id: string; message: string } | null>(null);
  const [suspendOpenId, setSuspendOpenId] = createSignal<string | null>(null);
  const [suspendReason, setSuspendReason] = createSignal("");
  const [revokeOpenId, setRevokeOpenId] = createSignal<string | null>(null);

  function closeRowUi(id: string): void {
    if (suspendOpenId() === id) {
      setSuspendOpenId(null);
      setSuspendReason("");
    }
    if (revokeOpenId() === id) setRevokeOpenId(null);
  }

  async function reactivate(id: string): Promise<void> {
    setActionPending(id);
    const result = await adminReactivateClient(id);
    setActionPending(null);
    if (!result.ok) {
      setRowError({ id, message: result.error === "client_already_revoked" ? copy.admin.clients.clientAlreadyRevoked : (result.message ?? result.error) });
      return;
    }
    setRowError(null);
    closeRowUi(id);
    setRefreshTick((t) => t + 1);
  }

  async function suspend(id: string): Promise<void> {
    setActionPending(id);
    const result = await adminSuspendClient(id, suspendReason().trim() || undefined);
    setActionPending(null);
    if (!result.ok) {
      setRowError({ id, message: result.error === "client_already_revoked" ? copy.admin.clients.clientAlreadyRevoked : (result.message ?? result.error) });
      return;
    }
    setRowError(null);
    closeRowUi(id);
    setRefreshTick((t) => t + 1);
  }

  async function revoke(id: string): Promise<void> {
    setActionPending(id);
    const result = await adminRevokeClient(id);
    setActionPending(null);
    if (!result.ok) {
      setRowError({ id, message: result.message ?? result.error });
      return;
    }
    setRowError(null);
    closeRowUi(id);
    setRefreshTick((t) => t + 1);
  }

  return (
    <div>
      <Show when={clients.error() || loadError()}>
        <div class="akl-error">{loadError() ?? copy.admin.clients.loadError}</div>
      </Show>
      <Show when={!clients.loading() && !clients.error() && !loadError()}>
        <Show when={rows().length > 0} fallback={<div class="akl-empty">{copy.admin.clients.empty}</div>}>
          <table class="akl-table">
            <thead>
              <tr>
                <th>{copy.admin.clients.colClient}</th>
                <th>{copy.admin.clients.colOwner}</th>
                <th>{copy.admin.clients.colCaps}</th>
                <th>{copy.admin.clients.colStatus}</th>
                <th>{copy.admin.clients.colSuspended}</th>
                <th>{copy.admin.clients.colRevoked}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              <For each={rows()}>
                {({ client, suspendedInfo }) => (
                  <tr class={client.status === "suspended" ? "akl-row-suspended" : undefined}>
                    <td data-col={copy.admin.clients.colClient} title={client.id}>
                      {client.name}
                    </td>
                    <td data-col={copy.admin.clients.colOwner}>
                      <AuthorRef userId={client.owner_user_id} linked />
                    </td>
                    <td data-col={copy.admin.clients.colCaps}>{client.caps}</td>
                    <td data-col={copy.admin.clients.colStatus}>{statusLabel(client.status)}</td>
                    <td data-col={copy.admin.clients.colSuspended}>
                      <Show when={suspendedInfo}>
                        {(s) => (
                          <>
                            <Show when={s().at}>{(at) => <div>{copy.admin.clients.suspendedAt(at())}</div>}</Show>
                            <Show when={s().reason}>{(reason) => <div class="akl-muted">{reason()}</div>}</Show>
                          </>
                        )}
                      </Show>
                    </td>
                    <td data-col={copy.admin.clients.colRevoked}>
                      <Show when={client.status === "revoked"}>{client.revoked_at}</Show>
                    </td>
                    <td>
                      <div class="akl-action-row">
                        <Show when={client.status === "suspended"}>
                          <button class="akl-btn" disabled={actionPending() === client.id} onClick={() => void reactivate(client.id)}>
                            {copy.admin.clients.reactivateButton}
                          </button>
                        </Show>
                        <Show when={client.status === "active"}>
                          <Show
                            when={suspendOpenId() === client.id}
                            fallback={
                              <button class="akl-btn-ghost" disabled={actionPending() === client.id} onClick={() => setSuspendOpenId(client.id)}>
                                {copy.admin.clients.suspendButton}
                              </button>
                            }
                          >
                            <input
                              type="text"
                              placeholder={copy.admin.bans.reasonPlaceholder}
                              value={suspendReason()}
                              onInput={(e) => setSuspendReason(e.currentTarget.value)}
                            />
                            <button class="akl-btn akl-btn-danger" disabled={actionPending() === client.id} onClick={() => void suspend(client.id)}>
                              {copy.actions.confirm}
                            </button>
                            <button class="akl-btn-ghost" disabled={actionPending() === client.id} onClick={() => closeRowUi(client.id)}>
                              {copy.actions.cancel}
                            </button>
                          </Show>
                        </Show>
                        <Show when={client.status !== "revoked"}>
                          <Show
                            when={revokeOpenId() === client.id}
                            fallback={
                              <button class="akl-btn-ghost" disabled={actionPending() === client.id} onClick={() => setRevokeOpenId(client.id)}>
                                {copy.admin.clients.revokeButton}
                              </button>
                            }
                          >
                            <span>
                              {copy.actions.confirm}? {copy.admin.clients.revokeConfirmNotice}
                            </span>
                            <button class="akl-btn akl-btn-danger" disabled={actionPending() === client.id} onClick={() => void revoke(client.id)}>
                              {copy.admin.clients.revokeButton}
                            </button>
                            <button class="akl-btn-ghost" disabled={actionPending() === client.id} onClick={() => closeRowUi(client.id)}>
                              {copy.actions.cancel}
                            </button>
                          </Show>
                        </Show>
                      </div>
                      <Show when={rowError()?.id === client.id}>
                        <span class="akl-inline-error">{rowError()?.message}</span>
                      </Show>
                    </td>
                  </tr>
                )}
              </For>
            </tbody>
          </table>
        </Show>
      </Show>
    </div>
  );
};

export default ClientsTab;
