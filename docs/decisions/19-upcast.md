# 19 — Upcast on write: one stored major, a chain of converters

Status: proposal round 2 (2026-09-10), branch `ldb-upcast` off `ldb-v3`.
Round 1 (same day) proposed a `home()` rank that let older-major records
sit next to newer ones. saltorbit's decisions replace it:

**Amended 2026-09-11 (20-spark.md S7).** This document's `akl` lineage is
renamed `spark` throughout (`01-format.md` decision 1; the payload is
unchanged) — every `akl/N` below reads `spark/N`. The invariant ids below
(`F16`, `F17`, `P11`) are **renumbered** to the ids `20-spark.md` §4
actually reserved for them: `F16`→**`F18`** (chain contract), `F17`→
**`F19`** (path composition), `P11`→**`P13`** (older-major write); `D6`
and `F9` keep their ids. `P12` (migration) also keeps its id — S4's own
record migration (spark's one-time cutover, `20-spark.md` §4) and this
document's chain-major migration are the **same function**,
`core/migrate.ts`'s `migrateTick`, generalised in S5 (§5, "the S4
selection gains `OR major(format) < latest`") rather than two separate
mechanisms. **The chain itself (registry `lineage()`/`latestOf()`/
`path()`/`walk()`, the `up`/`down` slots, `format_behind`, per-major
dumps) is designed here but had not landed as of this writing** —
`20-spark.md` §3 assigns it to slice **S5**, run after S4; §7's ledger
records exactly when it lands and any deviation from the design below.
Also amended: `cmini` is no longer a lineage with a cross edge (decision
2) — it is an unregistered adapter reached through the alias table,
never through `lineage()`/`path()` (§1, §4.2 below).

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
as written, and `03 §3` lets `format` change on `PUT`. When `spark/2` exists,
a client still speaking `spark/1` (the bot's `mirror!`: `fetchFreshAkl1` then
`PUT {format: "spark/1"}` — a name kept from before the rename, still
reading through the `?as=akl/1` alias today) that touches a `spark/2`
record would flip it back to `spark/1` and drop every `spark/2`-only
field, with an ordinary `updated` event. Today's registered formats don't
trigger it — every day-1 writer writes *into* `spark/1`, the hub — so this
is forward-looking, and it is the kind of corner `01` was written not to
paint: a flipped record cannot be un-flipped.

## 1. Terms

- **lineage** — the `<name>` in a format id. `spark/1`, `spark/2` share
  one; `mana2/1` its own. The cmini adapter is **not** a lineage — it has
  no major, no `up`/`down`, and is reached only through the alias table
  (decision 2, `01-format.md` §4), never through `lineage()`.
- **latest(L)** — the highest registered major of lineage `L`.
- **hub** — `spark` (renamed from `akl`, `01 §4`); every cross-lineage
  pair composes through it.
- **step** — `up_N: <L>/<N−1> → <L>/<N>` and `down_N: <L>/<N> → <L>/<N−1> | held`,
  the only two converters a major ships within its lineage.
- **chain** — the composition of steps between two majors of one lineage.
- **cross edge** — a `to`/`from` between lineages. Today: `spark/1 →
  mana2/1` (`to["mana2/1"]`) — one-directional, since `mana2/1`'s own
  registry `to`/`from` are `{}` (decision 3: it is output-only, never a
  translation source). Pinned to the major it was written against.

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

Cross-lineage is unchanged in shape, but the one-stored-format redesign
(decisions 1–2) narrowed which lineages exist: a `PUT` in a different
lineage is still a **move**, guarded by §3 R1 like any other cross-format
write, but with only `spark` and `mana2` registered — and `mana2/1`
refused on write (`role: "output"`) — there is, in phase 1, only ever one
lineage a record can move *into*: `spark`. A write naming the transitional
`akl/1` alias stores the same bytes under `spark/1` (not a separate
`akl` lineage); a write naming `cmini/1` is refused outright
(`unknown_format`, `LDB-F16`) rather than creating a `cmini` lineage
record — cmini is an import adapter, never a write target (decision 2).

## 3. Writes in an older major

`PUT {format: F, payload}` on a record `(G, current)`, `F ≠ G`,
`If-Match` satisfied (`LDB-P2`).

**R1 · Visibility.** `view = translate(current, F)` (the same path a
`GET ?as=F` walks, §4.2). If it is held, the client could never have read
this record whole in `F`, so this is a blind overwrite. Refuse:

```
409 { "error": "format_behind", "format": "spark/1", "see": "spark/2", "rev": 7,
      "message": "this record uses spark/2 features that spark/1 cannot show; write it as spark/2, or PATCH the field you mean to change" }
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
nothing. Cross edges may stay documented-lossy (the cmini adapter cannot
hold colstag amounts, `01 §6.2`); the chain may not.

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

## 4. The chain (**implemented in S5**; not yet landed as of this writing — see the amendment at the top of this document)

### 4.1 Directory contract (`01 §4` amended)

Updated for the registry shape S1 actually landed (`role` replaces the
old registry-level `lower()`; a format's own compile step, if any, is a
plain named export — spark's is `compileMagic`):

```
db/formats/<name>/<N>/
  schema.json
  index.ts        validate, hasMagic, edits
                  role: "stored" | "output"
                  up:   (p: <name>/<N−1>) => <name>/<N>            required for N > 1
                  down: (p: <name>/<N>)   => <name>/<N−1> | Held   required for N > 1
                  to:   { "<other>/<M>": fn }   optional cross edges, any major M of the other lineage
                  from: { "<other>/<M>": fn }   optional cross edges
                  plus whatever named exports the format wants (spark: compileMagic, cminiBoardWord)
  fixtures/       + <fixture>.down.json goldens (or .down.held.json), + <fixture>.up.json for every <N−1> fixture
```

`to`/`from` lose their within-lineage use; a format never lists its own
lineage there. `up`/`down` are the *only* within-lineage converters, so
`spark/3` ships `up` from `spark/2` and `down` to `spark/2` and nothing
else; `spark/1 ↔ spark/3` is two steps, computed by the registry. (The
alias table, `ALIASES`/`LEGACY_STORED`, is a *separate* mechanism —
`akl/1` is not a chain step of the `spark` lineage, and the cmini
adapter is not a lineage at all; `translate()` normalizes a legacy-stored
payload to `spark/1` *before* it ever enters `path()`, decision 12/§1.)

A new major is therefore: schema, validate, `edits`, one `up`, one
`down`, fixtures + goldens, README ("what this major adds; what `down`
holds on"). `LDB-F18` (renumbered from this document's own `F16`, per the
amendment above) refuses a registration missing any of these.

### 4.2 `translate(rec, as)` walks a path

```
path(from = <L1>/<a>, to = <L2>/<b>):
  L1 == L2:  chain a → b            (up steps if b > a, down steps if b < a)
  else:      chain a → m1   where m1 = the major of L1 that has a cross edge to L2     (to["<L2>/<m2>"])
             cross edge   m1 → <L2>/<m2>
             chain m2 → b
```

A cross edge is pinned to the majors it was written for (`spark/1`'s
`to["mana2/1"]` stays exactly that when `spark/2` lands); the chain covers
the rest. So the hub bumping costs its own `up`/`down` and **zero**
changes to any other lineage. If a lineage later adds a second cross edge
at a newer major (an advanced format's `to["spark/3"]`, say, because
`spark/3` can hold something the chain from `spark/1` used to lose), the
registry prefers the edge whose chain distance to `to` is shortest. The
cmini adapter never participates here at all — it is reached only through
`ALIASES`, not `path()` (decision 2).

The result is held iff any step is held; `see` names the record's native
(latest) format. `GET /v1/formats` advertises, per entry: `lineage`,
`major`, `latest: bool`, and `can_translate_to` computed from the path
function — every reachable format, not just direct edges, **aliases
included** (`01 §4`; landed early, in S1, ahead of the rest of this
chapter).

### 4.3 Day-1 impact

Nothing moves. `spark/1` and `mana2/1` are each `latest` of a one-major
lineage (the cmini adapter has no major to speak of); `up`/`down` are
unrequired at `N = 1`; the one real cross edge (`spark/1 → mana2/1`)
stays where it is. The chain code is exercised by the stub lineage in
tests (`t/1`, `t/2`, `t/3` via `registerForTest`) until `spark/2` exists.

## 5. Migrating a lineage when a major lands (**implemented in S5**)

Registering `spark/2` is a deploy of the Worker. From that moment the
storage rule (§2) is violated for every `spark/1` record until each is
rewritten. **This is the same mechanism S4 already built and shipped for
the legacy→spark cutover** (`core/migrate.ts`'s `migrateTick`, `03-api.md`
§7) — S5 generalises its selection rather than adding a second one
(`OR major(format) < latest`, alongside S4's `format != 'spark/<latest>'`).
Mechanism:

- **Amended (decision 11): operator-driven, not a cron.** This document's
  round-2 design put `migrateTick()` on the existing `*/5` import cron
  trigger; c7's request during S4 changed that for the shared function —
  a human (or a script) calls `POST /v1/admin/migrate/tick
  {dry_run, after?, limit? ≤ 100}` (`03-api.md` §7), paged by `next_after`
  until the report says nothing is left, the same way
  `migrate_records_to_spark.py` already drives S4's half. `migrateTick()`
  selects up to `limit` (≤ 100) records ordered by id whose `format` is
  below `latest` of its lineage (S5's own arm, added beside S4's `format
  != 'spark/<latest>'`), and rewrites each: `payload = chain(format →
  latest)(payload)`, one **`migrated`** event per record — rev-bumping
  (`LDB-P1`: every payload change is a rev and a `layout_revs` row),
  `modified_at` untouched (like magic-only writes used to be before
  decision 6 — this is not the author's edit either way), `actor:
  "system:migration"`, `via: "migration"`, `detail: {from: "spark/1", to:
  "spark/2"}`. Tombstones are migrated too (they are restorable; a
  restore should not resurrect an old major). `expectRev` guards every
  write (`LDB-P14`), same as S4's half.
- **Idempotent and bounded**: a tick with nothing below latest writes
  nothing; at a batch of 100 (S4's own sizing, §8 R-M3) 4 174 records is
  ~42 calls — well inside the D1 write budget (`d1-write-budget`: 100k
  rows/day; a migration is ~3 rows per record: `layouts`, `layout_revs`,
  `events`) and Workers Paid's per-invocation query ceiling.
- **`legacyFollows`** (`core/follows.ts`, renamed from `followsUpstream`
  in S3a) skips `migrated` events exactly as it skips historical
  magic-only ones (`LDB-I2a`, `LDB-I12`) — a migration never changes
  `upstream` (`nextUpstream`'s own rule, `03-api.md` §5).
- **`If-Match` holders** see one `stale` after their record migrates and
  refetch; that is the cost of rev-bumping, paid once per major, and it is
  the honest signal ("the record changed under you") rather than a silent
  rev-less rewrite that `LDB-P1` forbids anyway.
- **The import** (`import/apply.ts`) writes `spark/1` (via `fromCmini`,
  since S3b — the importer never writes the cmini shape at all, decision
  2); a one-major lineage today, so this migration mechanism has nothing
  to do for it yet. cmini itself is not a lineage (it has no `up`/`down`,
  §1), so a future cmini v4 would need its own adapter function, not a
  registered `cmini/2` major.

Between deploy and the last tick, reads are already correct (§4.2 walks
the chain from whatever the record is) and writes are already correct (§3
chains to latest). Only §2's *storage* invariant lags, by design and by a
bounded amount; `LDB-P12` pins that (the same id S4 already uses for the
legacy→spark half of this same convergence property).

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
   `spark/1` fetches `latest.spark-1.json` and never sees a shape it does
   not speak. Cost: one file per major; the dump job is already a full
   table walk.
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
const upstream = nextUpstream(await upstreamOf(db, record), "updated", actor.via);   // decision 5/6 (S3a)
return appendWrite(db, now, { kind: "updated", …, format, payload, hasMagic, upstream,
  source: { client: actor.source_client, version },                 // decision 14 (S3s)
  detail: { ...(writtenAs ? { written_as: writtenAs } : {}) },
  expectRev: record.rev });                                          // LDB-P14
```

(Sketch updated for what actually landed by S3s: `commitWrite`/
`isMagicOnlyReplace` don't exist any more — `appendWrite` is the one write
primitive, `Write.upstream`/`Write.source` are required fields, not
optional detail, and every writer passes `expectRev`. `written_as` is
still the one new thing this chapter adds to the shape.)

### 7.1 `isMagicOnlyReplace` — **retired, not adapted (S2, decision 6)**

Round 2's plan generalised this function ("translate `record.payload` to
`format` through the registry, compare minus magic") on the theory that a
magic-only write should keep not forking a following record regardless of
which format it moved through. Decision 6 (`20-spark.md`, taken during
S2, before this chapter's own slice ran) went the other way: **a
magic-only write forks like any other write now**, so `isMagicOnlyReplace`
and the `detail.magic_only` marker it fed were deleted outright in S2,
not carried forward here. `LDB-I12` is narrowed to a historical-events-
only meaning (`03-api.md` §5, `17-magic-ownership.md`) — nothing in this
chapter's own chain-write path needs to re-detect "magic only" for any
reason.

### 7.2 Errors and events

- `src/core/errors.ts`: `formatBehind(format, see, rev)` → `409 format_behind`
  (§3 R1), added to `03 §1`'s table and the conformance sweep.
- `03 §5`: `updated` gains `detail.written_as`; new kind **`migrated`**
  (rev-bumping, §5); `via` gains `"migration"`; `actor` gains
  `"system:migration"`.

## 8. Invariants (the covenant)

**Renumbered (20-spark.md §4, since this document's own ids collided
with ones the redesign claimed first — see the amendment at the top):**
this chapter's `F16` is `F18`, `F17` is `F19`, `P11` is `P13`; `P12` and
`D6` and `F9` keep their ids (`P12` because S5 *generalises* S4's own
migration rather than adding a second one).

| id | invariant | enforced by |
|---|---|---|
| LDB-F18 | **Chain contract.** Every registered `<L>/<N>`, `N > 1`: `<L>/<N−1>` is registered; `up`, `down`, `edits` are exported; `to`/`from` never name the module's own lineage. Over every fixture `p` at `N`: `down(p)` is held **or** `up(down(p)) ≡ p` (down is honest, §3 R3). Over every fixture `q` at `N−1`: `down(up(q)) ≡ q` (up is injective) and `up(q)` validates at `N`. Enumerated from the registry; exercised through the stub lineage until a real `N > 1` exists, and the test proves it catches each missing piece. | `tests/formats/chain.test.ts` (new) |
| LDB-F19 | **Path composition.** `translate(rec, as)` walks `path()` (§4.2): same lineage = the chain, otherwise chain → pinned cross edge → chain; the result is held iff a step is held; `see` is the record's native format; `can_translate_to` in `GET /v1/formats` equals the set of formats `path()` reaches, **aliases included**. Goldens: every fixture × every reachable format (`LDB-F7` extended from "declared translation" to "reachable format"). | `tests/formats/goldens.test.ts` (extended), `tests/formats/path.test.ts` (new, stub lineage: 1→3, 3→1, cross edge at a non-latest major) |
| LDB-P13 | **Older-major write.** (a) A `PUT`/`POST` in `F` stores at `latest(lineage(F))` with `detail.written_as = F` iff `F` was not latest; (b) a `PUT` in `F ≠ record.format` is refused `409 format_behind`, writing nothing, iff `translate(record, F)` is held; (c) after an accepted write, `GET ?as=F` returns the written payload exactly; (d) under any sequence of writes a record's major never decreases. | `tests/api/put-format.test.ts` (new): matrix over every registered pair × {held, not}; property test over random write sequences asserting (d) |
| LDB-P12 | **Migration.** After `migrateTick()` runs to quiescence, no record (live or tombstone) has `format` below its lineage's latest; each migrated record gained exactly one `migrated` event, rev + 1, `layout_revs` row present, `modified_at` unchanged, payload equal to the chain of its previous rev; a tick with nothing to do writes zero rows; one tick touches ≤ its own `limit`; `legacyFollows`/`upstream` are unchanged by a `migrated` event (`nextUpstream`); the manual admin tick calls the same function. **Already landed for S4's legacy→spark half** (`03-api.md` §7); S5 generalises the same id's selection to major upgrades, it does not add a second invariant. | `tests/import/migrate.test.ts` (S4's; extended in S5 with a stub lineage: register `t/2` after seeding `t/1` records; fake clock), `tests/events/follows.test.ts` |
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
2. **Write path** — `formatBehind`, `replaceLayout` (§7), `written_as`
   (§7.1's `isMagicOnlyReplace` is **not** part of this any more — it was
   deleted in S2, decision 6, before this slice runs); `put-format.test.ts`,
   `held.test.ts`'s PUT case, conformance sweep; `03 §1`/`§3`/`§5`.
3. **Migration** — extend the already-landed `migrateTick()` (S4) with
   the major-upgrade selection arm, driven the same operator way (`POST
   /v1/admin/migrate/tick`, decision 11 — **not** a cron, correcting this
   plan's original "cron dispatch"); `migrated` event; `legacyFollows`
   skip (unchanged by S3a); `migrate.test.ts`; `INVARIANTS.md` rows.
4. **Dumps** — per-major nightly files + sidecars; `dump.test.ts`,
   `rehost.test.ts`; `08-infrastructure.md` R2 layout note.

No D1 schema change (`layouts.format` and `layout_revs.format` already
carry what is stored; `events.kind` is free text). Deploy is the Worker.
The bot needs nothing for the first deploy: `writeWithFreshRecord` falls
through to `errorText(body.message)` on `format_behind`, and the message
is written to read correctly in Discord; a dedicated string is a
`// COPY: sign-off pending` line for `14-copy-signoff.md` when `spark/2` is
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
  it would rescue; that case cannot occur until `spark/2` has a field and a
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
   vs a prefix per major (`spark-1/latest.json`). Cosmetic; the prefix reads
   better in a bucket listing if monthly copies also fan out. (Still open;
   `20-spark.md`'s own prose uses the slash-free form when sketching S5,
   which is not the same as saltorbit having picked it.)
5. **When a cross edge should be re-pinned** (§4.2: an advanced format's
   `to["spark/3"]`, because `spark/3` can hold something the chain from
   `spark/1` loses — cmini has no cross edge to re-pin, decision 2). The
   registry prefers the shortest chain to the target; is "shortest" the
   right tie-break, or "highest-major edge"? Same answer for every case
   anyone has named so far; flagging so nobody hard-codes either.
