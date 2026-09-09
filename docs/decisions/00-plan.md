# The layout database — plan (round 1)

Status: proposal (2026-09-08). Branch `worktree-layout-db`. Nothing implemented.
Companion documents in this directory, in reading order:

| doc | what it settles |
|---|---|
| `01-format.md` | the layout record: profiles (`akl/1`, `cmini/1`, `mana2/1`, …), intent vs lowering, escape hatches, versioning, compatibility tests |
| `02-auth.md` | two ways in: Discord users (sessions/tokens) and registered clients (bots, Ed25519-signed requests acting for a user) |
| `03-api.md` | the HTTP surface: reads, writes, `If-Match`, the change feed, webhooks, dumps |
| `04-governance.md` | no single owner: org, admins, format ownership, rehost drill, backwards-compat gates |
| `05-bot.md` | the Discord bot: cmini command parity, what it talks to, where it lives |
| `06-akl-integration.md` | what changes on akl.gg: data root, pipeline, publish UX (#215), magic rules |

---

## 0. What I understood from the dictation (assumptions — correct me)

The transcript was voice-dictated; these are the readings the plan is built on.

1. "we want to **wait** for discord bots to be able to edit layouts" → *a **way** for* bots: a bot must be able to write without a per-user OAuth session. Modelled as a registered client with a keypair that signs requests and names the Discord user it acts for (`02-auth.md` §3).
2. "track **fingerprint**" → fingermap. "**digger** boards versus **Rohde** boards" → column-stagger vs row-stagger, with the amount of stagger recorded. "prematurely **Laur** lower" → lower.
3. "a proposal … talking about a Federation concept that I don't want to do" → `design/federation/01-design.md` is **not** being built. Its §2 lists why one database is risky (single owner, one person's schema, no home for richer layouts); this plan answers each of those with governance and a format registry instead of with sync (§2 below). Its vocabulary (envelope, `rev`, *held*, *shadowed*, feed-as-truth/push-as-nudge) is reused where it fits.
4. "start off synchronizing with the cmini database" → one-way import from `clemenpine.com/layoutapi/v3` into ours, continuing while it lives; local edits win per record; nothing is written back upstream (`06-akl-integration.md` §2). **Confirm: no write-through to cmini.**
5. "the discord bot should be doing more or less the same things that the cmini bot did" → full command parity within reason, starting from the bot's own (GPLv3, already vendored) command code with its file store swapped for our API (`05-bot.md`).
6. "keep the database in this repo for now … one folder … easy to move out later" → `db/` at the repo root: its own Worker, `wrangler.toml`, migrations, tests, `package.json`; no import crosses the `db/` boundary in either direction (§7).
7. Stats are not the database's job. It stores layouts, ownership, likes and history; every client computes its own numbers (akl.gg with mana2/wasm, the bot with the cmini analyzer). **Confirm.**

## 1. The goal

One database of keyboard layouts that the community, not one person, owns:
any client — akl.gg, a Discord bot, mana on a laptop, an analyzer nobody has
written yet — can read every layout in a format it understands and write the
layouts of the Discord user it is acting for. It starts as a mirror of cmini's
database and is allowed to diverge. Its format is expressive enough for
~99.5 % of what people make, keeps the author's *intent* (an adaptive swap is
stored as an adaptive swap, not as the two magic rules it lowers to), and has
an escape hatch for the rest. Every version of every format stays readable
forever. Every change is an event anyone can subscribe to. And no one human —
including its first maintainer — is needed for it to keep running.

## 2. Principles

Each becomes invariants in the companion docs (numbered `LDB-*` there;
registered in `design/INVARIANTS.md` when implemented).

- **P1 · A layout belongs to a Discord user.** Same identity everywhere: the
  bot sees it natively, web clients get it through OAuth. Only the owner (or an
  admin, logged as such) edits, renames, deletes or transfers it.
- **P2 · Intent is stored; lowering is derived.** The record holds what the
  author meant (`magic_keys`, `chiral_keys`, `adaptive_swaps`); the flat rule
  list engines consume is computed on read, deterministically. Raw lowered
  rules are accepted too, as the escape hatch — beside the intent, never
  instead of it.
- **P3 · Formats are named, versioned and plural.** A record says which
  format its payload is in. A format is a directory in the repo (schema +
  validator + lowering + frozen fixtures) with its own owners. A new format is
  a pull request, not a schema migration.
- **P4 · Old readers keep working.** `?as=<format>` on every read; a format
  version is never removed; its fixtures are never edited; CI fails when any
  historical fixture stops validating or lowers differently.
- **P5 · Every change is an event.** Append-only log from `seq = 0`; the feed
  is the source of truth for followers, webhooks are only a nudge (the
  federation doc's F-10, kept). A full dump is published nightly.
- **P6 · No single human is required.** Multiple admins in data, not in
  code; org-owned repo and cloud account; a rehost-from-dump procedure that
  CI itself exercises.
- **P7 · akl.gg is a client.** First and best-integrated, but with no private
  door: everything it does goes through the same API a bot or mana would use.

## 3. Architecture

```
  cmini (clemenpine.com/layoutapi/v3)
        │  one-way import, cron; local edits win per record (06 §2)
        ▼
  ┌──────────────────────────────────────────────────────────┐
  │  layout DB — db/  (Cloudflare Worker + D1, own domain)    │
  │                                                          │
  │  formats/  akl/1  cmini/1  mana2/1  core/1  …  (01)      │
  │  auth      Discord bearer · DB tokens · signed clients   │
  │  api       /v1/layouts  /v1/changes  /v1/dump  /v1/meta  │
  │  events    append-only log → feed + webhooks             │
  └───────┬──────────────────────┬───────────────────────────┘
          │ reads (any format)   │ writes (as a user)
  ┌───────┴───────┐   ┌──────────┴─────────┐   ┌──────────────────┐
  │  akl.gg       │   │  Discord bot       │   │ mana / others    │
  │  pipeline +   │   │  (bot/) Ed25519,   │   │ DB token, akl/1  │
  │  publish UX   │   │  acts as author    │   │ or mana2/1       │
  └───────────────┘   └────────────────────┘   └──────────────────┘
```

akl.gg's pipeline keeps its shape: `meta-watch` polls the DB's `/v1/meta`
instead of cmini's, `live-sync` computes patches for changed layouts, the
nightly rebuilds the base. The only change on day 1 is the URL the scrape
reads from (`06 §1`).

## 4. Decisions taken in this round (flip any of them)

- **D1 · One database, not federation.** Sync protocols buy resilience with
  races; at this community's write rate (single digits a minute) the cheaper
  resilience is a public feed, a nightly dump, open code and shared admin —
  anyone can stand up a replacement from yesterday's dump in an afternoon.
  The federation doc's three costs are answered: single point of failure →
  `04 §3` (rehost drill) and `§1` (shared ownership); one person's schema →
  the format registry with per-format owners (`01 §5`); no home for richer
  layouts → registered advanced formats stored verbatim, *held* for clients
  that cannot render them (`01 §4`).
- **D2 · Stable ids, unique names.** Every record gets an opaque id (ULID)
  that survives renames; `name` stays unique case-insensitively and is what
  humans and the bot type. cmini used the name as the id, so a rename there was
  delete + create; here it is one event on one record. Imported records keep
  their cmini name and carry the cmini id in `origin`.
- **D3 · `akl/1` is the common format**, and it is the site's existing shapes
  joined: cmini's `keys` map (`char → {row, col, finger}`, absolute thumb
  columns as in v3), a `board` that says row- or column-stagger with the
  amounts, and the magic authoring shape from `design/magic-rules/02-schema.md`
  unchanged, plus a raw `rules` list as the escape hatch (`01 §2`).
- **D4 · Intent and escape hatch coexist; conflicts are refused.** Lowering
  concatenates compiled idioms and raw rules; two rows with the same trigger
  are a 400 at write time with both shown, never a silent last-wins (`01 §3`).
- **D5 · Two auth lanes, one identity.** Users: a Discord access token
  (verified against Discord — round 1 of #215, already approved) or a
  DB-minted personal token for CLIs. Clients: Ed25519-signed requests from a
  registered public key, naming the user they act for. Both resolve to a
  Discord user id before any authorization rule runs (`02`).
- **D6 · `rev` + `If-Match`, whole-record PUT, field PATCH for the small
  verbs.** Concurrency is an integer revision per record, checked on write;
  409 carries the current record. Rename/link/fingermap/transfer are PATCH
  verbs so a bot's `!rename` is one small request.
- **D7 · Likes are a sub-resource, not part of `rev`.** A like changes
  `like_count` and emits an event; it does not bump the record's revision or
  `modified_at` (the bot and the site's sync already assume this).
- **D8 · Feed is truth, webhooks nudge.** `GET /v1/changes?since=` serves
  from 0 forever; webhook subscribers get a signed POST and a gap means poll.
- **D9 · Import is one-way and per-record.** A record imported from cmini
  keeps following upstream until someone writes it here; then it is *forked*
  and upstream changes to it become visible-but-unapplied events.
- **D10 · Admins are a table, formats have owners, ops are a runbook.**
  `04`.
- **D11 · The bot starts as a fork of cmini's command code** (GPLv3, in
  `vendor/cmini-analyzer/cmds` already), file store replaced by an API client;
  numbers from the cmini analyzer as people expect from that bot; mana2
  numbers later. Lives in `bot/` under the same move-out rule as `db/`.
- **D12 · Nothing ships to akl.gg's users until the DB is a strict superset
  of what the site shows from cmini today** — verified by a diff, not by eye.

## 5. Phases

Each is independently shippable; nothing user-visible on akl.gg changes before
phase 3.

| phase | delivers | proof it works |
|---|---|---|
| **0 · proposals** | this directory, rendered at akl.gg for the community | people other than saltorbit have read `01`–`04` |
| **1 · mirror** | `db/` Worker + D1; `formats/{core,cmini,akl}`; cmini import cron; reads (`/v1/layouts`, `?as=cmini/1`), `/v1/meta`, `/v1/changes`, `/v1/dump`; the cmini-compatible facade | `sync_cmini_data.py --base-url <ours>` produces a byte-identical data root to the upstream scrape (D12) |
| **2 · users write** | user lane auth; POST/PUT/PATCH/DELETE; likes; transfer; event log; admin table; audit page | API suite + conformance vectors; the site's #215 publish UX pointed at the DB, in the preview deploy |
| **3 · cutover** | akl.gg reads from the DB (pipeline data root, meta-watch), publishes to it; D1 `magic_rules` folded into records | prod on the DB for a week with the cmini import still running; no diff vs cmini for unforked records |
| **4 · bot** | client lane auth; `bot/` with the DB verbs (`add remove rename assign setfingermap swap! angle! unangle! mirror! cycle! like unlike link unlink list likes authors`), then the analyzer verbs | parity table in `05` all green in a test guild |
| **5 · open it** | webhooks; personal tokens page; `mana2/1` + one advanced format from its author; org + Cloudflare handover; rehost drill in CI; repo split | a second admin performs the rehost drill without saltorbit |

## 6. Questions for saltorbit

1. §0 items 1, 4, 7 — confirm the readings (bot lane; no write-back to cmini; DB stores no stats).
2. **Name and domain.** `api.akl.gg`? The code dir is `db/` either way; the docs say "the layout DB" until named.
3. **Bot in Python from cmini's GPLv3 code** (fast, exact parity, same numbers) vs a fresh bot? GPL means `bot/` is GPLv3; the DB and the site are unaffected.
4. **Day-1 co-admins**: who? The admins table (`04 §1`) is only democratic if it has two rows before phase 3.
5. **Org names**: a GitHub org for the DB + bot repos, and a Cloudflare account with ≥2 super-admins — or keep under your account with added members until phase 5?
6. **Import end state**: keep importing from cmini indefinitely (it stays a source for bot users who never move), or stop at a date?
7. **Rename semantics for imported records**: cmini's id is its name; if someone renames `foo` on our side, the cmini import must not re-create `foo`. Handled by `origin.cmini_id` (D9), but confirm you want the *old* name to become free here.
8. Anything in `01 §2` (the `akl/1` shape) you already know you want different — this is the one doc worth reading slowly.

## 7. Where the code lives, and how it moves out

```
db/                      ← the whole service; moves to its own repo as one `git mv`
  README.md              what it is, how to run, how to rehost
  package.json           own deps (wrangler, vitest); never imports from ../web or ../scripts
  wrangler.toml          Worker + D1 + cron triggers + R2 (dumps)
  migrations/            D1 schema, numbered; applied by CI
  src/                   the Worker: router, auth, formats, events, import
  formats/<name>/<N>/    schema.json · index.mjs (validate, toCore, lower, fromCmini/toCmini) · fixtures/
  tests/                 API suite, conformance vectors, format goldens, rehost drill
  docs/                  the public API reference (generated from 03)
bot/                     ← same rule; GPLv3; talks to db/ only over HTTP
```

Rules that keep the move cheap: (a) nothing outside `db/` imports from
inside it and vice versa — the site talks HTTP, tests use fixtures; (b) CI
for `db/` is its own workflow (`db.yml`) that runs `cd db && npm test`; (c)
secrets are the Worker's own; (d) the D1 database is its own (`akl-db`), not
`cb-magic`. The design docs stay in this repo's `design/layout-db/` until the
split and move with the code.
