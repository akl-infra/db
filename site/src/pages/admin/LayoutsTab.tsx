import type { Component } from "solid-js";
import { Show, createSignal } from "solid-js";
import { copy } from "../../copy.ts";
import { getLayout } from "../../api.ts";
import type { LayoutRecord } from "../../lib/types.ts";
import OwnerActions from "../../ui/OwnerActions.tsx";

/** Admin console, Layouts tab: search a layout by name or id, then the
 * SAME action set `pages/Layout.tsx` gives an owner (rename/transfer/
 * delete/restore/link) -- `OwnerActions`'s `isAdmin` prop only changes the
 * link copy (an admin's own submit is approved immediately). No like/
 * unlike here -- `liked` stays `undefined`, same as a signed-out visitor,
 * since an admin managing someone else's layout from this console isn't
 * liking it. saltorbit, 2026-09-13: admins do NOT get a like-count override --
 * likes are always per-user rows, no exceptions. */
const LayoutsTab: Component = () => {
  const [query, setQuery] = createSignal("");
  const [record, setRecord] = createSignal<LayoutRecord | undefined>(undefined);
  const [error, setError] = createSignal<string | null>(null);
  const [loading, setLoading] = createSignal(false);

  async function search(ref: string): Promise<void> {
    if (!ref) return;
    setLoading(true);
    setError(null);
    const result = await getLayout(ref);
    setLoading(false);
    if (!result.ok) {
      setRecord(undefined);
      setError(result.status === 404 ? copy.admin.layouts.notFound : (result.message ?? copy.admin.layouts.loadError));
      return;
    }
    setRecord(result.data);
  }

  return (
    <div>
      <div class="akl-action-row">
        <input
          type="text"
          placeholder={copy.admin.layouts.searchPlaceholder}
          value={query()}
          onInput={(e) => setQuery(e.currentTarget.value)}
        />
        <button class="akl-btn" disabled={loading() || !query().trim()} onClick={() => void search(query().trim())}>
          {copy.admin.layouts.searchButton}
        </button>
      </div>
      <Show when={error()}>{(msg) => <div class="akl-error">{msg()}</div>}</Show>
      <Show when={record()} keyed>
        {(data) => (
          <>
            <h2 title={data.id}>{data.name}</h2>
            <OwnerActions layout={data} liked={undefined} canManage isAdmin onChanged={() => void search(data.id)} />
          </>
        )}
      </Show>
    </div>
  );
};

export default LayoutsTab;
