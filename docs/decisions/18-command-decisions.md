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
| fingers fspeed | keep | ("port the 12 modes?" — asked what that means; §3) |
| sfbs sfs rolls inrolls outrolls alternates redirects | keep | |
| onehands | change | will be renamed (`3rolls` or similar) |
| pattern | **drop** | |
| freq freqs | change | collapse into one; both names alias the same thing |
| freqd | **drop** | |
| examples help | keep | |

## 2. Work items

Bot (branch after LDB-B26/B27 lands; each row is an invariant + tests):

- **C1 Drop** `link`, `mod`, `pattern`, `freqd` from the registry. `help` no longer lists them; an unknown-verb reply as for any other word. Transcript, scenario coverage (LDB-B18's `skipped[]`) and the parity table updated.
- **C2 Redirect stubs** for `search`, `filter`, `homerow`: registered so they answer honestly — one line pointing at akl.gg's filters with the site link (`// COPY: sign-off pending`) — rather than "not an available command". Revisit when saltorbit wants them back.
- **C3 No personal links.** `x.cmini.link` is never rendered again (`render/grid.ts` `toString`/`fingermapToString`, `commands/shared.ts`'s `GridRecord.link`); the payload keeps carrying it (import fidelity, LDB-F10 unchanged).
- **C4 `transfer`** = alias of `assign` (same command object under two names; `help` shows `transfer` as the primary once copy is signed, `assign` kept for cmini muscle memory).
- **C5 `freq` = `freqs`**: one implementation, the grouped-with-reverse output (`freqs`'s: a superset of `freq`'s), both names.
- **C6 `authors` paging** like `rank` (`authors [page]`), the LDB-B19 cap kept as the backstop.
- **C7 `history` → link.** Reply = one header line + the link to the layout's changelist page. Until akl.gg has one, the link is layoutdb's own public changelog (`/admin/changelog`, X3) filtered to the layout (add a `layout=<name>` filter to that page if it lacks one). Swap the target when the akl.gg page exists.
- **C8 `compare` link**: append the site's compare link (`cmpA`/`cmpB` hash keys, `web/src/core/codec.ts`). See §3 Q2 for the image form.
- **C9 `view` bench link**: the akl.gg link on `view` opens the layout in the bench (the site's hash for "open this layout in the bench" — to confirm with the site session; if none exists, it is a small site change). Other single-layout replies keep the card link.
- **C11 Link text.** The masked link's visible text is `akl.gg`, not `(akl.gg link)` (saltorbit, 03:3xZ) — `appendSiteLink` and the LDB-B25 row.
- **C10 `onehands` rename**: when the name is chosen, add it as the primary and keep `onehands` as an alias for a while.

DB / site (design first, `17`-style docs):

- **D1 Same-name re-add inherits likes** (`remove` decision). Proposed rule: `POST /v1/layouts` with a name currently held by a **tombstone the same actor owns** is a restore-with-payload — same record id, rev+1, likes and history kept, `kind: created` with `detail.restored_from: <rev>`; a different actor gets a fresh record and inherits nothing (a freed name must not be a way to collect someone else's likes). Invariant + tests in `db/`; the bot's `add` needs no change. Needs saltorbit's yes on the different-actor half.
- **D2 Rename never loses the id.** Already true at the record level (a rename is a `PATCH` on the same id; likes, history, rev chain continue — LDB-P4) but the SITE keys its catalog by `name.lower()`, so a rename moves the site id; the sync carries `_dbId` on every row. Add an explicit invariant that every path that identifies a layout across a rename (site sync, bot cache, links) does so by `_dbId`/record id, and a test that a renamed layout keeps its likes and history end to end.
- **D3 A per-layout changelist page** on akl.gg (the `history` target). Out of the bot's scope; either the site session builds it, or C7's layoutdb page is the long-term answer.
- **D4 Layout entry expressivity** (`add`/`setfingermap`): a design round — coordinates, stagger, thumbs, row 4 — "easy and identical for simple layouts, more expressive for advanced ones". Candidate: the akl/1 shape as an optional fenced JSON alternative to cmini's grid, plus the bench link so the site is the advanced editor. Design doc first, no code.
- **D5 `rank` by mana stat names** (later): a text form of akl.gg's stat vocabulary.
- **D6 `view` stat names/ordering** to match akl.gg (later; a copy round).

## 3. Open questions (saltorbit)

- **Q1 `fingers` modes.** cmini's `fingers [layout] [metric]` prints one per-finger table per metric: `usage` (what spark prints), and also `sfb`, `sfs`, `roll`, `alt`, `red`, `oneh`, `inroll`, `outroll`, `redirect`, `dsfb`, `speed` — twelve breakdowns of the same stats by finger. spark answers "not supported" for anything but `usage`. Port them (each is a column of numbers the site already has per finger), or leave `fingers` as the usage table only?
- **Q2 compare with an image.** Recommendation: no new verb — `image <a> <b>` renders the site's compare card (the same drawing code as `image <a>`, `cmpBase` set), and `compare` stays the text form plus the akl.gg compare link. One verb, two arities, matches how `view`/`image` already pair.
- **Q3 D1's different-actor half** (§2): fresh record, no inherited likes?
- **Q4 `onehands`' new name** when you have it.
- **Q5 `search`/`filter`/`homerow`**: stubs that point at the site (C2), or silent removal?
