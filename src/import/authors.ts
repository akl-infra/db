// The cmini import's author names (07 §6 S5: `GET /authors` on every
// non-quiet tick, no events), LDB-I15..I17. Upstream's `/authors` is
// `{name: user_id}` and keeps EVERY name a user has ever had on file, so
// one id arrives under several names (`657688933001330718` is `Valorance`,
// `va1orance` and `val0rance`). `authors` stores ONE name per id. The old
// applier rewrote the row for every name that differed, so each pass
// walked every multi-name id through all its names: `last_seen_at` (and so
// `/v1/meta.authors_modified_at`) moved on every pass with no event-seq
// bump, and a consumer scraping mid-pass saw whichever alias the walk was
// on (2026-09-11: the stats service re-published ~400-900 layouts per
// tick for author "changes" that were never real edits).
//
// The rule, one pure function (`planAuthorNames`) over upstream's map and
// the stored rows:
//   - a row whose name arrived through the USER lane (`name_source =
//     'user'`, `auth/discord.ts`'s `resolveBearer`) is never touched;
//   - a stored name that is still one of upstream's names for its id is
//     kept, whatever it is;
//   - otherwise (no row yet, the client lane's id placeholder, or a name
//     upstream no longer lists) the id gets `preferredName(names)`.
// So the stored name for an id changes at most once under any sequence of
// passes over the same upstream data (LDB-I16), a second pass writes
// nothing (LDB-I15), and neither depends on the order upstream lists names.
import type { Bindings } from "../env";
import type { Clock } from "../core/time";

// `authors.name_source` (migrations/0006_author_name_source.sql). L5
// (§4.3, LDB-MD4) adds a fourth source: `admin` -- an admin's own display-
// name override (`PUT /v1/admin/authors/:user_id`), stickier than every
// other source: neither a sign-in (`auth/discord.ts`) nor an import pass
// (this file's own `planAuthorNames`/`writeAuthorNames`) may overwrite it.
export type NameSource = "import" | "user" | "client" | "admin";
export const NAME_SOURCES: readonly NameSource[] = ["import", "user", "client", "admin"];

export interface StoredAuthor {
  name: string;
  source: NameSource;
}

export type AuthorWrite =
  | { kind: "insert"; userId: string; name: string }
  | { kind: "rename"; userId: string; from: string; to: string };

// Code-point order, which is also UTF-8 byte order -- NOT JS's default
// UTF-16 code-unit order (the two disagree when a supplementary-plane
// character meets one in U+E000..U+FFFF).
export function compareCodePoints(a: string, b: string): number {
  const ai = a[Symbol.iterator]();
  const bi = b[Symbol.iterator]();
  for (;;) {
    const x = ai.next();
    const y = bi.next();
    if (x.done === true) return y.done === true ? 0 : -1;
    if (y.done === true) return 1;
    const d = x.value.codePointAt(0)! - y.value.codePointAt(0)!;
    if (d !== 0) return d;
  }
}

// The name the import gives an id it has no keepable name for: the
// GREATEST of upstream's names in code-point (= UTF-8 byte) order.
// Layouts carry only the owner id, never a name, so every alias of an id
// is "on" exactly the same layouts and a most-layouts rule cannot tell
// them apart. This one is order-independent and locale-free, and it is
// exactly the name the old applier left behind after every completed pass:
// upstream is a Go server, and `encoding/json` writes a map's keys in
// sorted byte order, so the old last-write-wins walk always ended on the
// byte-greatest alias (bar an alias that is an array index, e.g. `42`,
// which `JSON.parse` hoists to the front of the key order -- not a shape
// any real Discord name takes). Deploying this rule therefore changes no stored name
// that a completed pass already settled, and a fresh import reproduces
// every fixture and golden built under the old applier. (It also leans
// towards Discord's current all-lowercase handles -- `oxey_` over `Oxey`,
// `clemenpine` over `ClemenPine` -- over the capitalised legacy usernames
// upstream still lists beside them.)
export function preferredName(names: readonly string[]): string {
  if (names.length === 0) throw new Error("preferredName: no names");
  let best = names[0]!;
  for (const n of names) if (compareCodePoints(n, best) > 0) best = n;
  return best;
}

// `{name: id}` -> id -> its names, ids in code-point order (so the write
// list below is deterministic too), each id's names deduped and sorted.
export function namesById(upstream: Readonly<Record<string, string>>): Map<string, string[]> {
  const byId = new Map<string, Set<string>>();
  for (const [name, id] of Object.entries(upstream)) {
    let set = byId.get(id);
    if (set === undefined) {
      set = new Set();
      byId.set(id, set);
    }
    set.add(name);
  }
  const ids = [...byId.keys()].sort(compareCodePoints);
  return new Map(ids.map((id) => [id, [...byId.get(id)!].sort(compareCodePoints)]));
}

// LDB-I15/I16/I17: the writes one import pass makes. Pure: same upstream
// content (in any key order) + same stored rows -> same list.
export function planAuthorNames(
  upstream: Readonly<Record<string, string>>,
  stored: ReadonlyMap<string, StoredAuthor>,
): AuthorWrite[] {
  const writes: AuthorWrite[] = [];
  for (const [userId, names] of namesById(upstream)) {
    const row = stored.get(userId);
    if (row === undefined) {
      writes.push({ kind: "insert", userId, name: preferredName(names) });
      continue;
    }
    if (row.source === "user" || row.source === "admin") continue; // LDB-I17/[LDB-MD4]: the user lane's name, or an admin override, wins
    if (names.includes(row.name)) continue; // LDB-I15: still one of upstream's names -- keep it
    writes.push({ kind: "rename", userId, from: row.name, to: preferredName(names) });
  }
  return writes;
}

// The pure fold of `writes` over `stored` -- what `writeAuthorNames` must
// leave in D1 when nothing else writes in between (LDB-I15's derived-state
// identity, checked against real D1 in tests/import/authors.test.ts).
export function foldAuthorWrites(
  stored: ReadonlyMap<string, StoredAuthor>,
  writes: readonly AuthorWrite[],
): Map<string, StoredAuthor> {
  const out = new Map(stored);
  for (const w of writes) {
    const row = out.get(w.userId);
    if (w.kind === "insert") {
      if (row === undefined) out.set(w.userId, { name: w.name, source: "import" });
    } else if (row !== undefined && row.name === w.from && row.source !== "user" && row.source !== "admin") {
      out.set(w.userId, { name: w.to, source: "import" });
    }
  }
  return out;
}

export async function readStoredAuthors(db: Bindings["DB"]): Promise<Map<string, StoredAuthor>> {
  const { results } = await db
    .prepare("SELECT user_id, name, name_source FROM authors")
    .all<{ user_id: string; name: string; name_source: NameSource }>();
  return new Map(results.map((r) => [r.user_id, { name: r.name, source: r.name_source }]));
}

// Statements per `db.batch()` -- a bounded chunk, not one batch for a
// first import's ~420 inserts.
const WRITE_CHUNK = 50;

// Applies a plan. Both statements are compare-and-set against the state
// the plan was made from, so a user-lane (or client-lane) write that lands
// between `readStoredAuthors` and here is never clobbered (LDB-I17): the
// insert yields to a row that appeared meanwhile, and the rename only fires
// while the row still holds the name it was planned from and was not
// claimed by the user lane. A skipped write is simply re-planned next pass.
// `last_seen_at` moves only on a row actually written, i.e. only when its
// stored name really changes (LDB-I15).
export async function writeAuthorNames(db: Bindings["DB"], now: Clock, writes: readonly AuthorWrite[]): Promise<void> {
  if (writes.length === 0) return;
  const at = now();
  const statements = writes.map((w) =>
    w.kind === "insert"
      ? db
          .prepare(
            `INSERT INTO authors (user_id, name, first_seen_at, last_seen_at, name_source) VALUES (?, ?, ?, ?, 'import')
             ON CONFLICT(user_id) DO NOTHING`,
          )
          .bind(w.userId, w.name, at, at)
      : db
          .prepare(
            `UPDATE authors SET name = ?, name_source = 'import', last_seen_at = ?
             WHERE user_id = ? AND name = ? AND name_source NOT IN ('user', 'admin')`,
          )
          .bind(w.to, at, w.userId, w.from),
  );
  for (let i = 0; i < statements.length; i += WRITE_CHUNK) {
    await db.batch(statements.slice(i, i + WRITE_CHUNK));
  }
}
