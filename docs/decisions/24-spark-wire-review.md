# 24 — spark/1 as a wire format: an independent review

**Status:** review, 2026-09-12, before the first outside adopter. Reviewed: `22-spark-spec.md` (as shipped), `23-geometry.md` (this week's decisions, including §4 "Duplicates"), `db/formats/spark/1/*`, `db/formats/mana2/1/translate.ts`, `db/formats/adapters/cmini/translate.ts`, `db/formats/registry.ts`, `db/docs/adoption.md`, the `spark-format-notes` page, `01`/`19`/`20`/`21`, and the 2026-09-10..12 Discord thread with xsznix and zak. Code is "today"; `23` is "where it's going". Nothing here is a decision; every recommendation names the smallest change.

## Verdict

spark/1 plus this week's decisions is a sound *stored* format for a community layout database with several clients: the envelope/payload split is right, strict write-time validation is right, "intent above, one flat lowering below" is right, and the board simplification removes more inference than it adds. It is not yet a sound *wire contract*, for three reasons that are cheap to fix now and expensive after an adopter: (1) the magic section's semantics live in `magic.ts` rather than the spec — phase order, last-wins, character-identity contexts, the `"none"`/`"repeat_previous"` sentinels — so a second implementer cannot reproduce the lowering from the document; (2) the duplicate-keys decision is under-specified exactly where neon needs it: "chars named by magic are unique" does not cover the chiral scaffold, which needs the *hand* of every layout char, and a duplicated char with keys on both hands is precisely neon's case; (3) the versioning rule ("additive optional = same major") cannot see the change that matters most — meaning changes under an unchanged shape, of which "`LT` at col 7 is now a left thumb" is this week's example. Before the first adopter: write the magic contract into the spec (findings 1–4), close the duplicates hole (5), replace the sentinels (6), state the reader obligations and the golden-identity versioning rule (7–8), and reserve `" "` (11). Everything else — `from=` for a second lineage, an authoritative-format hint, the `link` field, `magic.notes` — can wait, provided the spec says it is deferred rather than silently decided.

## Findings

### 1. The magic contract is in the code, not the spec

**Issue.** `22` §3 says `magic` holds intent and `compileMagic` derives rows; it says nothing about *which* rows. The scaffold rules (LDB-F14 word-start row, LDB-F15 global special-char exclusion, chiral self-row), the phase order (`magic.ts:271-277`: scaffold < chiral < explicit rule < adaptive < raw), last-wins within a phase (`resolveRows`), and "a raw row in any collision is refused" (`findCollision`) are all only in `magic.ts` and `db/INVARIANTS.md`. **Hurts:** any second client that lowers (mana2 users reading `?format=spark/1`, LW projecting onto spark, a future non-TS bot) — two clients lowering one payload will disagree, which is the one thing a wire format exists to prevent. **Fix:** move the phase-order paragraph and the three scaffold rules into `22` §3 verbatim (notes item 6 says the same; I add: the tags table from `01` §3 belongs there too, since `type` is on the wire in `mana2/1`).

### 2. State the one concept; make the idioms sugar over it

**Issue.** xsznix's model — a repeat key with contextual bindings layered on; magic, skip-magic, adaptives, sequence transforms as one concept — is *already what `computeRows` is*: every idiom expands to `bind(context, key) → output` rows and `rules[]` is that primitive exposed raw. The spec presents them as "two vocabularies" (notes item 7) and never says the idioms are macros. **Hurts:** authors (when does an adaptive vs a rule apply — xsznix 04:11), and every adopter who must decide whether `rules[]` is trusted or opaque. **Fix:** one paragraph in §3: *the primitive is a binding `(context, key) → output` (context = the preceding emitted character, or `' '` at word start; `rules[].inputs` allows a longer context); `magic_keys`, `chiral_keys`, `adaptive_swaps` are macros whose expansions are listed below; `compileMagic` is the expansion; expansion order and last-wins are the contract.* This keeps saltorbit's author-focus (the sugar stays, validated) and removes the smell xsznix named ("UB between the authoring layer and the IR", 04:16): the IR is defined, in the same document, as the expansion. It costs no shape change.

### 3. Keystroke vs character identity: state the default and the boundary

**Issue.** `after: "n"` is undefined between "key n was pressed" and "char n was emitted". akl.gg implements character identity (I-108: magic arms off the emitted char); keymaxx makes it explicit (Discord 04:55); saltorbit chose "pick a default" (04:58). The spec says nothing. **Why character identity is the only honest default here:** the analyzers this format lowers to see *text*, never keystrokes — mana2 inverts `output → inputs` over the corpus — so any analyzer-visible semantics is character identity by construction; keystroke identity only diverges on chained magic (`n*` emitting `nl`, then `*` after that `l`), which no consumer of spark can observe. **Hurts:** LW/keymaxx when projecting (they need to know what they are projecting onto), and authors of chained magic who believe the record captures their firmware. **Fix:** two sentences in §3: contexts are character identity; behaviour that differs between character- and keystroke-identity firmware (chained magic, overlapping contexts) is outside what this format records — an author who needs it authors in a format that has the disambiguator. That is the downscoping saltorbit asked for, written down instead of implied.

### 4. `rules[]` — keep it, as the primitive, not as "opaque"

**Issue.** Notes item 7 offers "opaque, never lifted, never merged" or deletion. Neither matches the code: raw rows *do* take part in the lowering (phase 4) and collide with idioms by design (`magic_collision`), and `fromCmini` writes leftovers there (`adapters/cmini/translate.ts:92-94`) so ~every imported record with 3-code-point rows depends on it. **Fix:** per finding 2, `rules[]` is the primitive: appended last, never resolved against an idiom row (a collision involving a raw row is refused — keep), lifted only by `liftRules` on import. Disagreement with the notes: not opaque, and not deleted.

### 5. Duplicates: the uniqueness rule is one hand short

**Issue.** `23` §4 allows the same `char` on several entries and requires only that chars *named* by magic be unique. But the chiral scaffold enumerates *every* layout char and asks its hand (`magic.ts:236-245`, `handOf` = `keys[ch].finger`); with a list, `handOf` must pick an entry. neon's two `y`s are on opposite hands — that is the point of the duplication — so for a chiral key `;` the row `y;` is undefined, and neon is the motivating example. The repeat scaffold (`layoutChars`) also enumerates chars; with duplicates it must dedupe or emit `y*→yy` twice (a same-phase self-collision, resolved silently by last-wins). **Hurts:** the exact layouts the change is for; analyzer parity. **Fix (smallest):** (a) scaffolds enumerate *distinct* chars; (b) a chiral scaffold skips a char whose entries span both hands unless that char is in `except` or has an explicit rule — and `validate()` says so with a path (`magic_needs_unique_key` extended: "y is on both hands; add it to except or give it a rule"); (c) `handOf` for a char on one hand only is well defined. Also: **first-occurrence-in-(row,col)** ties "which key is analysed" to geometry, the opposite of intent. Smaller and stronger: *the list is ordered; the first entry for a char is its primary; the lowering analyses the primary and emits the rest as `skip`*. The importer and the bot already write in reading order, so nothing changes for the 99 %, and neon's author can put the analysed `y` first without a new field. (`canonical()` leaves arrays in place, so ordering survives storage.) Note honestly in §7 that the `skip` lowering is *worse* for neon than the stand-in-char hack (all `y` traffic lands on one hand); the hack can coexist, and mana2's own advice is "implement duplicates through magic". Two consequences to spec: `PATCH {fingermap: {y: …}}` (`edits.ts:25-38`, keyed by char) must refuse a duplicated char rather than pick one; JSON-pointer error paths become `/keys/<index>` (the conformance fixture `patch-400-invalid_payload.json` has `/keys/z`).

### 6. Stringly sentinels: `"repeat_previous"`, `"none"`, and chiral `same`/`opposite`

**Issue.** `magicKey.default` is `string` (`schema.json:77`) with two magic words (`magic.ts:35`: `repeat_previous`, `none`) or a literal char. The spec documents `repeat_previous` and "absent = none" but `liftRules` *stores* `default: "none"` (`magic.ts:402`), so imported records carry a sentinel the spec never mentions. `chiral.same`/`opposite` are any non-empty string (`magic.ts:676-681`) and also accept `"repeat_previous"` (`:243`); the `01` example shows `"same": "ee"`, which today would emit `c + "ee"`. **Hurts:** every future client, and the format's own schema (a JSON Schema cannot check any of this). **Fix:** tag it now, while the DB is disposable: `default?: {repeat: true} | {char: "e"}` (absent = none; refuse `"none"`), and the same shape for `same`/`opposite`. Agree with notes item 8; extend it to the chiral fields and to killing `"none"`.

### 7. `additionalProperties: false` is right; the *reader* rule is missing

**Issue.** Strict server-side validation is correct (xsznix 11:44: extensions need write-time validation; D3 gives clients their own formats instead of `x`). But the same-major "additive optional" rule (`01` §5) plus adoption.md §3 ("validate client-side against the schema") means a client with a vendored schema rejects valid records after any additive change, and a client doing read-modify-write with a stale struct drops the new field on `PUT` — `If-Match` cannot catch that. **Hurts:** adopters and the format's ability to ever add a field. **Fix:** two obligations in the spec's first screen: *readers ignore unknown fields (only the server refuses them); a client that does not understand every field of a record uses `PATCH`, never `PUT`.* Agree with notes item 10; this is the half it lacks.

### 8. Versioning: shape rules cannot see meaning changes

**Issue.** This week's changes include a meaning change under an unchanged shape: `finger: "LT"` at col 7 used to be re-anchored by column (`translate.ts:414-416`), now it *is* a left thumb (`23` §4.2). No schema diff shows it. "Additive optional = same major" (notes item 11) would call it a minor. **Hurts:** future migrations and any client pinned to a major. **Fix:** the mechanical rule the covenant already supports: *a same-major change leaves every existing fixture's `.lowered.json` and `.mana2-1.json` goldens byte-identical (LDB-F2/F7); anything that changes a golden is a new major.* Keep D11's in-place editing until the adopter, then this rule. On L6 (delete the chain code): fine, but the *promise* in adoption.md §8 — a pinned major keeps reading and writing — is what xsznix agreed to ("your schema version determines pinned behaviour", 16:00); keep the contract text and reinstate a mechanism before spark/2. Note the tension: R3 "down is held or lossless" means a spark/1-pinned bot would get `held` for a duplicated-key record — exactly the "nope, use the other bot" outcome xsznix flagged (13:35).

### 9. Record vs payload: a table, plus three strays

**Issue.** The split is right (name, owner, likes, timestamps, `upstream`, `formats{rev, has_magic, source}` in the envelope; keys/board/magic in the payload) but is documented only in `21` §2.3 and adoption.md. Three strays: `magic.notes`/`magic.updated` are record-ish free text living inside the payload (`schema.json:51-52`, "nothing compiles them"); `has_magic` is payload-derived but lives in the envelope (fine, say so); `owner` is a snowflake with no display name on the record (clients need `/v1/authors/{id}`). **Fix:** the two-row table at the top of `22` (notes item 13), plus: `notes`/`updated` are declared non-semantic (ignored by lowering, not compared for identity), and the deferred envelope items are listed by name — moderated `link`, a display name, a layout date distinct from record `created_at` — so an adopter knows they are coming rather than absent.

### 10. Derived hand split and fingering name: label yes, refusal no

**Issue.** Deriving `handSplit`/`classifyFingering` is right (one function, never stored). But `23` §4.4-4 turns the *classifier* into a write rule (`400 fingering_needs_ansi`): a layout whose left-hand fingers happen to match `angle` is refused on `ortho`. That is a rule about the bot's ASCII look leaking into the wire format; an adopter writing ortho + custom fingers that coincidentally match a reference gets a 400 they cannot understand. Also `23` §4.4-3 and notes item 2 disagree (row-3 non-thumb keys allowed vs refused). **Fix:** keep the classifier for labels and rendering; drop rule 4 from `validate()` (the bot may still refuse `fingers! x angle` off ansi as a *bot* rule); keep `23`'s row-3 allowance (lossless import, `01` §2.1's original reasoning).

### 11. Character identity: reserve `" "`, say the rest in one sentence

**Issue.** One code point, no normalization: `é` precomposed passes, `e`+U+0301 is refused as two code points (good, loud), compatibility forms pass (`ﬁ`, fullwidth). Case: `Y`/`Q` appear as keys in `upstream-100` fixtures beside `y`/`q`; nothing says what a capital means. `" "`: `23` says space is not a key (#333), yet `mana2/1 → spark` maps `space` to a `" "` key (`translate.ts:109`) and `computeRows` special-cases `" " in keys` (`magic.ts:216`) — two code paths already disagree. `~`: a bot/cmini convention, not reserved by spark. **Fix:** §2 "Identity": chars compared by code point as stored, no normalization (writers should send NFC), case-sensitive, no shift layer, no reserved characters; `" "` is refused in `char` until #333 defines it. Agree with notes item 3, plus the space refusal.

### 12. A second stored format: what the registry must not assume

**Issue.** `FormatModule` requires `schema: object` (JSON Schema, `registry.ts:95`), `hasMagic` (`:107`), and `edits` whose `board`/`magic` "arrive shaped as spark/1's object — the API's one board vocabulary regardless of the record's own format" (`:78-81`). LW will be TOML or a DSL with no canonical representation (xsznix 15:47, 05:19); keymaxx is an IR. Storing them as `payload: "<text>"` with `schema: {type: "string"}` works, but `hasMagic` forces a parse and the PATCH vocabulary is spark's. MF-10 ("each output reachable from exactly one stored lineage") means a second lineage cannot serve `?format=mana2/1` at all, and `21` §2.5 "stored formats are never derived" forbids the on-demand spark projection saltorbit and xsznix agreed on (13:58: generated on demand, suppressed by an authored one — "yep"). **Fix:** the registry must not assume JSON-object payloads, spark's PATCH vocabulary, or a mana2 edge; make `hasMagic` and `edits` optional (`unsupported_for_format` already exists), and decide `?format=mana2/1&from=<lineage>` now (per-record: unambiguous when the layout stores one lineage, `from=` required otherwise). Reword "never derived" as "no derivation edge is registered today" so it is not enshrined as an invariant.

### 13. Board: fine; say the coordinate function is the contract

`board` as one word with fixed stagger (`23` §4.1) is the right call. The spec must carry the `(kind, row, col) → (x, y)` table itself (LDB-F30 makes it one function; a wire spec needs the numbers), state that `colstag` is geometry-for-renderers only (stats as ortho), and list the non-goals. No change beyond prose.

## What the Discord discussion asked for that the format does not deliver

| ask | delivered? | should it? |
|---|---|---|
| one underlying concept for magic/adaptive/skip/sequence (xsznix 04:07) | in the code (`computeRows`), not in the spec | yes — finding 2, prose only |
| explicit keystroke/character disambiguator (04:55) | no | no (saltorbit's call); state the default and the boundary — finding 3 |
| defined overlap/application order (04:14) | code + invariants, not spec | yes — finding 1 |
| duplicate letters (neon, 12:11) | decided this week | yes; close the chiral-hand hole — finding 5 |
| compat projections on demand, suppressed by an authored one (13:58) | mana2 only; spark-from-LW forbidden by `21` §2.5 | later, but don't enshrine the prohibition — finding 12 |
| an authoritative/preferred-format hint per layout (13:59) | no (D3: formats independent) | not now; document `formats[f].modified_at`+`source` as the freshness signal |
| opaque bytes + a validation/lowering module per format (15:48) | mostly (`FormatModule`) | yes; drop the JSON-object and `hasMagic` assumptions — finding 12 |
| adapters between schema revs, pinned behaviour (15:58–16:00) | designed (19), frozen, slated for deletion (L6) | keep the contract; reinstate before spark/2 — finding 8 |
| preferred space side / named magic keys (zak 21:42) | #333 deferred; magic keys are chars | fine; say so in §5 |
| moderated `link`, view counts, mod queue (21:44+) | envelope, planned | envelope only; list as deferred — finding 9 |

## Explicit disagreements with the notes page

- **Item 1** (first occurrence in `(row, col)`): prefer list order = author priority; and the uniqueness rule must cover the chiral scaffold's hand lookup (finding 5).
- **Item 2** (refuse non-thumb keys on row ≥ 3, drop at import): disagree; `23` §4.4-3 already allows them, and the import should stay lossless (finding 10).
- **Item 7** (`rules[]` opaque, or deleted): neither — it is the primitive, with the collision rule kept (finding 4).
- **Item 11** ("additive optional = same major"): inadequate; use golden identity (finding 8).
- **Item 12** ("or leave it out entirely"): say it — "akl.gg and the bot read `spark/1`; nothing requires another client to" is one line adopters need.
- **Settled table, "named fingerings require `board: ansi`"**: as a *write* rule, disagree (finding 10).

## Proposed skeleton for `22-spark-spec.md`

0. **Status and versioning.** `spark/1` is edited in place until the first outside adopter (D11); after that, a change is same-major iff every existing fixture's goldens stay byte-identical; a pinned major keeps reading and writing (adoption §8).
1. **Record vs payload.** The two-row table; `notes`/`updated` are non-semantic; deferred envelope fields listed by name.
2. **Identity.** A `char` is one code point, compared as stored (no normalization, case-sensitive, no shift layer, nothing reserved, `" "` refused pending #333). A position is `(row, col)`, integers, unique across `keys`.
3. **Keys.** `keys` is an ordered list of `{char?, row, col, finger}`; no `char` = a free position; the same `char` may appear several times and its first entry is the primary.
4. **Board and thumbs.** Four words; the `(kind, row, col) → (x, y)` table; `LT`/`RT` is the hand; `handSplit` and the fingering name are derived labels and never refuse a write.
5. **Magic.** 5.1 the primitive binding; 5.2 each idiom and its exact expansion; 5.3 expansion order and last-wins, raw rows refused on collision; 5.4 contexts are character identity and what lies outside; 5.5 duplicates: scaffolds enumerate distinct chars, a two-handed char needs `except` or a rule.
6. **Validation.** Schema, then the ordered cross-field checks, each with its error code and path.
7. **Lowering to `mana2/1`.** Never held; the board table; duplicates → primary analysed, rest `skip` (a documented loss).
8. **Import from cmini.** The guesses, each with its info event.
9. **Reader and writer obligations.** Ignore unknown fields on read; `PATCH` when you don't understand every field; validate against the served schema.
10. **What it cannot express**, with the issue number for each deferred item.
11. **Worked examples** (extracted and tested, LDB-F24): plain, iso, colstag with thumbs, duplicates + magic.

## Resolution (round 2)

**Status:** 2026-09-12, round-2 author (a second reviewer, with the lead) after saltorbit's two standing rulings — *the format represents what the bot may refuse* (F10 as principle) and *`keys` is an ordered list, duplicates allowed* — and the lead's instructions to the running format slice (F5, F6, F10, F11). saltorbit: "I mostly trust the choices you two come to." Below: every finding with the one-sentence rule an implementer codes from, then answers A–H, then the disagreements that remain. Re-read for this round: `magic.ts`, `mana2/1/translate.ts`, `registry.ts`, `edits.ts`, `core/canonical.ts`, `import/diff.ts`, the site's `akl1.ts`/`rules.ts`, `functions/_lib/rules.mjs`, adoption.md §7–8, `21` §2, and the Discord thread end to end.

### Findings → final rules

| # | finding | resolved rule (what the implementer codes) | state |
|---|---|---|---|
| 1 | magic contract in code, not spec | `22` §5 carries, verbatim from `magic.ts`: the three scaffold rules (LDB-F14 word-start row for a *literal* `default` only, never for repeat, not gated by `except`; LDB-F15 global exclusion of every magic/chiral key's own char from every magic-key scaffold; the chiral self-row `key+key` taking `same`), the phase order `scaffold(0) < chiral(1) < explicit rule(2) < adaptive(3) < raw(4)`, last-wins within a phase by emission order, "any same-`inputs` pair that includes a raw row is `400 magic_collision`", and the tag vocabulary as emitted into `mana2/1` rows (`repeat`, `default:<c>`, `magic`, `chiral`, `adaptive`, `raw`). | closed |
| 2 | one concept, idioms as sugar | §5 opens with: *the primitive is a binding `(context, key) → output`, context = the preceding emitted character or `' '` at word start (`rules[].inputs` allows a longer context); `magic_keys`, `chiral_keys`, `adaptive_swaps` are macros whose exact expansions are listed in §5.2; `compileMagic` is the expansion; the order and last-wins in §5.3 are the contract.* | closed |
| 3 | keystroke vs character identity | §5.4: *contexts are character identity (the preceding emitted character); behaviour that differs between character- and keystroke-identity firmware — chained magic, overlapping contexts — is outside what this format records; an author who needs it authors in a format that has the disambiguator.* | closed |
| 4 | `rules[]` | *`rules[]` is the primitive exposed raw: appended in phase 4 in author order, never resolved against an idiom row (a collision is refused, never last-wins), lifted into idioms only by import (`liftRules`), never on read.* Not opaque, not deleted. | closed |
| 5 | duplicates one hand short | *`keys` is ordered; the first entry for a char is its primary; scaffolds enumerate distinct chars; the chiral scaffold emits no row for a char whose entries span both hands, and `validate()` refuses such a payload (`400 magic_needs_unique_key`, path `/keys/<i>` of the second-hand entry) unless that char is in that chiral key's `except` or a `rules[]` row exists with `inputs === char + chiralKey`; the mana2 lowering analyses the primary and emits later entries as `skip`; `PATCH {fingermap}` refuses a duplicated char (`invalid_payload`, path `/keys/<i>` of the first entry); every error path into `keys` is `/keys/<i>`.* See C for the reasoning and the wording fixes `23` still needs. | closed |
| 6 | stringly sentinels | *`default`, `same`, `opposite` are tagged objects, absent = none; the strings `"none"`/`"repeat_previous"` and `null` are refused by the schema; `liftRules` omits `default` instead of writing a sentinel.* Spelling: see F (my one open disagreement). | closed modulo F |
| 7 | reader obligations | §9 of `22`: *readers ignore unknown fields (only the server refuses them); a client that does not understand every field of a record uses `PATCH`, never `PUT`; validate against the schema served at `GET /v1/formats/spark/1/schema.json`, never a vendored copy.* | closed |
| 8 | versioning by shape | `22` §0: *until the first outside adopter, `spark/1` is edited in place (D11); after, a change is same-major iff every existing fixture's `.lowered.json` and `.mana2-1.json` goldens stay byte-identical — anything that changes a golden is a new major; a pinned major keeps reading and writing (adoption §8's promise stays in the text); L6 deletes the chain CODE only and a mechanism is reinstated before `spark/2` registers.* Pre-condition, or the rule is vacuous: the fixture set must cover every feature before the adopter (§11's list — duplicates + chiral `except`, iso, colstag with thumbs, tagged magic, empty). | closed |
| 9 | record vs payload | `22` §1 carries the two-row table (envelope: id, name, owner, likes, timestamps, `upstream`, `formats{rev, has_magic, source}`; payload: `keys`, `board`, `magic`) and names the deferred envelope fields (moderated `link`, display name, a layout date distinct from `created_at`, view counts). `magic.notes`/`magic.updated`: **dropped** (A). | closed |
| 10 | derived labels never refuse | saltorbit's ruling, now `23`'s table: *`handSplit` and `classifyFingering` are derived labels; no `validate()` rule reads them; "angle only on ansi" is a bot rule for `fingers!`/`board!`; `fromCmini` maps `ortho`/`mini` → `ortho` faithfully.* | closed |
| 11 | character identity | `22` §2: *a `char` is one code point, compared as stored — no normalization (writers should send NFC), case-sensitive, no shift layer, nothing reserved; `" "` is refused in `char` until #333 defines it.* | closed |
| 12 | registry assumptions | *`21` §2.5's "stored formats are never derived" is reworded "no derivation edge between stored lineages is registered today"; `hasMagic` and `edits` become optional in `FormatModule` (`unsupported_for_format` for a missing edit; a missing `hasMagic` reads as `false` on the envelope); the registry never assumes a JSON-object payload.* `from=`: see B. | closed |
| 13 | board | `22` §4 carries the `(kind, row, col) → (x, y)` table from `23` §4.1 with the numbers, states `colstag` is geometry-for-renderers (stats as ortho), lists the non-goals. | closed |
| — | notes page items 2, 11, 12 | row-3 non-thumb keys allowed and imported losslessly; golden identity replaces "additive optional"; the line "akl.gg and the bot read `spark/1`; nothing requires another client to" goes into `22` §0. | closed |

### A — `magic.notes` / `magic.updated`: drop them

**Drop both from the payload** (the lead's lean), not "declare non-semantic". Reasons, in order of weight:

1. **No writer exists.** The site's publish path already strips them — `functions/_lib/rules.mjs` `ruleSetSignature`'s own comment: metadata "that a published set never does" carry; `web/src/core/rules.ts` `RuleSetShareForm` has no slot for them; `liftRules` never emits them; `fromCmini` has nothing to lift them from. Keeping a field nobody writes is a field an adopter has to ask about.
2. **"Non-semantic but rev-bumping" is a contradiction on the wire.** `payload_json` is `canonical(payload)`; a `PUT` that differs only in `notes` bumps `formats.spark.rev`, moves `modified_at`, forks a following layout (`21` §2.2: a write to lineage `spark` forks), and appears on the feed — none of which "non-semantic" can mean. To make it truly non-semantic the server would have to strip it before canonicalising, which is just dropping it with extra steps.
3. **`updated` duplicates an envelope fact.** `formats["spark/1"].modified_at` is the one write-time timestamp; a second, client-asserted one inside the payload is exactly the record-ish stray finding 9 named.
4. **D10 already decided it.** Client extras are the client's; akl.gg's workbench state (what these were on the site) lives in akl.gg.

Cost: zero today (the DB is disposable, `additionalProperties: false` refuses them going forward, LDB-F22's "notes/updated are strings" row becomes "notes/updated are refused"). If a shared free-text note is ever wanted it is an *envelope* field with moderation, next to `link` — list it there as deferred.

### B — `?format=mana2/1&from=<lineage>`: reserve now, implement with the second lineage

Reserve, don't implement — with one cheap, testable half-step so the reservation is real rather than prose:

- adoption.md §3/§7 name `from` as a reserved query parameter on every route that takes `?format=`: *`from=<lineage>` names which stored lineage an output format is derived from; required once more than one stored lineage registers an edge to that output format, optional (and redundant) while exactly one does.*
- Today the server accepts `from=spark` on a `?format=mana2/1` read as a no-op and refuses any other value with `400 bad_request` (param `from`) — one conformance fixture each. A client can start sending it now and never change.
- Nothing else: no registry change, no `MF-10` relaxation. Designing the "which lineage do I mean" semantics against a hypothetical `lw/1` is the ocean saltorbit keeps declining to boil; the parameter name is the only thing that would be painful to change later, and the signing string already covers the query verbatim, so reserving it has no auth cost.

### C — duplicates and the chiral scaffold

**Confirmed: skip-unless-`except`-or-rule is the only coherent option.** A lowered row is `(context char, key) → output`; the context is the *emitted* char (F3), which carries no hand. Two entries for `y` on opposite hands would need `y;` → `y<same>` and `y;` → `y<opposite>` at once — two outputs for one `inputs`, which the flat table cannot hold and mana2's loader would collapse last-wins. So for a chiral key there are exactly three honest states for a two-handed char: excluded (`except`), bound explicitly (a `rules[]` row with `inputs === char + key` — note a *chiral* key has no `rules[]` of its own and a key is never both magic and chiral, so "explicit rule" for a chiral key can only mean a raw row), or refused. "Skip silently" is not on the list: it would drop a row the author thinks exists.

**An explicit rule for a two-handed char means "whichever key was pressed"** — automatically, not by a special case: the row fires on the emitted `y`, and character identity does not know which `y` key produced it. Say that sentence in §5.5 so nobody adds a per-hand branch later.

**First-entry primary deciding the hand: no.** Agreed with the lead, and the reason is stronger than "silent is worse": the primary is an *analysis* choice (which `y` the analyzer scores), not a *firmware* fact; letting it pick the chiral hand would make the magic rows depend on list order, which D says nothing else does, and would emit a row that is wrong for half of the author's `y` presses. The author who wants per-hand chiral output has the format's existing path — two distinct chars (`y` and a stand-in) plus `except` — which is neon's method today and stays valid. State it in §7 next to the `skip` loss.

Two wording drifts in `23` that an implementer could code from wrongly: the decisions table at the top still says "keeps the first occurrence in (row, col) order", and LDB-F33 in §9 says "analyses the first occurrence in `(row, col)` order" — both must read *first entry in list order* (§4's own text already does). And LDB-F33's "a char named anywhere in `magic` is unique on the layout" should read *has at most one entry* (LDB-F22 allows zero: a named key need not be on the layout).

One consistency note that costs nothing: `liftRules`' chiral pass already treats a char with no single hand as `bad` and pushes those rows to leftovers (`magic.ts:488-501`) — with list keys, `handOf` returning `null` for a two-handed char makes the import produce exactly the raw row the validator wants. No new import logic.

### D — does list order mean anything else? No — but two traps

Order carries **no** meaning beyond primary selection. Checked: `layoutChars` sorts distinct chars by code point (scaffolds are order-free); `fromSpark` places the grid by `(row, col)` and sorts thumbs by `(col, row)`; `handSplit`/`classifyFingering`/the coordinate function read positions and fingers; the `.lowered.json` goldens cannot see order; rev and `If-Match` are counters, not hashes; the site draws from positions. `canonical()` preserves array order, so order survives storage and shows up in `payload_json` bytes — which is where the traps are:

1. **The import diff is byte-identity.** `import/diff.ts:201` decides "unchanged" by `canonical(u) === canonical(o)`. If the importer emits `keys` in cmini's object order and cmini's serialiser ever reorders (a dict rebuilt upstream), every following layout gets a content-identical new rev on the next tick. Rule: *`fromCmini` emits `keys` sorted by `(row, col)`* — deterministic, geometry-derived, and harmless to primary selection because cmini's char-keyed map cannot carry duplicates. Same rule for `mana2/1 → spark` (`toSpark` already walks rows then columns).
2. **A read-modify-write client that re-emits in its own order bumps revs for nothing.** The site's `toAkl1` rebuilds `keys` from bench order after `normalizeLayoutColumns`; a no-op save would then `PUT` a different byte string. Rule for every full-payload writer: *preserve the fetched list order for entries you did not add; append new entries at the end* — and the invariant that enforces it, `canonical(toAkl1(fromAkl1(p))) === canonical(p)` for every fixture (G).

Error paths (`/keys/<i>`) index the *request body as sent*, never a stored order — say so once in §6.

### E — free entries keep `finger` required: agree

Three concrete reasons, any one sufficient: `handSplit` needs a hand for every position on the finger rows (a hole between the hands still sits on one side); the mana2 lowering writes a fingermap digit for a `skip` cell (`translate.ts:444-446`) and LDB-F5's `mana2 → spark → mana2` identity over the vendored files needs it back; the bot's `~` token and cmini's `free` both arrive with a finger (the column's default), so it is never missing at the door. A free entry without a finger would be the one field in the format that readers have to re-derive — the pattern `23` §1 exists to end.

### F — tag spelling: prefer a `kind` discriminator

This is where I push back. Recommend

```
default: { "kind": "repeat" } | { "kind": "char", "char": "e" }     // absent = none
same / opposite: the same shape
```

over `{ "repeat": true } | { "char": "e" }`. Reasons:

1. `{ "repeat": false }` is a degenerate value the boolean spelling has to legislate (refused? equal to absent?); a discriminator has no such value.
2. Every adopter culture in this thread deserialises tagged unions the same way — serde `#[serde(tag = "kind")]` (keymaxx), a Go `switch v.Kind` (mana2), a TS discriminated union (bot, site), JSON Schema `oneOf` with `const` — and the boolean form is the one shape none of them expresses natively.
3. Extension: xsznix's model (04:10) makes repeat and skip-repeat *separate concepts*; if a `{ "kind": "skip" }` (or an explicit `{ "kind": "none" }`) is ever wanted it is one more enum value, not a new field name readers must learn to tell apart from `repeat`/`char`.
4. One spelling for three fields, and the same tag vocabulary the lowered rows already carry (`type: "repeat"`).

Cost: one message to the running format slice; the DB is disposable and no writer exists yet. **Fallback if the lead keeps the boolean spelling** (I will not block on it): the schema must pin it — `{ "repeat": { "const": true } }` with `additionalProperties: false` per branch — so `repeat: false` is a schema refusal, not a validator special case; and `22` §5.2 must show both branches.

### G — the running site slice

Nothing changes in its brief (tagged magic mapped at the codec, `keys` as an ordered list, `board` one word). Four things to add to it, each an invariant, not a feature:

1. **Round-trip identity.** `canonical(toAkl1(fromAkl1(p))) === canonical(p)` for every spark/1 fixture, duplicates, iso, colstag and tagged magic included. This is the one test that catches every lossy-PUT trap below at once.
2. **`draftKeysAsMap` is a collapse point** (`akl1.ts:98-101`: `out[k.c] = …`, last wins). A record with two `y`s loses one on the way into a char-keyed bench draft, and a subsequent publish would *delete the author's duplicate*. Until the bench can hold a list, a record with a duplicated char is view-only on the bench (xsznix's "degrade to view-only", 13:29) — never edit-and-republish through the map.
3. **Round-trip `board` verbatim.** The bench edits `ansi`/`ortho` today; `iso`/`colstag` must survive a publish of a record the bench cannot re-author, not be downgraded to `ortho`.
4. **Codec refuses what the DB refuses, before the request.** Chiral `same`/`opposite` must be one code point at the codec (`{ "char": "ee" }` is a 400); `notes`/`updated` are not sent (A); `repeat_previous`/`none` strings never leave the site.

### H — what round 1 missed, before the first outside adopter

1. **No request-body size cap.** Nothing in `db/src` bounds a `POST`/`PUT` body or `keys.length`/`rules.length`; a schema without a size bound is not a wire contract. State one (canonical bytes; 64 KiB covers every fixture by an order of magnitude) with its own error code and fixture.
2. **The served schema still says `akl/1`** (`schema.json:3-4`: `$id …/formats/akl/1/schema.json`, title `akl/1 payload`). A resolver that caches by `$id` will confuse the two; fix before anyone fetches it.
3. **`rules[].type` is a free string with reserved meaning.** `liftRules` promotes a raw row tagged `repeat`/`magic`/`chiral`/`adaptive`/`default:<c>` into an idiom on import, and the tag rides into `mana2/1` rows. Either reserve those words on write (refuse them in `rules[].type`) or document that a client writing them is opting into the lift. Recommend refuse: raw means raw.
4. **adoption.md examples are pre-list.** §0/§5 still show `"payload":{"keys":{}}` and `finger ∈ … TB`; the conformance fixtures under `layouts-write/` carry the same shapes. The signing vector file (`client-signing.json`) is bytes-only and stays; every other example changes with the shape.
5. **Say what a magic-named char with zero entries means** (LDB-F22): allowed, produces no scaffold rows, is not an error. With a list this needs the words "at most one entry", not "unique".
6. **Say that scaffolds enumerate thumb-key chars too** (`layoutChars` walks every entry): a thumb `e` gets `e*→ee`. Fine, but an adopter comparing against a per-finger-row lowering will otherwise think it is a bug.
7. **Two thumb rows are schema-legal** (`row` ≤ 4, thumbs on any row ≥ 3): state it as allowed and rendered by column, or cap thumbs to one row. Recommend allowed — it costs nothing and svalboard-adjacent boards want it.

### Disagreements that remain

One, soft: **F (tag spelling)** — I recommend `kind`; the lead instructed `{ "repeat": true }`. Either is codeable; my fallback conditions are in F. Everything else — A (drop), B (reserve + no-op `from=spark`), C, D, E, G, H, and every finding's rule above — the lead and I agree on, and saltorbit can take that as the joint decision.
