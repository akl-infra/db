# The Discord bot

Status: proposal (2026-09-08). Part of `00-plan.md`. Source of the parity
list: `vendor/cmini-analyzer/cmds/*.py` at upstream `068a4f50` (every
command's `use()`/`desc()` read directly).

## 1. Shape

Fork, don't rewrite (D11). cmini's bot tree — its whole command set, its
parser, its analyzer and its response formatting, under GPLv3 — was
vendored at `vendor/cmini-analyzer` until #214 removed it; it is still in
this repo's history (`a5b0fe35^:vendor/cmini-analyzer`, upstream
`068a4f50`) and, better, at upstream itself. The bot is that tree with
**one module replaced**:
`util/memory.py` (a directory of JSON files) becomes a client of the layout
DB. Everything a user sees — wording, tables, the `!cmini` prefix if that is
what people want to keep typing — stays as it is, so the day the bot switches
nobody in the server has to relearn anything.

```
bot/                        GPLv3 (inherited)
  cmini/                    the fork: cmds/ core/ util/ … from vendor/cmini-analyzer
  akl_client/               HTTP client for the DB: reads, writes, client-lane signing (02 §3)
  memory.py                 the replacement: same function names (add/remove/get/find/…), API underneath
  cache/                    a local mirror of every layout (cmini/1), refreshed from /v1/changes —
                            so analyzer verbs (view, sfbs, rank…) never wait on HTTP
  tests/                    parity table (§2) as a test; signing vectors (02 §3.2)
```

Numbers: the cmini analyzer's, as they are today — that is what "the cmini
bot" means to the people who use it. mana2 numbers (`!akl view …`?) are a
later addition, not a replacement.

## 2. Command parity

Every command in `cmds/`, what it becomes. **DB** = a write to the layout
DB; **read** = served from the local cache; **local** = unchanged, no DB
involvement.

### 2.1 Layout-changing verbs → DB writes (client lane, actor = message author)

| command | usage | becomes | notes |
|---|---|---|---|
| `add` | `add [LAYOUT]` | `POST /v1/layouts` `format: cmini/1` | the bot's own grid parser stays; it produces the exact cmini shape (`board` word, `keys`, `free`) |
| `remove` | `remove [name]` | `DELETE /v1/layouts/{name}` | `403 not_owner` → the bot's own *you don't own any layout named* |
| `rename` | `rename [old] [new]` | `PATCH {name}` | `409 name_taken` → *already exists* |
| `assign` | `assign` (transfer) | `POST …/transfer {to}` | `03 §3` |
| `setfingermap` | `setfingermap [name] [MATRIX]` | `PATCH {fingermap}` (+ `{board}` when the matrix implies one) | validation strings preserved (LDB-P7) |
| `swap!` `cycle!` | `swap! [name] [chars]` | local transform (`cmds/swap.py modify`) then `PUT` | |
| `angle!` `unangle!` | `angle! [name]` | local transform then `PUT` | `mini` refusal stays client-side |
| `mirror!` | `mirror! [name]` | local transform then `PUT` | |
| `like` `unlike` | `like [name]` | `PUT`/`DELETE …/like` | qwerty refusal server-side too |
| `link` `unlink` | (restricted today) | **dropped** — the record has no `link` (00 §6, saltorbit's round-1 cut); an imported cmini `link` rides in the payload for fidelity only and no command reads or writes it |
| `admin` `maintenance` | restricted | `/v1/admin/*` where they map; the rest stay bot-local | |

### 2.2 Read verbs → local cache (analyzer unchanged)

`view stats fingers fspeed sfbs sfs rolls inrolls outrolls onehands
alternates redirects pattern compare mod swap cycle angle unangle mirror
fingermap homerow filter search rank freq freqd freqs examples names guess
random count xkb list likes authors corpus` — all read `memory.get/find`
which now reads the cache. `list [username]` and `authors` use
`/v1/authors`; `likes` (a user's liked layouts) uses `GET /v1/layouts?liked_by=`
— one small addition to `03 §2` (**add `liked_by` filter**).

`find` keeps its fuzzy match (Damerau-Levenshtein over the cached names).

### 2.3 Local / social (no DB)

`8ball catball dofball wooperball woopercat question flip gen help suggest
akl alt pairings` — unchanged.

### 2.4 New verbs (after parity)

- `!cmini magic [name]` — show a layout's magic as the author wrote it
  (idioms from `akl/1`, raw rules otherwise) — reads `?as=akl/1`.
- `!cmini history [name]` — last 5 events.
- `!cmini transfer` is `assign` already.

## 3. The cache

`/v1/changes?since=<cursor>` on a 30 s timer plus the SSE stream when up;
bootstrapped from `/v1/dump`. Every layout as `cmini/1` (`?as=cmini/1`,
which is what the analyzer parses) in the same on-disk shape
`memory.parse_file` reads today (`layouts/<name>.json`) — so the analyzer
and every read command are untouched. Writes update the cache from the
response before the next tick, so `!add` then `!view` in the same second
works.

## 4. Signing (client lane)

`akl_client/sign.py`: `PyNaCl`'s Ed25519; the signing string of `02 §3.2`;
the vectors in `db/tests/vectors/client-signing.json` are a test in
`bot/tests/` too — the bot and the Worker share the file (copied into
`bot/` at the split; a test asserts they are identical while both live in
this repo).

Key: generated once on the bot host (`akl-client keygen`), public half
registered by an admin (`02 §3.1`), private half in the bot's env. Rotation:
keygen, register, switch, revoke.

## 5. Where it runs

Wherever the cmini bot ran: a small always-on host (a VPS, a Raspberry Pi, a
Fly machine). Stateless except the cache (rebuildable) and the key. The
runbook (`04 §4`) lists it; the Discord application has ≥ 2 team members.

## 6. Invariants

| id | invariant | enforced by |
|---|---|---|
| LDB-B1 | Every cmini command exists with the same `use()` string and the same success/error wording for the cases in the parity table. | `bot/tests/parity.test`: table-driven against a local DB |
| LDB-B2 | Every write the bot makes carries `X-Akl-Actor = message.author.id`; the bot has no code path that writes as anyone else. | grep + unit test on the client |
| LDB-B3 | A read verb never performs an HTTP request (cache only). | unit test with HTTP mocked to fail |
| LDB-B4 | The bot's signature for every vector equals the Worker's expectation. | shared vectors file |

## 7. Open questions (bot)

1. *(resolved: `link`/`unlink` are dropped with the record's `link` field, 00 §6.)*
2. Keep the `!cmini` prefix, or `!akl`, or both? (Copy question — saltorbit's.)
3. Hosting for the bot: your call; proposal a $5 VPS with the runbook.
