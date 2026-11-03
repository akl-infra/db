// The read-path drift set (LDB-CV25): what a SAFE-METHOD request writes on a frozen database, measured by tests/api/read-path-drift.test.ts and
// pinned in DRIFT_SET. While the Worker is read_only the jobs are stopped and every write route answers 503, but a GET still bookkeeps (a nonce and an
// author upsert for a signed client, auth_cache and an author upsert for a Discord bearer, ...). So D1 drifts between `export` and `verify`, and the
// proof must tolerate exactly this set and nothing else (LDB-CV26).

/** Row identity per table (the primary key); a table not listed here is identified by its whole row. */
export const PRIMARY_KEYS = {
  nonces: ["client_id", "nonce"],
  auth_cache: ["token_hash"],
  authors: ["user_id"],
  authors_head: ["id"],
  discord_users: ["user_id"],
  discord_users_head: ["id"],
  layouts_head: ["id"],
  ratelimit: ["key"],
  idempotency: ["scope", "key"],
};

const id = (table, row) => JSON.stringify((PRIMARY_KEYS[table] ?? Object.keys(row).sort()).map((k) => row[k]));

/**
 * What changed between two snapshots (`{table: rows[]}`), as `{table: {added, removed, changed: {column: rowsChanged}}}` for the tables that changed.
 * `added` and `removed` count rows by primary key; `changed` counts, per column, the rows present in both whose value differs.
 */
export function describeDrift(before, after) {
  const out = {};
  for (const table of [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()) {
    const b = new Map((before[table] ?? []).map((r) => [id(table, r), r]));
    const a = new Map((after[table] ?? []).map((r) => [id(table, r), r]));
    const d = { added: 0, removed: 0, changed: {} };
    for (const [k, row] of a) {
      const old = b.get(k);
      if (old === undefined) d.added++;
      else for (const col of new Set([...Object.keys(old), ...Object.keys(row)])) if (JSON.stringify(old[col] ?? null) !== JSON.stringify(row[col] ?? null)) d.changed[col] = (d.changed[col] ?? 0) + 1;
    }
    for (const k of b.keys()) if (!a.has(k)) d.removed++;
    if (d.added > 0 || d.removed > 0 || Object.keys(d.changed).length > 0) out[table] = d;
  }
  return out;
}

/** `describeDrift`'s output reduced to its shape: per table, whether rows were added/removed and which columns changed (no counts, so it does not depend on the request mix). */
export function summarizeDrift(described) {
  return Object.fromEntries(
    Object.entries(described).map(([t, d]) => [t, { rows: d.added > 0 && d.removed > 0 ? "added+removed" : d.added > 0 ? "added" : d.removed > 0 ? "removed" : "none", columns: Object.keys(d.changed).sort() }]),
  );
}

/** The union of two summaries (several phases of one measurement). */
export function mergeSummaries(a, b) {
  const out = {};
  for (const t of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const x = a[t] ?? { rows: "none", columns: [] };
    const y = b[t] ?? { rows: "none", columns: [] };
    const rows = new Set([...x.rows.split("+"), ...y.rows.split("+")].filter((r) => r !== "none"));
    out[t] = { rows: rows.size === 0 ? "none" : [...rows].sort().join("+"), columns: [...new Set([...x.columns, ...y.columns])].sort() };
  }
  return out;
}

/**
 * MEASURED (tests/api/read-path-drift.test.ts: anonymous, signed-client and Discord-bearer GETs over every GET route, snapshot of every table before and
 * after) and pinned there. Everything else is untouched by a safe-method request.
 *   nonces       a signed GET inserts its nonce (the replay guard).
 *   auth_cache   a bearer GET inserts the token's answer; an expired row is upserted (expires_at).
 *   authors      a signed GET upserts the actor (new row, or last_seen_at refreshed); a bearer GET upserts the user (new row, or name / name_source from Discord).
 *   authors_head the trigger on authors moves its counters (count, modified_at, version).
 * `rows: "added"`: rows may appear (never disappear); `columns`: may change in rows present on both sides.
 */
export const DRIFT_SET = {
  auth_cache: { rows: "added", columns: ["expires_at"] },
  authors: { rows: "added", columns: ["last_seen_at", "name", "name_source"] },
  authors_head: { rows: "none", columns: ["count", "modified_at", "version"] },
  nonces: { rows: "added", columns: [] },
};

import { canon, compareProofs, localSelect, orderOf, proveAll, proveAllBatched, provenTables, readAllRows } from "./checksum.mjs";

/** Tables that drift. */
export const isDriftTable = (t) => Object.hasOwn(DRIFT_SET, t);

/**
 * Compare one drift table, row by row, `left` against `right` (arrays of row objects, any value shapes `canon` knows).
 *  - rows are matched by primary key; the DRIFT_SET columns of a shared row may differ (counted as `tolerated`); any other column that differs is `bad`;
 *  - a row only on `right` is `rightOnly` (rows that appeared after the export: allowed when the table's rows may be "added");
 *  - a row only on `left` is `leftOnly` (rows that vanished: never allowed, unless `extras: "both"`, which lets either side hold extra rows: the
 *    original D1 against AWS's capture, each of which has bookkept on its own).
 * Returns { ok, leftOnly, rightOnly, tolerated: {col: n}, bad: {col: n} }.
 */
export function compareDriftTable(table, left, right, { extras = "right" } = {}) {
  const spec = DRIFT_SET[table];
  if (spec === undefined) throw new Error(`${table} is not a drift table`);
  const pk = PRIMARY_KEYS[table];
  const key = (r) => JSON.stringify(pk.map((k) => canon(r[k])));
  const strip = (r) => Object.fromEntries(Object.entries(r).filter(([k]) => k !== "__rid"));
  const L = new Map(left.map((r) => [key(r), strip(r)]));
  const R = new Map(right.map((r) => [key(r), strip(r)]));
  const out = { ok: true, leftOnly: 0, rightOnly: 0, tolerated: {}, bad: {} };
  for (const [k, l] of L) {
    const r = R.get(k);
    if (r === undefined) {
      out.leftOnly++;
      continue;
    }
    for (const col of new Set([...Object.keys(l), ...Object.keys(r)])) {
      if (canon(l[col]) === canon(r[col])) continue;
      const bucket = spec.columns.includes(col) ? out.tolerated : out.bad;
      bucket[col] = (bucket[col] ?? 0) + 1;
    }
  }
  for (const k of R.keys()) if (!L.has(k)) out.rightOnly++;
  const mayAdd = spec.rows.includes("added");
  out.ok = Object.keys(out.bad).length === 0 && (out.leftOnly === 0 || extras === "both") && (out.rightOnly === 0 || (mayAdd && (extras === "right" || extras === "both")));
  if (extras === "both" && out.leftOnly > 0 && !mayAdd) out.ok = false;
  return out;
}

/**
 * A logged commit unit (its statements' SQL) that only bookkeeps a read: the nonce, the author upsert, the bearer cache. The rollback treats such units after
 * the image as "no write reached AWS". Statement shapes are those of src/store/d1/auth.ts (tests/cutover/drift.test.ts reads them from the source).
 */
const BOOKKEEPING = [/^INSERT INTO (nonces|auth_cache|authors) \(/i, /^UPDATE authors SET last_seen_at = \?/i];
export const isBookkeepingSql = (sql) => BOOKKEEPING.some((re) => re.test(sql.trim()));
export const isBookkeepingUnit = (sqls) => sqls.length > 0 && sqls.every(isBookkeepingSql);

/**
 * Compare the loaded/captured database `localDb` with a remote one (live D1, or the original D1 against AWS's capture), tolerating exactly the drift set.
 *  - every table outside the set: count + checksum, as always (`leftProof`, when given, replaces the local computation: the image entry's stored proof);
 *  - every drift table: row by row (compareDriftTable), the drift columns and rows only on the remote side tolerated.
 * Returns { problems: string[], plain: {tables, rows}, drift: {table: {leftOnly, rightOnly, tolerated, bad}}, lost: {table: n} } where `lost` counts the rows the
 * remote has and the local database will not ("lost on AWS: read-path bookkeeping").
 */
export async function compareWithDrift({ localDb, remoteSelect, remoteSelectMany, leftProof, pageRows, concurrency, stats, extras = "right", names = { left: "sqlite", right: "d1" } }) {
  const all = provenTables(localDb);
  const plain = all.filter((t) => !isDriftTable(t));
  const left = leftProof === undefined ? await proveAll({ select: localSelect(localDb), db: localDb, tables: plain, pageRows }) : Object.fromEntries(plain.filter((t) => leftProof[t] !== undefined).map((t) => [t, leftProof[t]]));
  const right = await proveAllBatched({ select: remoteSelect, ...(remoteSelectMany ? { selectMany: remoteSelectMany } : {}), db: localDb, tables: Object.keys(left), pageRows, concurrency, stats });
  const cmp = compareProofs(left, right, names);
  const problems = cmp.diffs.map((d) => `${d.table}: ${d.field} ${names.left} ${d[names.left]} != ${names.right} ${d[names.right]}`);
  const drift = {};
  const lost = {};
  for (const t of all.filter(isDriftTable)) {
    const order = orderOf(localDb, t);
    const l = await readAllRows({ select: localSelect(localDb), table: t, order, pageRows });
    const r = await readAllRows({ select: remoteSelect, table: t, order, pageRows });
    const d = compareDriftTable(t, l, r, { extras });
    drift[t] = d;
    if (d.rightOnly > 0) lost[t] = d.rightOnly;
    if (!d.ok) {
      const why = [];
      if (d.leftOnly > 0 && extras === "right") why.push(`${d.leftOnly} row(s) of the ${names.left} are gone from the ${names.right}`);
      if (d.rightOnly > 0 && !DRIFT_SET[t].rows.includes("added")) why.push(`${d.rightOnly} new row(s) in the ${names.right}`);
      for (const [c, n] of Object.entries(d.bad)) why.push(`column ${c} differs in ${n} row(s) (outside the drift set)`);
      problems.push(`${t} (read-path drift table): ${why.join("; ") || "differs"}`);
    }
  }
  return { problems, plain: { tables: cmp.tables, rows: cmp.rows }, drift, lost };
}
