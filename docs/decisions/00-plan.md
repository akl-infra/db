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
| `07-implementation-phase1.md` | how to build phase 1 (the mirror): the measured upstream facts every rule cites, toolchain, `db/` layout, migration 0001, the two formats, PR slices S1–S8 as self-contained briefs with their tests and invariants, CI, definition of done, the phase-1 invariant registry |
| `08-infrastructure.md` | the map of what runs where (site, DB, bot, CI), what it costs, and the follow-ups penciled in but deliberately not done now (diff → Worker cron, rehost drill → Fly schedule, repo split, domain, self-hosted runner) |
| `09-implementation-phase2.md` | phase 2 (people write): user lane, write verbs, If-Match, admins as data, PATCH edits, likes, rate limits, preview DB — slices T1–T7 (draft; reviewer pass pending) |
| `10-implementation-phase4.md` | phase 4 (the bot + the DB's client lane): the code inventory of what the bot shares with akl.gg, site PRs U1/U2, slices C1 + V1–V7 (draft; reviewer pass pending) |
| `11-implementation-phase3.md` | phase 3 (akl.gg cuts over): the site-side seams, slices W1–W6 with the production flip marked as saltorbit's (draft; reviewer pass pending) |

---

## 0. What I understood from the dictation (assumptions — correct me)

The transcript was voice-dictated; these are the readings the plan is built on.

1. "we want to **wait** for discord bots to be able to edit layouts" → *a **way** for* bots: a bot must be able to write without a per-user OAuth session. Modelled as a registered client with a keypair that signs requests and names the Discord user it acts for (`02-auth.md` §3).
2. "track **fingerprint**" → fingermap. "**digger** boards versus **Rohde** boards" → column-stagger vs row-stagger, with the amount of stagger recorded. "prematurely **Laur** lower" → lower.
3. "a proposal … talking about a Federation concept that I don't want to do" → `design/federation/01-design.md` is **not** being built. Its §2 lists why one database is risky (single owner, one person's schema, no home for richer layouts); this plan answers each of those with governance and a format registry instead of with sync (§2 below). Its vocabulary (envelope, `rev`, *held*, *shadowed*, feed-as-truth/push-as-nudge) is reused where it fits.
4. "start off synchronizing with the cmini database" → one-way import from `clemenpine.com/layoutapi/v3` into ours, continuing while it lives; local edits win per record; nothing is written back upstream (`06-akl-integration.md` §2). **Confirm: no write-through to cmini.**
5. "the discord bot should be doing more or less the same things that the cmini bot did" → full command parity within reason. *(Revised 2026-09-09: a TypeScript rewrite sharing akl.gg's core — mana2 wasm + `cminiRowFromMana2` — not a fork of the Python; prefix tentatively `!aklgg`; `05-bot.md`.)*
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
  │  formats/  akl/1  cmini/1  mana2/1  …  (01)             │
  │  auth      Discord bearer · signed clients               │
  │  api       /v1/layouts  /v1/changes  /v1/dump  /v1/meta  │
  │  events    append-only log → feed + webhooks             │
  └───────┬──────────────────────┬───────────────────────────┘
          │ reads (any format)   │ writes (as a user)
  ┌───────┴───────┐   ┌──────────┴─────────┐   ┌──────────────────┐
  │  akl.gg       │   │  Discord bot       │   │ mana / others    │
  │  pipeline +   │   │  (bot/) Ed25519,   │   │ reads any format │
  │  publish UX   │   │  acts as author    │   │ follows the feed │
  └───────────────┘   └────────────────────┘   └──────────────────┘
```

akl.gg's pipeline keeps its shape: `meta-watch` polls the DB's `/v1/meta`
instead of cmini's, `live-sync` computes patches for changed layouts, the
nightly rebuilds the base. On day 1 the scrape reads `?as=cmini/1` from the
DB instead of cmini's API; the extracted files are the same shape (`06 §1`).

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
  humans and the bot type. cmini used the lowercase name as the id (`AdNW`
  is id `adnw`; 184 differ by case), so a rename there was delete + create;
  here it is one event on one record (an upstream rename still arrives as
  delete + create, `06 §2`). Imported records keep their cmini name
  verbatim; the `imported` event and `import_map` carry the cmini id.
  **No provenance field on the record** (saltorbit, round-1 review): one
  client adds, another edits — where a layout came from is the event log's
  business, not a flag that goes stale.
- **D3 · `akl/1` is the common format**, and it is the site's existing shapes
  joined: cmini's `keys` map (`char → {row, col, finger}`, absolute thumb
  columns as in v3), a `board` that says row- or column-stagger with the
  amounts, and the magic authoring shape from `design/magic-rules/02-schema.md`
  unchanged, plus a raw `rules` list as the escape hatch (`01 §2`).
- **D4 · Intent and escape hatch coexist; conflicts are refused.** Lowering
  concatenates compiled idioms and raw rules; two rows with the same trigger
  are a 400 at write time with both shown, never a silent last-wins (`01 §3`).
- **D5 · Two auth lanes, one identity.** Users: a Discord access token
  (verified against Discord — round 1 of #215, already approved). Clients: Ed25519-signed requests from a
  registered public key, naming the user they act for. Both resolve to a
  Discord user id before any authorization rule runs (`02`). DB-minted
  personal tokens for CLIs were proposed and **set aside** (saltorbit, round 1
  review); how mana writes is an open question (`02 §7`).
- **D6 · `rev` + `If-Match`, whole-record PUT, field PATCH for the small
  verbs.** Concurrency is an integer revision per record, checked on write;
  409 carries the current record. Rename/fingermap/transfer are PATCH
  verbs so a bot's `!rename` is one small request.
- **D7 · Likes are a sub-resource, not part of `rev`.** A like changes
  `like_count` and emits an event; it does not bump the record's revision or
  `modified_at` (the bot and the site's sync already assume this).
- **D8 · Feed is truth, webhooks nudge.** `GET /v1/changes?since=` serves
  from 0 forever; webhook subscribers get a signed POST and a gap means poll.
- **D9 · Import is one-way and per-record, and "forked" is derived.** A
  record imported from cmini keeps following upstream while its latest
  write is an import; once a person has written it here, upstream changes
  to it become visible-but-unapplied events. No flag — the import reads the
  record's own history to decide (`06 §2`).
- **D10 · Admins are a table, formats have owners, ops are a runbook.**
  `04`.
- **D11 · The bot is a TypeScript rewrite that shares akl.gg's logic**
  (saltorbit, 2026-09-09, replacing round 1's "fork the Python"): no cmini code
  reused; numbers from the mana2 wasm engine composed into cmini stats by
  the site's own `cminiRowFromMana2`, so bot and site agree by construction
  (LDB-B5); cmini's command names, usage lines and wording kept for parity;
  prefix tentatively `!aklgg`; runs on Fly.io; MIT. `bot/` may import
  `web/src/core` and `db/formats` (by path until they are packages) and
  nothing else — the one named exception to §7's rule (`05 §1`).
- **D12 · Nothing ships to akl.gg's users until the DB is a strict superset
  of what the site shows from cmini today** — verified by a diff, not by eye.

## 5. Phases

Each is independently shippable; nothing user-visible on akl.gg changes before
phase 3.

| phase | delivers | proof it works |
|---|---|---|
| **0 · proposals** | this directory, rendered at akl.gg for the community | people other than saltorbit have read `01`–`04` |
| **1 · mirror** | `db/` Worker + D1; `formats/{cmini,akl}`; cmini import cron; reads (`/v1/layouts`, `?as=cmini/1`), `/v1/meta`, `/v1/changes`, `/v1/dump` | every record read `?as=cmini/1` equals upstream's copy on the cmini projection (`canonical()`, likes sorted — D12, LDB-P5), daily, three days running |
| **2 · users write** | user lane auth; POST/PUT/PATCH/DELETE; likes; transfer; event log; admin table; audit page | API suite + conformance vectors; the site's #215 publish UX pointed at the DB, in the preview deploy |
| **3 · cutover** | akl.gg reads from the DB (pipeline data root, meta-watch), publishes to it; D1 `magic_rules` folded into records | prod on the DB for a week with the cmini import still running; no diff vs cmini for unforked records |
| **4 · bot** | client lane auth; `bot/` (TS rewrite on `@akl/core`) with the DB verbs (`add remove rename assign setfingermap swap! angle! unangle! mirror! cycle! like unlike list likes authors`), then the analyzer verbs | parity table in `05` all green in a test guild |
| **5 · open it** | webhooks; `mana2/1` + one advanced format from its author; org + Cloudflare handover; rehost drill in CI; repo split | a second admin performs the rehost drill without saltorbit |

## 6. Questions for saltorbit

1. §0 items 1, 4, 7 — confirm the readings (bot lane; no write-back to cmini; DB stores no stats).
2. **Name and domain.** `api.akl.gg`? The code dir is `db/` either way; the docs say "the layout DB" until named.
3. *(resolved 2026-09-09)* Bot = TypeScript rewrite sharing akl.gg's core; MIT; Fly.io; prefix tentatively `!aklgg` (`05`).
4. **Day-1 co-admins**: who? The admins table (`04 §1`) is only democratic if it has two rows before phase 3.
5. **Org names**: a GitHub org for the DB + bot repos. *(Cloudflare: resolved 2026-09-09 — a new community-owned account, ≥2 Super Admins from day one, its own domain later; `04 §1`, `07 §1`.)*
6. **Import end state**: keep importing from cmini indefinitely (it stays a source for bot users who never move), or stop at a date?
7. **Rename semantics for imported records**: cmini's id is its name; if someone renames `foo` on our side, the cmini import must not re-create `foo`. Handled by `import_map` (`03 §8`, D9), but confirm you want the *old* name to become free here.
8. Anything in `01 §2` (the `akl/1` shape) you already know you want different — this is the one doc worth reading slowly.
9. **CLI writes** (mana publishing as its user): personal tokens are set aside; the alternatives are a Discord device-flow login inside mana (needs mana to register a Discord app) or publishing through akl.gg only. Which, or neither for now?

Round 2 (the 07 rewrite, 2026-09-08) adds three, none blocking phase 1:

10. **Invariant registry placement**: `db/INVARIANTS.md` + one pointer entry
    in `design/INVARIANTS.md` (`07 §11`), so the registry moves with the
    code — or one `I-nnn` per `LDB-*` in the site's registry as the covenant
    literally says? (Built as the former; flip if you want the latter.)
11. **Combos, row 4, empty layouts** are in the live cmini set and now in
    the formats' envelope (`01 §8` Q6–7). Fine, or hold them?
12. **Upstream renames as delete + create** (`06 §2`, Q4).

Resolved in the round-1 review (2026-09-08): no `link` on the record either (saltorbit: "let's delete this too") — cmini's `link` is accepted inside the `cmini/1` payload for import fidelity only (the D12 diff), never surfaced as a record field, verb or bot command; no `origin` field on the record (history instead, D2/D9); no `core` at all — not a field, not a format ("overkill"); a format that wants to appear on akl.gg ships `to["akl/1"]`, otherwise it is held there (`01 §4`); no personal tokens (D5); no cmini-compatible facade — the site's sync reads `?as=cmini/1` (`06 §1`); polling cost answered in `03 §5` (edge cache + ETag + per-client limit; webhooks/stream preferred).

## 7. Where the code lives, and how it moves out

```
db/                      ← the whole service; moves to its own repo as one `git mv`
  README.md              what it is, how to run, how to rehost
  package.json           own deps (wrangler, vitest); never imports from ../web or ../scripts
  wrangler.toml          Worker + D1 + cron triggers + R2 (dumps)
  migrations/            D1 schema, numbered; applied by CI
  src/                   the Worker: router, auth, formats, events, import
  formats/<name>/<N>/    schema.json · index.mjs (validate, lower, to/from) · fixtures/
  tests/                 API suite, conformance vectors, format goldens, rehost drill
  docs/                  the public API reference (generated from 03)
bot/                     ← MIT; talks to db/ over HTTP; may import web/src/core + db/formats (05 §1), nothing else
```

Rules that keep the move cheap: (a) nothing outside `db/` imports from
inside it and vice versa — the site talks HTTP, tests use fixtures, the
formats reach the site as an npm package (`06 §5`; LDB-G5 tests both
directions); (b) CI for `db/` is its own workflow (`db.yml`) that runs `cd
db && npm test`, and `gates.sh` runs the same when `db/node_modules`
exists; (c) secrets are the Worker's own; (d) the D1 database is its own
(`akl-db`), not `cb-magic`; (e) the invariant registry is `db/INVARIANTS.md`
(`LDB-*`, with the tag-coverage check `LDB-T1`), and `design/INVARIANTS.md`
carries one pointer entry rather than a copy (`07 §11`). The design docs
stay in this repo's `design/layout-db/` until the split and move with the
code.
