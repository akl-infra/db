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

- `!spark magic [name]` — a layout's magic as the author wrote it (idioms
  from `akl/1`, raw rules otherwise) — reads `?as=akl/1`.
- `!spark history [name]` — last 5 events.
- `!spark image [name]` — the site's copy-as-image render (§3), which is
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
