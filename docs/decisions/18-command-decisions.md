# 18 — Command-surface decisions (spark)

Status: saltorbit's review of every verb, 2026-09-10 03:25Z, from the review
page (`16-command-audit.md` §1 was the input). Verbatim decisions, then
the work they imply, then the questions still open. Copy changes (new
strings, renamed verbs) stay `// COPY: sign-off pending` until saltorbit signs
`14-copy-signoff.md`.

## 1. Decisions

| verb | decision | saltorbit's note |
|---|---|---|
| add | keep | still good; the way layouts are added (coordinates, stagger…) needs more expressivity for advanced layouts while staying easy and identical for simple ones; `view` should carry an akl.gg link that opens the bench, so people edit on the site rather than through Discord |
| remove | keep | a later `add` of the same name must inherit the deleted layout's likes |
| rename | keep | make sure ids are never lost through a rename |
| assign | keep | add `transfer` as an alias (the DB's own verb) |
| setfingermap | keep | same expressivity note as `add` |
| swap! cycle! angle! unangle! mirror! like unlike | keep | |
| view | keep | colors (D), the akl.gg link, the magic line only when rules could not be applied — fine; stat names/ordering will change to match akl.gg later; **remove the personal link** at the bottom; stays text (no image) |
| fingermap | keep | colors; remove the personal link |
| image | keep | caption carries the akl.gg link |
| magic | keep | akl.gg's rules only |
| history | change | link out to an akl.gg changelist page instead (to be created) |
| link | **drop** | |
| swap cycle angle unangle mirror | keep | colors + link like `view`; **every personal link goes away** ("they're not even in layoutdb anymore") |
| mod | **drop** | |
| compare | keep | add a link to akl.gg's compare; consider a compare-with-image command |
| random list likes corpus | keep | |
| rank | keep | cmini-style stats for now; later a text form that takes mana stat names |
| authors | keep | page it like `rank` |
| stats | keep | leave as is |
| search filter homerow | **drop** | the complex things should direct people to the site; maybe back later |
| fingers fspeed | keep | usage only (the other cmini metrics are not ported) |
| sfbs sfs rolls inrolls outrolls alternates redirects | keep | |
| onehands | change | will be renamed (`3rolls` or similar) |
| pattern | **drop** | |
| freq freqs | change | collapse into one; both names alias the same thing |
| freqd | **drop** | |
| examples help | keep | |

## 2. Work items

Bot (branch after LDB-B26/B27 lands; each row is an invariant + tests):

- **C1 Drop** `link`, `mod`, `pattern`, `freqd` from the registry. `help` no longer lists them; an unknown-verb reply as for any other word. Transcript, scenario coverage (LDB-B18's `skipped[]`) and the parity table updated. **SHIPPED 2026-09-10 (LDB-B30, worktree-ldb-v3): modules deleted, `linkFor`/`siteIdFor`/`appendSiteLink` moved to `commands/siteLink.ts`.**
- **C2 Redirect stubs** for `search`, `filter`, `homerow`: registered so they answer honestly — one line pointing at akl.gg's filters with the site link (`// COPY: sign-off pending`) — rather than "not an available command". Revisit when saltorbit wants them back. **SHIPPED 2026-09-10 (LDB-B31, worktree-ldb-v3): `copy.ts`'s `siteFiltersRedirect`; `render/similar.ts` (the DSL's Jaro-Winkler port) deleted with them.**
- **C3 No personal links.** `x.cmini.link` is never rendered again (`render/grid.ts` `toString`/`fingermapToString`, `commands/shared.ts`'s `GridRecord.link`); the payload keeps carrying it (import fidelity, LDB-F10 unchanged).
- **C4 `transfer`** = alias of `assign` (same command object under two names; `help` shows `transfer` as the primary once copy is signed, `assign` kept for cmini muscle memory). **SHIPPED 2026-09-10 (LDB-B32, worktree-ldb-v3): both names registered as the SAME `Command` instance; `desc()`'s "primary" wording still pending copy sign-off.**
- **C5 `freq` = `freqs`**: one implementation, the grouped-with-reverse output (`freqs`'s: a superset of `freq`'s), both names. **SHIPPED 2026-09-10 (LDB-B33, worktree-ldb-v3): `freq.ts` deleted, both names registered to `freqs.ts`'s Command instance.**
- **C6 `authors` paging** like `rank` (`authors [page]`), the LDB-B19 cap kept as the backstop. **SHIPPED 2026-09-10 (LDB-B34, worktree-ldb-v3): `AUTHORS_PAGE_SIZE` = `rank.ts`'s own `LENGTH` (15), 1-based page, page 1 default, out-of-range/invalid-page copy pending sign-off.**
- **C7 `history` → link.** Reply = one header line + the link to the layout's changelist page. Until akl.gg has one, the link is layoutdb's own public changelog (`/admin/changelog`, X3) filtered to the layout (add a `layout=<name>` filter to that page if it lacks one). Swap the target when the akl.gg page exists. **SHIPPED 2026-09-10 (LDB-B35, worktree-ldb-v3): `/admin/changelog` already accepts a `layout=<id-or-name>` filter (`db/src/routes/changelog.ts`'s `resolveLayoutFilter`, no DB change needed) -- header is `image.ts`'s own "name (author) (N likes)" shape; no more per-call history GET.**
- **C8 `compare` link**: append the site's compare link (`cmpA`/`cmpB` hash keys, `web/src/core/codec.ts`). See §3 Q2 for the image form. **SHIPPED 2026-09-10 (LDB-B36, worktree-ldb-v3): `siteLink.ts`'s `compareLinkFor`.**
- **C9 `view` bench link**: the akl.gg link on `view` opens the layout in the bench (the site's hash for "open this layout in the bench" — to confirm with the site session; if none exists, it is a small site change). Other single-layout replies keep the card link.
- **C12 `image <a> <b>`** renders the site's compare card (same drawing code, `cmpBase` set) — saltorbit: "great idea, do that"; `compare` stays text + the akl.gg compare link (C8). **SHIPPED 2026-09-10 (LDB-B36, worktree-ldb-v3): `render/image.ts`'s `buildStandaloneImagePlan` takes an optional `base`; `image <a>` (one name) unchanged. Linux compare goldens NOT regenerated in this pass -- `scripts/linux-goldens.sh` needs a fresh run (Docker was available in this environment, but the existing macOS-only golden pair is what's committed; see the handoff report).**
- **C13 `spacegrams` as a user setting** (saltorbit, 04:1xZ): `spacegrams on|off` beside `corpus` (`prefs.ts`, per user, on the Fly volume); every stat verb and `!image` compute with it (the harvest's spacegrams variant of the cell / the engine's `context.space`), and the card's footer says which (`· spacegrams` / `· no spacegrams`; the static "no spacegrams" note shipped 2026-09-10 is the interim). **SHIPPED 2026-09-10 (LDB-B37, worktree `ldb-c13-bot`)**: implemented as the three-way `off|left|right` (matching the harvest's own `none`/`lt`/`rt` files exactly) rather than the `on|off` sketched above — `off` maps to the pre-existing fixed `none` context, `left`/`right` bind space to that thumb; `(corpus, space)` is one cache/harvest key throughout (`cache/cells.ts`, `engine/host.ts`, `engine/site.ts`); `!image`'s footer (`copy.ts`'s `spacegramsFooterSuffix`, replacing `noSpacegramsSuffix`) says `· no spacegrams` / `· spacegrams (left thumb)` / `· spacegrams (right thumb)`. `!view`'s corpus header line untouched, per this row's own note. **`auto` ADDED 2026-09-10 (LDB-B39, branch `ldb-auto-labels`; saltorbit: "Spacegrams should also support auto")**: `!spacegrams off|left|right|auto` — `auto` is akl.gg's own auto mode (`@akl/core/spacegrams`: rules 1a/1b/2 from the keys, else the side with the lower plain Redirect Total, tie/missing → left), resolved per layout inside `cache/cells.ts` (`resolveSpace`, memoised per (id, rev, corpus); a harvested catalog record settles from the site's `.lt`/`.rt` harvests with no compute, otherwise at most two). `compare`/`image a b` resolve each layout on its own; the `!image` footer names the resolved side (`· spacegrams (auto: left thumb)`, COPY pending). Default stays `off`. **T2 + I1 picked 2026-09-10 (mockup round; branch `ldb-sg-indicator`)**: the `view`/`compare` text grid shows one `␣` under the resolved space thumb (LDB-B41, T2 — a thumb-row rendering bug found on the way, LDB-B43, fixed first), the stats block gains the card's `NoTh`/`Thumb` rows whenever a thumb is involved (LDB-B44), and the `!image` card draws akl.gg's own dashed space key on the resolved side with the footer reading `SG On`/`SG Off` (LDB-B42, I1 — the two strings dictated verbatim, signed, `14-copy-signoff.md` round 5; the long forms above are gone). The header/corpus line of `!view` stays untouched (not picked).
- **C11 Link text.** The masked link's visible text is `akl.gg`, not `(akl.gg link)` (saltorbit, 03:3xZ) — `appendSiteLink` and the LDB-B25 row.
- **C10 `onehands` rename**: when the name is chosen, add it as the primary and keep `onehands` as an alias for a while. **SHIPPED 2026-09-10 (LDB-B38, worktree `ldb-c13-bot`)**: broadened per a later saltorbit ask ("we have a bunch of different names for cmini stats on akl.gg. can we use those?") from just `onehands` to all five akl.gg card labels that have a cmini-verb counterpart — `alt`/`rol2`/`rol3`/`red`/`sfb` registered as PRIMARY aliases of `alternates`/`rolls`/`onehands`/`redirects`/`sfbs` (same `Command` instance under both keys, C4's `assign`/`transfer` pattern); `sfs`/`inrolls`/`outrolls` already matched and are unchanged. **Displayed names followed 2026-09-10 (LDB-B40, branch `ldb-auto-labels`; saltorbit: "this should say 3-rolls, not onehands … If there's anywhere else similar, let's fix")**: the n-gram headers print `3-Rolls`/`2-Rolls`/`2-Rolls In`/`2-Rolls Out`/`Alternations`, and the `view`/`compare` stats block prints the card's own rows in the card's order (`Alt`, `Roll`, `Rol2`, `Rol3`, `Red`, `SFB`, `SFS` (Alt/Red), `LH/RH`); no cmini-only stat name survives anywhere a stat is named. Verb keys unchanged.

DB / site (design first, `17`-style docs):

- **D1 Same-name re-add inherits likes** (`remove` decision; saltorbit 2026-09-10: "tombstoned name carries likes for whoever takes it. it's a quirk people like"). Rule: `POST /v1/layouts` with a name held by a tombstone — **any** actor — creates the new record with the tombstone's likes copied onto it (`liked` events `via: name_inherited` naming the source record, so the fold stays the record; the tombstone keeps its own history and stays restorable by its owner, which would then split the likes — acceptable, document it). Invariant + tests in `db/`; the bot's `add` needs no change. **`db/`-side DONE** (2026-09-10): `LDB-P9` (`db/INVARIANTS.md`), `core/write.ts`'s `createLayout` + `core/events.ts`'s `Like.detail`, tests in `db/tests/api/write.test.ts` (inherit same/different owner, no tombstone, zero-like tombstone, restore-after-inherit, `/v1/changes`).
- **D2 Rename never loses the id.** Already true at the record level (a rename is a `PATCH` on the same id; likes, history, rev chain continue — LDB-P4) but the SITE keys its catalog by `name.lower()`, so a rename moves the site id; the sync carries `_dbId` on every row. Add an explicit invariant that every path that identifies a layout across a rename (site sync, bot cache, links) does so by `_dbId`/record id, and a test that a renamed layout keeps its likes and history end to end. **`db/`-side DONE** (2026-09-10): `LDB-P10` (`db/INVARIANTS.md`) pins create → like ×3 → rename → GET by new name/by id/history/likes/`full=1` all agree (`db/tests/api/patch.test.ts`); the SITE-side half (sync/bot cache/links keying by `_dbId`, outside `db/`) is still open.
- **D3 A per-layout changelist page** on akl.gg (the `history` target). Out of the bot's scope; either the site session builds it, or C7's layoutdb page is the long-term answer.
- **D4 Layout entry expressivity** (`add`/`setfingermap`) — **PARKED 2026-09-10, mockups https://claude.ai/code/artifact/fd8f4a07-cf10-4e78-b3bc-a3f77ecb3530, see 13-ledger §6b**: a design round — coordinates, stagger, thumbs, row 4 — "easy and identical for simple layouts, more expressive for advanced ones". Candidate: the akl/1 shape as an optional fenced JSON alternative to cmini's grid, plus the bench link so the site is the advanced editor. Design doc first, no code.
- **D7 `setmagic` + `magic` in akl.gg's shape** — **CLOSED 2026-09-10: magic is edited on the site only; `magic` read stays** (mockups e7e65dd1 / c56085f3 kept for reference) (saltorbit, 2026-09-10 04:0xZ: "we also need to work on magic -- setmagic and magic both, like how we represent this in a similar way to akl.gg"). `magic` already prints the site's caption text (magic keys / adaptive swaps); the design question is the WRITE side: a Discord text grammar for a rule set (magic keys with per-key rules and a default, chiral keys, adaptive swaps, raw rules) that round-trips to akl/1 `magic`, mirrors the site's editor vocabulary, and validates with the same `validateRuleSet`. Design doc with mockups first; `setmagic [name]` + fenced block as the likely shape; write = `PATCH {magic}` (lifts a cmini/1 record to akl/1, doc 17 §3).
- **D8 The format carries the board shape** — **PARKED with D4 (same artifact; do D8 first when resumed)** (saltorbit, 04:2xZ: "we need to work on format too. we may decide to include the board shape etc. and that would make rendering decisions easier"). akl/1's `board` today is `{kind, stagger, cmini}`; a format round (with D4) to decide what physical shape a record carries -- rows/columns, per-row stagger, thumb cluster positions, key sizes -- so the site's and the bot's renderers read geometry instead of inferring it from the cmini word. `01-format.md` §2 is the doc to amend; a new minor of akl/1, never a rewrite of stored payloads.
- **D5 `rank` by mana stat names** (later): a text form of akl.gg's stat vocabulary.
- **D6 `view` stat names/ordering** to match akl.gg (later; a copy round).

## 3. Open questions (saltorbit)

- ~~Q1 `fingers` modes~~ — **usage only** (saltorbit). `fingers`/`fspeed` stay as they are.
- ~~Q2 compare with an image~~ — **`image <a> <b>`** (saltorbit: "great idea, do that") → C12.
- ~~Q3 D1's different-actor half~~ — **likes carry to whoever takes the name** → D1 as written.
- ~~Q4 `onehands`' new name~~ — **`rol3`** (akl.gg's own card label), alongside `alt`/`rol2`/`red`/`sfb` for the other four → C10/LDB-B38.
- **Q5 `search`/`filter`/`homerow`**: stubs that point at the site (C2), or silent removal?
