import type { Component } from "solid-js";
import { Show, createSignal } from "solid-js";
import { copy } from "../copy.ts";
import {
  clearLink,
  deleteLayout,
  getLink,
  likeLayout,
  renameLayout,
  restoreLayout,
  submitLink,
  transferLayout,
  unlikeLayout,
} from "../api.ts";
import type { ApiResult } from "../api.ts";
import type { LayoutRecord, LinkSubmission } from "../lib/types.ts";
import { createAsync } from "../lib/asyncData.ts";

/** W1b deliverable 1: signed-in owner (or admin) actions on a layout.
 * Rendered by `pages/Layout.tsx` (public page, `showLike` on) and by the
 * admin console's Layouts tab (`showLike` off -- an admin managing someone
 * else's layout from the moderation console isn't "liking" it). Every
 * action confirms IN PLACE (no `window.confirm`/`alert` -- SITE-15) and
 * shows the DB's own error `message` verbatim; a 409 `stale` (the record
 * changed since it was loaded) offers a reload instead of retrying blind.
 */
const OwnerActions: Component<{
  layout: LayoutRecord;
  liked: boolean | undefined; // undefined = not signed in, or not yet known
  canManage: boolean; // owner OR admin
  isAdmin: boolean; // site admin -- unlocks immediate link approval (no like-count override: likes are always per-user rows, saltorbit 2026-09-13)
  onChanged: () => void;
}> = (props) => {
  const ifMatch = () => `"layout:${props.layout.layout_rev}"`;

  // Every write below addresses the layout by `id` (a ULID), never `name`:
  // `db/src/core/records.ts`'s `byRef` (which every write route's
  // `loadForWrite` goes through) resolves an id FIRST and, unlike its
  // name lookup, does not filter `deleted = 0` -- so a rename doesn't
  // orphan a ref this component is still holding, and a delete's
  // immediate Restore action (below) keeps working on the very same id.

  // ── like / unlike ───────────────────────────────────────────────────
  const [likePending, setLikePending] = createSignal(false);
  const [likeError, setLikeError] = createSignal<string | null>(null);

  const doLike = async () => {
    setLikePending(true);
    setLikeError(null);
    const result = props.liked ? await unlikeLayout(props.layout.id) : await likeLayout(props.layout.id);
    setLikePending(false);
    if (!result.ok) {
      setLikeError(result.message ?? result.error);
      props.onChanged(); // resync -- an already_liked/not_liked 409 means our local `liked` guess was stale
      return;
    }
    props.onChanged();
  };

  // ── generic result handling for the row actions below ────────────────
  const [staleNotice, setStaleNotice] = createSignal(false);

  function handleResult<T>(result: ApiResult<T>, setError: (msg: string | null) => void, onSuccess: () => void): void {
    if (!result.ok) {
      if (result.status === 409 && result.error === "stale") setStaleNotice(true);
      setError(result.message ?? result.error);
      return;
    }
    setError(null);
    setStaleNotice(false);
    onSuccess();
    props.onChanged();
  }

  // ── rename ─────────────────────────────────────────────────────────
  const [renameOpen, setRenameOpen] = createSignal(false);
  const [renameValue, setRenameValue] = createSignal(props.layout.name);
  const [renamePending, setRenamePending] = createSignal(false);
  const [renameError, setRenameError] = createSignal<string | null>(null);

  const doRename = async () => {
    setRenamePending(true);
    const result = await renameLayout(props.layout.id, renameValue(), ifMatch());
    setRenamePending(false);
    handleResult(result, setRenameError, () => setRenameOpen(false));
  };

  // ── delete ─────────────────────────────────────────────────────────
  const [deleteOpen, setDeleteOpen] = createSignal(false);
  const [deletePending, setDeletePending] = createSignal(false);
  const [deleteError, setDeleteError] = createSignal<string | null>(null);

  const doDelete = async () => {
    setDeletePending(true);
    const result = await deleteLayout(props.layout.id, ifMatch());
    setDeletePending(false);
    handleResult(result, setDeleteError, () => setDeleteOpen(false));
  };

  // ── restore ────────────────────────────────────────────────────────
  const [restoreOpen, setRestoreOpen] = createSignal(false);
  const [restoreName, setRestoreName] = createSignal("");
  const [restorePending, setRestorePending] = createSignal(false);
  const [restoreError, setRestoreError] = createSignal<string | null>(null);

  const doRestore = async () => {
    setRestorePending(true);
    const result = await restoreLayout(props.layout.id, restoreName().trim() || undefined);
    setRestorePending(false);
    handleResult(result, setRestoreError, () => setRestoreOpen(false));
  };

  // ── transfer ───────────────────────────────────────────────────────
  const [transferOpen, setTransferOpen] = createSignal(false);
  const [transferTo, setTransferTo] = createSignal("");
  const [transferPending, setTransferPending] = createSignal(false);
  const [transferError, setTransferError] = createSignal<string | null>(null);

  const doTransfer = async () => {
    setTransferPending(true);
    const result = await transferLayout(props.layout.id, transferTo().trim(), ifMatch());
    setTransferPending(false);
    handleResult(result, setTransferError, () => setTransferOpen(false));
  };

  // ── link ───────────────────────────────────────────────────────────
  const [linkRefresh, setLinkRefresh] = createSignal(0);
  const linkInfo = createAsync(
    () => [props.layout.id, linkRefresh()] as const,
    ([id]) => getLink(id),
  );
  const pendingSubmission = (): LinkSubmission | null => {
    const r = linkInfo.data();
    return r?.ok ? r.data.pending : null;
  };
  const [linkOpen, setLinkOpen] = createSignal(false);
  const [linkValue, setLinkValue] = createSignal("");
  const [linkPending, setLinkPending] = createSignal(false);
  const [linkError, setLinkError] = createSignal<string | null>(null);
  const [linkNotice, setLinkNotice] = createSignal<string | null>(null);

  const doSubmitLink = async () => {
    setLinkPending(true);
    const result = await submitLink(props.layout.id, linkValue().trim());
    setLinkPending(false);
    if (!result.ok) {
      setLinkError(result.message ?? result.error);
      return;
    }
    setLinkError(null);
    setLinkOpen(false);
    setLinkNotice("submission" in result.data ? copy.actions.linkQueued : copy.actions.linkSetImmediately);
    setLinkRefresh((n) => n + 1);
    props.onChanged();
  };

  const doClearLink = async () => {
    setLinkPending(true);
    const result = await clearLink(props.layout.id);
    setLinkPending(false);
    if (!result.ok) {
      setLinkError(result.message ?? result.error);
      return;
    }
    setLinkError(null);
    setLinkNotice(null);
    setLinkRefresh((n) => n + 1);
    props.onChanged();
  };

  return (
    <div class="akl-owner-actions">
      <Show when={staleNotice()}>
        <div class="akl-error">
          {copy.actions.staleNotice}{" "}
          <button
            class="akl-btn-ghost"
            onClick={() => {
              setStaleNotice(false);
              props.onChanged();
            }}
          >
            {copy.actions.reload}
          </button>
        </div>
      </Show>

      {/* like / unlike -- shown whenever the caller passed a known liked
          state (signed in); hidden entirely from the admin console, where
          `props.liked` is always undefined. */}
      <Show when={props.liked !== undefined}>
        <div class="akl-action-row">
          <button class="akl-btn" disabled={likePending()} onClick={() => void doLike()}>
            {props.liked ? copy.actions.unlike : copy.actions.like}
          </button>
          <Show when={likeError()}>{(msg) => <span class="akl-inline-error">{msg()}</span>}</Show>
        </div>
      </Show>

      <Show when={props.canManage}>
        <h2>{copy.actions.sectionTitle}</h2>

        {/* rename */}
        <div class="akl-action-row">
          <Show
            when={renameOpen()}
            fallback={
              <button class="akl-btn" onClick={() => setRenameOpen(true)}>
                {copy.actions.rename}
              </button>
            }
          >
            <input
              type="text"
              aria-label={copy.actions.renamePrompt}
              placeholder={copy.actions.renamePrompt}
              value={renameValue()}
              onInput={(e) => setRenameValue(e.currentTarget.value)}
            />
            <button class="akl-btn" disabled={renamePending()} onClick={() => void doRename()}>
              {copy.actions.confirm}
            </button>
            <button class="akl-btn-ghost" disabled={renamePending()} onClick={() => setRenameOpen(false)}>
              {copy.actions.cancel}
            </button>
          </Show>
          <Show when={renameError()}>{(msg) => <span class="akl-inline-error">{msg()}</span>}</Show>
        </div>

        {/* delete / restore */}
        <Show
          when={!props.layout.deleted}
          fallback={
            <div class="akl-action-row">
              <div class="akl-muted">{copy.actions.deletedNotice}</div>
              <Show
                when={restoreOpen()}
                fallback={
                  <button class="akl-btn" onClick={() => setRestoreOpen(true)}>
                    {copy.actions.restore}
                  </button>
                }
              >
                <input
                  type="text"
                  aria-label={copy.actions.restoreNamePrompt}
                  placeholder={copy.actions.restoreNamePrompt}
                  value={restoreName()}
                  onInput={(e) => setRestoreName(e.currentTarget.value)}
                />
                <button class="akl-btn" disabled={restorePending()} onClick={() => void doRestore()}>
                  {copy.actions.confirm}
                </button>
                <button class="akl-btn-ghost" disabled={restorePending()} onClick={() => setRestoreOpen(false)}>
                  {copy.actions.cancel}
                </button>
              </Show>
              <Show when={restoreError()}>{(msg) => <span class="akl-inline-error">{msg()}</span>}</Show>
            </div>
          }
        >
          <div class="akl-action-row">
            <Show
              when={deleteOpen()}
              fallback={
                <button class="akl-btn akl-btn-danger" onClick={() => setDeleteOpen(true)}>
                  {copy.actions.delete}
                </button>
              }
            >
              <span>{copy.actions.confirm}?</span>
              <button class="akl-btn akl-btn-danger" disabled={deletePending()} onClick={() => void doDelete()}>
                {copy.actions.delete}
              </button>
              <button class="akl-btn-ghost" disabled={deletePending()} onClick={() => setDeleteOpen(false)}>
                {copy.actions.cancel}
              </button>
            </Show>
            <Show when={deleteError()}>{(msg) => <span class="akl-inline-error">{msg()}</span>}</Show>
          </div>
        </Show>

        {/* transfer */}
        <div class="akl-action-row">
          <Show
            when={transferOpen()}
            fallback={
              <button class="akl-btn" onClick={() => setTransferOpen(true)}>
                {copy.actions.transfer}
              </button>
            }
          >
            <input
              type="text"
              aria-label={copy.actions.transferPrompt}
              placeholder={copy.actions.transferPrompt}
              value={transferTo()}
              onInput={(e) => setTransferTo(e.currentTarget.value)}
            />
            <button class="akl-btn" disabled={transferPending()} onClick={() => void doTransfer()}>
              {copy.actions.confirm}
            </button>
            <button class="akl-btn-ghost" disabled={transferPending()} onClick={() => setTransferOpen(false)}>
              {copy.actions.cancel}
            </button>
          </Show>
          <Show when={transferError()}>{(msg) => <span class="akl-inline-error">{msg()}</span>}</Show>
        </div>

        {/* link */}
        <div class="akl-action-row akl-link-actions">
          <h3>{copy.actions.linkSectionTitle}</h3>
          <Show when={pendingSubmission()}>{(sub) => <div class="akl-muted">{copy.actions.linkPending(sub().url)}</div>}</Show>
          <Show when={linkNotice()}>{(msg) => <div class="akl-muted">{msg()}</div>}</Show>
          <div>
            <Show
              when={linkOpen()}
              fallback={
                <>
                  <button class="akl-btn" onClick={() => setLinkOpen(true)}>
                    {props.isAdmin ? copy.actions.linkSubmitAdmin : copy.actions.linkSubmit}
                  </button>
                  <Show when={props.layout.link}>
                    <button class="akl-btn-ghost" disabled={linkPending()} onClick={() => void doClearLink()}>
                      {copy.actions.linkClear}
                    </button>
                  </Show>
                </>
              }
            >
              <input
                type="text"
                aria-label={copy.actions.linkPrompt}
                placeholder={copy.actions.linkPrompt}
                value={linkValue()}
                onInput={(e) => setLinkValue(e.currentTarget.value)}
              />
              <button class="akl-btn" disabled={linkPending()} onClick={() => void doSubmitLink()}>
                {copy.actions.confirm}
              </button>
              <button class="akl-btn-ghost" disabled={linkPending()} onClick={() => setLinkOpen(false)}>
                {copy.actions.cancel}
              </button>
            </Show>
            <Show when={linkError()}>{(msg) => <span class="akl-inline-error">{msg()}</span>}</Show>
          </div>
        </div>
      </Show>
    </div>
  );
};

export default OwnerActions;
