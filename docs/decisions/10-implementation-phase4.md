# Implementation — phase 4, the bot (and the client lane it needs)

Status: plan, round 1 (2026-09-09, drafted during phase 1; needs a reviewer
pass before any slice starts). Part of `00-plan.md` (§5 phase 4) and
`05-bot.md` (the shape, parity table, hosting). Phase 2's user lane and
write verbs (`09`) are prerequisites; this doc adds the **client lane**
(`02 §3`) to the DB and builds `bot/`.

## 0. Inventory — what the bot shares with akl.gg (measured on the branch)

| piece | where it lives today | layer | what the bot needs |
|---|---|---|---|
| cmini-view composition | `web/src/core/stats/merge.ts` — `cminiRowFromMana2(…)`, `cminiStatsRowToFields`, `mana2RowFields`, `baseRowFields` | core ✓ | imports as is |
| the engine driver | `web/src/data/swap-engine.ts` — `createSwapEngine({ makeWorker, fetchText, onError })`, `fetchSwapTablesText(engine, corpus, spacegrams, loadText)`; worker protocol `init` / `loadCorpus` / `compute` / `suggest*` | **data** ✗ | the driver already injects `makeWorker` and `fetchText`, so it is DOM-free by construction — **move it down to `core/`** (site PR U1 below); in Node the bot supplies a `worker_threads` Worker running the same `web/swap-worker.js` + wasm |
| the wasm engine | `tools/swapengine` (Go → `web/lib/swapengine.wasm` + `web/swap-worker.js` built by the site's build) | build artifact | the bot's Dockerfile copies the built `swapengine.wasm` + `swap-worker.js` from the site build (same bytes as the deployed site — LDB-B5's "same wasm build") |
| corpus tables the wasm loads | `web/data/mana2-corpora-extended/*.json` (build artifact; `fetchSwapTablesText` reads them) | data | fetched at boot from `https://akl.gg/data/…` (public static) into memory, or shipped in the image; boot-fetch keeps the bot in step with the site's corpora set |
| layout geometry / keys model | `web/src/core/geometry.ts`, `side.ts`, `format.ts` | core ✓ | as is |
| grid text ↔ keys (`!add` parsing, `to_string`) | `web/src/core/export.ts` — `matrixText`, `addGridText`, `fingermapGridText`, `applyCyclesToKeys`, `cminiSwapPairs`, `diffToTranspositions` | core ✓ | the `!add` parser is cmini's `add.py` heuristics ported to TS (board word from leading whitespace, gap rule, duplicate rule) — new, in `bot/`, with cmini's error strings |
| magic authoring shape, scaffold, lowering | `web/src/core/rules.ts`, `magicScaffold.ts`, `magicResolve.ts` — and `db/formats/akl/1/magic.ts` (the DB's lowering) | core ✓ / db | `@akl/layout-formats` for validate/lower/lift; `core/rules.ts` for the site's rule-set shape (identical to `akl/1.magic`, LDB-F3) |
| board drawing for images | `web/src/core/legacyBoardDrawer.ts` (core) + `web/src/ui/copy-image/{draw,image,statrows}.ts` (**ui**, canvas) | mixed | the `ui/copy-image` drawing is canvas-API code with no Solid — **move the pure drawing to `core/copyimage/`** taking a `CanvasRenderingContext2D`-shaped object (site PR U2); the bot renders with `@napi-rs/canvas` |
| state hash / share links | `web/src/core/codec.ts` — `encodeStateHash`, `msgpack*`, `b64url*` | core ✓ | for `!aklgg link` (a share URL into akl.gg) and #218's draft handoff |

Two site PRs unblock the sharing (both pure moves, archlint-checked):
**U1** `data/swap-engine.ts` → `core/swap-engine.ts` (it imports nothing
from `data`; `data/swap-compute/*` keeps importing it); **U2** the drawing
half of `ui/copy-image` → `core/copyimage/`. After U1/U2 the bot depends on
`web/src/core` only — the archlint exception in `05 §1`.

## 1. Before the first PR

| need | default if unanswered | blocks |
|---|---|---|
| `!aklgg` prefix (tentative, `05 §8`) | `!aklgg`; `!cmini` not answered | nothing (a constant) |
| Test server | saltorbit's, bot already invited (2026-09-09) | V6 |
| Fly app | created by `fly launch` from `bot/` (saltorbit's account; `FLY_API_TOKEN` org token is in the repo) | V7 |
| Discord token | in `bot/.env` locally (gitignored); Fly secret `DISCORD_TOKEN` at V7 | V1 |
| The DB's client lane (below) deployed on the preview DB | T7 of `09` | V4+ |

## 2. Slices

Order: C1 (DB) → V1 → V2 → V3 → V4 (needs C1) → V5 → V6 → V7. U1/U2 are
site PRs that precede V2.

### C1 — the client lane in the DB (`02 §3`)

**Lands (in `db/`):** migration `0003_clients.sql` (`clients {id PK, name,
pubkey, owner_user_id, caps, discord_app_id, status, created_at,
revoked_at}`, `nonces {client_id, nonce, at, PK(client_id, nonce)}` pruned
> 10 min); `src/auth/client.ts` — `verifyClientRequest(env, request)`:
headers `X-Akl-Client`, `X-Akl-Timestamp`, `X-Akl-Nonce`, `X-Akl-Actor`,
`X-Akl-Signature`; signing string exactly `02 §3.2` (`"akl-v1\n" + METHOD
+ "\n" + PATH_WITH_QUERY + "\n" + TIMESTAMP + "\n" + NONCE + "\n" + ACTOR +
"\n" + base64url(sha256(body))`); Ed25519 via Web Crypto (`crypto.subtle.
importKey('raw', …, {name:'Ed25519'})` — available in workerd); checks:
client active, `|now − ts| ≤ 300`, nonce unseen, signature, `caps` allow
the actor (`act-as-user` any; `act-as-owner-only` only `owner_user_id`);
`ctx.actor = { user_id: ACTOR, via: "client:<id>" }`. `requireActor` (T1)
tries bearer first, then the client headers. Admin routes `POST/DELETE/GET
/v1/admin/clients` (T3's pattern). Per-client write rate limit (60/10 min)
on top of the actor's (T5). `db/tests/vectors/client-signing.json`: ≥ 10
(key, request, signature) triples generated once by a script
(`scripts/gen-vectors.mjs`, seeded) and frozen.

| file | asserts | invariant |
|---|---|---|
| `tests/auth/client.test.ts` (workers) | every vector accepted; each single-field mutation (method, path, query, timestamp ± 301 s, replayed nonce, body byte, actor, key) refused with `401 bad_signature` / `401 replay` / `401 stale_timestamp`; revoked client refused from revocation on; `act-as-owner-only` refuses a foreign actor | **LDB-A4**, LDB-A5 |
| `tests/api/write.test.ts` (extended) | every write verb accepted on the client lane emits `via: client:<id>` | LDB-A5 |

### V1 — `bot/` skeleton

`bot/package.json` (discord.js ^14, `@napi-rs/canvas`, dotenv, vitest),
`tsconfig`, `src/main.ts` (gateway client, `MessageContent` intent, prefix
router, `!aklgg help`), `src/config.ts` (env: `DISCORD_TOKEN`, `DB_BASE_URL`,
`SITE_BASE_URL`, `PREFIX`, `CLIENT_ID`, `CLIENT_PRIVATE_KEY`), `Dockerfile`
(node:24-slim; copies `swapengine.wasm` + `swap-worker.js` from a site
build stage), `.github/workflows/bot.yml` (test on PR/push under `bot/**`;
deploy on `main` with `FLY_API_TOKEN`), archlint rule + `tests/boundary.
test.ts` (LDB-B6: imports only `../web/src/core`, `../db/formats`, npm).

### V2 — the engine in Node

`src/engine/` — `createSwapEngine` from `core/swap-engine.ts` with
`makeWorker = () => new Worker('./swap-worker.js')` (`worker_threads`, the
browser `postMessage` shape shimmed) and `fetchText` → `SITE_BASE_URL/data/…`;
`compute(layout, corpus)` → mana2 cells → `cminiRowFromMana2` → the row the
site shows. Boot: load every corpus the site lists (`/data/corpora.json`).

| file | asserts | invariant |
|---|---|---|
| `tests/numbers.test.ts` | for every `upstream-100` layout × every corpus: the bot's cmini-view row deep-equals the site's (computed by the same `cminiRowFromMana2` over the same engine output — both sides in the test, one engine instance), and equals the site's **static harvest** for layouts present in `web/data/stats/<corpus>.json` when a built data dir is available (skipped visibly otherwise) | **LDB-B5** |

### V3 — the cache and the DB client

`src/cache/` (boot from `/v1/dump/latest.json` → gunzip → records as
`akl/1`; then `/v1/changes` every 30 s; SSE when phase 5 ships it),
`src/client/` (`get/list/detail?as=akl/1`, writes with client-lane
signing (`sign.ts`, Web Crypto Ed25519), `If-Match` never sent — `03 §1`).
`tests/cache.test.ts` (dump → feed → a change event updates the cache;
LDB-B3: read verbs make no HTTP call — fetch mocked to throw),
`tests/sign.test.ts` (LDB-B4: reproduces every vector in
`db/tests/vectors/client-signing.json`; a test asserts the bot's copy equals
the DB's file byte-for-byte while both live in this repo).

### V4 — the write verbs

`add remove rename assign setfingermap swap! cycle! angle! unangle! mirror!
like unlike` per `05 §2.1`; the `!add` grid parser (cmini's `add.py`
heuristics, error strings verbatim); transforms (`swap`/`cycle`/`angle`/
`unangle`/`mirror`) ported from cmini's `cmds/*.py` logic **as TS, from the
spec of their behaviour** (the parity tests are the spec — the bot's
strings and matrices; no Python reused). `tests/parity-write.test.ts`
(LDB-B1: table of command → expected reply text for success and every
error, against a local DB (miniflare) with the client lane; LDB-B2: every
request's `X-Akl-Actor` equals the message author id — asserted on a
recording client).

### V5 — the read verbs

`view stats fingers fspeed sfbs sfs rolls inrolls outrolls onehands
alternates redirects pattern compare mod swap cycle angle unangle mirror
fingermap homerow filter search rank freq freqd freqs examples names guess
random count xkb list likes authors corpus` — text renderers reproducing
cmini's tables (`render/text.ts`); `rank`/`filter`/`search`/`homerow` over
the cached rows; `find` fuzzy match. `tests/parity-read.test.ts` (LDB-B1:
golden replies per command over the 100-layout cache; goldens written once
from cmini's own output where the bot's data has it, otherwise from the
first run and reviewed).

### V6 — the image verb + new verbs

`!aklgg image [name]` via `core/copyimage` on `@napi-rs/canvas` (pixel
golden per fixture, tolerance 0); `!aklgg magic`, `!aklgg history`,
`!aklgg link` (share URL). Manual pass in the test server: every command
once, transcript saved to `bot/tests/transcripts/` and diffed on later runs.

### V7 — deploy

`fly launch` (saltorbit), `fly secrets set DISCORD_TOKEN CLIENT_PRIVATE_KEY`,
`bot.yml` deploy job, the public key registered on the (preview, then
production) DB by an admin, memory measured (`05 §5`), README runbook
(key rotation, redeploy, logs).

## 3. Invariants added (phase 4)

`LDB-A4`, `LDB-A5` (client half) in the DB; `LDB-B1`–`B6` in the bot
(`05 §7`), registered in `bot/INVARIANTS.md` with the same tag-coverage
test as `db/` (LDB-T1's twin).

## 4. Open questions

1. `!cmini` compatibility period — answer both prefixes for a month?
   (saltorbit; copy.)
2. Corpus tables: fetch from akl.gg at boot (always in step, needs the
   site up at boot) or ship in the image (self-contained, can drift)?
   Proposal: fetch, with the image carrying a fallback snapshot.
3. `xkb` and `gen`/`names`/`guess` — parity for the odd ones or drop?
   Proposal: parity for everything that reads layouts; `gen` is out of
   scope (a generator is an analyzer feature).
