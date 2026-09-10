# 19 — Upcast on write: one stored major, a chain of converters

Status: proposal round 2 (2026-09-10), branch `ldb-upcast` off `ldb-v3`.
Round 1 (same day) proposed a `home()` rank that let older-major records
sit next to newer ones. saltorbit's decisions replace it:

1. **Always store the latest major.** A write in an older major is upcast
   and stored at the lineage's current major.
2. **Converters are a chain.** Every major ships exactly one step up from
   and one step down to the previous major. Crossing several majors is
   several steps.
3. **Every layout is available at every major.** A dump of all layouts at
   a given major must be queryable.

This document is the design under those three. It amends `01 §1` (records
no longer keep their written format forever within a lineage), `01 §4`/`§5`
(the directory contract), `03 §3`/`§5` (PUT, events, dumps).

## 0. The gap this closes

`replaceLayout` (`src/core/write.ts`) stores `body.format`/`body.payload`
as written, and `03 §3` lets `format` change on `PUT`. When `akl/2` exists,
a client still speaking `akl/1` (the bot's `mirror!`: `fetchFreshAkl1` then
`PUT {format: "akl/1"}`) that touches an `akl/2` record would flip it back
to `akl/1` and drop every `akl/2`-only field, with an ordinary `updated`
event. Today's three formats don't trigger it — every day-1 writer writes
*into* `akl/1`, the hub — so this is forward-looking, and it is the kind of
corner `01` was written not to paint: a flipped record cannot be
un-flipped.

## 1. Terms

- **lineage** — the `<name>` in a format id. `akl/1`, `akl/2` share one;
  `cmini/1` is its own, `mana2/1` its own.
- **latest(L)** — the highest registered major of lineage `L`.
- **hub** — `akl` (`01 §4`); every cross-lineage pair composes through it.
- **step** — `up_N: <L>/<N−1> → <L>/<N>` and `down_N: <L>/<N> → <L>/<N−1> | held`,
  the only two converters a major ships within its lineage.
- **chain** — the composition of steps between two majors of one lineage.
- **cross edge** — a `to`/`from` between lineages (`cmini/1 ↔ akl/1`,
  `mana2/1 ↔ akl/1`), pinned to the major it was written against.

## 2. Storage rule

**A record is stored at `latest(lineage(record.format))`.** Always. Three
ways a record could be anywhere else, and what happens in each:

| how | what happens |
|---|---|
| a write arrives in an older major (§3) | upcast through the chain at write time; stored at latest; the event says what it was written as |
| a new major is registered (§5) | every record of that lineage is migrated up by a bounded, idempotent cron step; each gets a `migrated` event |
| a rev in `layout_revs` predates the bump | history is never rewritten; `/rev/{n}` reads translate on the way out like any read (`?as=`) |

`01 §1`'s "stored exactly as written, never rewritten in place by a schema
change" becomes: *stored at the lineage's latest major; the bytes the
writer sent are the rev's `layout_revs` row when they were already latest,
and `detail.written_as` names the older major otherwise.* The event log is
still the truth; the record is still its fold.

Cross-lineage is unchanged: a `cmini/1` record stays `cmini/1` (its
lineage's latest *is* 1). A `PUT` in a different lineage is a **move**,
exactly as `03 §3` has it today ("an author moving their layout from
`cmini/1` to `akl/1`"), guarded by §3 R1 like any other cross-format write.

## 3. Writes in an older major

`PUT {format: F, payload}` on a record `(G, current)`, `F ≠ G`,
`If-Match` satisfied (`LDB-P2`).

**R1 · Visibility.** `view = translate(current, F)` (the same path a
`GET ?as=F` walks, §4.2). If it is held, the client could never have read
this record whole in `F`, so this is a blind overwrite. Refuse:

```
409 { "error": "format_behind", "format": "akl/1", "see": "akl/2", "rev": 7,
      "message": "this record uses akl/2 features that akl/1 cannot show; write it as akl/2, or PATCH the field you mean to change" }
```

**R2 · Store at latest.** Otherwise:

- same lineage: `stored = chain(F → latest(L))(payload)`, format `latest(L)`;
- different lineage: a move — `stored = payload` in `F` if `F` is its
  lineage's latest, else `chain(F → latest(lineage(F)))(payload)`. The
  record's lineage changes; §2's rule then holds in the new one.

**R3 · Down is honest.** Within a lineage, `down_N` returns `held` whenever
*anything* would be lost — never a documented-lossy projection. That is
what makes R1 sufficient: a write that passes R1 replaces a record whose
`latest`-only content was empty, so a pure upcast of the write loses
nothing. Cross edges may stay documented-lossy (`cmini/1` cannot hold
colstag amounts, `01 §6.2`); the chain may not.

**R4 · Writer's-view identity** (test-time): after an accepted write,
`translate(stored, F) ≡ payload` under `canonical()`. What you wrote is
what you read back.

**Validation.** `payload` validates against `F` first (`LDB-F1`); the
chained result validates against the stored format before commit (the
re-run `patchLayout` already does). A step that yields an invalid payload
is a format bug: `500`, never a stored invalid record.

**Not in v1, reserved:** a base-aware step (`up_N(p, base?)`) that carries
`latest`-only content forward when the visible part is unchanged, so an
old client could edit a record R1 currently refuses. The signature can
grow later without touching any caller; the `written_as` breadcrumb and
R4 already give it its test.

`POST` in an older major: same as R2's chain, no R1 (there is no record).
`PATCH` is unchanged: edits run on the stored (latest) payload through the
format's own `edits`; verb bodies are versioned with `/v1/`, so a new hub
major's `edits` accept the `/v1/` shapes (`09 §3 T4`).

## 4. The chain

### 4.1 Directory contract (`01 §4` amended)

```
db/formats/<name>/<N>/
  schema.json
  index.ts        validate, lower, hasMagic, edits
                  up:   (p: <name>/<N−1>) => <name>/<N>            required for N > 1
                  down: (p: <name>/<N>)   => <name>/<N−1> | Held   required for N > 1
                  to:   { "<other>/<M>": fn }   optional cross edges, any major M of the other lineage
                  from: { "<other>/<M>": fn }   optional cross edges
  fixtures/       + <fixture>.down.json goldens (or .down.held.json), + <fixture>.up.json for every <N−1> fixture
```

`to`/`from` lose their within-lineage use; a format never lists its own
lineage there. `up`/`down` are the *only* within-lineage converters, so
`akl/3` ships `up` from `akl/2` and `down` to `akl/2` and nothing else;
`akl/1 ↔ akl/3` is two steps, computed by the registry.

A new major is therefore: schema, validate, lower, edits, one `up`, one
`down`, fixtures + goldens, README ("what this major adds; what `down`
holds on"). `LDB-F16` refuses a registration missing any of these.

### 4.2 `translate(rec, as)` walks a path

```
path(from = <L1>/<a>, to = <L2>/<b>):
  L1 == L2:  chain a → b            (up steps if b > a, down steps if b < a)
  else:      chain a → m1   where m1 = the major of L1 that has a cross edge to L2     (to["<L2>/<m2>"])
             cross edge   m1 → <L2>/<m2>
             chain m2 → b
```

A cross edge is pinned to the majors it was written for (`cmini/1.to["akl/1"]`
stays exactly that when `akl/2` lands); the chain covers the rest. So the
hub bumping costs its own `up`/`down` and **zero** changes to any other
lineage. If a lineage later adds a second cross edge at a newer major
(`cmini/1.to["akl/3"]`, say, because `akl/3` can hold something the chain
used to lose), the registry prefers the edge whose chain distance to `to`
is shortest.

The result is held iff any step is held; `see` names the record's native
(latest) format. `GET /v1/formats` advertises, per entry: `lineage`,
`major`, `latest: bool`, and `can_translate_to` computed from the path
function — every reachable format, not just direct edges (`01 §4` already
promised the composed pairs).

### 4.3 Day-1 impact

Nothing moves. `cmini/1`, `akl/1`, `mana2/1` are each `latest` of a
one-major lineage; `up`/`down` are unrequired at `N = 1`; the three cross
edges stay where they are. The chain code is exercised by the stub lineage
in tests (`t/1`, `t/2`, `t/3` via `registerForTest`) until `akl/2` exists.

## 5. Migrating a lineage when a major lands

Registering `akl/2` is a deploy of the Worker. From that moment the
storage rule (§2) is violated for every `akl/1` record until each is
rewritten. Mechanism:

- **A cron job** on the existing `*/5` trigger (`LDB-C5`'s dispatch):
  `migrateTick()` selects up to `MIGRATE_BATCH` (500) records whose
  `format` is below `latest` of its lineage, ordered by id, and rewrites
  each: `payload = chain(format → latest)(payload)`, one **`migrated`**
  event per record — rev-bumping (`LDB-P1`: every payload change is a rev
  and a `layout_revs` row), `modified_at` untouched (like magic-only
  writes: this is not the author's edit), `actor: "system:migration"`,
  `via: "migration"`, `detail: {from: "akl/1", to: "akl/2"}`. Tombstones
  are migrated too (they are restorable; a restore should not resurrect an
  old major).
- **Idempotent and bounded**: a tick with nothing below latest writes
  nothing; 4 174 records is 9 ticks (45 minutes) at 500 — well inside the
  D1 write budget (`d1-write-budget`: 100k rows/day; a migration is ~3
  rows per record: `layouts`, `layout_revs`, `events`).
- **`POST /v1/admin/migrate/tick`** kicks it by hand, event-logged like the
  other admin ticks (`LDB-A5`).
- **`followsUpstream`** (`core/follows.ts`) skips `migrated` events exactly
  as it skips magic-only ones (`LDB-I2a`, `LDB-I12`) — a migration never
  forks a following record.
- **`If-Match` holders** see one `stale` after their record migrates and
  refetch; that is the cost of rev-bumping, paid once per major, and it is
  the honest signal ("the record changed under you") rather than a silent
  rev-less rewrite that `LDB-P1` forbids anyway.
- **The import** (`import/apply.ts`) writes `cmini/1`, a one-major
  lineage; untouched. If cmini ever ships a v4 the same machinery covers
  `cmini/2`.

Between deploy and the last tick, reads are already correct (§4.2 walks
the chain from whatever the record is) and writes are already correct (§3
chains to latest). Only §2's *storage* invariant lags, by design and by a
bounded amount; `LDB-P12` pins that.

## 6. Every layout at every major (dumps)

Three surfaces, none of which needs a second copy of the data:

1. **The list** (`03 §2`): `GET /v1/layouts?as=<L>/<M>&full=1` already
   translates per record and marks the rest `held: true`. It works for any
   registered major of any lineage through §4.2, paged.
2. **The nightly dump** (`LDB-D1`, R2 `akl-db-dumps`): beside `latest.json`
   (native, unchanged), the nightly writes one **`latest.<name>-<N>.json`
   per registered major of every lineage** — every live record as its
   translation to that major, or `{…record fields, held: true, see}` when
   the chain holds. Monthly copies follow the same pattern. A consumer on
   `akl/1` fetches `latest.akl-1.json` and never sees a shape it does not
   speak. Cost: one file per major; the dump job is already a full table
   walk.
3. **`/v1/changes`** (`03 §5`) carries records without payloads;
   consumers fetch payloads with `?as=`. Unchanged.

Not proposed: a materialised `layout_views(layout_id, format, payload)`
table refreshed on every write. It is the fallback if on-demand
translation proves slow in the list (it will not for a two-step chain over
4 000 records), and it would multiply every write's D1 rows by the number
of majors, which the budget memo says to avoid. If it is ever needed, the
same `path()` populates it; nothing in this design precludes it.

## 7. `replaceLayout` after the change

```ts
requireIfMatch(ifMatch);
const { record, admin } = await loadForWrite(db, ref, actor, { allowDeleted: false });
await requireRev(db, record, ifMatch);
validatePayload(body.format, body.payload);                          // LDB-F1

let format = body.format, payload = body.payload, writtenAs: string | undefined;

if (body.format !== record.format) {
  const view = translate(record, body.format);                       // R1: the GET ?as= path
  if ("held" in view) throw formatBehind(body.format, record.format, record.rev);
}
const target = latestOf(lineage(body.format).name);                  // R2
if (target !== body.format) {
  payload = walk(body.format, target, body.payload);                 // the chain; never held going up
  format = target;
  writtenAs = body.format;
}

const { hasMagic } = validatePayload(format, payload);               // the chained result
const magicOnly = isMagicOnlyReplace(record, format, payload);       // §7.1
return commitWrite(db, now, { kind: "updated", …, format, payload, hasMagic,
  detail: { ...(magicOnly ? { magic_only: true } : {}), ...(writtenAs ? { written_as: writtenAs } : {}) } });
```

### 7.1 `isMagicOnlyReplace`

Its hard-coded `cmini/1 → akl/1` branch (`fromCmini` then compare) becomes
"translate `record.payload` to `format` through the registry, compare
minus magic". Same computation, no literal format ids, and it keeps
working when `format` is `akl/2` and the record is `cmini/1`.

### 7.2 Errors and events

- `src/core/errors.ts`: `formatBehind(format, see, rev)` → `409 format_behind`
  (§3 R1), added to `03 §1`'s table and the conformance sweep.
- `03 §5`: `updated` gains `detail.written_as`; new kind **`migrated`**
  (rev-bumping, §5); `via` gains `"migration"`; `actor` gains
  `"system:migration"`.

## 8. Invariants (the covenant)

| id | invariant | enforced by |
|---|---|---|
| LDB-F16 | **Chain contract.** Every registered `<L>/<N>`, `N > 1`: `<L>/<N−1>` is registered; `up`, `down`, `edits` are exported; `to`/`from` never name the module's own lineage. Over every fixture `p` at `N`: `down(p)` is held **or** `up(down(p)) ≡ p` (down is honest, §3 R3). Over every fixture `q` at `N−1`: `down(up(q)) ≡ q` (up is injective) and `up(q)` validates at `N`. Enumerated from the registry; exercised through the stub lineage until a real `N > 1` exists, and the test proves it catches each missing piece. | `tests/formats/chain.test.ts` (new) |
| LDB-F17 | **Path composition.** `translate(rec, as)` walks `path()` (§4.2): same lineage = the chain, otherwise chain → pinned cross edge → chain; the result is held iff a step is held; `see` is the record's native format; `can_translate_to` in `GET /v1/formats` equals the set of formats `path()` reaches. Goldens: every fixture × every reachable format (`LDB-F7` extended from "declared translation" to "reachable format"). | `tests/formats/goldens.test.ts` (extended), `tests/formats/path.test.ts` (new, stub lineage: 1→3, 3→1, cross edge at a non-latest major) |
| LDB-P11 | **Stored at latest.** (a) A `PUT`/`POST` in `F` stores at `latest(lineage(F))` with `detail.written_as = F` iff `F` was not latest; (b) a `PUT` in `F ≠ record.format` is refused `409 format_behind`, writing nothing, iff `translate(record, F)` is held; (c) after an accepted write, `GET ?as=F` returns the written payload exactly; (d) under any sequence of writes a record's major never decreases. | `tests/api/put-format.test.ts` (new): matrix over every registered pair × {held, not}; property test over random write sequences asserting (d) |
| LDB-P12 | **Migration.** After `migrateTick()` runs to quiescence, no record (live or tombstone) has `format` below its lineage's latest; each migrated record gained exactly one `migrated` event, rev + 1, `layout_revs` row present, `modified_at` unchanged, payload equal to the chain of its previous rev; a tick with nothing to do writes zero rows; one tick touches ≤ `MIGRATE_BATCH`; `followsUpstream` is unchanged by a `migrated` event; the manual admin tick calls the same function. | `tests/import/migrate.test.ts` (new, stub lineage: register `t/2` after seeding `t/1` records; fake clock), `tests/events/follows.test.ts` (extended) |
| LDB-D6 | **Per-major dumps.** The nightly writes `latest.<name>-<N>.json` for every registered major of every lineage; each carries every live record as its translation or as `held: true, see`; sha256 sidecar per file; the native `latest.json` is byte-identical to today's. | `tests/api/dump.test.ts` (extended), `tests/rehost.test.ts` |
| LDB-F9 | unchanged, and now also holds for writes: a held record cannot be overwritten through a format it is held for | `tests/api/held.test.ts` gains the `PUT` case |

`db/INVARIANTS.md` gets the rows; `tests/tools/invariants.test.ts`
(`LDB-T1`) fails until each has a tagged test. `LDB-F5`/`F7`/`F10` keep
their meaning (cross edges are unchanged); `F6`'s frozen-file check is
untouched (the stub lineage lives under `tests/`).

## 9. Work plan

One PR, four commits, each green alone:

1. **Registry** — `lineage()`, `latestOf()`, `path()`, `walk()`,
   `translate` over `path()`; `up`/`down` in `FormatModule` (optional at
   `N = 1`, required otherwise); stub lineage under
   `tests/formats/stub-lineage.ts`; `chain.test.ts`, `path.test.ts`,
   goldens extended; `01 §4`/`§5` amended; `GET /v1/formats` fields.
2. **Write path** — `formatBehind`, `replaceLayout` (§7),
   `isMagicOnlyReplace` (§7.1), `written_as`; `put-format.test.ts`,
   `held.test.ts`'s PUT case, conformance sweep; `03 §1`/`§3`/`§5`.
3. **Migration** — `migrateTick()` on the cron dispatch + admin kick,
   `migrated` event, `followsUpstream` skip; `migrate.test.ts`;
   `INVARIANTS.md` rows.
4. **Dumps** — per-major nightly files + sidecars; `dump.test.ts`,
   `rehost.test.ts`; `08-infrastructure.md` R2 layout note.

No D1 schema change (`layouts.format` and `layout_revs.format` already
carry what is stored; `events.kind` is free text). Deploy is the Worker.
The bot needs nothing for the first deploy: `writeWithFreshRecord` falls
through to `errorText(body.message)` on `format_behind`, and the message
is written to read correctly in Discord; a dedicated string is a
`// COPY: sign-off pending` line for `14-copy-signoff.md` when `akl/2` is
real.

Size: ~200 lines registry, ~60 write path, ~120 migration, ~60 dumps,
~600 tests. One Sonnet agent per commit, the invariant ids as the bar,
Fable review of each diff (`plan-review-before-impl`).

## 10. Non-goals, kept deliberately

- **Same-major `PUT` stays whole-replace.** A client that strips unknown
  optional keys added by a minor drops them; that is what "additive and
  optional" (`01 §5`) buys survivability for, `PATCH` avoids it, and the
  server cannot see which minor a client speaks (minor identifiers were
  rejected in `01 §5`).
- **No base-aware upcast in v1** (§3, reserved). R1 refuses the one case
  it would rescue; that case cannot occur until `akl/2` has a field and a
  record uses it.
- **No materialised per-major table** (§6). Dumps and the list cover
  "every layout at every major" without a second copy.
- **No runtime writer's-view check** (R4 is test-time).
- **Cross edges stay documented-lossy**; only the chain is held-or-lossless.

## 11. Open questions (for saltorbit)

1. **`migrated` bumps `rev`.** It must, for `LDB-P1` (record = fold of
   events, one `layout_revs` row per rev). The visible cost is one `stale`
   per client-held rev per major bump. OK? The alternative — a rev-less
   in-place rewrite — breaks the fold and history.
2. **Tombstones migrate too** (§5). Alternative: migrate on restore. The
   proposal migrates them because a dump at an old major should not have
   to special-case restorable records, and there are few.
3. **Cross-lineage moves keep the permissive rule** (§2: a `PUT` in another
   lineage moves the record, after R1). Alternative: only moves *into* the
   hub. Today's clients only ever move into the hub; the permissive rule
   needs no rank table.
4. **Dump file naming** `latest.<name>-<N>.json` (slash-free for R2 keys)
   vs a prefix per major (`akl-1/latest.json`). Cosmetic; the prefix reads
   better in a bucket listing if monthly copies also fan out.
5. **When a cross edge should be re-pinned** (§4.2: `cmini/1.to["akl/3"]`
   because `akl/3` can hold something the chain from `akl/1` loses). The
   registry prefers the shortest chain to the target; is "shortest" the
   right tie-break, or "highest-major edge"? Same answer for every case
   anyone has named so far; flagging so nobody hard-codes either.
