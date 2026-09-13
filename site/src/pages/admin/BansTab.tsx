import type { Component } from "solid-js";
import { For, Show, createSignal } from "solid-js";
import { copy } from "../../copy.ts";
import { adminBanUser, adminListBans, adminUnbanUser } from "../../api.ts";
import type { BanRow } from "../../lib/types.ts";
import { createAsync } from "../../lib/asyncData.ts";
import AuthorRef from "../../ui/AuthorRef.tsx";

/** Admin console, Bans tab (db/docs/adoption.md §10): list, ban with an
 * optional reason, unban. `409 cannot_ban_admin` is shown verbatim as its
 * own copy line -- an admin can never be banned, by rule. */
const BansTab: Component = () => {
  const [refreshTick, setRefreshTick] = createSignal(0);
  const bans = createAsync(
    () => refreshTick(),
    () => adminListBans(),
  );
  const [userId, setUserId] = createSignal("");
  const [reason, setReason] = createSignal("");
  const [banPending, setBanPending] = createSignal(false);
  const [banError, setBanError] = createSignal<string | null>(null);
  const [unbanPending, setUnbanPending] = createSignal<string | null>(null);

  const rows = (): BanRow[] => {
    const r = bans.data();
    return r?.ok ? r.data.bans : [];
  };

  async function ban(): Promise<void> {
    const id = userId().trim();
    if (!id) return;
    setBanPending(true);
    setBanError(null);
    const result = await adminBanUser(id, reason().trim() || undefined);
    setBanPending(false);
    if (!result.ok) {
      setBanError(result.error === "cannot_ban_admin" ? copy.admin.bans.cannotBanAdmin : (result.message ?? result.error));
      return;
    }
    setUserId("");
    setReason("");
    setRefreshTick((t) => t + 1);
  }

  async function unban(id: string): Promise<void> {
    setUnbanPending(id);
    await adminUnbanUser(id);
    setUnbanPending(null);
    setRefreshTick((t) => t + 1);
  }

  return (
    <div>
      <div class="akl-action-row">
        <input type="text" placeholder={copy.admin.bans.userPlaceholder} value={userId()} onInput={(e) => setUserId(e.currentTarget.value)} />
        <input type="text" placeholder={copy.admin.bans.reasonPlaceholder} value={reason()} onInput={(e) => setReason(e.currentTarget.value)} />
        <button class="akl-btn akl-btn-danger" disabled={banPending() || !userId().trim()} onClick={() => void ban()}>
          {copy.admin.bans.banButton}
        </button>
        <Show when={banError()}>{(msg) => <span class="akl-inline-error">{msg()}</span>}</Show>
      </div>

      <Show when={bans.error()}>
        <div class="akl-error">{copy.admin.bans.loadError}</div>
      </Show>
      <Show when={!bans.loading() && !bans.error()}>
        <Show when={rows().length > 0} fallback={<div class="akl-empty">{copy.admin.bans.empty}</div>}>
          <table class="akl-table">
            <thead>
              <tr>
                <th>{copy.admin.bans.colUser}</th>
                <th>{copy.admin.bans.colBy}</th>
                <th>{copy.admin.bans.colAt}</th>
                <th>{copy.admin.bans.colReason}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              <For each={rows()}>
                {(row) => (
                  <tr>
                    <td data-col={copy.admin.bans.colUser}>
                      <AuthorRef userId={row.user_id} linked />
                    </td>
                    <td data-col={copy.admin.bans.colBy}>
                      <AuthorRef userId={row.by} linked />
                    </td>
                    <td data-col={copy.admin.bans.colAt}>{row.at}</td>
                    <td data-col={copy.admin.bans.colReason}>{row.reason ?? ""}</td>
                    <td>
                      <button class="akl-btn-ghost" disabled={unbanPending() === row.user_id} onClick={() => void unban(row.user_id)}>
                        {copy.admin.bans.unbanButton}
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

export default BansTab;
