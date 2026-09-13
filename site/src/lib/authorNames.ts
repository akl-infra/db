// Author display-name resolution (W1b deliverable 2): `GET /v1/authors`
// fetched once per visit and cached in memory, keyed by Discord user id.
// Every place that shows an author (the list, a layout's owner, the author
// page, the changes feed) reads through `authorName()` -- the raw id stays
// available as the `title` tooltip at each call site, never dropped.
//
// [SITE-17] `resolveAuthorName` is pure and total: any id (known, unknown,
// empty, null/undefined) falls back to the id itself (or "" for no id) and
// never throws -- `tests/tools/author-names.test.ts` property-tests it
// directly, independent of the module-level fetch below.
import { createSignal } from "solid-js";
import { getAuthors } from "../api.ts";

export function resolveAuthorName(map: ReadonlyMap<string, string>, id: string | null | undefined): string {
  if (id === null || id === undefined || id === "") return "";
  return map.get(id) ?? id;
}

const [authorMap, setAuthorMap] = createSignal<ReadonlyMap<string, string>>(new Map());

export async function loadAuthorNames(): Promise<void> {
  const result = await getAuthors();
  if (!result.ok) return; // keep whatever was cached (or empty); every lookup still falls back to the id
  // `getAuthors()` is `{ "<user_id>": "<name>" }` (`?by=id`) -- already
  // exactly the shape this cache wants, so no per-row loop is needed.
  setAuthorMap(new Map(Object.entries(result.data)));
}

/** Reactive: re-renders any consumer once `loadAuthorNames()` resolves. */
export function authorName(id: string | null | undefined): string {
  return resolveAuthorName(authorMap(), id);
}

// Fetched once per visit, same shape as session.ts's `void refreshMe()` --
// a module-scope side effect fired on first import, not re-run per page.
void loadAuthorNames();
