# 16 — Command-surface audit (spark)

Status: audit, 2026-09-10, answering #304 "Audit command surface" and
"Don't repeat user strings (abuse to get around blocks)". Read with
`05-bot.md` §2 (what each verb maps to) and `bot/INVARIANTS.md` (what is
enforced). Every fact below was read from `bot/src/commands/*.ts`,
`bot/src/main.ts`, `bot/src/router.ts` at 064b21eb.

## 1. The surface

45 verbs registered by `commands/index.ts`'s `buildRegistry()`; `help`
lists them. Prefixes `!spark !sp !aklgg !ag`; in a DM no prefix is
needed. A reply goes where the command was typed (no cmini-style
CMINI_CHANNEL redirection, `05` §2). Bot authors are ignored unless
allow-listed (`TEST_BOT_IDS`, production: unset).

| verb | class | what it touches | who may | echoes raw input? |
|---|---|---|---|---|
| `help` | local | registry | anyone | no (unknown verb → the generic line) |
| `add` | **write** | `POST /v1/layouts` | anyone (owner = actor) | name on `409 name_taken` |
| `remove` | **write** | `DELETE` | owner (server-checked) | arg on success/403 |
| `rename` | **write** | `PATCH {name}` | owner | old + new names |
| `assign` | **write** | `POST …/transfer` | owner | name, target |
| `setfingermap` | **write** | `PATCH {fingermap}` | owner | name |
| `swap!` `cycle!` `angle!` `unangle!` `mirror!` | **write** | transform + `PUT` | owner | name |
| `like` `unlike` | **write** | `PUT/DELETE …/like` | anyone | name |
| `view` `fingermap` `image` `magic` `history` `link` | read | cache (+ wasm) | anyone | name on a miss |
| `compare` `mod` `swap` `cycle` `angle` `unangle` `mirror` `random` | read | cache + wasm | anyone | name on a miss |
| `rank` `list` `likes` `authors` `stats` | read | cache | anyone | `list`: user arg on a miss |
| `filter` `search` `homerow` | read | cache | anyone | no |
| `fingers` `fspeed` | read | cache + wasm | anyone | name on a miss |
| `sfbs` `sfs` `rolls` `inrolls` `outrolls` `alternates` `redirects` `onehands` `pattern` `freq` `freqs` `examples` | read | cache + site n-gram tables | anyone | name on a miss; `freq`/`freqs`: the queried n-grams |
| `freqd` | read | — | anyone | no (answers "not available yet") |
| `corpus` | local | prefs file | anyone | corpus arg (validated against the site's list first) |

Not ported, on purpose (`05` §2): `link`/`unlink` (admin-only in cmini,
no link on the record), `admin`/`maintenance` (the DB's `/v1/admin/*`
is signed, not a chat verb), cmini's DM redirection. Not built yet:
`freqd` (needs a 4-gram table the site never built).

## 2. What already protects the surface

- **Writes are the DB's problem, not the bot's.** Every mutating verb is
  a signed client-lane request with `actor = message author`; ownership,
  name rules (`check_name`: ≥3 chars, `NAME_SET` charset, no leading `_`,
  ≤64, not ULID-shaped), If-Match freshness, and the per-actor rate limit
  (60 writes / 10 min; 300 / 10 min for the whole client) are enforced
  server-side (`03-api.md` §1, §3). The bot cannot be talked into a write
  the DB would refuse.
- **No stale reads, no clobbering writes** (LDB-B14, the fresh `If-Match`
  on every write).
- **The `add` grid never comes back verbatim.** Grid errors are cmini's
  own positional messages (`missing gap before column …`), not the input.
- **`!authors` is length-capped** (LDB-B19) — the one reply that can
  outgrow Discord's 2 000 chars from data alone.
- **Attachments are the bot's own PNGs** (`!image`), never a user file.

## 3. Findings

**F1 — 58 reply sites interpolate the user's own text.** The miss family
(`Error: couldn't find any layout named \`<what they typed>\``, 30+
sites), the write verbs' 403/404/409 replies (`you don't own the layout
<name>`, `\`<name>\` already exists`), `assign`'s `invalid ID <target>`,
`list`'s `user \`<arg>\` does not exist`, `freq`/`freqs`' `\`<query>\`
not found`, and `main.ts`'s `Error: <verb> is not an available command`.
All are cmini's own wording, and all let a user make the bot post an
arbitrary string — a mention, a link, a slur, text longer than a message
— under the bot's name, which is exactly the "abuse to get around blocks"
saltorbit named. Note the fuzzy finder (`render/find.ts`) makes the miss
family rarer than it looks: any non-empty query resolves to the NEAREST
name and the reply then shows the resolved record's name, not the query;
the echo fires only on an empty cache, the write verbs' own exact-match
paths, and the non-name arguments.
→ **LDB-B26 (proposed): a reply never contains a user-supplied string
that is not a validated name.** One helper (`copy.ts`'s
`quoteUserText`) applied at every site: the text is echoed only if it
satisfies the DB's own name rules (charset `[A-Za-z0-9 _\-'():~]`, ≤ 64
chars) — a typo like `grafite` still reads naturally; anything else (a
mention, a URL, a newline, unicode, a paragraph) is replaced by a neutral
form (`that layout` / `that user` / `that corpus`), so the sentence stays
grammatical and cmini-shaped. `freq`/`freqs` allow `[a-z' ]` ≤ 16 chars
(n-grams are letters). `main.ts`'s unknown-verb line allows `[a-z!]+` ≤
32. Enforcement: a property test (fast-check, already a dev dependency)
generating arbitrary strings for every argument position of every
registered verb against a fake runtime and asserting the reply contains
neither the string nor any `<@`, `@everyone`, `@here`, `http`. Copy
impact: the neutral fallbacks are new strings (sign-off pending,
`14-copy-signoff.md`); the happy-path wording is unchanged.

**Status: DONE (LDB-B26), 2026-09-10, branch `ldb-b26`.** Every site named
above, plus three this audit's own table missed on a closer per-command
read (`help.ts`'s "Unknown command", `mod.ts`'s own "couldn't find any
layout" echo — distinct from the other read-only preview twins only in
variable name, `layoutName` — and `render/kwargs.ts`'s "invalid kwarg",
the one call site EVERY `--flag`-taking verb — `filter`/`rank`/`mod`/
`search` — shares), is wrapped. `rank`'s unsupported-stat line and
`examples`' query echo were also found to be genuine, previously-
unaudited gaps (this table's own "echoes raw input? no" for
`filter`/`search`/`homerow` undercounted `filter`'s own `compareWithStr`
kwarg-value echo, which is INTENTIONALLY left open — see below) and are
now wrapped too (`verb`/`ngram` kind respectively; both a narrow,
documented trade-off against a rare honest-input edge, not a behavior
regression this audit's own tests didn't already cover). Left
deliberately open: `filter.ts`'s `compareWithStr` (`--<metric> <value>`'s
error text) still echoes its raw comparison-operator string verbatim on
a malformed value — none of `quoteUserText`'s five kinds fit an arbitrary
`>`/`<`-prefixed comparison string, and it needs a `--flagname` token to
even reach (not hit by pure single-argument fuzzing the way every other
site here is) — flagged for a follow-up, not silently dropped.

**F2 — no general reply-length guard.** Only `!authors` truncates. A
2 000+ char reply throws `DiscordAPIError[50035]` in `replyOrAlert`,
which is caught and reported (LDB-B21) — the user sees nothing. Today
that needs data, not input (F1's fix caps the echo), but `list` for an
author with hundreds of layouts, or `rank` with a large page, can reach
it. → **LDB-B27 (proposed): `replyOrAlert` hard-caps content at 2 000
chars** with a visible marker on the last line (`… (truncated)`, sign-off
pending), so the reply always lands and the operator alert stays for
real API errors.

**Status: DONE (LDB-B27), 2026-09-10, branch `ldb-b26`.** `main.ts`'s
`capReplyContent`, run inside `replyOrAlert` over every reply (every
verb, `bareTryReply`, `notAvailableReply`, `commandFailedInternally`, ...)
before it ever reaches `message.reply`: a no-op at or under 2 000 chars;
over it, cuts to fit -- preferring the last newline before the limit so a
fenced code block or a list row is never sliced mid-line, closing an odd
(still-open) ``` fence first -- then appends the marker. `!authors`' own
LDB-B19 truncation already fits comfortably under the cap by construction
and is unaffected.

**F3 — reads are unmetered.** The DB rate-limits writes per actor; the
bot meters nothing. Every read is cheap (cache + harvest) except the
wasm recomputes (transform previews, fresh records: ~90 ms each,
serialized through one lock) and `!image` (a 2 340-px canvas, ~21 MB
transient, now that it matches the site's 6×). A burst of `!image` from
one user or channel is the one way chat input turns into CPU/RSS on the
1 GB machine. → **LDB-B28 (proposed): a per-user cooldown on `image` and
the transform previews** (one in flight per user; a second request
within N s answers the existing cmini-style "slow down" line if cmini has
one, else a new string, sign-off pending). Measure before choosing N;
the memory watchdog (LDB-B15) already DMs on pressure.

**F4 — `assign` accepts a raw Discord id or a name and echoes it on a
miss** (`Error: invalid ID <target>`). Covered by F1's helper; nothing
else to do — the target must exist in `authors` server-side.

**F5 — `random` and `rank` are the only verbs that read the whole cache
per call**; both are O(n) over 4 200 records in memory, fine.

**F6 — the fuzzy finder is a feature and a footgun.** cmini-faithful (a
miss resolves to the nearest name), so `!sp remove grafite` targets
`graphite` — harmless because the DB's ownership check refuses, but
`!sp like grafite` likes `graphite`. Keep (parity), note in `05` §2.
"Did you mean" is a nice-to-have already on the ledger.

**F7 — Zak's composable commands** (#304): out of this audit's scope; a
design question for `15-transition.md` §8, not a surface risk.

## 4. Order of work

1. LDB-B24/B25 (akl.gg magic rules everywhere; the akl.gg link on every
   single-layout reply) — in flight, branch `ldb-b24`.
2. LDB-B26 (F1) then LDB-B27 (F2): both touch every command file, so
   they land after 1 to avoid a three-way merge.
3. LDB-B28 (F3) after measuring `!image` at 6× on Fly for a day.
