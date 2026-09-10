# 19 — Upcast on write: older clients keep writing

Status: proposal (2026-09-10), branch `ldb-upcast` off `ldb-v3`. Follows the
format thread with xsznix (migration = translate on read, `01 §5`) and
saltorbit's addendum: *clients on older versions must still be able to write,
so the DB needs an upcast too.* Nothing here changes a stored byte; it
changes what a cross-format `PUT` stores.

## 0. The gap

`01 §5` says records keep their written format and readers translate. That
covers reads. For writes, `03 §3` says "`PUT`: whole payload replaced;
`format` may change", and `src/core/write.ts`'s `replaceLayout` does
exactly that: validates `body.payload` against `body.format` and stores
both as written.

So the day `akl/2` exists (say it adds `keys[c].alt`, `01 §8` item 5), a
client still speaking `akl/1` — the bot's `mirror!`, a `fetchFreshAkl1` +
`PUT {format: "akl/1"}` — that touches an `akl/2` record flips the record
back to `akl/1` and every `alt` is gone. Silently: the write is valid
`akl/1`, the event is an ordinary `updated`, and the next `?as=akl/2`
reader gets `akl2.from["akl/1"]` of a payload that never had `alt`.

Today's three formats do not trigger this. `akl/1` is the hub and both
day-1 clients (the bot, the site's magic editor, the migration script)
write *into* it: a `cmini/1` or `mana2/1` record they `PUT` as `akl/1`
moves up losslessly (`LDB-F5`). The gap is forward-looking, and it is the
kind `01` says not to paint ourselves into: a stored record cannot be
un-flipped.

## 1. Terms

- **lineage** — the `<name>` half of a format id. `akl/1` and `akl/2` share
  a lineage; `cmini/1` and `akl/1` do not.
- **hub** — the lineage every pair composes through (`01 §4`): `akl`.
- **native** — the format a record is stored in (`record.format`).
- **view** — what a reader gets from `?as=F`: `native.to[F](payload)`.
- **home(F, G)** — where a write in `F` against a record in `G` is stored
  (§3 R2). It is never "further from the hub" or "down a lineage" than the
  record already is.
- **base** — the record's current native payload, handed to a `from` so it
  can reconcile what the writer's view could not show (§3 R3).

## 2. The three ways an older client writes

| the client does | today | after this proposal |
|---|---|---|
| `POST` a new layout in `F` | stored as `F`; newer readers upcast on read | unchanged |
| `PATCH` a verb (`name fingermap board magic`) | the edit runs on the native payload through that format's `edits`; untouched fields stay | unchanged; this is the safe lane. A new major ships `edits` (§4.3) |
| `PUT` the whole payload as `F` over a record in `G ≠ F` | stored as `F`; `G`-only content dropped | R1–R3 below: refused when the client could not have seen the record whole; otherwise stored in `home(F, G)` through `G.from[F](payload, base)` |

`PUT` in the record's own format is unchanged: you replace what you send.
(The residual hazard there — a minor adds an optional key and a client
strips unknown keys before writing back — is what "additive and optional"
buys survivability for, `PATCH` is the lane that avoids it, and with three
client maintainers it is a message, not a mechanism. Noted in §9.)

## 3. The rule

A `PUT {format: F, payload}` arrives for a record `(G, current)`, `F ≠ G`,
`If-Match` already satisfied (`LDB-P2`).

**R1 · Visibility.** Compute `view = G.to[F](current)`. If `G.to[F]` is not
wired, or returns `held`, the client could never have read this record in
`F`, so this is a blind overwrite. Refuse:

```
409 { "error": "format_behind", "format": "akl/1", "see": "akl/2", "rev": 7,
      "message": "this record is akl/2 and akl/1 cannot show all of it; write it as akl/2, or PATCH the field you mean to change" }
```

Same shape as `held` (`03 §1`), a different word because a write was
refused rather than a read.

**R2 · Home.** The stored format is `home(F, G)`:

```
rank(f) = (lineage(f) == hub ? 1 : 0, major(f))
home(F, G) = the higher-ranked of F, G;
             on a tie in lineage-rank across DIFFERENT lineages (mana2/1 vs cmini/1): F, as written
```

Consequences, spelled out for the pairs that exist or are planned:

| record `G` | write `F` | home | what happens |
|---|---|---|---|
| `cmini/1` | `akl/1` | `akl/1` | a move up, stored as written (today's bot/migration path, unchanged) |
| `mana2/1` | `akl/1` | `akl/1` | same |
| `akl/1` | `cmini/1` | `akl/1` | upcast: `akl1.from["cmini/1"](payload, base)` |
| `akl/1` | `mana2/1` | `akl/1` | upcast: `akl1.from["mana2/1"](payload, base)` |
| `akl/2` | `akl/1` | `akl/2` | upcast: `akl2.from["akl/1"](payload, base)` — the case this proposal exists for |
| `akl/1` | `akl/2` | `akl/2` | a move up, stored as written |
| `cmini/1` | `mana2/1` | `mana2/1` | a move, stored as written (R1 still applies) |

A record's format therefore only ever moves toward the hub or up its
lineage. It never regresses, whoever writes it.

**R3 · Reconcile.** When `home ≠ F` the server stores
`home.from[F](payload, base)` with `base = current` (the record is already
in `home` in every such row above, so `home == G`). `from` gains an
optional second argument; the format decides what the writer's view could
not show and carries it forward from `base`. A `from` that ignores `base`
is a pure conversion, which is what every existing `from` is today (§4.1
lists what each day-1 one should do with it).

**R4 · Writer's-view identity** (a test-time invariant, not a runtime
check): after an accepted cross-format `PUT`, `home.to[F](stored)` equals
`payload` under `canonical()`. What the client wrote is what it reads back.
A `from` that breaks this is a format bug caught by `LDB-F17`, not a
request the client can do anything about, so it is not checked per
request.

**Validation order.** `body.payload` is validated against `F` first
(`LDB-F1`, unchanged); the reconciled result is validated against `home`
again before commit, the same re-run `patchLayout` already does after its
edits. A reconciliation that produces an invalid `home` payload is a format
bug and answers `500`, never a stored invalid record.

## 4. Contract changes

### 4.1 `from` takes a base

`db/formats/registry.ts`:

```ts
export interface FormatModule {
  …
  to:   Record<string, (p: Payload) => Payload | Held>;
  from: Record<string, (p: Payload, base?: Payload) => Payload>;   // base: this format's own payload, when the write edits an existing record
  …
}
```

Source-compatible: every existing `from` has arity 1 and keeps working.
What each day-1 `from` should do with `base` once it has one:

| `from` | today drops (`01 §6`) | with `base` |
|---|---|---|
| `akl/1.from["cmini/1"]` (`fromCmini`) | non-`x.cmini` keys of `x`; colstag stagger amounts (cmini has no colstag) | carry `base.x`'s non-`cmini` keys verbatim; when the write's cmini board word equals `base.board.cmini`, carry `base.board` whole (kind + stagger amounts) |
| `akl/1.from["mana2/1"]` | magic idiom structure (mana2 rows are flat), `TB`, non-`x.mana2` `x` | carry `base.x`'s non-`mana2` keys; when `lower(base.magic)` equals the write's rows (canonical, order-insensitive), carry `base.magic` whole — the idioms survive an edit that did not touch magic |
| `cmini/1.from["akl/1"]`, `mana2/1.from["akl/1"]` | — | never called with a base under R2 (home is never cmini or mana2 when the record was akl); `base` unused |
| `akl/2.from["akl/1"]` (future) | `alt` | for each `c` in the write's `keys`, carry `base.keys[c].alt` when `keys[c]` (row, col, finger) is unchanged from `base`; drop it otherwise — an `alt` is a claim about a position, and the writer moved the key |

The rule of thumb for a format author: *carry forward what the writer could
not see, for as long as what they could see still says the same thing about
it.* Each format's README gains a "reconcile" paragraph listing exactly
this (`01 §4`'s "what it cannot express" already lives there).

### 4.2 `home()` and `lineage()` in the registry

Two pure helpers beside `translate`:

```ts
export const HUB = "akl";
export function lineage(id: string): { name: string; major: number }   // parses "<name>/<N>"
export function home(writeFormat: string, recordFormat: string): string // §3 R2
```

`GET /v1/formats` (`03 §2`) advertises `lineage` and `major` per entry so a
client can tell it is behind without parsing ids.

### 4.3 Lineage adjacency (what a new major must ship)

A registered `<name>/<N>`, `N > 1`, must have `<name>/<N−1>` registered
and:

- `to["<name>/<N−1>"]`, returning `held` per payload when this payload
  uses something `N−1` cannot hold (the thing R1 keys off);
- `from["<name>/<N−1>"]`, with a `base`-aware reconcile (§4.1);
- `edits` accepting the `/v1/` verb bodies (`board`/`magic` are `akl/1`
  shapes by `09 §3 T4`; the verb vocabulary is versioned with the API path,
  not with the format — a new hub major converts inside its `edits`).

`01 §4` currently says `to`/`from` are optional. They stay optional across
lineages; within a lineage they are required. `LDB-F16` enforces it from
the registry.

## 5. `replaceLayout` after the change

```ts
requireIfMatch(ifMatch);
const { record, admin } = await loadForWrite(db, ref, actor, { allowDeleted: false });
await requireRev(db, record, ifMatch);
validatePayload(body.format, body.payload);                      // LDB-F1, as today

let format = body.format;
let payload = body.payload;
let writtenAs: string | undefined;

if (body.format !== record.format) {
  // R1: could the writer have seen this record whole?
  const view = translate(record, body.format);                    // the same call GET ?as= makes
  if ("held" in view) throw formatBehind(body.format, record.format, record.rev);

  // R2 + R3: where it lives, and how the hidden part comes along.
  const target = home(body.format, record.format);
  if (target !== body.format) {
    payload = getFormat(target)!.from[body.format]!(body.payload, record.payload);   // from[] exists: R1 passed through to[], and F16 wires from[] with to[] inside a lineage; across lineages the hub's from[] is wired for every registered format (01 §4)
    format = target;
    writtenAs = body.format;
  }
}

const { hasMagic } = validatePayload(format, payload);            // the reconciled result, re-validated
const magicOnly = isMagicOnlyReplace(record, format, payload);    // §5.1

return commitWrite(db, now, {
  kind: "updated", …, format, payload, hasMagic,
  ...(magicOnly ? { detail: { magic_only: true } } : {}),
  ...(writtenAs ? { detail: { …, written_as: writtenAs } } : {}),
});
```

### 5.1 `isMagicOnlyReplace` simplifies

Its `cmini/1 → akl/1` special case (`fromCmini(record.payload)` then
compare) exists because the migration script writes `akl/1` over `cmini/1`
records. Under R2 that PUT's `home` is `akl/1`, and comparing "stored minus
magic" against "`akl1.from["cmini/1"](current)` minus magic" is the same
computation expressed through the registry instead of a hard-coded pair.
Generalise: when `format ≠ record.format`, lift `record.payload` into
`format` via `from` (or compare `to[format]` of it — either side works
because `LDB-F5` makes the pair lossless) and compare minus magic. The
function loses its two literal format ids.

### 5.2 The event

`updated` gains `detail.written_as: "<F>"` whenever the stored format is not
the one the client sent. `03 §5`'s `detail` line lists it. Nothing reads it
yet; it is the forensic breadcrumb for "why did this record's `alt` change
on a write from the bot".

## 6. Error

`src/core/errors.ts`:

```ts
export function formatBehind(format: string, see: string, rev: number): ApiError   // 409 { error: "format_behind", format, see, rev, message }
```

Added to `03 §1`'s error table and to `tests/api/conformance.test.ts`'s
sweep of every route × every error code it can answer.

## 7. Invariants (the covenant)

| id | invariant | enforced by |
|---|---|---|
| LDB-F16 | **Lineage adjacency.** For every registered `<name>/<N>` with `N > 1`: `<name>/<N−1>` is registered, `to["<name>/<N−1>"]` and `from["<name>/<N−1>"]` are both wired, and `edits` is exported. Enumerated from the registry; phase 1 has no `N > 1`, so the test also registers a stub lineage (`t/1`, `t/2`, `registerForTest`) and asserts the check catches each missing piece. | `tests/formats/lineage.test.ts` (new) |
| LDB-F17 | **Reconcile.** For every `from[F]` with a base, over every fixture pair `(base in G, write in F)`: (a) writer's-view identity, `G.to[F](from[F](write, base)) ≡ write` under `canonical()`; (b) remainder preserved, `hidden(from[F](write, base)) ≡ hidden(base)` where `hidden(p) = p − G.from[F](G.to[F](p))` — the part of a payload `F` cannot show — whenever the write leaves the visible part of `base` unchanged (`G.to[F](base) ≡ write`); (c) validity, the result validates as `G`. For the day-1 `from`s the concrete carried fields (§4.1: `x` keys, colstag amounts, magic idioms) get a named fixture each. | `tests/formats/reconcile.test.ts` (new, generated over the registry × fixtures; property test over random single-field edits of the visible part); the stub lineage carries `extra` |
| LDB-P11 | **Cross-format PUT.** A `PUT` in `F` over a record in `G ≠ F` is (a) refused `409 format_behind` iff `G.to[F]` of the current payload is held or unwired, writing nothing; (b) otherwise stored in `home(F, G)`, so a record's format never moves away from the hub or down its lineage under any sequence of writes; (c) afterwards `GET ?as=F` returns the written payload exactly; (d) the `updated` event carries `detail.written_as = F` iff the stored format is not `F`. | `tests/api/put-format.test.ts` (new): a matrix over every registered pair × {held, not held} via the stub lineage plus the three real formats; a property test replaying random write sequences and asserting (b) on the format trajectory |
| LDB-F9 | unchanged, and now also holds for writes: a held record cannot be overwritten through the format it is held for | `tests/api/held.test.ts` gains the `PUT` case |

`db/INVARIANTS.md` gets the three rows; `tests/tools/invariants.test.ts`
(`LDB-T1`) fails until each has a tagged test.

## 8. Work plan

One PR, three commits, in this order so every step is green on its own:

1. **Registry + formats** — `from(p, base?)` signature, `lineage()`,
   `home()`, `HUB`; `fromCmini`/`fromMana2` learn `base` (§4.1); the stub
   lineage lives under `tests/formats/stub-lineage.ts` (test-only, so
   `LDB-F6`'s frozen-file check is untouched); `lineage.test.ts`,
   `reconcile.test.ts`; README "reconcile" paragraphs; `01 §4`/`§5`
   amendments.
2. **Write path** — `formatBehind`, `replaceLayout` (§5),
   `isMagicOnlyReplace` generalised (§5.1), `written_as` (§5.2);
   `put-format.test.ts`, `held.test.ts`'s PUT case, the conformance sweep;
   `03 §1`/`§3`/`§5` amendments; `INVARIANTS.md` rows.
3. **Advertise** — `lineage`/`major` in `GET /v1/formats`; the bot's
   `writeWithFreshRecord` maps `format_behind` to a message (copy stand-in,
   `// COPY: sign-off pending`, `14-copy-signoff.md`) — today it would fall
   through to `errorText(body.message)`, which is acceptable for the first
   deploy.

No data migration, no D1 change: `layout_revs.format` already records
whatever was stored. Deploy is the Worker only.

Estimated size: ~120 lines in `registry.ts`/`translate.ts`, ~40 in
`write.ts`, ~30 in `errors.ts`, ~400 of tests. A Sonnet agent per commit,
with the invariant ids as the acceptance bar (`plan-review-before-impl`).

## 9. Non-goals, kept deliberately

- **Same-format `PUT` stays whole-replace.** The minor-version key-stripping
  hazard (§2) is not solved by the server, because it cannot see which
  minor a client speaks and `01 §5` rejected minor identifiers. `PATCH` is
  the answer; the contract is additive-optional.
- **No runtime writer's-view check** (R4 is test-time). A per-request
  `to(from(p))` doubles the write's CPU for a class of bug the fixture matrix
  catches at PR time.
- **No "merge" API.** `base` is the whole mechanism. A format that wants a
  smarter three-way merge (the writer's *previous* view against the current
  one) has `layout_revs` and `If-Match`'s `rev` to fetch it from, later, in
  its own `from`; the signature does not need to grow now.
- **Verb bodies stay pinned to `/v1/`**, not to a format major (§4.3).

## 10. Open questions (for saltorbit)

1. **R1's answer: refuse, or accept and drop with a warning?** Proposal:
   refuse. A `409` with `see` is the same thing a reader already gets, the
   client already handles `stale` on the same route, and silent loss is
   the one outcome `01` was written to prevent. The alternative
   (`Warning:` header, store the upcast of a lossy view) is one line if you
   want it.
2. **Non-hub cross-lineage writes** (`mana2/1` over `cmini/1`): R2 stores as
   written after R1. Alternative: refuse unless the writer is the hub. It
   cannot happen with today's clients; proposal keeps the permissive rule
   because it is the one that needs no rank table.
3. **`written_as` on the event, or a separate `upcast` event kind?** Proposal:
   detail on `updated`, so `followsUpstream` and every other fold stay
   untouched.
4. **Does the bot want to speak `format_behind` now**, or is falling through
   to `body.message` fine until `akl/2` exists? Proposal: the fall-through;
   the message is written so it reads correctly in Discord as is.
