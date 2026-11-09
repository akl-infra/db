// Concurrent-write scenarios for akldb, written against a `Target` so the SAME code runs in two places:
//  - tests/api/stress.test.ts: in-process (SELF.fetch + the D1 binding), the fast part of the suite;
//  - scripts/stress/run.mjs: over real HTTP against a local `wrangler dev` and node:sqlite on its D1 file (the soak).
// No imports from src/: it is a black-box client of the documented API plus read-only SQL for the invariants.
// Contracts under test (docs/decisions/21-formats.md D13, docs/technical-reference.md "Writes require a SCOPED If-Match"):
//  E1 a stale edit is `409 stale` {scope, rev, record, last_write} and writes nothing; E2 of two edits based on the same
//  version exactly one succeeds; E3 an edit on its own part's current version succeeds even when another part of the
//  layout was written in between (MF-6); E4 creating needs no version, fails only on a taken name; L1-L4 likes.
//  events.seq is gapless (tests/events/races.test.ts), layout_revs (layout_id, n) is gapless and 1:1 with rev-bumping events.

export interface Res {
  status: number;
  etag: string | null;
  json: any;
  req?: CallOpts; // set by the soak's wrapper so a failure can name the request that caused it
  bytes?: Uint8Array; // set for application/gzip bodies (dumps), which are not JSON
}
export interface CallOpts {
  method: string;
  path: string;
  user?: number | string; // stress user index (or a raw Discord id), becomes `Authorization: Bearer t<id>`
  body?: unknown;
  headers?: Record<string, string>;
}
export interface Target {
  call(o: CallOpts): Promise<Res>;
  sql(q: string, ...params: unknown[]): Promise<Record<string, any>[]>;
}

export const FINGERS = ["LP", "LR", "LM", "LI", "RI", "RM", "RR", "RP", "LT", "RT"];
const CHARS = "abcdefghijkl";
export const BOOTSTRAP_ADMIN = "184412255822020608";

export function userId(n: number | string): string {
  return typeof n === "string" ? n : `9${String(n).padStart(17, "0")}`;
}

// ---- payloads that verify themselves ------------------------------------------------------------------------------
// The seed is the code point of one marker key; everything else in the payload is a pure function of it, so a reader
// that sees any payload can recompute what it must be and a torn / mixed payload cannot pass.
export function payloadFor(seed: number, altCap = 3): any {
  const keys: any[] = CHARS.split("").map((c, i) => ({ char: c, row: Math.floor(i / 6), col: i % 6, finger: FINGERS[i % 8] }));
  keys.push({ char: String.fromCodePoint(0x4e00 + seed), row: 3, col: 0, finger: "LT" });
  const alts: any[] = [];
  CHARS.split("").forEach((c, i) => {
    const k = (seed + i) % (altCap + 1);
    for (let j = 1; j <= k; j++) alts.push({ ngram: [c], fingers: [FINGERS[(seed + i + j * 3) % 10]] });
  });
  if (seed % 3 === 0) {
    alts.push({ ngram: ["a", "b"], fingers: [FINGERS[seed % 10], FINGERS[(seed + 1) % 10]] });
    alts.push({ ngram: ["c", null, "e"], fingers: [FINGERS[(seed + 2) % 10], null, FINGERS[(seed + 3) % 10]] });
  }
  return alts.length > 0 ? { keys, alts } : { keys };
}
export function seedOf(payload: any): number | null {
  const k = (payload?.keys ?? []).find((x: any) => typeof x.char === "string" && x.char.codePointAt(0)! >= 0x4e00);
  return k === undefined ? null : k.char.codePointAt(0)! - 0x4e00;
}
export function canon(v: any): string {
  if (Array.isArray(v)) return `[${v.map(canon).join(",")}]`;
  if (v !== null && typeof v === "object") return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(",")}}`;
  return JSON.stringify(v);
}
export function payloadIsIntact(p: any, altCap = 3): boolean {
  const s = seedOf(p);
  return s !== null && canon(p) === canon(payloadFor(s, altCap));
}

// ---- reporting ---------------------------------------------------------------------------------------------------
export class Report {
  failures: string[] = [];
  stats: Record<string, number> = {};
  name: string;
  constructor(name: string) {
    this.name = name;
  }
  log?: (s: string) => void; // called for EVERY failed check, at the moment it happens
  check(cond: unknown, msg: string): boolean {
    if (!cond) this.log?.(`FAIL ${new Date().toISOString()} [${this.name}] ${msg}`);
    if (!cond && this.failures.length < 60) this.failures.push(msg);
    if (!cond) this.stats["failures"] = (this.stats["failures"] ?? 0) + 1;
    return !!cond;
  }
  count(k: string, n = 1): void {
    this.stats[k] = (this.stats[k] ?? 0) + n;
  }
  assertOk(): void {
    if (this.failures.length > 0) throw new Error(`${this.name}: ${this.failures.length}+ failure(s)\n  ${this.failures.slice(0, 20).join("\n  ")}`);
  }
}

let nameCounter = 0;
const runTag = Math.floor(Math.random() * 36 ** 3).toString(36);
export function freshName(prefix: string): string {
  return `${prefix}-${runTag}${(nameCounter++).toString(36)}`;
}

export async function create(t: Target, user: number | string, name: string, payload: any, headers?: Record<string, string>): Promise<Res> {
  return t.call({ method: "POST", path: "/v1/layouts", user, body: { name, format: "spark/1", payload }, headers });
}
export function put(t: Target, user: number | string, ref: string, rev: number, payload: any): Promise<Res> {
  return t.call({ method: "PUT", path: `/v1/layouts/${ref}`, user, headers: { "If-Match": `"spark:${rev}"` }, body: { format: "spark/1", payload } });
}
export function rename(t: Target, user: number | string, ref: string, layoutRev: number, name: string): Promise<Res> {
  return t.call({ method: "PATCH", path: `/v1/layouts/${ref}`, user, headers: { "If-Match": `"layout:${layoutRev}"` }, body: { name } });
}
export function del(t: Target, user: number | string, ref: string, layoutRev: number): Promise<Res> {
  return t.call({ method: "DELETE", path: `/v1/layouts/${ref}`, user, headers: { "If-Match": `"layout:${layoutRev}"` } });
}
export function restore(t: Target, user: number | string, id: string): Promise<Res> {
  return t.call({ method: "POST", path: `/v1/layouts/${id}/restore`, user, body: {} });
}
export function read(t: Target, ref: string): Promise<Res> {
  return t.call({ method: "GET", path: `/v1/layouts/${ref}?format=spark/1` });
}

/** A successful write's identity, for the "no lost update / no phantom" ledger check. */
export type Ack = { layout: string; scope: string; rev: number };
export function ackOf(r: Res): Ack | null {
  const j = r.json;
  if (r.status !== 200 && r.status !== 201) return null;
  const m = /^"(layout|spark):(\d+)"$/.exec(r.etag ?? "");
  if (m === null || typeof j?.id !== "string") return null;
  return { layout: j.id, scope: m[1]!, rev: Number(m[2]) };
}

// ---- database invariants -------------------------------------------------------------------------------------------
/** Structural invariants of the tables; `layoutIds` limits the per-layout part (the global parts always run). */
export async function checkDb(t: Target, r: Report, layoutIds?: string[]): Promise<void> {
  const seqs = (await t.sql("SELECT seq FROM events ORDER BY seq")).map((x) => Number(x.seq));
  r.check(seqs.every((s, i) => s === i + 1), `events.seq is not gapless 1..${seqs.length} (first break at index ${seqs.findIndex((s, i) => s !== i + 1)})`);
  r.stats["events"] = seqs.length;

  const bumping = Number((await t.sql("SELECT COUNT(*) c FROM events WHERE rev IS NOT NULL"))[0]!.c);
  const revRows = Number((await t.sql("SELECT COUNT(*) c FROM layout_revs"))[0]!.c);
  r.check(bumping === revRows, `rev-bumping events (${bumping}) != layout_revs rows (${revRows})`);
  r.stats["revs"] = revRows;

  const orphanRevs = await t.sql(
    "SELECT lr.layout_id, lr.n FROM layout_revs lr LEFT JOIN events e ON e.seq = lr.event_seq WHERE e.seq IS NULL OR e.layout_id != lr.layout_id OR e.rev IS NOT lr.rev OR e.format IS NOT lr.format LIMIT 5",
  );
  r.check(orphanRevs.length === 0, `layout_revs rows without a matching event: ${JSON.stringify(orphanRevs)}`);
  const orphanEvents = await t.sql(
    "SELECT e.seq FROM events e LEFT JOIN layout_revs lr ON lr.event_seq = e.seq WHERE e.rev IS NOT NULL AND lr.event_seq IS NULL LIMIT 5",
  );
  r.check(orphanEvents.length === 0, `rev-bumping events without a layout_revs row: ${JSON.stringify(orphanEvents)}`);
  const orphanLayouts = await t.sql("SELECT lr.layout_id FROM layout_revs lr LEFT JOIN layouts l ON l.id = lr.layout_id WHERE l.id IS NULL LIMIT 5");
  r.check(orphanLayouts.length === 0, `layout_revs for a layout that does not exist: ${JSON.stringify(orphanLayouts)}`);
  const formatsOrphan = await t.sql("SELECT f.layout_id FROM layout_formats f LEFT JOIN layouts l ON l.id = f.layout_id WHERE l.id IS NULL LIMIT 5");
  r.check(formatsOrphan.length === 0, `layout_formats row without a layout: ${JSON.stringify(formatsOrphan)}`);

  const dupLive = await t.sql("SELECT name, COUNT(*) c FROM layouts WHERE deleted = 0 GROUP BY name COLLATE NOCASE HAVING c > 1 LIMIT 5");
  r.check(dupLive.length === 0, `two live layouts share a name: ${JSON.stringify(dupLive)}`);

  const likeBad = await t.sql(
    "SELECT l.id, l.like_count, (SELECT COUNT(DISTINCT user_id) FROM likes k WHERE k.layout_id = l.id) real FROM layouts l WHERE l.like_count != (SELECT COUNT(DISTINCT user_id) FROM likes k WHERE k.layout_id = l.id) LIMIT 5",
  );
  r.check(likeBad.length === 0, `like_count != distinct likers (L4): ${JSON.stringify(likeBad)}`);

  const where = layoutIds === undefined ? "" : ` WHERE id IN (${layoutIds.map(() => "?").join(",")})`;
  const layouts = layoutIds !== undefined && layoutIds.length === 0 ? [] : await t.sql(`SELECT id, n, layout_rev, deleted FROM layouts${where}`, ...(layoutIds ?? []));
  // One pass per table, grouped in memory: far cheaper than a query per layout in the soak.
  const revsByLayout = new Map<string, Record<string, any>[]>();
  const allRevs = await t.sql(`SELECT layout_id, n, lineage, rev, payload_json FROM layout_revs${layoutIds === undefined ? "" : ` WHERE layout_id IN (${layoutIds.map(() => "?").join(",")})`} ORDER BY layout_id, n`, ...(layoutIds ?? []));
  for (const x of allRevs) {
    const a = revsByLayout.get(x.layout_id) ?? [];
    a.push(x);
    revsByLayout.set(x.layout_id, a);
  }
  const fmts = await t.sql(`SELECT layout_id, lineage, rev, payload_json, has_magic, has_alts FROM layout_formats${layoutIds === undefined ? "" : ` WHERE layout_id IN (${layoutIds.map(() => "?").join(",")})`}`, ...(layoutIds ?? []));
  const fmtByLayout = new Map<string, Record<string, any>[]>();
  for (const f of fmts) fmtByLayout.set(f.layout_id, [...(fmtByLayout.get(f.layout_id) ?? []), f]);

  for (const l of layouts) {
    const revs = revsByLayout.get(l.id) ?? [];
    r.check(revs.length === Number(l.n) && revs.every((x, i) => Number(x.n) === i + 1), `layout ${l.id}: layout_revs.n not gapless 1..${l.n} (has ${revs.map((x) => x.n).join(",")})`);
    const layoutScope = revs.filter((x) => x.lineage === null);
    r.check(layoutScope.length === Number(l.layout_rev) && layoutScope.every((x, i) => Number(x.rev) === i + 1), `layout ${l.id}: layout-scope revs not 1..${l.layout_rev}`);
    const lineages = new Set(revs.filter((x) => x.lineage !== null).map((x) => x.lineage));
    for (const ln of lineages) {
      const rs = revs.filter((x) => x.lineage === ln);
      r.check(rs.every((x, i) => Number(x.rev) === i + 1), `layout ${l.id}/${ln}: format revs not gapless from 1 (${rs.map((x) => x.rev).join(",")})`);
      const row = (fmtByLayout.get(l.id) ?? []).find((f) => f.lineage === ln);
      if (!r.check(row !== undefined, `layout ${l.id}: history has lineage ${ln} but layout_formats has no row`)) continue;
      r.check(Number(row!.rev) === rs.length, `layout ${l.id}/${ln}: layout_formats.rev ${row!.rev} != history length ${rs.length} (TORN RECORD)`);
      const last = rs[rs.length - 1]!;
      r.check(row!.payload_json === last.payload_json, `layout ${l.id}/${ln}: layout_formats.payload_json != payload of its latest revision (TORN RECORD)`);
      let parsed: any = null;
      try {
        parsed = JSON.parse(row!.payload_json);
      } catch {
        r.check(false, `layout ${l.id}/${ln}: payload_json is not JSON`);
      }
      if (parsed !== null) {
        r.check(Number(row!.has_alts) === ((parsed.alts?.length ?? 0) > 0 ? 1 : 0), `layout ${l.id}/${ln}: has_alts column disagrees with the payload`);
        r.check(Number(row!.has_magic) === (parsed.magic !== undefined && Object.keys(parsed.magic).length > 0 ? 1 : Number(row!.has_magic)), `layout ${l.id}/${ln}: has_magic`);
      }
    }
    for (const f of fmtByLayout.get(l.id) ?? []) r.check(lineages.has(f.lineage), `layout ${l.id}: layout_formats row ${f.lineage} with no history`);
  }
  r.stats["layouts_checked"] = layouts.length;

  // A format write may never land after the layout was deleted (21-formats D2/S2.2: "can never land on a tombstone"):
  // for each layout, replay its rev-bumping events in seq order and track deleted state.
  const evs = await t.sql(
    `SELECT seq, layout_id, kind, format, rev FROM events WHERE rev IS NOT NULL${layoutIds === undefined ? "" : ` AND layout_id IN (${layoutIds.map(() => "?").join(",")})`} ORDER BY layout_id, seq`,
    ...(layoutIds ?? []),
  );
  const state = new Map<string, boolean>();
  for (const e of evs) {
    if (e.format === null) {
      if (e.kind === "deleted") state.set(e.layout_id, true);
      else if (e.kind === "restored") state.set(e.layout_id, false);
      else if (e.kind === "created") state.set(e.layout_id, false);
    } else if (state.get(e.layout_id) === true) {
      r.check(false, `layout ${e.layout_id}: format event seq ${e.seq} (${e.kind}) landed while the layout was deleted`);
    }
  }
}

/** The public feed, paged to its end, equals the events table (kinds, layouts, revs, order) up to its head. */
export async function checkFeed(t: Target, r: Report): Promise<void> {
  const rows = await t.sql("SELECT seq, kind, layout_id, format, rev, actor FROM events ORDER BY seq");
  const seen: any[] = [];
  let since = 0;
  for (let guard = 0; guard < 100000; guard++) {
    const res = await t.call({ method: "GET", path: `/v1/changes?since=${since}&limit=500` });
    if (!r.check(res.status === 200, `GET /v1/changes?since=${since} -> ${res.status}`)) return;
    seen.push(...res.json.items);
    if (res.json.items.length === 0) break;
    since = res.json.next;
  }
  r.check(seen.length === rows.length, `feed has ${seen.length} events, table has ${rows.length}`);
  const n = Math.min(seen.length, rows.length);
  let mismatch = -1;
  for (let i = 0; i < n; i++) {
    const a = seen[i], b = rows[i]!;
    if (a.seq !== Number(b.seq) || a.kind !== b.kind || a.layout_id !== b.layout_id || a.format !== b.format || (a.rev ?? null) !== (b.rev === null ? null : Number(b.rev)) || a.actor !== b.actor) {
      mismatch = i;
      break;
    }
  }
  r.check(mismatch < 0, `feed disagrees with the events table at index ${mismatch}: ${mismatch < 0 ? "" : JSON.stringify([seen[mismatch], rows[mismatch]])}`);
  const meta = await t.call({ method: "GET", path: "/v1/meta" });
  r.check(meta.json?.seq === rows.length, `/v1/meta.seq ${meta.json?.seq} != events head ${rows.length}`);
  r.stats["feed_events"] = seen.length;
}

/** Every acknowledged write is in history exactly once; every history row was acknowledged. */
export async function checkLedger(t: Target, r: Report, acked: Ack[], layoutIds: string[]): Promise<void> {
  const want = new Set(acked.map((a) => `${a.layout}|${a.scope}|${a.rev}`));
  r.check(want.size === acked.length, `two acknowledged writes claim the same (layout, scope, rev): ${acked.length - want.size} duplicate(s) (E2 violated)`);
  if (layoutIds.length === 0) return;
  const have = new Set<string>();
  const rows = await t.sql(`SELECT layout_id, lineage, rev FROM layout_revs WHERE layout_id IN (${layoutIds.map(() => "?").join(",")})`, ...layoutIds);
  for (const x of rows) have.add(`${x.layout_id}|${x.lineage === null ? "layout" : x.lineage}|${x.rev}`);
  let lost = 0, phantom = 0;
  for (const k of want) if (!have.has(k)) { lost++; r.check(false, `LOST UPDATE: acknowledged ${k} is not in history`); }
  // creations are acknowledged only through the format ETag ("spark:1"); their layout rev 1 is implicit.
  for (const k of have) if (!want.has(k) && !/\|layout\|1$/.test(k)) { phantom++; r.check(false, `PHANTOM: history has ${k} that no client was told succeeded`); }
  r.stats["acked"] = acked.length;
  r.stats["lost"] = lost;
  r.stats["phantom"] = phantom;
}

// ---- scenarios -----------------------------------------------------------------------------------------------------
const isStale = (x: Res) => x.status === 409 && x.json?.error === "stale";

/** S1: N writers on one layout's spark scope, same base rev, unary-alt payloads. Exactly one winner per rev (E1/E2). */
export async function sameScopeCas(t: Target, o: { writers: number; rounds: number; owner: number }): Promise<Report> {
  const r = new Report("same-scope CAS");
  const c = await create(t, o.owner, freshName("cas"), payloadFor(0));
  r.check(c.status === 201, `create ${c.status} ${JSON.stringify(c.json)}`);
  const id = c.json.id as string;
  const acked: Ack[] = [ackOf(c)!];
  let seed = 1;
  for (let round = 1; round <= o.rounds; round++) {
    const seeds = Array.from({ length: o.writers }, () => seed++);
    const res = await Promise.all(seeds.map((s) => put(t, o.owner, id, round, payloadFor(s))));
    const wins = res.map((x, i) => ({ x, s: seeds[i]! })).filter((w) => w.x.status === 200);
    const lost = res.filter((x) => x.status !== 200);
    r.check(wins.length === 1, `round ${round}: ${wins.length} winners for spark:${round} (want exactly 1); statuses ${res.map((x) => x.status).join(",")}`);
    r.check(lost.every(isStale), `round ${round}: loser not 409 stale: ${JSON.stringify(lost.filter((x) => !isStale(x)).map((x) => [x.status, x.json?.error]))}`);
    if (wins.length === 1) {
      const w = wins[0]!;
      r.check(w.x.etag === `"spark:${round + 1}"`, `round ${round}: winner ETag ${w.x.etag}`);
      acked.push(ackOf(w.x)!);
      for (const l of lost.filter(isStale)) {
        r.check(l.json.scope === "spark" && l.json.rev === round + 1, `round ${round}: stale body scope/rev ${l.json.scope}/${l.json.rev}`);
        r.check(canon(l.json.record?.payload) === canon(payloadFor(w.s)), `round ${round}: stale.record.payload is not the winner's payload`);
        r.check(l.json.last_write?.kind !== undefined, `round ${round}: stale.last_write missing`);
      }
      const g = await read(t, id);
      r.check(g.json.formats["spark/1"].rev === round + 1 && canon(g.json.payload) === canon(payloadFor(w.s)), `round ${round}: read-after-write is not the winner (rev ${g.json.formats["spark/1"].rev})`);
    }
    r.count("writes_attempted", o.writers);
    r.count("stale", lost.length);
  }
  await checkDb(t, r, [id]);
  await checkLedger(t, r, acked, [id]);
  return r;
}

/** S2: layout-scope and format-scope writers racing on one layout. Both scopes' winners land (E3/MF-6); the rest are stale. */
export async function crossScope(t: Target, o: { rounds: number; perScope: number; owner: number }): Promise<Report> {
  const r = new Report("cross-scope (MF-6)");
  const base = freshName("xs");
  const c = await create(t, o.owner, base, payloadFor(0));
  const id = c.json.id as string;
  const acked: Ack[] = [ackOf(c)!];
  let seed = 1, nm = 0;
  for (let k = 1; k <= o.rounds; k++) {
    const names = Array.from({ length: o.perScope }, () => freshName(`${base.slice(0, 20)}-n${nm++}`));
    const seeds = Array.from({ length: o.perScope }, () => seed++);
    const jobs = [...names.map((n) => rename(t, o.owner, id, k, n)), ...seeds.map((s) => put(t, o.owner, id, k, payloadFor(s)))];
    const res = await Promise.all(jobs);
    const ren = res.slice(0, o.perScope), fmt = res.slice(o.perScope);
    r.check(ren.filter((x) => x.status === 200).length === 1, `round ${k}: rename winners ${ren.filter((x) => x.status === 200).length}; ${ren.map((x) => x.status)}`);
    r.check(fmt.filter((x) => x.status === 200).length === 1, `round ${k}: format winners ${fmt.filter((x) => x.status === 200).length}; ${fmt.map((x) => x.status)}`);
    for (const x of res.filter((y) => y.status !== 200)) r.check(isStale(x), `round ${k}: non-stale failure ${x.status} ${JSON.stringify(x.json).slice(0, 200)}`);
    for (const x of res) { const a = ackOf(x); if (a) acked.push(a); }
    const g = await read(t, id);
    r.check(g.json.layout_rev === k + 1 && g.json.formats["spark/1"].rev === k + 1, `round ${k}: revs after both scopes landed: layout ${g.json.layout_rev}, spark ${g.json.formats["spark/1"].rev}`);
    r.count("rounds_ok");
  }
  await checkDb(t, r, [id]);
  await checkLedger(t, r, acked, [id]);
  return r;
}

/** S3: concurrent creates of one name (case variants included). Exactly one 201, the rest 409 name_taken (E4). */
export async function createSameName(t: Target, o: { creators: number; rounds: number }): Promise<Report> {
  const r = new Report("concurrent create, same name");
  const ids: string[] = [];
  for (let k = 0; k < o.rounds; k++) {
    const base = freshName("dup");
    const variants = Array.from({ length: o.creators }, (_, i) => (i % 2 === 0 ? base : base.toUpperCase()));
    const res = await Promise.all(variants.map((nm, i) => create(t, 100 + i, nm, payloadFor(i))));
    const won = res.filter((x) => x.status === 201);
    r.check(won.length === 1, `round ${k}: ${won.length} creates won (${res.map((x) => x.status)})`);
    for (const x of res.filter((y) => y.status !== 201)) r.check(x.status === 409 && x.json?.error === "name_taken", `round ${k}: loser ${x.status} ${x.json?.error}`);
    if (won[0]) ids.push(won[0].json.id);
    const live = await t.sql("SELECT COUNT(*) c FROM layouts WHERE name = ? AND deleted = 0", base);
    r.check(Number(live[0]!.c) === 1, `round ${k}: ${live[0]!.c} live rows for ${base}`);
    if (won[0]) {
      const ev = await t.sql("SELECT COUNT(*) c FROM events WHERE layout_id = ?", won[0].json.id);
      r.check(Number(ev[0]!.c) === 2, `winner has ${ev[0]!.c} events (want created + format_added)`);
    }
    r.count("rounds_ok");
  }
  await checkDb(t, r, ids);
  return r;
}

/**
 * S4: readers observe a layout while writers rename/PUT it. Every observation must be a state that was acknowledged:
 * (spark rev, payload) pairs match the winners' acks, payloads are intact, layout_rev -> name matches, and per reader revs never go backwards.
 */
export async function readersDuringWrites(t: Target, o: { rounds: number; readers: number; owner: number }): Promise<Report> {
  const r = new Report("reads during writes");
  const c = await create(t, o.owner, freshName("rw"), payloadFor(0));
  const id = c.json.id as string;
  const fmtSeen = new Map<number, string>([[1, canon(payloadFor(0))]]); // spark rev -> payload canon, from acks
  const nameAt = new Map<number, string>([[1, c.json.name]]);
  const acked: Ack[] = [ackOf(c)!];
  const obs: { fr: number; lr: number; payload: any; name: string; reader: number }[] = [];
  let stop = false;
  const readerLoop = async (rid: number) => {
    while (!stop) {
      const g = await read(t, id);
      if (g.status === 200) obs.push({ fr: g.json.formats["spark/1"].rev, lr: g.json.layout_rev, payload: g.json.payload, name: g.json.name, reader: rid });
      else r.check(false, `reader got ${g.status}`);
      const list = await t.call({ method: "GET", path: `/v1/layouts?format=spark/1&full=1&limit=5` });
      r.check(list.status === 200, `list ${list.status}`);
    }
  };
  const readers = Array.from({ length: o.readers }, (_, i) => readerLoop(i));
  let seed = 1;
  for (let k = 1; k <= o.rounds; k++) {
    const nm = freshName("rwn");
    const s = seed++;
    const [a, b] = await Promise.all([put(t, o.owner, id, k, payloadFor(s)), rename(t, o.owner, id, k, nm)]);
    r.check(a.status === 200 && b.status === 200, `round ${k}: writes ${a.status}/${b.status}`);
    if (a.status === 200) { fmtSeen.set(k + 1, canon(payloadFor(s))); acked.push(ackOf(a)!); }
    if (b.status === 200) { nameAt.set(k + 1, nm); acked.push(ackOf(b)!); }
  }
  stop = true;
  await Promise.all(readers);
  let bad = 0;
  for (const x of obs) {
    const ok = canon(x.payload) === fmtSeen.get(x.fr) && payloadIsIntact(x.payload) && nameAt.get(x.lr) === x.name;
    if (!ok) { bad++; r.check(false, `torn read: spark rev ${x.fr} layout_rev ${x.lr} name ${x.name} payload seed ${seedOf(x.payload)}`); }
  }
  for (let rid = 0; rid < o.readers; rid++) {
    const mine = obs.filter((x) => x.reader === rid);
    r.check(mine.every((x, i) => i === 0 || (x.fr >= mine[i - 1]!.fr && x.lr >= mine[i - 1]!.lr)), `reader ${rid}: revisions went backwards`);
  }
  r.stats["observations"] = obs.length;
  r.stats["torn"] = bad;
  await checkDb(t, r, [id]);
  await checkLedger(t, r, acked, [id]);
  return r;
}

/** S5: unary-alt payload edge cases through the API: 3 per key, the cap probe, duplicates, round trip through every read path. */
export async function unaryAltPayloads(t: Target, o: { owner: number }): Promise<Report> {
  const r = new Report("unary alt payloads");
  const mk = (alts: any[]) => ({ keys: payloadFor(0).keys, alts });
  const per = (n: number) => Array.from({ length: n }, (_, j) => ({ ngram: ["a"], fingers: [FINGERS[(j * 3 + 1) % 10]] }));
  for (const n of [1, 2, 3]) {
    const p = mk(per(n));
    const c = await create(t, o.owner, freshName(`ua${n}`), p);
    r.check(c.status === 201 && canon(c.json.payload) === canon(p), `${n} unary alts on one key: ${c.status}`);
    const id = c.json.id;
    for (const path of [`/v1/layouts/${id}?format=spark/1`, `/v1/layouts/${id}/rev/1?format=spark/1`]) {
      const g = await t.call({ method: "GET", path });
      r.check(canon(g.json.payload) === canon(p), `${n} alts round trip via ${path}`);
    }
    const stored = await t.sql("SELECT payload_json FROM layout_formats WHERE layout_id = ?", id);
    r.check(canon(JSON.parse(stored[0]!.payload_json)) === canon(p), `${n} alts stored form`);
  }
  // Documented: NO per-key cap (22-spark-spec §5a: only "duplicate unary key/finger assignments are refused"). Probe 4 and 10.
  for (const n of [4, 10]) {
    const c = await create(t, o.owner, freshName(`ucap${n}`), mk(per(n)));
    r.stats[`unary_${n}_per_key_status`] = c.status;
    r.check(c.status === 201, `${n} distinct-finger unary alts on one key: ${c.status} ${JSON.stringify(c.json).slice(0, 160)} (docs allow any number of distinct fingers)`);
  }
  const dup = await create(t, o.owner, freshName("udup"), mk([...per(2), per(1)[0]]));
  r.check(dup.status === 400 && dup.json?.error === "invalid_payload", `exact duplicate unary alt: ${dup.status} ${dup.json?.error}`);
  const dupBefore = Number((await t.sql("SELECT COUNT(*) c FROM layouts"))[0]!.c);
  // Concurrent creates of an invalid and valid payload: the invalid one leaves no trace.
  const mix = await Promise.all([create(t, o.owner, freshName("umix"), mk([...per(2), per(1)[0]])), create(t, o.owner, freshName("umix"), mk(per(3)))]);
  r.check(mix[0].status === 400 && mix[1].status === 201, `mixed invalid/valid concurrent: ${mix.map((x) => x.status)}`);
  r.check(Number((await t.sql("SELECT COUNT(*) c FROM layouts"))[0]!.c) === dupBefore + 1, "an invalid payload created a layout row");
  // Unary alt naming a char that is not on the layout, wrong arity, wildcard in a unary: all 400, nothing written.
  const evBefore = Number((await t.sql("SELECT COUNT(*) c FROM events"))[0]!.c);
  for (const bad of [[{ ngram: ["z"], fingers: ["LI"] }], [{ ngram: ["a"], fingers: ["LI", "LM"] }], [{ ngram: [null], fingers: [null] }], [{ ngram: ["a"], fingers: [null] }], [{ ngram: ["a"], fingers: ["XX"] }]]) {
    const x = await create(t, o.owner, freshName("ubad"), mk(bad));
    r.check(x.status === 400, `bad unary ${JSON.stringify(bad)} -> ${x.status}`);
  }
  r.check(Number((await t.sql("SELECT COUNT(*) c FROM events"))[0]!.c) === evBefore, "refused payloads wrote events");
  await checkDb(t, r);
  return r;
}

/** S6: delete / restore / recreate / format-write races on a small set of layouts. */
export async function deleteRecreateRaces(t: Target, o: { rounds: number; owner: number }): Promise<Report> {
  const r = new Report("delete/recreate races");
  const touched: string[] = [];
  const acked: Ack[] = [];
  for (let k = 0; k < o.rounds; k++) {
    const name = freshName("dr");
    const c = await create(t, o.owner, name, payloadFor(k));
    const id = c.json.id as string;
    touched.push(id);
    acked.push(ackOf(c)!);
    // DELETE, PUT (same snapshot), and a concurrent create of the same name racing the tombstone.
    const res = await Promise.all([del(t, o.owner, id, 1), put(t, o.owner, id, 1, payloadFor(k + 1000)), create(t, o.owner + 1, name, payloadFor(k + 2000)), put(t, o.owner, id, 1, payloadFor(k + 3000))]);
    const [d, p1, c2, p2] = res;
    r.check(d.status === 200, `round ${k}: delete ${d.status} ${JSON.stringify(d.json).slice(0, 120)}`);
    for (const p of [p1, p2]) r.check([200, 404, 409].includes(p.status), `round ${k}: put during delete ${p.status} ${JSON.stringify(p.json).slice(0, 120)}`);
    r.check(p1.status !== 200 || p2.status !== 200, `round ${k}: two format writes at spark:1 both won`);
    for (const x of res) { const a = ackOf(x); if (a) acked.push(a); }
    if (c2.status === 201) touched.push(c2.json.id);
    r.check(c2.status === 201 || (c2.status === 409 && c2.json?.error === "name_taken"), `round ${k}: recreate ${c2.status} ${JSON.stringify(c2.json).slice(0, 120)}`);
    // The name is held by at most one live layout; restore of the tombstone is refused while a live one holds it.
    const live = await t.sql("SELECT id FROM layouts WHERE name = ? AND deleted = 0", name);
    r.check(live.length <= 1, `round ${k}: ${live.length} live holders of ${name}`);
    const rs = await restore(t, o.owner, id);
    if (c2.status === 201) r.check(rs.status === 409 && rs.json?.error === "name_taken", `round ${k}: restore over a live name -> ${rs.status} ${rs.json?.error}`);
    else r.check(rs.status === 200 || (rs.status === 409 && rs.json?.error === "name_taken"), `round ${k}: restore -> ${rs.status} ${rs.json?.error}`);
    const a = ackOf(rs);
    if (a) acked.push(a);
    // Tombstone is still a record by id; a PUT with the right rev against a deleted layout is refused and writes nothing.
    r.count("rounds_ok");
  }
  await checkDb(t, r, touched);
  await checkLedger(t, r, acked, touched);
  return r;
}

/** S7: likes (L1-L4) racing each other and edits. */
export async function likeRaces(t: Target, o: { likers: number; owner: number }): Promise<Report> {
  const r = new Report("likes");
  const c = await create(t, o.owner, freshName("lk"), payloadFor(0));
  const id = c.json.id as string;
  const likeOf = (u: number) => t.call({ method: "PUT", path: `/v1/layouts/${id}/like`, user: u });
  const unlikeOf = (u: number) => t.call({ method: "DELETE", path: `/v1/layouts/${id}/like`, user: u });
  // the same user 6 times at once -> one 2xx, five already_liked; plus distinct users with concurrent edits
  const same = await Promise.all(Array.from({ length: 6 }, () => likeOf(200)));
  r.check(same.filter((x) => x.status < 300).length === 1, `same-user concurrent likes: ${same.map((x) => x.status)}`);
  for (const x of same.filter((y) => y.status >= 300)) r.check(x.status === 409 && x.json?.error === "already_liked", `like loser ${x.status} ${x.json?.error}`);
  const edits = Array.from({ length: 5 }, (_, i) => put(t, o.owner, id, 1 + 0 * i, payloadFor(10 + i)));
  const mixed = await Promise.all([...Array.from({ length: o.likers }, (_, i) => likeOf(300 + i)), ...edits]);
  r.check(mixed.slice(0, o.likers).every((x) => x.status < 300), `distinct likers: ${mixed.slice(0, o.likers).map((x) => x.status)}`);
  r.check(mixed.slice(o.likers).filter((x) => x.status === 200).length === 1, "exactly one concurrent edit wins while liking");
  const g = await read(t, id);
  r.check(g.json.like_count === o.likers + 1, `like_count ${g.json.like_count} want ${o.likers + 1}`);
  r.check(g.json.layout_rev === 1 && g.json.formats["spark/1"].rev === 2, `likes moved a version (L3): layout ${g.json.layout_rev}, spark ${g.json.formats["spark/1"].rev}`);
  const un = await Promise.all([...Array.from({ length: 4 }, () => unlikeOf(200)), ...Array.from({ length: 3 }, () => likeOf(200))]);
  const final = (await read(t, id)).json.like_count;
  const real = Number((await t.sql("SELECT COUNT(DISTINCT user_id) c FROM likes WHERE layout_id = ?", id))[0]!.c);
  r.check(final === real, `like_count ${final} != ${real} distinct likers after unlike/like storm`);
  r.check(un.every((x) => x.status < 300 || (x.status === 409 && ["already_liked", "not_liked"].includes(x.json?.error))), `unlike/like storm statuses ${un.map((x) => x.status)}`);
  await checkDb(t, r, [id]);
  return r;
}

/** S8: Idempotency-Key: N concurrent identical POSTs create exactly one layout; replays return the same body. */
export async function idempotentCreate(t: Target, o: { copies: number; owner: number }): Promise<Report> {
  const r = new Report("idempotent create");
  const name = freshName("idem");
  const key = `stress-${name}`;
  const res = await Promise.all(Array.from({ length: o.copies }, () => create(t, o.owner, name, payloadFor(7), { "Idempotency-Key": key })));
  const created = res.filter((x) => x.status === 201);
  r.check(created.length >= 1, `no 201 among ${res.map((x) => x.status)}`);
  const ids = new Set(created.map((x) => x.json.id));
  r.check(ids.size === 1, `idempotent replays returned ${ids.size} distinct ids`);
  for (const x of res.filter((y) => y.status !== 201)) r.check(x.status === 409 && x.json?.error === "idempotency_in_progress", `unexpected ${x.status} ${x.json?.error}`);
  const rows = await t.sql("SELECT COUNT(*) c FROM layouts WHERE name = ?", name);
  r.check(Number(rows[0]!.c) === 1, `${rows[0]!.c} layouts created for one key`);
  const again = await create(t, o.owner, name, payloadFor(7), { "Idempotency-Key": key });
  r.check(again.status === 201 && ids.has(again.json.id), `replay after completion: ${again.status}`);
  const mismatch = await create(t, o.owner, name + "x", payloadFor(8), { "Idempotency-Key": key });
  r.check(mismatch.status === 422 && mismatch.json?.error === "idempotency_mismatch", `different body, same key: ${mismatch.status} ${mismatch.json?.error}`);
  r.stats["in_progress_409"] = res.filter((x) => x.status === 409).length;
  await checkDb(t, r, [...ids]);
  return r;
}

/** S9 (admin + R2): dumps taken while writes land (several layouts, continuously) must each be internally consistent. */
export async function dumpDuringWrites(t: Target, o: { owner: number; dumps: number; writers: number }): Promise<Report> {
  const r = new Report("dump during writes");
  const ids: string[] = [];
  const acked: Ack[] = [];
  for (let i = 0; i < o.writers; i++) { const c = await create(t, o.owner + i, freshName("dmp"), payloadFor(0)); ids.push(c.json.id); acked.push(ackOf(c)!); }
  let stop = false;
  const writers = ids.map(async (id, i) => {
    let rev = 1, seed = 1;
    while (!stop) {
      const x = await put(t, o.owner + i, id, rev, payloadFor(seed++));
      if (x.status === 200) { rev++; acked.push(ackOf(x)!); } else r.check(false, `writer ${x.status}`);
      if (Math.random() < 0.2) { const y = await rename(t, o.owner + i, id, 1 + Math.floor((rev - 1) / 1000), freshName("dmpn")); if (y.status === 200) acked.push(ackOf(y)!); }
    }
  });
  await new Promise((res) => setTimeout(res, 30));
  let torn = 0;
  for (let k = 0; k < o.dumps; k++) {
    const d = await t.call({ method: "POST", path: "/v1/admin/dump", user: BOOTSTRAP_ADMIN });
    if (!r.check(d.status === 200 || d.status === 201, `admin dump -> ${d.status} ${JSON.stringify(d.json).slice(0, 160)}`)) break;
    const latest = await t.call({ method: "GET", path: "/v1/dump/latest.json" });
    const file = await t.call({ method: "GET", path: `/v1/dump/${latest.json.key}` });
    if (!r.check(file.status === 200 && file.bytes !== undefined, `GET /v1/dump/${latest.json.key} -> ${file.status}`)) break;
    const dump = JSON.parse(await new Response(new Blob([file.bytes!]).stream().pipeThrough(new DecompressionStream("gzip"))).text());
    const before = torn;
    const evSeqs: number[] = dump.events.map((e: any) => e.seq);
    r.check(evSeqs.every((v, i) => v === i + 1), `dump ${k}: events not gapless`);
    r.check(evSeqs.length >= d.json.seq, `dump ${k}: file has  events, fewer than its manifest seq ${d.json.seq} (MF-13: a dump may be ahead of meta.seq, never behind)`);
    if (evSeqs.length > d.json.seq) r.count("dump_ahead_of_manifest");
    const bumping = dump.events.filter((e: any) => e.rev !== null).length;
    if (!r.check(bumping === dump.layout_revs.length, `dump ${k}: rev-bumping events ${bumping} != layout_revs ${dump.layout_revs.length} (TORN DUMP)`)) torn++;
    const fmtBy = new Map<string, any>(dump.layout_formats.map((f: any) => [`${f.layout_id}|${f.lineage}`, f]));
    for (const l of dump.records) {
      const hist = dump.layout_revs.filter((x: any) => x.layout_id === l.id);
      if (hist.length !== l.n) { torn++; r.check(false, `dump ${k}: layout ${l.id} n=${l.n} but ${hist.length} layout_revs rows (TORN DUMP)`); }
      const f = fmtBy.get(`${l.id}|spark`);
      const sh = hist.filter((x: any) => x.lineage === "spark");
      if (f && f.rev !== sh.length) { torn++; r.check(false, `dump ${k}: layout ${l.id} spark rev ${f.rev} != history ${sh.length} (TORN DUMP)`); }
      if (f && sh.length && f.payload_json !== sh[sh.length - 1].payload_json) { torn++; r.check(false, `dump ${k}: layout ${l.id} payload_json != latest history payload (TORN DUMP)`); }
    }
    r.check(dump.records.filter((l: any) => !l.deleted).length === d.json.layout_count, `dump ${k}: manifest layout_count ${d.json.layout_count} != live ${dump.records.filter((l: any) => !l.deleted).length}`);
    r.count("dumps");
    r.stats["dump_events_last"] = evSeqs.length;
    void before;
  }
  stop = true;
  await Promise.all(writers);
  r.stats["torn_dumps"] = torn;
  await checkDb(t, r, ids);
  await checkLedger(t, r, acked, ids);
  return r;
}

// ---- soak ----------------------------------------------------------------------------------------------------------
function mulberry32(a: number): () => number {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface SoakOpts {
  durationMs: number;
  workers: number;
  owners: number;
  layouts: number;
  seed: number;
  log?: (s: string) => void;
}

/** Randomized mixed traffic for `durationMs`, then every invariant on the quiesced database. */
export async function soak(t0: Target, o: SoakOpts): Promise<Report> {
  const r = new Report("soak");
  r.log = o.log;
  const t: Target = { sql: (q, ...p) => t0.sql(q, ...p), call: async (c) => { const x = await t0.call(c); x.req = c; return x; } };
  const rnd = mulberry32(o.seed);
  const pick = <T,>(a: T[]): T => a[Math.floor(rnd() * a.length)]!;
  const log = o.log ?? (() => {});
  const hist: Record<string, number> = {};
  const note = (op: string, st: number) => { hist[`${op} ${st}`] = (hist[`${op} ${st}`] ?? 0) + 1; };
  const acked: Ack[] = [];
  type L = { id: string; owner: number; name: string; lrev: number; frev: number; deleted: boolean };
  const pool: L[] = [];
  const touched = new Set<string>();
  let seed = 1, names = 0, stop = false, backoff = 0;
  const fail = (op: string, x: Res) => r.check(false, `${op}: unexpected ${x.status} ${x.json?.error ?? ""} for ${x.req?.method} ${x.req?.path} user=${x.req?.user} if-match=${x.req?.headers?.["If-Match"] ?? "-"} body=${JSON.stringify(x.req?.body)?.slice(0, 120)} -> ${JSON.stringify(x.json).slice(0, 400)}`);
  const sync = (l: L, x: Res) => { // adopt the server's view from any layout-shaped body
    const j = x.json?.record ?? x.json;
    if (j && typeof j.layout_rev === "number" && j.id === l.id) {
      l.lrev = Math.max(l.lrev, j.layout_rev); l.deleted = j.deleted; l.name = j.name;
      const f = j.formats?.["spark/1"]; if (f) l.frev = Math.max(l.frev, f.rev);
    }
  };
  const keep = (x: Res) => { const a = ackOf(x); if (a) acked.push(a); };
  const ok429 = async (x: Res) => { if (x.status === 429) { backoff++; await new Promise((res) => setTimeout(res, 250)); return true; } return false; };

  // seed the pool
  for (let i = 0; i < o.layouts; i++) {
    const owner = i % o.owners;
    const nm = freshName("sk");
    const c = await create(t, owner, nm, payloadFor(seed++));
    if (c.status !== 201) { fail("seed create", c); continue; }
    keep(c); touched.add(c.json.id);
    pool.push({ id: c.json.id, owner, name: nm, lrev: 1, frev: 1, deleted: false });
  }

  const ops: [string, number, (l: L) => Promise<unknown>][] = [
    ["put-known", 14, async (l) => { // base rev from the local cache: stale by design when another worker was faster
      const x = await put(t, l.owner, l.id, l.frev, payloadFor(seed++)); note("put-known", x.status);
      if (await ok429(x)) return; keep(x); sync(l, x);
      if (x.status === 200) l.frev = Math.max(l.frev, ackOf(x)!.rev);
      else if (!(isStale(x) || x.status === 404)) fail("put-known", x);
    }],
    ["put-fresh", 12, async (l) => {
      const g = await read(t, l.id); if (g.status !== 200) { note("put-fresh/read", g.status); return; }
      sync(l, g);
      if (g.json.deleted) return;
      const x = await put(t, l.owner, l.id, g.json.formats["spark/1"].rev, payloadFor(seed++)); note("put-fresh", x.status);
      if (await ok429(x)) return; keep(x); sync(l, x);
      if (!(x.status === 200 || isStale(x) || x.status === 404)) fail("put-fresh", x);
    }],
    ["rename", 8, async (l) => {
      const x = await rename(t, l.owner, l.id, l.lrev, freshName("skr")); note("rename", x.status);
      if (await ok429(x)) return; keep(x); sync(l, x);
      if (!(x.status === 200 || isStale(x) || x.status === 404 || (x.status === 409 && x.json?.error === "name_taken"))) fail("rename", x);
    }],
    ["delete", 3, async (l) => {
      const x = await del(t, l.owner, l.id, l.lrev); note("delete", x.status);
      if (await ok429(x)) return; keep(x); sync(l, x);
      if (!(x.status === 200 || isStale(x) || x.status === 404)) fail("delete", x);
    }],
    ["restore", 8, async (l0) => {
      const gone = pool.filter((p) => p.deleted);
      const l = gone.length > 0 && rnd() < 0.8 ? pick(gone) : l0;
      const x = await restore(t, l.owner, l.id); note("restore", x.status);
      if (await ok429(x)) return; keep(x); sync(l, x);
      if (!(x.status === 200 || x.status === 404 || (x.status === 409 && ["name_taken", "stale"].includes(x.json?.error)) || (x.status === 400 && /is not deleted/.test(x.json?.message ?? "")))) fail("restore", x);
    }],
    ["create", 8, async () => {
      const owner = Math.floor(rnd() * o.owners);
      const clash = rnd() < 0.25 && pool.length > 0; // sometimes collide with an existing (maybe live) name, any case
      const nm = clash ? (rnd() < 0.5 ? pick(pool).name.toUpperCase() : pick(pool).name) : freshName("skn");
      const x = await create(t, owner, nm, payloadFor(seed++)); note("create", x.status);
      if (await ok429(x)) return;
      if (x.status === 201) { keep(x); touched.add(x.json.id); pool.push({ id: x.json.id, owner, name: nm, lrev: 1, frev: 1, deleted: false }); }
      else if (!(x.status === 409 && x.json?.error === "name_taken") && !(x.status === 400 && x.json?.error === "invalid_name")) fail("create", x);
    }],
    ["like", 6, async (l) => {
      const u = 1000 + Math.floor(rnd() * 40);
      const x = rnd() < 0.7 ? await t.call({ method: "PUT", path: `/v1/layouts/${l.id}/like`, user: u }) : await t.call({ method: "DELETE", path: `/v1/layouts/${l.id}/like`, user: u });
      note("like", x.status);
      if (await ok429(x)) return;
      if (!(x.status < 300 || x.status === 404 || (x.status === 409 && ["already_liked", "not_liked"].includes(x.json?.error)))) fail("like", x);
    }],
    ["get", 14, async (l) => {
      const x = await read(t, l.id); note("get", x.status);
      if (x.status === 200) {
        r.check(x.json.formats["spark/1"].rev >= 1 && payloadIsIntact(x.json.payload), `get ${l.id}: payload not intact / rev ${x.json.formats["spark/1"].rev}`);
      } else fail("get", x);
    }],
    ["history", 4, async (l) => {
      const x = await t.call({ method: "GET", path: `/v1/layouts/${l.id}/history` }); note("history", x.status);
      if (x.status !== 200) return fail("history", x);
      const revs = x.json.filter((e: any) => e.format === "spark/1").map((e: any) => e.rev);
      r.check(revs.every((v: number, i: number) => v === i + 1), `history ${l.id}: spark revs ${revs.join(",")}`);
      const seqs = x.json.map((e: any) => e.seq);
      r.check(seqs.every((v: number, i: number) => i === 0 || v > seqs[i - 1]), `history ${l.id}: seq not increasing`);
    }],
    ["rev", 4, async (l) => {
      const n = 1 + Math.floor(rnd() * Math.max(1, l.frev));
      const x = await t.call({ method: "GET", path: `/v1/layouts/${l.id}/rev/${n}?format=spark/1` }); note("rev", x.status);
      if (x.status === 200) r.check(payloadIsIntact(x.json.payload), `rev ${n} of ${l.id}: payload not intact`);
      else if (x.status !== 404) fail("rev", x);
    }],
    ["list-full", 3, async () => {
      const x = await t.call({ method: "GET", path: "/v1/layouts?format=spark/1&full=1&limit=50" }); note("list-full", x.status);
      if (x.status !== 200) return fail("list-full", x);
      for (const it of x.json.items) if (it.name.startsWith("sk-") && !payloadIsIntact(it.payload)) r.check(false, `list full: payload of ${it.id} not intact`);
    }],
    ["list-alts", 2, async () => {
      const x = await t.call({ method: "GET", path: "/v1/layouts?format=spark/1&has_alts=true&limit=50" }); note("list-alts", x.status);
      if (x.status !== 200) return fail("list-alts", x);
      for (const it of x.json.items) r.check(it.formats["spark/1"].has_alts === true, `has_alts list returned ${it.id} with has_alts=false`);
    }],
  ];
  const total = ops.reduce((a, b) => a + b[1], 0);
  const chooseOp = () => { let k = rnd() * total; for (const op of ops) { k -= op[1]; if (k <= 0) return op; } return ops[0]!; };

  // sequence monotonicity probe: /v1/meta.seq and the feed head never move backwards while writers run
  let lastSeq = 0;
  const probe = (async () => {
    while (!stop) {
      const m = await t.call({ method: "GET", path: "/v1/meta" });
      if (m.status === 200) { r.check(m.json.seq >= lastSeq, `/v1/meta.seq went backwards ${lastSeq} -> ${m.json.seq}`); lastSeq = Math.max(lastSeq, m.json.seq); }
      const f = await t.call({ method: "GET", path: `/v1/changes?since=${Math.max(0, lastSeq - 20)}&limit=100` });
      if (f.status === 200) { const s = f.json.items.map((e: any) => e.seq); r.check(s.every((v: number, i: number) => i === 0 || v === s[i - 1] + 1), `feed window has a gap: ${s.join(",")}`); }
      await new Promise((res) => setTimeout(res, 300));
    }
  })();

  const tStart = Date.now(), end = tStart + o.durationMs;
  let nextLog = tStart + 30000, iterations = 0;
  const worker = async () => {
    while (Date.now() < end) {
      iterations++;
      const op = chooseOp();
      // 60% of the traffic hits 8 hot layouts so same-scope conflicts are the norm, not the exception
      const l = pool.length > 0 ? (rnd() < 0.6 ? pool[Math.floor(rnd() * Math.min(8, pool.length))]! : pick(pool)) : undefined;
      try { await op[2](l ?? ({ id: "none", owner: 0, name: "", lrev: 1, frev: 1, deleted: false })); }
      catch (e) { r.check(false, `${op[0]} threw: ${String(e).slice(0, 200)}`); }
      if (Date.now() > nextLog) { nextLog = Date.now() + 30000; log(`  ${Math.round((Date.now() - tStart) / 1000)}s iterations=${iterations} acked=${acked.length} layouts=${pool.length} seq~${lastSeq} failures=${r.failures.length}`); }
    }
  };
  await Promise.all(Array.from({ length: o.workers }, worker));
  stop = true; await probe;
  r.stats["iterations"] = iterations;
  r.stats["backoff_429"] = backoff;
  r.stats["layouts_created"] = pool.length;
  r.stats["seconds"] = Math.round((Date.now() - tStart) / 1000);
  log(`soak traffic done: ${iterations} ops, ${acked.length} acked writes; checking invariants`);

  const ids = [...touched];
  await checkDb(t, r);
  await checkFeed(t, r);
  await checkLedger(t, r, acked, ids);
  // every layout read back equals the table
  let compared = 0;
  for (const id of ids) {
    const g = await t.call({ method: "GET", path: `/v1/layouts/${id}?format=spark/1` });
    const row = (await t.sql("SELECT l.layout_rev, l.deleted, f.rev, f.payload_json FROM layouts l JOIN layout_formats f ON f.layout_id = l.id AND f.lineage = 'spark' WHERE l.id = ?", id))[0];
    if (!row) { r.check(false, `layout ${id} has no row`); continue; }
    // deleted layouts still read by id
    if (g.status !== 200) { r.check(false, `final GET ${id} -> ${g.status}`); continue; }
    r.check(g.json.layout_rev === Number(row.layout_rev) && g.json.formats["spark/1"].rev === Number(row.rev) && canon(g.json.payload) === canon(JSON.parse(row.payload_json)) && g.json.deleted === (Number(row.deleted) === 1), `final read of ${id} differs from its row`);
    compared++;
  }
  r.stats["final_compared"] = compared;
  const sorted = Object.entries(hist).sort();
  log("status histogram:\n  " + sorted.map(([k, v]) => `${k}: ${v}`).join("\n  "));
  return r;
}
