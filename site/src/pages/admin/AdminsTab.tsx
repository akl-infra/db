import type { Component } from "solid-js";
import { For, Show, createSignal } from "solid-js";
import { copy } from "../../copy.ts";
import { adminAddAdmin, adminListAdmins, adminRemoveAdmin } from "../../api.ts";
import { createAsync } from "../../lib/asyncData.ts";
import AuthorRef from "../../ui/AuthorRef.tsx";

/** Admin console, Admins tab (`GET/POST/DELETE /v1/admin/admins`): list,
 * add, remove. `409 last_admins` on removing the last remaining admin is
 * shown as its own copy line. */
const AdminsTab: Component = () => {
  const [refreshTick, setRefreshTick] = createSignal(0);
  const admins = createAsync(
    () => refreshTick(),
    () => adminListAdmins(),
  );
  const [userId, setUserId] = createSignal("");
  const [note, setNote] = createSignal("");
  const [addPending, setAddPending] = createSignal(false);
  const [addError, setAddError] = createSignal<string | null>(null);
  const [removePending, setRemovePending] = createSignal<string | null>(null);
  const [removeError, setRemoveError] = createSignal<string | null>(null);

  const rows = () => {
    const r = admins.data();
    return r?.ok ? r.data : [];
  };

  async function add(): Promise<void> {
    const id = userId().trim();
    if (!id) return;
    setAddPending(true);
    setAddError(null);
    const result = await adminAddAdmin(id, note().trim() || undefined);
    setAddPending(false);
    if (!result.ok) {
      setAddError(result.message ?? result.error);
      return;
    }
    setUserId("");
    setNote("");
    setRefreshTick((t) => t + 1);
  }

  async function remove(id: string): Promise<void> {
    setRemovePending(id);
    setRemoveError(null);
    const result = await adminRemoveAdmin(id);
    setRemovePending(null);
    if (!result.ok) {
      setRemoveError(result.error === "last_admins" ? copy.admin.admins.lastAdmin : (result.message ?? result.error));
      return;
    }
    setRefreshTick((t) => t + 1);
  }

  return (
    <div>
      <div class="akl-action-row">
        <input type="text" placeholder={copy.admin.admins.userPlaceholder} value={userId()} onInput={(e) => setUserId(e.currentTarget.value)} />
        <input type="text" placeholder={copy.admin.admins.notePlaceholder} value={note()} onInput={(e) => setNote(e.currentTarget.value)} />
        <button class="akl-btn" disabled={addPending() || !userId().trim()} onClick={() => void add()}>
          {copy.admin.admins.addButton}
        </button>
        <Show when={addError()}>{(msg) => <span class="akl-inline-error">{msg()}</span>}</Show>
      </div>

      <Show when={admins.error()}>
        <div class="akl-error">{copy.admin.admins.loadError}</div>
      </Show>
      <Show when={removeError()}>{(msg) => <div class="akl-inline-error">{msg()}</div>}</Show>
      <Show when={!admins.loading() && !admins.error()}>
        <Show when={rows().length > 0} fallback={<div class="akl-empty">{copy.admin.admins.empty}</div>}>
          <table class="akl-table">
            <thead>
              <tr>
                <th>{copy.admin.admins.colUser}</th>
                <th>{copy.admin.admins.colAddedBy}</th>
                <th>{copy.admin.admins.colAddedAt}</th>
                <th>{copy.admin.admins.colNote}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              <For each={rows()}>
                {(row) => (
                  <tr>
                    <td data-col={copy.admin.admins.colUser}>
                      <AuthorRef userId={row.user_id} linked />
                    </td>
                    <td data-col={copy.admin.admins.colAddedBy}>
                      <Show when={row.added_by} fallback="">
                        {(id) => <AuthorRef userId={id()} linked />}
                      </Show>
                    </td>
                    <td data-col={copy.admin.admins.colAddedAt}>{row.added_at}</td>
                    <td data-col={copy.admin.admins.colNote}>{row.note ?? ""}</td>
                    <td>
                      <button class="akl-btn-ghost" disabled={removePending() === row.user_id} onClick={() => void remove(row.user_id)}>
                        {copy.admin.admins.removeButton}
                      </button>
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

export default AdminsTab;
