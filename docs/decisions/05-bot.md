# The Discord bot

Status: proposal, round 2 (2026-09-09). Part of `00-plan.md`. Source of the
parity list: cmini's `cmds/*.py` at upstream `068a4f50` (every command's
`use()`/`desc()` read directly; the tree was vendored at
`vendor/cmini-analyzer` until #214 — still at `a5b0fe35^`).

## 1. Shape — a rewrite that shares akl.gg's logic

**Decided (saltorbit, 2026-09-09): a rewrite, not a fork.** No Python is
reused. The bot is TypeScript, and its numbers come from the same code that
produces akl.gg's: the mana2 engine (the Go swap engine compiled to wasm that
the site already runs for drafts and swap mode), with the classic cmini
stats **composed** from the mana2 harvest by `web/src/core/stats/merge.ts`'s
`cminiRowFromMana2` — the one composition the site has used since #214
("there is no second analyzer", `CLAUDE.md`). Same engine, same composition,
same digits as the site, by construction rather than by parity testing.

```
bot/                        MIT (a rewrite; nothing of cmini's GPLv3 code)
  src/
    main.ts                 discord.js client; message commands with the `!spark` prefix (tentative, §8)
    commands/               one module per verb, same names/usage/wording as cmini's (§2)
    render/                 text tables (cmini's wording) and the image renderer (§3)
    cache/                  local mirror of every layout, fed by /v1/changes (§4)
    client/                 the DB client: reads, writes, client-lane signing (02 §3)
  Dockerfile · fly.toml     one small machine (§5)
  tests/                    parity table, numbers-equal-the-site, signing vectors
```

What it shares with akl.gg, and how: the site's `web/src/core/**` is the
pure, DOM-free layer of the frontend (stats composition, layout geometry,
codec/export, magic scaffold/resolve, the swap-engine worker protocol). The
bot imports it as a package rather than by path — `@akl/core` published
from `web/src/core` at the split, the same way `db/formats` becomes
`@akl/layout-formats` (`06 §5`). Until the split, `bot/` may import
`web/src/core` and `db/formats` **read-only and by path** — a narrow,
named exception to `00 §7`'s no-cross-import rule, enforced by an archlint
rule (`bot → web/src/core | db/formats` only, nothing else, never the
reverse). Anything the bot needs that lives in `web/src/data` or `ui`
is moved down to `core` by a site PR — `10 §2`: **U1** moves the worker
driver `data/swap-engine.ts` (zero imports, every effect injected) to
`core/swap-engine.ts`; **U2** moves the canvas drawing half of
`ui/copy-image/` to `core/copyimage/`. Nothing is duplicated.

The wasm engine gives the bot stats for **any** layout — published or
`!spark swap`'d on the fly — at ~90 ms per layout in a `worker_threads`
Worker (`10 §1` D1). Catalog-wide verbs (`rank`, `filter`) do **not**
recompute 4 000 layouts: the bot reads the site's own precomputed cells
(`https://akl.gg/data/mana2/<corpus>.rowstag.none.json`, the same engine's
output, gated on every deploy against the wasm) and computes only what the
harvest cannot have — records newer than the nightly, and transforms
(`10 §1` D3). The wasm and the corpus tables are fetched from the site at
boot, never shipped in the image (D2).

## 2. Command parity

Every command in cmini's `cmds/`, what it becomes. **DB** = a write to the
layout DB (client lane, actor = message author); **compute** = the wasm
engine + `cminiRowFromMana2`, over the local cache; **local** = unchanged,
no layouts involved. Usage lines and wording are cmini's, so nobody relearns
anything; only the prefix changes (§8).

### 2.1 Layout-changing verbs → DB writes

| command | usage | becomes | notes |
|---|---|---|---|
| `add` | `add [LAYOUT]` | `POST /v1/layouts` `format: akl/1` | the grid parser is rewritten in TS with cmini's exact error strings (`missing gap before column …`, LDB-P7); board word derived as `add.py` does, stored as `board.cmini` + geometry |
| `remove` | `remove [name]` | `DELETE /v1/layouts/{name}` | `403 not_owner` → *you don't own any layout named* |
| `rename` | `rename [old] [new]` | `PATCH {name}` | `409 name_taken` → *already exists* |
| `assign` `transfer` | `assign [LAYOUT] [AUTHOR]` | `POST …/transfer {to}` | C4 (18 §2, LDB-B32, 2026-09-10 SHIPPED): `transfer` registered as the SAME Command object -- `assign` kept for cmini muscle memory |
| `setfingermap` | `setfingermap [name] [MATRIX]` | `PATCH {fingermap}` (+ `{board}` when implied) | validation strings preserved |
| `swap!` `cycle!` | `swap! [name] [chars]` | local transform then `PUT` | |
| `angle!` `unangle!` | `angle! [name]` | local transform then `PUT` | `mini` refusal client-side |
| `mirror!` | `mirror! [name]` | local transform then `PUT` | |
| `like` `unlike` | `like [name]` | `PUT`/`DELETE …/like` | qwerty refusal server-side too |
| `link` `unlink` | (admin-only in cmini) | **dropped** — no link on the record (round-1 review); C1 (18 §2, LDB-B30, 2026-09-10 SHIPPED) removed the `!link` VERB too — `linkFor`/`siteIdFor`/`appendSiteLink` moved to `commands/siteLink.ts`, still used everywhere else | |
| `admin` `maintenance` | restricted | `/v1/admin/*` where they map; the rest stay bot-local | |

### 2.2 Read verbs → compute over the cache

`view stats fingers fspeed sfbs sfs rolls inrolls outrolls onehands
alternates redirects pattern compare mod swap cycle angle unangle mirror
fingermap homerow filter search rank freq freqd freqs examples names guess
random count xkb list likes authors corpus` — the cmini-view row for a layout
is `cminiRowFromMana2(engine.compute(layout, corpus))`; the per-finger and
n-gram detail verbs (`sfbs`, `rolls`, `pattern`, `freq…`) read the same
harvest the site's popovers read. `list [username]`, `authors` and
`likes` read the bot's local cache (authors, `likedBy` from the dump +
`liked`/`unliked` events — LDB-B3; the DB's `liked_by` filter, `10` C1, is
for other clients). `find` keeps cmini's fuzzy match (Damerau–Levenshtein
over cached names, `10` V4). `corpus` (a user's preferred corpus) is
bot-local state on a 1 GB Fly volume (`10 §1` D10); the default is the
site's `reddit` (cmini's `mt-quotes` does not exist on akl.gg). The
n-gram detail verbs (`sfbs`, `rolls`, `pattern`, `freq…`) keep cmini's
wording and columns over the site's corpus tables and mana2 taxonomy —
format parity, not number parity (`10` V5).

### 2.3 Local / social

`8ball catball dofball wooperball woopercat question flip gen help suggest
akl alt pairings` — rewritten as-is, no layouts involved.

### 2.4 New verbs (after parity)

- `!spark magic [name]` — a layout's magic as the author wrote it (idioms
  from `akl/1`, raw rules otherwise) — reads `?as=akl/1`.
- `!spark history [name]` — last 5 events. **Changed 2026-09-10** (C7, §2.5
  below): now a header line + a link to layoutdb's own changelog, no more
  per-call DB fetch.
- `!spark image [name]` — the site's copy-as-image render (§3), which is
  what #218 asked for from mana. **Extended 2026-09-10** (C12, §2.5): a
  second name renders the site's compare card.

### 2.5 Update 2026-09-10 (`18-command-decisions.md`'s round-2 review) — SHIPPED

- **C1/LDB-B30**: `link`/`mod`/`pattern`/`freqd` dropped from the registry
  outright (their modules deleted, not just unregistered).
  `commands/link.ts`'s `linkFor`/`siteIdFor`/`appendSiteLink` moved to
  `commands/siteLink.ts`.
- **C2/LDB-B31**: `search`/`filter`/`homerow` are one-line redirect stubs
  (`copy.ts`'s `siteFiltersRedirect`) — no DSL, no cache read, no fetch
  (added to `NO_FRESH_VERBS`); `render/similar.ts` (Jaro-Winkler) deleted
  with them.
- **C4/LDB-B32**: `transfer` is a second registry key for `assign`'s own
  `Command` object.
- **C5/LDB-B33**: `freq`/`freqs` collapse into one implementation
  (`freqs.ts`'s grouped-with-reverse output), registered under both names;
  `freq.ts` deleted.
- **C6/LDB-B34**: `authors [page]` pages like `rank` — `AUTHORS_PAGE_SIZE`
  = `rank.ts`'s own `LENGTH` (15), a plain 1-based page number, page 1
  default; the LDB-B19 byte-budget cap stays as the within-page backstop.
- **C7/LDB-B35**: `history` moves to the cache-only column — no more
  per-call `GET /v1/layouts/{ref}/history`, no more "last 5 events". The
  reply is `image.ts`'s own header-line shape plus a masked link to
  layoutdb's own public changelog (`db/src/routes/changelog.ts`'s
  `/admin/changelog?layout=<name>`, `ctx.dbBaseUrl` — a NEW `CommandContext`
  field, distinct from `siteBaseUrl`/akl.gg until D3 gives akl.gg its own
  changelist page).
- **C8/LDB-B36**: `compare` appends the site's compare-dock link
  (`siteLink.ts`'s `compareLinkFor`, `encodeStateHash({cmpA, cmpB})`).
- **C12/LDB-B36**: `image <a> <b>` renders the site's compare card through
  the SAME drawing code `image <a>` uses (`render/image.ts`'s
  `buildStandaloneImagePlan`, extended with an optional `base`); `image
  <a>` (one name) is unchanged.
- **C13/LDB-B37**: `!spacegrams off|left|right`, a second per-user
  preference beside `!corpus` in the SAME `prefs.ts` file (same
  durability) — no arg reads the current setting back (default `off`); an
  arg validates against those three values and persists. Every stat verb
  and `!image` compute WITH it: `space.ts` maps the preference onto the
  site's own `context.space` vocabulary (`none`/`lt`/`rt`) — the harvest
  read and the wasm fallback's CONTEXT both key off `(corpus, space)` as
  one pair (`cache/cells.ts`, `engine/host.ts`, `engine/site.ts`). `!image`'s
  footer names the setting (`copy.ts`'s `spacegramsFooterSuffix`,
  replacing the static `noSpacegramsSuffix` this same section shipped
  2026-09-10 as an interim). `!view`'s corpus header line is untouched — a
  separate design.
- **C10/LDB-B38**: akl.gg's own card-label stat names
  (`web/src/copy/card.ts`) — `alt`/`rol2`/`rol3`/`red`/`sfb` — are
  registered as PRIMARY aliases of `alternates`/`rolls`/`onehands`/
  `redirects`/`sfbs`, same `Command` instance under both keys (C4's
  `assign`/`transfer` pattern); `sfs`/`inrolls`/`outrolls` already match
  and are unchanged.
- **C13 follow-up, LDB-B39 (saltorbit 2026-09-10: "Spacegrams should also
  support auto")**: `!spacegrams auto` — akl.gg's OWN auto mode
  (`@akl/core/spacegrams`, `web/src/core/spacegrams.ts`: rules 1a/1b/2
  from the keys, else rule 3 = the side with the lower mana2 Redirect
  Total, tie/missing → left), resolved PER LAYOUT by `cache/cells.ts`
  (`resolveSpace`, memoised per (id, rev, corpus); rule 3's two cells go
  through the usual harvest-else-wasm path, so a catalog record settles
  from the site's shipped `.lt`/`.rt` harvests with no compute). A verb
  hands the cache a `SpaceRequest` (`none`/`lt`/`rt`/`auto`); the engine
  only ever sees a concrete context. `compare`/`image a b` resolve each
  layout on its own; `!image`'s footer names the resolved side
  (`· spacegrams (auto: left thumb)`). Default stays `off`.
- **LDB-B40 (saltorbit 2026-09-10: "this should say 3-rolls, not onehands …
  If there's anywhere else similar, let's fix")**: every stat the bot
  NAMES uses akl.gg's vocabulary — the n-gram headers say `3-Rolls`/
  `2-Rolls`/`2-Rolls In`/`2-Rolls Out`/`Alternations` (`Onehands`/`Rolls`/
  `Inrolls`/`Outrolls`/`Alternates` are gone), and the `view`/`compare`/
  write-success stats block prints the card's own rows in the card's
  order — `Alt`, `Roll` (In/Out), `Rol2` (In/Out), `Rol3` (In/Out), `Red`
  (Bad), `SFB`, `SFS` (Alt/Red), `LH/RH` — in cmini's column shape
  (`render/grid.ts`'s `statsStr`). Stretch/Scissor are not printed: the
  composed cmini row carries no such numbers (NoTh/Thumb, which it does
  carry, followed as LDB-B44 below). Verb names/aliases untouched.
  Signed-off copy (`14-copy-signoff.md` round 4).
- **LDB-B43 (saltorbit 2026-09-10, live: `!sp view night` drew the LT thumb
  `r` at x=21)**: thumb rows keep their ABSOLUTE columns.
  `render/matrix.ts` had ported cmini's OLD cluster-relative thumb rule
  (a fixed 6/13-space indent on row 3, `thumbIndent`) on top of records
  that carry absolute thumb columns since cmini's 2026-08-31 v3
  re-encoding, so the leading blank cells AND the fixed indent both
  applied. All three thumb-indent branches (key grid, finger grid, common
  matrix) are gone — akl.gg's own `matrixText` rule: the row's leading
  blank cells are the indent. An LT-home thumb (col 3) sits 6 chars into
  its row, an RT-home one (col 6) 13, plus the 2-char display margin
  every cmini row carries (night's thumb line: `        r`). The seven
  thumb-bearing `tests/fixtures/cmini-matrix` goldens were regenerated
  (`gen-cmini-goldens.py` mirrors the rule); every non-thumb LDB-B1
  golden is byte-identical.
- **C13 follow-up, LDB-B41 (saltorbit 2026-09-10, mockup round T2)**: the
  `view`/`compare` text grid shows the space key. When a layout's
  RESOLVED space context is `lt`/`rt`, the key grid gains exactly one `␣`
  (U+2423) under the thumb side that types space; `none` leaves the grid
  byte-identical to today's. Placement (`render/matrix.ts`'s
  `spaceKeyPlacement`/`withSpaceKeys`, akl.gg's `dottedSpaceKeyPos` idea
  in text form): a new line under the thumb HOME column (col 3 for `lt`,
  col 6 for `rt` — one in from the middle finger, saltorbit's correction on
  the first live render) plus the board's stagger step, or — when the
  layout renders a thumb row with keys on that side — on that row, one
  cell outside the cluster, never crossing the center gap; a key is never
  overwritten. `compare`'s common grid carries NO `␣` (two glyphs on a
  diff grid collided with a thumb key's `~` and opened a second line —
  "this render is bad"); its sides are still resolved for the numbers and
  the NoTh/Thumb rows show the context. The stats block separates its
  groups with a blank line: Alt · Roll/Rol2/Rol3 · Red(+NoTh/Thumb) ·
  SFB/SFS · LH/RH. `view` resolves
  the side first (`resolveSpace`, memoised — the same call `rowFor('auto')`
  would make) and reads the row for it; `compare` resolves each layout on
  its own and marks each one's space on the common grid. Worked example
  (graphite as stored, space on the left thumb): `  q x m c v  k p . - /`
  then `      ␣` (under `m`). `fingermap`/`magic`/`image`'s header line,
  the write verbs' success blocks, `random` and the previews are
  untouched. Header/corpus lines untouched (not a picked change).
- **LDB-B44 (saltorbit 2026-09-10: "add the thumb reds category like we have
  on akl.gg whenever a thumb is involved (sg, thumb alpha)")**: after the
  `Red` row, `statsStr` prints the card's own `NoTh`/`Thumb` sub-rows
  (`StatsCmini.tsx`, `copy/card.ts` labels), gated exactly as the site
  gates them — `red_thumb != null` (a thumb key) OR `forceThumb`, which
  `toString` sets when the resolved space context is `lt`/`rt`; `compare`
  gates on either layout qualifying and nets a one-sided thumb null
  against 0 (the site's `dvD` rule). The four fields enter
  `CminiStatsRow` through the ONE adapter `shared.ts:toCminiStatsRow`
  (LDB-B5). Label column = cmini's ` {:>5}` = 6 wide, which `Thumb:` fills
  exactly. graphite/reddit with spacegrams on: `  Red:  4.88%   (Bad:
  0.13%)` / ` NoTh:  1.10%   (Bad:     0.13%)` / `Thumb:  3.78%   (Bad:
  0.00%)`; a thumbless layout with spacegrams off prints today's block.
- **C13 follow-up, LDB-B42 (saltorbit 2026-09-10, mockup round I1)**: the
  `!image` card draws akl.gg's own dashed synthetic space key on each
  layout's RESOLVED side (`render/image.ts` hands `spaceSide`/
  `base.spaceSide` to the site's own `measureKb`, `lt`/`rt` → `'lt'`/
  `'rt'`, `none` → null; `mana2Spacegrams` follows), and the footer's
  corpus string becomes `<corpus> · SG On` / `<corpus> · SG Off`
  (`copy.ts`'s `spacegramsFooterSuffix` — the two strings dictated
  verbatim, signed, `14-copy-signoff.md` round 5; `Off` iff the
  preference is `off`, `On` for any resolved side, a compare card whose
  sides differ included), so the drawn line reads `corpus: reddit · SG On
  ·  akl.gg`. The long forms (`· spacegrams (auto: new left thumb, old
  right thumb)` etc.) overflowed the footer into the LH/RH block and are
  gone; the footer is now measured against the card width for the
  longest corpus name. A new `graphite-sg-lt` image golden per
  platform+arch.

## 3. Rendering

Text output reproduces cmini's tables (its `layout.to_string`, fingermap
matrix, stat tables) — the wording is the parity contract. The image verb
reuses the site's copy-as-image drawing (`core/copyimage/` after `10 §2`
U2) through a headless canvas (`@napi-rs/canvas`) so a Discord image and
the site's image come from the same drawing code — not the same pixels:
a server rasterizer and its fonts differ from a browser's (`10 §1` D7;
LDB-B12 is determinism of the bot's own render).

## 4. The cache

Bootstrapped from `/v1/dump`. Every layout as `akl/1` (the format the site
reads), with the wasm-computed cmini row per corpus memoised beside it,
keyed `(id, rev, corpus)` so nothing recomputes unless the rev moved.

**No stale reads, no clobbering writes (saltorbit, 2026-09-09).** A read verb's
answer must equal the answer computed from the DB's state at the moment
the verb ran — never a snapshot from whenever the cache last happened to
sync. So before ANY read verb answers, the bot calls `ensureFresh()`: one
conditional `GET /v1/meta`, `If-None-Match` = the ETag last seen. A `304`
(the event log's `seq` is unchanged) serves straight from memory, no other
request. A `200` with `seq` past the cache's own cursor folds
`GET /v1/changes?since=<cursor>` (the same fold as everything else in this
section) before the verb runs. Concurrent callers share one in-flight
check rather than each firing their own; a `/v1/meta` failure answers an
honest "the layout database isn't reachable right now" instead of ever
serving something that might be stale. `ensureFresh()` is the *only*
freshness mechanism a read verb depends on — there is no separate polling
loop backing it.

The SSE stream (`GET /v1/changes/stream`, reconnecting with backoff on any
drop) is layered on top as a keep-warm optimization, nothing more: it
folds events into the cache the moment they happen so that `ensureFresh`'s
own catch-up is almost always empty, keeping replies fast. Losing the
stream costs latency, not correctness — `ensureFresh` still catches the
cache up before every read either way, so a dropped connection degrades
quietly and reconnects on its own.

Writes never trust the cache either. Every write verb that modifies an
*existing* record — everything except `add`, which is creating one from
nothing — fetches that record fresh right before writing, applies its
edit to that fresh copy, and sends the write with `If-Match` set to the
rev it just read: never omitted, never based on whatever rev the cache
happened to be holding. If someone else's write landed in between, the DB
answers 409 and the bot folds that newer record into the cache immediately
and tells the user to try again — it never blindly retries over top of a
change it didn't know about. The response of any accepted write is folded
into the cache right away too, so `!add` then `!view` in the same second
still works.

**Operability (saltorbit, 2026-09-09, `watchdog.ts`/`client/http.ts`/`main.ts`).**
A production hang (`!sp swap! dsfs ou`, ~1 minute, nothing logged) meant
`dbFetch` gained a 20 s abort timeout — a hung DB call now fails fast with
its own message instead of a silent stall — and every write's non-2xx
response is logged (method, path, the DB's `error`/`message`, elapsed ms;
never the signed headers), alongside a slow-command log (`verb` + elapsed
ms) for anything over 5 s. A memory watchdog DMs `ALERT_USER_ID` once when
`process.memoryUsage().rss` crosses `ALERT_MEMORY_PCT` (default 80%) of
the cgroup memory limit and once more on recovery, and once at boot if the
previous run didn't shut down cleanly (`<dataDir>/spark.pid-marker`
surviving to the next boot). `TEST_BOT_IDS` allowlists specific bot
authors (empty in production) so an end-to-end harness's own bot can drive
a second spark instance. LDB-B15/B16/B17; `10 §1` D16.

## 5. Where it runs

**Decided (saltorbit, 2026-09-09): Fly.io**, one `shared-cpu-1x` machine,
256 MB to start (measure peak RSS across every compute verb in the test
guild before raising it; an OOM restart drops one command and loses
nothing), in saltorbit's Fly account (the bot is his, `04 §1`), deployed from
`bot.yml` with a deploy token. One 1 GB volume (`/data`) for the per-user
corpus preferences only (`10 §1` D10); the layout cache is rebuilt from
`/v1/dump` at boot and the engine is fetched from the site at boot. The signing key (`02 §3`) lives in Fly
secrets; rotation = new key, register, switch, revoke. The Discord
application is saltorbit's.

## 6. Signing (client lane)

`client/sign.ts`: Web Crypto Ed25519; the signing string of `02 §3.2`; the
vectors in `db/tests/vectors/client-signing.json` are a test in
`bot/tests/` too (a test asserts the two copies are identical while both
live in this repo).

## 7. Invariants

| id | invariant | enforced by |
|---|---|---|
| LDB-B1 | Every cmini command exists with the same `use()` string and the same success/error wording for the cases in the parity table. | `bot/tests/parity.test`: table-driven against a local DB |
| LDB-B2 | Every write the bot makes carries `X-Akl-Actor = message.author.id`; the bot has no code path that writes as anyone else. **Extended (2026-09-09):** every mutating verb but `add` fetches its record fresh and sends the write with `If-Match` set to that fresh rev, always — no path omits it. | grep + unit test on the client |
| LDB-B3 | A read verb's own body never performs an HTTP request (cache only) — `ensureFresh()` (LDB-B14) lives one level up, in dispatch, not inside a verb. | unit test with HTTP mocked to fail |
| LDB-B4 | The bot's signature for every vector equals the Worker's expectation. | shared vectors file |
| **LDB-B5** | **The bot's numbers are the site's numbers:** for every `upstream-100` layout × every corpus, the bot's cell equals the deployed site's harvest cell (rel 1e-9) and its composed cmini row equals the same composition over that cell; the bot boots only when the wasm's pin equals the harvest's; `cminiRowFromMana2` is called from exactly one bot module. | `bot/tests/engine/numbers.test.ts` against the wasm and harvest the site serves (`10` V2) |
| LDB-B6 | `bot/` imports only `@akl/core` / `@akl/layout-formats` (by path until the split) from this repo, and nothing imports `bot/`. | `bot/tests/tools/boundary.test.ts` + `db/`'s outside-scan |
| LDB-B7–B12 | env vars in one place; `bot.yml`'s shape; the worker answers the site's protocol; cache = fold of dump + feed (**extended 2026-09-09 to a THIRD fold path, the SSE stream** — a stream-fed store and a poll/`ensureFresh`-fed store over the same events are byte-for-byte equal); prefs survive restarts; the image is a pure function of its plan. | `10 §7` |
| **LDB-B14** | **Verify-then-serve:** a read verb's answer equals the answer computed from the DB's state at the moment the verb ran, never a stale in-memory snapshot. `ensureFresh()` is the *only* freshness mechanism; a `/v1/meta` failure never serves possibly-stale data silently. | `bot/tests/cache/fresh.test.ts` |
| LDB-B15 | The memory watchdog DMs `ALERT_USER_ID` once per threshold crossing (10-point hysteresis on recovery), never when unset; a non-clean-restart marker DMs once at the next boot, then is always rewritten. | `bot/tests/watchdog.test.ts` |
| LDB-B16 | A write-path `dbFetch` call times out after 20 s (a synthetic result, never a hang or a throw) and every non-2xx write response is logged (method/path/DB message/elapsed ms, never the signed headers); a `400 if_match_required` (structurally impossible given LDB-B2) logs as a bug, not an ordinary failure, and is never retried. | `bot/tests/client/http.test.ts`, `bot/tests/commands/write.test.ts`, `bot/tests/main.test.ts` |
| LDB-B17 | `TEST_BOT_IDS` allowlists specific bot authors so `handleMessage` treats their messages like a real user's; every other bot author stays ignored. | `bot/tests/main.test.ts` |
| LDB-B19 | `!authors`'s reply never exceeds Discord's 2 000-char message limit (a live e2e finding: an untruncated reply silently failed to send); a reply that already fits is never truncated. | `bot/tests/commands/read.test.ts` |
| LDB-B22 | The shipped fonts register or the render refuses -- never a silently font-less card (a production finding: the Docker image had no `bot/fonts/` and every `!image` went out with blank text). `ensureFontsRegistered` throws a named `FontsMissingError` for a missing/rejected file, boot runs it and DMs the operator on failure, and the Dockerfile's final stage ships `bot/fonts` beside `dist/`. | `bot/tests/render/image.test.ts`, `bot/tests/tools/dockerfile.test.ts` |
| LDB-B23 | `feed_down` is self-explanatory and every cache-side fetch is bounded (a production incident: 10 `feed_down` DMs, no reason given, no notice on recovery -- both `ensureFresh().catch(() => {})` and the stream's own reconnect loop swallowed their errors, and nothing anywhere had a timeout). `cache/liveness.ts`'s small mutable record tracks the fresh/stream sides' last success and last error; a `feed_down` report's `note` is `describeLiveness()`, naming which side is dead and why; a NEW `feed_up` kind reports once, the first tick after a `feed_down` finds the feed good again. `cache/fresh.ts`'s meta GET, `cache/feed.ts`'s changes-page/detail GETs, and `cache/stream.ts`'s connect fetch all carry a bound (default 20 s); the stream's READ loop separately gets an idle timeout (default 90 s, reset by any chunk including a `: ping`) that drops and reconnects a truly silent connection. | `bot/tests/cache/liveness.test.ts`, `bot/tests/cache/{fresh,feed,stream}.test.ts`, `bot/tests/main.test.ts` |
| LDB-B24 | akl.gg's own magic rules are the bot's ONLY magic rules (GH #304: "On view command for Opal, it says magic rules not applied?" + "Drop cmini magic rules on the floor, only use aklgg magic rules everywhere"). `magic/source.ts`'s `createSiteMagicSource` resolves: (a) an akl/1 record's own `payload.magic`, when it has any -- the DB record is the source of truth once seeded; (b) else `data/magic_rules.json`'s entry keyed by the record's lowercased name -- the seed/fallback; (c) else `null`. A `cmini/1` record's own translated magic (lifted from cmini's analyzer by `fromCmini`) is NEVER read. `!magic`/`!image`'s caption and every stats compute (the wasm gains an optional `mana2-magic` engine path over the corpus's extended tables, falling back to the plain engine when they 404) read this instead of a record's own payload/cmini's `has_magic` flag; the `(magic rules not applied)` line now means "has akl.gg rules AND fell back", never harvest rows (already magic-aware) and never cmini's flag. `data/magic_rules.json` is a third bounded LDB-B3 exception (one request per process). | `bot/tests/magic/source.test.ts`, `bot/tests/cache/cells.test.ts`, `bot/tests/engine/host.test.ts`, `bot/tests/commands/{magic,image,read}.test.ts`, `bot/tests/render/grid.test.ts`, `bot/tests/cache/readonly.test.ts` |
| LDB-B25 | Every single-layout reply carries a masked Discord hyperlink to the layout's akl.gg detail card (GH #304 + same-day follow-up: masked, not a bare URL). `commands/link.ts`'s `appendSiteLink` appends `[akl.gg](<url>)` as the final line, exactly one blank line after cmini's own output. `view`/`image`/`magic`/`history`'s success line/`fingermap`/the read-only preview transforms (linking the BASE layout) carry it; `!add`, every bang write verb, `random`, and every not-found/held error reply don't; `link` itself is unchanged. | `bot/tests/commands/link.test.ts`, `bot/tests/commands/{read,image,magic,history}.test.ts` |
| LDB-B29 | The key grids (`view`, `fingermap`, the read-only previews) are painted per finger in Discord's ANSI colors -- three colors only (saltorbit, 2026-09-10): yellow on the middle fingers and thumbs, cyan on LP/LI/RR, pink on LR/RI/RP, alternated so no adjacent fingers share one; the colored grid is the plain grid plus escape codes and nothing else, so cmini's parity strings survive byte-for-byte and a client without ANSI shows today's output. | `bot/tests/render/ansi.test.ts` |
| LDB-B26 | A reply never contains a user-supplied string that hasn't been validated as a name (GH #304: "Don't repeat user strings -- abuse to get around blocks"; `16-command-audit.md` §3 F1). `copy.ts`'s `quoteUserText(text, kind, quoted?)` echoes the caller's own text verbatim only when it passes that kind's own allow-list (`layout`/`user`: the DB's own name rules; `corpus`/`ngram`/`verb`: narrower charsets); anything else -- a mention, `@everyone`/`@here`, a URL, a newline, 65+ chars, unicode, empty -- answers a neutral, still-grammatical fallback instead. A record's own name/a cache-resolved author name/a `defs`-confirmed corpus are data, not input, and stay untouched. | `bot/tests/copy.test.ts`, `bot/tests/commands/no-raw-echo.property.test.ts` |
| LDB-B27 | A reply never exceeds Discord's 2 000-char message limit (`16-command-audit.md` §3 F2: only `!authors`, LDB-B19, capped itself before this). `main.ts`'s `capReplyContent` runs over every reply inside `replyOrAlert`; a no-op under the limit, otherwise cut to fit (preferring the last newline, closing an open ``` fence first) with a `… (truncated)` marker appended. | `bot/tests/main.test.ts` |
| LDB-B30 | `link`/`mod`/`pattern`/`freqd` DROPPED from the registry (§2.5 C1, 2026-09-10) -- modules deleted, `help` lists none of them. | `bot/tests/commands/registry.test.ts` |
| LDB-B31 | `search`/`filter`/`homerow` are redirect stubs (§2.5 C2) -- one line, zero cache/network reads. | `bot/tests/commands/read.test.ts` |
| LDB-B32 | `transfer` is `assign`'s own `Command` object under a second registry key (§2.5 C4). | `bot/tests/commands/write.test.ts` |
| LDB-B33 | `freq`/`freqs` are one implementation registered under both names (§2.5 C5). | `bot/tests/commands/ngramVerbs.test.ts` |
| LDB-B34 | `authors [page]` pages like `rank` (§2.5 C6) -- 15/page, 1-based, out-of-range answers honestly; LDB-B19's cap stays as the within-page backstop. | `bot/tests/commands/read.test.ts` |
| LDB-B35 | `history` is cache-only (§2.5 C7) -- no more per-call DB fetch; the reply is a header line + a masked link to layoutdb's own changelog. | `bot/tests/commands/history.test.ts` |
| LDB-B36 | `compare`/`image <a> <b>` append the site's compare-dock link (§2.5 C8); `image <a> <b>` additionally renders the site's compare CARD through the same drawing code `image <a>` uses (§2.5 C12). | `bot/tests/commands/{read,image}.test.ts`, `bot/tests/render/image.test.ts` |
| LDB-B37 | `!spacegrams off\|left\|right` (§2.5 C13) is a per-user preference beside `!corpus`; every stat verb and `!image` compute with it -- `(corpus, space)` is one cache/harvest key (`cache/cells.ts`), the wasm CONTEXT and `!image`'s footer both follow the setting. | `bot/tests/prefs.test.ts`, `bot/tests/cache/cells.test.ts`, `bot/tests/engine/{host,site}.test.ts`, `bot/tests/commands/{read,image}.test.ts` |
| LDB-B38 | akl.gg's own card-label names -- `alt`/`rol2`/`rol3`/`red`/`sfb` -- are PRIMARY registry aliases of `alternates`/`rolls`/`onehands`/`redirects`/`sfbs` (§2.5 C10), same `Command` instance under both keys. | `bot/tests/commands/ngramVerbs.test.ts` |
| LDB-B39 | `!spacegrams auto` (§2.5 C13 follow-up) is akl.gg's own auto rule per layout: the bot's side == `autoSpaceSideFrom(keys, computeVowelHand(keys), ltRed, rtRed)` over the bot's own engine's plain Redirect Totals; memoised per (id, rev, corpus), at most two computes per `view`, zero for a harvested record. | `bot/tests/cache/autoSpace.test.ts` (matrix + property), `bot/tests/commands/{read,image}.test.ts`, `bot/tests/copy.test.ts`, `bot/tests/prefs.test.ts` |
| LDB-B40 | No stats-rendering reply contains a cmini-only stat name (`Onehand`, `One:`, `Rol:`, `Rtl`, `Alternates`, `Inrolls`/`Outrolls`, bare `Rolls`, `Red/Alt`) -- akl.gg's names everywhere (§2.5), the stats block in the card's row order. | `bot/tests/commands/statNames.test.ts`, `bot/tests/render/grid.test.ts`, `bot/tests/commands/ngramVerbs.test.ts`, `bot/tests/copy.test.ts` |
| LDB-B41 | `view`'s key grid shows exactly one `␣` under the thumb side that types space when the layout's resolved space context is `lt`/`rt` (§2.5), byte-identical to today's grid with `none`; against the thumb cluster on that side or under the thumb home column (col 3 / col 6), never across the center gap, never over a key. `compare`'s common grid never carries one. | `bot/tests/render/matrix.test.ts` (matrix over every fixture x both sides), `bot/tests/render/grid.test.ts` (exact blocks), `bot/tests/commands/read.test.ts` |
| LDB-B42 | The `!image` card draws akl.gg's own dashed space key on each layout's resolved side through the site's own `measureKb` (none on both sides = the pre-B42 card byte-for-byte) and its footer says `<corpus> · SG On` / `· SG Off` (§2.5), never wider than the card for the longest corpus name. | `bot/tests/render/image.test.ts` (per-side synthetic item, footer width, the `graphite-sg-lt` golden), `bot/tests/commands/image.test.ts`, `bot/tests/copy.test.ts` |
| LDB-B43 | Thumb rows keep their absolute columns (§2.5): every thumb key's x in the bot's grid equals its x in akl.gg's `matrixText` plus the 2-char display margin (LT-home col 3 = 6 into the row, RT-home col 6 = 13); the finger grid and the common matrix agree; the seven thumb-bearing cmini-matrix goldens regenerated, no non-thumb golden changed. | `bot/tests/render/matrix.test.ts` |
| LDB-B44 | The stats block prints the card's `NoTh`/`Thumb` split of Red exactly when the card shows it -- `red_thumb != null` or a space thumb computed with (§2.5); `compare` on either side qualifying, one-sided nulls netting against 0; the four fields through the ONE adapter (LDB-B5); a thumbless layout with spacegrams off prints today's block. | `bot/tests/render/grid.test.ts`, `bot/tests/commands/read.test.ts`, `bot/tests/commands/statNames.test.ts` |
| LDB-B45 | `!theme [default|colorblind]` is a per-user preference stored next to corpus and spacegrams; `!image` paints with akl.gg's own `activeFingerColors(theme)` (`@akl/core/colors`, colorblind = Kate's Modified Colorblind Palette); missing/unknown = `default`, which is byte-identical to the pre-theme card; the text grids' ANSI colors do not follow it. | `bot/tests/commands/theme.test.ts`, `bot/tests/render/image.test.ts`, `bot/tests/commands/image.test.ts` |
| LDB-B46 | The image card's footer text is WCAG AA (>= 4.5:1) on the card background for every theme: the watermark line and the LH/RH separator take `IMG_COLORS.dim` via `ImagePlan.footerColors`; akl.gg's own copy-as-image never sets it and is unchanged. | `bot/tests/render/image.test.ts` |

## 8. Open questions (bot)

1. **Prefix:** `!spark` (saltorbit, tentative, 2026-09-09) — answer to `!cmini`
   too during a transition, or not at all?
2. *(resolved, `10 §0`/`§2`)* the driver moves to `core/swap-engine.ts`
   (U1), the drawing to `core/copyimage/` (U2); the worker itself is
   bot-owned and speaks the site's protocol.
3. *(resolved, `10 §1` D7)* `@napi-rs/canvas` over the moved drawing code;
   no SVG path.
4. A dedicated channel / DM redirection for long replies (cmini's
   `RESTRICTED`) — `10 §9`.
