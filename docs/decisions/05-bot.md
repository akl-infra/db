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
is moved down to `core` by a site PR — `10 §2`: **U1** moves the worker
driver `data/swap-engine.ts` (zero imports, every effect injected) to
`core/swap-engine.ts`; **U2** moves the canvas drawing half of
`ui/copy-image/` to `core/copyimage/`. Nothing is duplicated.

The wasm engine gives the bot stats for **any** layout — published or
`!aklgg swap`'d on the fly — at ~90 ms per layout in a `worker_threads`
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

- `!aklgg magic [name]` — a layout's magic as the author wrote it (idioms
  from `akl/1`, raw rules otherwise) — reads `?as=akl/1`.
- `!aklgg history [name]` — last 5 events.
- `!aklgg image [name]` — the site's copy-as-image render (§3), which is
  what #218 asked for from mana.

## 3. Rendering

Text output reproduces cmini's tables (its `layout.to_string`, fingermap
matrix, stat tables) — the wording is the parity contract. The image verb
reuses the site's copy-as-image drawing (`core/copyimage/` after `10 §2`
U2) through a headless canvas (`@napi-rs/canvas`) so a Discord image and
the site's image come from the same drawing code — not the same pixels:
a server rasterizer and its fonts differ from a browser's (`10 §1` D7;
LDB-B12 is determinism of the bot's own render).

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
| LDB-B2 | Every write the bot makes carries `X-Akl-Actor = message.author.id`; the bot has no code path that writes as anyone else. | grep + unit test on the client |
| LDB-B3 | A read verb never performs an HTTP request (cache only). | unit test with HTTP mocked to fail |
| LDB-B4 | The bot's signature for every vector equals the Worker's expectation. | shared vectors file |
| **LDB-B5** | **The bot's numbers are the site's numbers:** for every `upstream-100` layout × every corpus, the bot's cell equals the deployed site's harvest cell (rel 1e-9) and its composed cmini row equals the same composition over that cell; the bot boots only when the wasm's pin equals the harvest's; `cminiRowFromMana2` is called from exactly one bot module. | `bot/tests/engine/numbers.test.ts` against the wasm and harvest the site serves (`10` V2) |
| LDB-B6 | `bot/` imports only `@akl/core` / `@akl/layout-formats` (by path until the split) from this repo, and nothing imports `bot/`. | `bot/tests/tools/boundary.test.ts` + `db/`'s outside-scan |
| LDB-B7–B12 | env vars in one place; `bot.yml`'s shape; the worker answers the site's protocol; cache = fold of dump + feed; prefs survive restarts; the image is a pure function of its plan. | `10 §7` |

## 8. Open questions (bot)

1. **Prefix:** `!aklgg` (saltorbit, tentative, 2026-09-09) — answer to `!cmini`
   too during a transition, or not at all?
2. *(resolved, `10 §0`/`§2`)* the driver moves to `core/swap-engine.ts`
   (U1), the drawing to `core/copyimage/` (U2); the worker itself is
   bot-owned and speaks the site's protocol.
3. *(resolved, `10 §1` D7)* `@napi-rs/canvas` over the moved drawing code;
   no SVG path.
4. A dedicated channel / DM redirection for long replies (cmini's
   `RESTRICTED`) — `10 §9`.
