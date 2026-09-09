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
    main.ts                 discord.js client; message commands with the `!aklgg` prefix (tentative, §8)
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
(the wasm loader is in `web/src/data/swap-engine.ts`) is either moved down
to `core` or duplicated once with a header naming the source — moving it
down is preferred, and is a site PR.

The wasm engine gives the bot stats for **any** layout — published or
`!aklgg swap`'d on the fly — with no static harvest to ship; the measured
recompute is ~90 ms per layout, so a `rank` over 4 000 layouts is a
one-off cache the bot builds at boot from `/v1/dump` and refreshes per
change event.

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
| `assign` | `assign` (transfer) | `POST …/transfer {to}` | |
| `setfingermap` | `setfingermap [name] [MATRIX]` | `PATCH {fingermap}` (+ `{board}` when implied) | validation strings preserved |
| `swap!` `cycle!` | `swap! [name] [chars]` | local transform then `PUT` | |
| `angle!` `unangle!` | `angle! [name]` | local transform then `PUT` | `mini` refusal client-side |
| `mirror!` | `mirror! [name]` | local transform then `PUT` | |
| `like` `unlike` | `like [name]` | `PUT`/`DELETE …/like` | qwerty refusal server-side too |
| `link` `unlink` | (admin-only in cmini) | **dropped** — no link on the record (round-1 review) | |
| `admin` `maintenance` | restricted | `/v1/admin/*` where they map; the rest stay bot-local | |

### 2.2 Read verbs → compute over the cache

`view stats fingers fspeed sfbs sfs rolls inrolls outrolls onehands
alternates redirects pattern compare mod swap cycle angle unangle mirror
fingermap homerow filter search rank freq freqd freqs examples names guess
random count xkb list likes authors corpus` — the cmini-view row for a layout
is `cminiRowFromMana2(engine.compute(layout, corpus))`; the per-finger and
n-gram detail verbs (`sfbs`, `rolls`, `pattern`, `freq…`) read the same
harvest the site's popovers read. `list [username]` and `authors` use
`/v1/authors`; `likes` uses `GET /v1/layouts?liked_by=` (phase 4 adds the
filter). `find` keeps cmini's fuzzy match (Damerau–Levenshtein over cached
names). `corpus` (a user's preferred corpus) is bot-local state, as in cmini.

### 2.3 Local / social

`8ball catball dofball wooperball woopercat question flip gen help suggest
akl alt pairings` — rewritten as-is, no layouts involved.

### 2.4 New verbs (after parity)

- `!aklgg magic [name]` — a layout's magic as the author wrote it (idioms
  from `akl/1`, raw rules otherwise) — reads `?as=akl/1`.
- `!aklgg history [name]` — last 5 events.
- `!aklgg image [name]` — the site's copy-as-image render (§3), which is
  what #218 asked for from mana.

## 3. Rendering

Text output reproduces cmini's tables (its `layout.to_string`, fingermap
matrix, stat tables) — the wording is the parity contract. The image verb
reuses the site's copy-as-image drawing (`core/legacyBoardDrawer.ts` and
the copyimage copy) through a headless canvas (`@napi-rs/canvas`) so a
Discord image and the site's image are the same pixels.

## 4. The cache

`/v1/changes?since=<cursor>` on a 30 s timer plus the SSE stream when up;
bootstrapped from `/v1/dump`. Every layout as `akl/1` (the format the site
reads), with the wasm-computed cmini row per corpus memoised beside it.
Writes update the cache from the response before the next tick, so `!add`
then `!view` in the same second works.

## 5. Where it runs

**Decided (saltorbit, 2026-09-09): Fly.io**, one `shared-cpu-1x` machine,
256 MB to start (measure peak RSS across every compute verb in the test
guild before raising it; an OOM restart drops one command and loses
nothing), in saltorbit's Fly account (the bot is his, `04 §1`), deployed from
`bot.yml` with a deploy token. No volume: the cache is
rebuilt from `/v1/dump` at boot. The signing key (`02 §3`) lives in Fly
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
| LDB-B2 | Every write the bot makes carries `X-Akl-Actor = message.author.id`; the bot has no code path that writes as anyone else. | grep + unit test on the client |
| LDB-B3 | A read verb never performs an HTTP request (cache only). | unit test with HTTP mocked to fail |
| LDB-B4 | The bot's signature for every vector equals the Worker's expectation. | shared vectors file |
| **LDB-B5** | **The bot's numbers are the site's numbers:** for every fixture layout × corpus, the bot's cmini-view row deep-equals `cminiRowFromMana2` over the site's swap-engine output, and its mana2 cells equal the engine's. | `bot/tests/numbers.test` against the same wasm build the site ships |
| LDB-B6 | `bot/` imports only `@akl/core` / `@akl/layout-formats` (by path until the split) from this repo, and nothing imports `bot/`. | archlint rule + boundary test |

## 8. Open questions (bot)

1. **Prefix:** `!aklgg` (saltorbit, tentative, 2026-09-09) — answer to `!cmini`
   too during a transition, or not at all?
2. Which `web/src/core` pieces the bot needs that currently sit in `data`
   (the wasm loader, the worker protocol) — moved down or duplicated? An
   inventory is the first task of the phase-4 doc.
3. The image verb's headless canvas: `@napi-rs/canvas` vs rendering the
   board to SVG and rasterising with `resvg` — decide when the copy-as-image
   code's dependencies are inventoried.
