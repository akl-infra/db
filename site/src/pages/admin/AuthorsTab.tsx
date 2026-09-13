import type { Component } from "solid-js";
import { Show, createSignal } from "solid-js";
import { copy } from "../../copy.ts";
import { adminSetAuthorName, getAuthor } from "../../api.ts";
import type { Author } from "../../lib/types.ts";
import { loadAuthorNames } from "../../lib/authorNames.ts";

/** Admin console, Authors tab: the one NEW moderation capability (db/docs/
 * adoption.md §10) -- overriding a Discord id's display name so neither a
 * later sign-in nor the cmini import renames it again. No "clear override"
 * route exists (an admin sets it again to change it, per the API). */
const AuthorsTab: Component = () => {
  const [userId, setUserId] = createSignal("");
  const [author, setAuthor] = createSignal<Author | undefined>(undefined);
  const [error, setError] = createSignal<string | null>(null);
  const [loading, setLoading] = createSignal(false);
  const [newName, setNewName] = createSignal("");
  const [renamePending, setRenamePending] = createSignal(false);
  const [renameError, setRenameError] = createSignal<string | null>(null);
  const [notice, setNotice] = createSignal<string | null>(null);

  async function lookup(id: string): Promise<void> {
    if (!id) return;
    setLoading(true);
    setError(null);
    setNotice(null);
    const result = await getAuthor(id);
    setLoading(false);
    if (!result.ok) {
      setAuthor(undefined);
      setError(result.status === 404 ? copy.admin.authors.notFound : (result.message ?? copy.admin.authors.loadError));
      return;
    }
    setAuthor(result.data);
    setNewName(result.data.name);
  }

  async function rename(): Promise<void> {
    const a = author();
    const name = newName().trim();
    if (!a || !name) return;
    setRenamePending(true);
    setRenameError(null);
    const result = await adminSetAuthorName(a.user_id, name);
    setRenamePending(false);
    if (!result.ok) {
      setRenameError(result.message ?? result.error);
      return;
    }
    setAuthor(result.data);
    setNotice(copy.admin.authors.renamed);
    // The site-wide `authorName()` cache (lib/authorNames.ts) was loaded
    // once per visit -- refresh it too so this rename shows up everywhere
    // else on the current visit without a reload.
    void loadAuthorNames();
  }

  return (
    <div>
      <div class="akl-action-row">
        <input
          type="text"
          placeholder={copy.admin.authors.lookupPlaceholder}
          value={userId()}
          onInput={(e) => setUserId(e.currentTarget.value)}
        />
        <button class="akl-btn" disabled={loading() || !userId().trim()} onClick={() => void lookup(userId().trim())}>
          {copy.admin.authors.lookupButton}
        </button>
      </div>
      <Show when={error()}>{(msg) => <div class="akl-error">{msg()}</div>}</Show>
      <Show when={author()} keyed>
        {(a) => (
          <div class="akl-action-row">
            <span class="akl-muted" title={a.user_id}>
              {copy.admin.authors.currentName(a.name)}
            </span>
            <input
              type="text"
              placeholder={copy.admin.authors.newNamePrompt}
              value={newName()}
              onInput={(e) => setNewName(e.currentTarget.value)}
            />
            <button class="akl-btn" disabled={renamePending() || !newName().trim()} onClick={() => void rename()}>
              {copy.admin.authors.rename}
            </button>
            <Show when={renameError()}>{(msg) => <span class="akl-inline-error">{msg()}</span>}</Show>
            <Show when={notice()}>{(msg) => <span class="akl-muted">{msg()}</span>}</Show>
          </div>
        )}
      </Show>
    </div>
  );
};

export default AuthorsTab;
