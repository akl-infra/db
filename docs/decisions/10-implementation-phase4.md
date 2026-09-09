# Implementation — phase 4, the bot (and the client lane it needs)

Status: plan, round 2 (2026-09-09; round-1 draft reviewed against the site
code on `worktree-layout-db`, cmini's own sources at `a5b0fe35^:vendor/
cmini-analyzer`, and the phase-1 `db/` code; rewritten as closed briefs).
Part of `00-plan.md` (§5 phase 4) and `05-bot.md` (the shape, parity list,
hosting). Written like `07`/`09`: every slice names its files, signatures,
bodies, error strings, tests and the `LDB-*` ids those tests enforce, so a
strong-but-literal coding agent can land it from this document alone.

Prerequisites: phase 2's `T1` (the actor middleware) and `T2` (the write
verbs) on the branch; `T4`/`T5` for the PATCH/like verbs; `T7` (the preview
DB) before anything talks to a real DB. The site PRs `U1`/`U2` (§2) need
nothing from `db/`.

Decisions not reopened here: the bot is a TypeScript rewrite, no Python
reused, numbers from the mana2 wasm + `cminiRowFromMana2` (the site's own
composition), prefix tentatively `!spark`, Fly.io 256 MB in saltorbit's
account, MIT; the client lane is Ed25519-signed requests from
admin-registered keys asserting the acting Discord user (`02 §3`); only the
DB is co-owned; production flips are saltorbit's; `appendWrite` is the only
writer.

## 0. Inventory — what the bot shares with akl.gg (measured on the branch, 2026-09-09)

Round 1's table had four wrong paths and one wrong assumption (that
`web/swap-worker.js` can run under `worker_threads`). Corrected:

| piece | where it lives today (verified) | layer | what the bot does with it |
|---|---|---|---|
| **the wasm engine** | `web/data/swap/engine.wasm` (4.6 MB) + `web/data/swap/wasm_exec.js` (Go's runtime shim, version-locked to the binary) + `web/data/swap/meta.json` `{mana2Pin, statsVersion, goVersion, wasmBytes}` — built by `scripts/build_wasm.py` from `tools/swapengine` (Go 1.26.4, `GOOS=js GOARCH=wasm`, pins stamped via `-ldflags`, so `swapengine.ready()` self-reports them). **Not** `web/lib/` (that holds only `debuglog.js`). Deployed with the site as `https://akl.gg/data/swap/*` | build artifact | fetched at boot from the site (§1 D2); the pin it reports must equal the harvest's (`data/mana2/build_id.json`) — the site's own `web/tests/tools/datasync.mjs` gate, reused as a boot check |
| **how Node loads it** | `tools/swapengine/smoke.js` already does it: `require(wasm_exec.js)` sets `globalThis.Go`; `new Go()`; `WebAssembly.instantiate(bytes, go.importObject)`; `go.run(instance)` (never resolves); poll `globalThis.swapengineReady === true`; then the **synchronous** `globalThis.swapengine.{ready, loadCorpus(engine, corpus, spacegrams, tablesText), compute(engine, corpus, board, space, layoutJSON[, magicRulesJSON]), convertLayout, resolveMagicNgramsMana2, suggest, suggestRefine}` (`tools/swapengine/main_js.go:42-57`) | — | `compute` blocks the thread ~90 ms per layout, so it must not run on the gateway thread — a `worker_threads` Worker (§1 D1) |
| **the site's worker** | `web/swap-worker.js` — Web Worker API only: `self.onmessage`, bare `postMessage`, `importScripts('data/swap/wasm_exec.js')`, `fetch('data/swap/engine.wasm')` relative to the script URL, `setTimeout` coalescing of `compute` | — | **not runnable under `worker_threads` as is** (no `self`, no `importScripts`, no relative `fetch`, `postMessage` is `parentPort.postMessage`); its *wire protocol* is what the bot reuses (below), the file itself is not |
| **the driver** | `web/src/data/swap-engine.ts` — `createSwapEngine({ makeWorker, fetchText, onError })` → `{ ensure, loadCorpus, compute, convert, resolveMagicNgrams, suggest, suggestRefine, withLock, isCorpusLoaded, loadText, dispose }`; `fetchSwapTablesText(engineName, corpus, spacegrams, loadText)`. **Zero imports**; every effect injected (`SwapWorkerLike` = `{postMessage, addEventListener, removeEventListener?, onerror?, terminate?}`); the wire protocol: id-less `init`→`ready {mana2Pin, statsVersion}`, `loadCorpus {engine, corpus, context, tables}`→`corpusReady`, reqId-keyed `compute {engine, corpus, context, layout, magicRules?}`→`stats {reqId, …cell}`, `convert`→`converted`, `resolveMagicNgrams`→`magicNgrams`, `suggest`→`suggested`, `suggestRefine`→`suggestRefined`, `error {reqId?, error}` | **data** | moved to `core/swap-engine.ts` by **U1** (§2) — a pure move, 11 importers; one archlint catch (§2) |
| **corpus tables the wasm loads** | `web/data/mana2/ngrams/<corpus>[.sg].json` (13 corpora × 2 = 26 files, 11 MB total; `{options, monograms, bigrams, trigrams}` text the wasm parses itself) for engine `mana2`; `web/data/mana2/ngrams-extended/…` (115 MB) for engine `mana2-magic`. The corpus list: `web/data/mana2/defs.json`.`corpora` (13) — **not** `mana2-corpora-extended`, **not** `corpora.json` | build artifact | standard tables fetched from `https://akl.gg/data/mana2/ngrams/<corpus>.json` at boot (§1 D2); the extended tables are **not** fetched (§1 D4: no magic-resolved compute in phase 4) |
| **the site's precomputed cells** | `web/data/mana2/<corpus>.<board>.<space>.json` — `{ "<layout id>": Mana2Cell }` for every catalog layout, id = the lowercase name (`layouts.json`'s id); the deploy gate `tools/swapengine/engine/compute_test.go:TestComputeMana2MatchesHarvest` proves wasm == harvest to `reconcileTol = 1e-12` on every deploy | build artifact | the bot's catalog cells come **from here** (§1 D3) — a `rank` over 4 000 layouts is 13 fetches, not 78 minutes of wasm; the wasm computes only what the harvest cannot have (records newer than the build, transforms) |
| **cmini-view composition** | `web/src/core/stats/merge.ts` — `cminiRowFromMana2(cell: Mana2Cell, defs: Mana2Defs, hasThumb: boolean, fingerIdx: () => Record<string, number> | null)` → the `stats_row()`-shaped object; `cminiStatsRowToFields(row, board)` → the row fields; `cellHasThumb(cell)`. The site's exact live call is `web/src/state/rowFields.ts:cminiCellToFields` = `cminiStatsRowToFields(cminiRowFromMana2(c, defs, cellHasThumb(c), fingerIdx) ?? {}, board)` | core ✓ | as is. Inputs the bot must supply: `defs` = `web/data/mana2/defs.json` (`Mana2Defs`: `bigram`/`trigram`/`trigramExtra` stat defs, `fingers` = `["LP","LR","LM","LI","LT","RT","RI","RM","RR","RP"]`, `corpora`, `boards`, `spaces`); `fingerIdx` = `Object.fromEntries(defs.fingers.map((f, i) => [f, i]))` (`core/mana2Space.ts:mana2FingerIdx`); `board` ∈ `rowstag|ortho` (only matters for harvest-row `fingers_<board>` lookups; a live cell's `fingers`/`fspeed` are unsuffixed) |
| **the compute payload** | `web/src/core/session.ts:swapLayoutPayload(src)` → `{ name, board: nativeBoard ?? 'stagger', keys: { "<c>": {row, col, finger} } }` after `core/geometry.ts:normalizeLayoutColumns` (I-156: a negative column panics the Go runtime); the view context `swapContext(engine, board, spacegrams, thumb)` → `{ board: 'rowstag'|'ortho', space: 'none'|'lt'|'rt' }`; the cmini view always computes at `space: 'none'`; `data/swap-compute/computeLoop.ts:wasmEngineFor` maps the view name to `mana2` | core ✓ | as is; the bot's `Keys` (the site's `KeyCell[]` = `[{c, row, col, finger}]`) come from the record's `akl/1` `keys` map |
| layout geometry / keys model | `web/src/core/geometry.ts` (`normalizeLayoutColumns`, `layoutHasThumbKey`, `keyboardBoard`, `mirrorThumbKeys`, `bvAngleModRotate`), `side.ts`, `format.ts` | core ✓ | as is |
| grid text ↔ keys | `web/src/core/export.ts` — `matrixText`/`addGridText`/`fingermapGridText` (the **`!cmini add` exporter shape** — what cmini *parses*), `applyCyclesToKeys`, `cminiSwapPairs`, `diffToTranspositions`, `CMINI_FINGER_VALUES` | core ✓ | `applyCyclesToKeys`/`CMINI_FINGER_VALUES` as is. **cmini's display shape** (`util/layout.py:get_matrix` — 2-space lead, an extra space after column 4, per-board row indents, thumb row indented 6/13) is what the bot must *print* for parity; it is not `matrixText` — ported in V4 (`render/matrix.ts`, ≈80 lines, spec = the Python quoted in §5) |
| magic authoring shape, scaffold, lowering | `web/src/core/rules.ts` (`RuleSet`, `magicRulesFlatCompile`, `magicCaptionTextLines`, `validateRuleSet`), `magicScaffold.ts`, `magicResolve.ts`; `db/formats/akl/1/{index,magic,translate}.ts` (`validate`, `lower`, `to`, `from`, `reconcileScaffoldsToTrueRows`) and `db/src/formats/registry.ts`'s `translate(rec, as)` | core ✓ / db | `db/formats` for translate-to-`akl/1` of every cached record and for `!spark magic`'s caption; `core/rules.ts:magicCaptionTextLines` for the text |
| board drawing for images | `web/src/ui/copy-image/{types,geometry,caption,statrows,draw}.ts` — canvas-API code over a `CanvasRenderingContext2D` parameter; imports are `core/*`, `copy/*` and each other; `draw.ts` reads exactly two deps (`deps.activeFingerColors`, `deps.keyTextColor`, line 300); **the only DOM call is `document.createElement('canvas')` in `drawImageCanvas` (`draw.ts:497`)**. `image.ts` (`resolveImageTargets`, `buildImagePlan`, `copyAsImage(id, btn: HTMLElement, …)`) reads store-shaped `CopyImageDeps` and the clipboard — stays in `ui`. Fonts are CSS stacks (`copy/copyimage.ts:57-58`: `"Helvetica Neue", Helvetica, Arial, sans-serif` / `Menlo, ui-monospace, …`) | **ui** | the five drawing modules move to `core/copyimage/` by **U2** (§2); the bot builds its own `ImagePlan` and paints on `@napi-rs/canvas`. **Pixel identity with the browser is not achievable** (different rasterizer, different fonts) — `05 §3`'s "the same pixels" is corrected to "the same drawing code" (§1 D7) |
| state hash / share links | `web/src/core/codec.ts` — `encodeStateHash`, `msgpackEncode`, `b64urlEncode`; `core/export.ts:swapShareHash` | core ✓ | `!spark link` |
| the DB client code | `db/src/core/events.ts` (`Event` shape: `seq at kind layout_id name owner rev actor via admin detail before after`), `db/src/core/records.ts:toWire` (the record wire shape) | db | the bot does **not** import `db/src` (only `db/formats`, LDB-B6); the wire shapes are typed in `bot/src/client/types.ts` from `03` |

## 1. Decisions taken in this round (ledger; flip any of them)

1. **D1 · Engine host = a bot-owned `worker_threads` Worker speaking the site's wire protocol.** `bot/src/engine/worker.ts` loads the wasm exactly as `tools/swapengine/smoke.js` does and answers `init`/`loadCorpus`/`compute`/`resolveMagicNgrams` with the same message shapes `web/swap-worker.js` emits; `core/swap-engine.ts` (U1) drives it through a 6-line `SwapWorkerLike` adapter over `parentPort`. Not the alternative (shimming `self`, `importScripts` and a relative `fetch` so `web/swap-worker.js` runs verbatim): three monkeypatches on Node globals to save ~60 lines, and the coalescing/`setTimeout` half of that file is browser-drag logic the bot never needs. The protocol, not the file, is the shared thing; V2's `protocol.test.ts` pins it.
2. **D2 · The wasm and the standard corpus tables are fetched from the site at boot, nothing is shipped in the image.** `SITE_BASE_URL/data/swap/{meta.json,wasm_exec.js,engine.wasm}` + `/data/mana2/defs.json` + `/data/mana2/ngrams/<corpus>.json` × 13 (≈ 16 MB, one boot). Always in step with what the site serves — which is what LDB-B5 means — and the image is `node:24-slim` + `dist/`, no Go toolchain, no site build stage. Boot fails loudly if the site is unreachable (Fly restarts the machine; the site is static on Cloudflare Pages and has never been the thing that was down). Round 1's "ship in the image with a fallback snapshot" is dropped: two copies of the engine is one more way to be quietly wrong (the `datasync` lesson).
3. **D3 · Catalog cells come from the site's harvest; the wasm fills the gaps.** At boot the bot fetches `/data/mana2/<corpus>.rowstag.none.json` × 13 (the cmini view's context, `space: 'none'`, `DEFAULT_BOARD = 'rowstag'` — `state/view.ts:35`) and `/data/mana2/build_id.json`; a cached record whose lowercase name is in the harvest **and** whose `modified_at ≤ build_id.built_at` uses the harvest cell; everything else (new since the build, edited, renamed, every transform verb) is computed by the wasm on demand and memoised per `(id, rev, corpus)`. A rev-bumping change event evicts the id. The harvest is re-fetched when `build_id.json` changes (checked every 10 min). Memory: 13 × ~4 200 cells × ~400 B ≈ 22 MB. This is not a shortcut around LDB-B5 — it *is* LDB-B5's second half (the site's deploy gate already proves wasm == harvest to 1e-12).
4. **D4 · No magic-resolved compute in phase 4.** The `mana2-magic` engine needs the 115 MB extended tables; on a 256 MB machine that is the whole budget. The bot computes with engine `mana2` (the site's cmini view for a layout with rules shows the *resolved* numbers via `cmini-magic` — so a magic layout's `!spark view` numbers are the site's *unresolved* numbers; V5 prints `(magic rules not applied)` under the header when the record has rules). `!spark magic` shows the rules. Extended tables per corpus on demand with an LRU is phase 5 if anyone asks.
5. **D5 · Context = `{board: 'rowstag', space: 'none'}` for every layout.** cmini's analyzer had no board notion; the site's default view is `rowstag`. `!spark view` therefore shows what a fresh akl.gg visitor sees. The board word on the record still decides the *drawn* shape (`keyboardBoard(word)`) and the `add` grid, not the stats. A per-user board preference is not built (nobody asked; `!corpus` is the one preference cmini had).
6. **D6 · Parity strings live in the bot, keyed by (verb, error code); the DB's `message` is the fallback.** cmini has three different not-owner strings (`remove`: ``you don't own any layout named `x` ``; `rename`/`setfingermap`: ``you don't own a layout named `x` ``; the `!` transforms: `you don't own the layout x`), so no single DB `message` can satisfy LDB-P7's "matches the bot's own string" — `03 §9` LDB-P7's phase-4 clause is reworded to: *every (verb, error code) the parity table names renders the bot's own string; the DB's `message` is what the bot prints for any error the table does not name*. `bot/src/render/strings.ts` is the table; `tests/parity/*.json` is the proof.
7. **D7 · The image verb shares the drawing code, not the pixels.** `05 §3` corrected. V6's test is determinism (two renders of one plan are byte-equal) plus a plan snapshot, not a browser golden.
8. **D8 · Per-client write limit 300 / 10 min** (`02 §3.3` said 60). The per-actor limit (60, T5) is the fairness rule and already bounds each *person* the bot acts for; the per-client number is a rogue-key bound and a real multi-user bot serving a busy channel exceeds 6 writes/min. Counted in the same `ratelimit` table with key `client:<id>`, same statement, same 429 body.
9. **D9 · The client lane is a lane, not a write-only lane.** `resolveActor` accepts it on any route (so `GET /v1/me` with client headers answers `via: "client:<id>"` — the bot's boot self-check). Reads are never rate-limited or nonce-tracked differently; the bot never signs a read in practice (LDB-B3), but the middleware is one code path.
10. **D10 · Per-user corpus preference lives on a 1 GB Fly volume** (`/data/prefs.json`, written on every `!corpus`), not in the DB (not layout data) and not in memory (lost on every deploy; cmini's `corpora.json` persisted). `05 §5` "no volume" corrected. Default corpus = the site's `DEFAULT_CORPUS = 'reddit'` (`core/corpus.ts:27`); cmini's `mt-quotes` does not exist on the site — `!corpus mt-quotes` answers cmini's own `The corpus `mt-quotes` doesn't exist.`
11. **D11 · `assign` follows the DB's rule (owner or admin), not cmini's (admin only).** A superset; cmini's `Unauthorized` string is printed when the DB answers `403 not_owner`. The target may be a name or an id: a 17–20-digit token is an id, anything else is resolved through the cached `/v1/authors` map with cmini's fuzzy `authors.get_id` (Damerau–Levenshtein, ported).
12. **D12 · Scope of parity.** V4 + V5 cover every verb that reads or writes layouts or corpora (§5 lists them). `link`/`unlink` (dropped with the record's `link`, `00 §6`), `gen` (a generator), `xkb` (DM-only template export), `names`/`guess`/`count`/`8ball`/`catball`/`dofball`/`wooperball`/`woopercat`/`question`/`flip`/`akl`/`alt`/`pairings`/`suggest` (minigames/social/cmini-specific) are **V8, after the parity tables are green** — listed so nobody thinks they were forgotten, cut from this document's briefs.
13. **D13 · `!add` parses cmini's *current* grid rules, not the vendored copy's.** The vendored `add.py` (`a5b0fe35^`) predates cmini v3's absolute thumb columns (2026-08-31; memory `thumb-absolute-cols`): it stores a thumb key's column as its index among the stripped row's tokens. The live API stores absolute columns (`adept`'s `e` is `{row: 3, col: 6, finger: TB}`). The bot follows the live rule: a row-3 key's `col` is its absolute column (leading-space offset ÷ 2, as `setfingermap`'s matrix already implies), `finger` = `RT` when `spaces[3] > 8` else `LT`. The parity fixture for a thumb layout pins it; the agent verifies once against upstream `068a4f50`'s `add.py` (`git show` is not enough — the vendored tree is older).
14. **D14 · The client lane carries no display name** (C1 step 7): `/v1/authors` shows a bot-only author's id until they sign into akl.gg once. The bot's replies use the cached name when one exists, the id otherwise.
15. **D15 · No stale reads, no clobbering writes (saltorbit, 2026-09-09).** The 30 s `feedTick` poll this document's own §4 V3 originally specified is retired outright — `cache/fresh.ts`'s `ensureFresh()` (one conditional `GET /v1/meta`, folding `GET /v1/changes?since=<cursor>` only when `seq` moved) runs before every read verb and is now the sole freshness guarantee (LDB-B14): a read's answer equals the DB's state at the moment it ran, not a snapshot from whenever the cache last happened to sync. `cache/stream.ts`'s SSE `subscribe()` replaces the poll as a keep-warm layer on top — it makes `ensureFresh`'s own catch-up almost always empty, but a dropped stream costs latency, never correctness (a stream failure is swallowed and retried with backoff, never surfaced). Symmetrically, every write verb but `add` now fetches its record fresh immediately before writing and sends `If-Match` set to that fresh rev, unconditionally, no fallback path that omits it (LDB-B2, extended) — a `409 stale` folds the conflict's own record into the cache and answers "changed a moment ago" rather than retrying blind. `bot/tests/cache/fresh.test.ts`, `bot/tests/cache/stream.test.ts`, `bot/tests/commands/write.test.ts` are the tests; `bot/INVARIANTS.md`'s LDB-B2/B3/B10/B14 rows are the registry entries this decision touches.

## 2. The two site PRs (precede V2/V6; archlint-checked; no `db/` involvement)

### U1 — `web/src/data/swap-engine.ts` → `web/src/core/swap-engine.ts`

A `git mv` plus 11 import-path edits. Nothing in the file imports anything;
every effect is injected, so the move is legal under `core`'s rule
(`CORE_STATE_FORBIDDEN` in `web/tests/tools/archlint.mjs:282` bans
`fetch(`, `new Worker`, `setTimeout`, `Date.now`, … — the file uses none).
One catch: that regex is a **line scan that includes comments**, and two
doc lines in the file contain the literal `new Worker(...)` ("this module
never calls `new Worker(...)` itself", twice) — reword them (`the Worker
constructor`) in the move; do not add `archlint-allow`.

| edit | files |
|---|---|
| move | `web/src/data/swap-engine.ts` → `web/src/core/swap-engine.ts` (header updated: "core/ because it has no imports and every effect is injected — `makeWorker`/`fetchText` are the caller's; the bot drives it under Node") |
| import path | `web/src/app/main.ts`, `web/src/data/catalog.ts`, `web/src/data/http.ts`, `web/src/data/magic-api.ts`, `web/src/data/magic-ngrams.ts`, `web/src/data/swap-compute/{computeLoop,speculators,suggest}.ts`, `web/src/state/bench/engine.ts`, `web/src/state/engineHealth.ts`, `web/src/state/types.ts` (the `grep -rln "swap-engine" web/src` list on 2026-09-09; re-grep at landing) |
| tests | whatever under `web/tests/` imports the old path (`grep -rl "data/swap-engine"`); `design/ARCHITECTURE.md`'s module map line for `data/` and `core/` |

DoD: `sh web/tests/tools/gates.sh --fast` green (archlint `imports`, `dom`,
`state`, `size` all pass on the moved file); `npm test` green; no behaviour
change (no catalog entry touched).

### U2 — the drawing half of `web/src/ui/copy-image/` → `web/src/core/copyimage/`

| edit | detail |
|---|---|
| move | `ui/copy-image/{types,geometry,caption,statrows,draw}.ts` → `core/copyimage/` (they import only `core/*`, `copy/*` and each other — verified 2026-09-09) |
| split | in the moved `draw.ts`, `drawImageCanvas(plan, deps): HTMLCanvasElement` becomes `drawImage(ctx: CanvasRenderingContext2D, plan: ImagePlan, deps: DrawDeps): void` — the body from `ctx.scale(plan.dpr, plan.dpr)` down (the `document.createElement` + `getContext` lines leave). `ui/copy-image/image.ts` keeps a 7-line `drawImageCanvas` that creates the canvas, scales, and calls `drawImage` |
| type | `DrawDeps = Pick<CopyImageDeps, 'activeFingerColors' | 'keyTextColor'>` — the two `deps.` reads in `draw.ts` (line 300) — declared in `core/copyimage/types.ts`; `CopyImageDeps` (store getters, clipboard callback, `HTMLElement`) stays in `ui/copy-image/image.ts` and extends it |
| stays in ui | `image.ts` (`resolveImageTargets`, `buildImagePlan`, `copyAsImage`) — `buildImagePlan` measures through the store-shaped deps; the bot builds its `ImagePlan` directly (V6) |
| archlint | `core/copyimage/*` reads copy strings from `copy/copyimage.ts`/`copy/card.ts` — allowed (`copy` is a leaf any layer may import); no I-15 gate on core |

DoD: gates green; the copy-image Playwright/vitest specs untouched and
green (`grep -rl copy-image web/tests`); the exported PNG for the
`graphite` fixture byte-equal before/after (existing golden if one
exists, else a one-off `web/tests/golden` addition in the PR).

## 3. Before the first PR

| need | default if unanswered | blocks |
|---|---|---|
| `!spark` prefix (tentative, `05 §8`) and whether `!cmini` is answered too | `!spark` only; `PREFIXES` is a config list so the transition is a redeploy | nothing (a constant) — **saltorbit** |
| Test server | saltorbit's, bot already invited (2026-09-09); `TEST_GUILD_ID` in `bot/.env` | V6's manual pass |
| Fly app + volume | `fly launch --no-deploy` from `bot/` then `fly volumes create botdata --size 1` (saltorbit's account; `FLY_API_TOKEN` org token is a repo secret) | V7 |
| Discord token | `bot/.env` locally (gitignored); Fly secret `DISCORD_TOKEN` at V7 | V1 |
| The bot's Ed25519 key | generated once by `bot/scripts/gen-key.mjs` (prints `CLIENT_PRIVATE_KEY` = base64url PKCS8 seed, `pubkey` = base64url raw 32 bytes); registered on the **preview** DB by an admin through `POST /v1/admin/clients` (C1); on production by **saltorbit** at V7 | V4 |
| The client lane deployed on the preview DB | C1 on the branch + `T7`'s preview job | V4 |
| `SITE_BASE_URL` | `https://akl.gg` (prod data is public and static); a preview deploy's URL for engine experiments | V2 |

## 4. Slices — PRs in order

Order: **C1** (DB) ∥ **U1**, **U2** (site) → **V1** → **V2** (needs U1) → **V3** →
**V4** (needs C1 on preview) → **V5** → **V6** (needs U2) → **V7**. Every
`db/` slice adds its rows to `db/INVARIANTS.md` and tags its tests; every
`bot/` slice does the same in `bot/INVARIANTS.md` (LDB-T1's twin,
`bot/tests/tools/invariants.test.ts`, a copy of `db/tests/tools/
invariants.test.ts` with the root changed — a copy, not an import, LDB-B6).

### C1 — the client lane in the DB (`02 §3`), `liked_by`, admin client routes

**Lands (in `db/`):** `migrations/000N_clients.sql` (N = the next free
number at landing: `0003` if `09 §6.12`'s `0003_admin2.sql` has not landed,
else `0004`), `src/auth/client.ts`, `src/auth/actor.ts` extended,
`src/routes/admin.ts` extended, `src/routes/layouts.ts` `liked_by`,
`src/core/ratelimit.ts` client key, `core/errors.ts` +4,
`scripts/gen-vectors.mjs`, `tests/vectors/client-signing.json`,
`tests/auth/client.test.ts`, `tests/api/clients.test.ts`, extensions to
`tests/api/{write,list,ratelimit,me,conformance}.test.ts`.

```sql
-- migrations/000N_clients.sql
CREATE TABLE clients (
  id             TEXT PRIMARY KEY,        -- ULID minted at registration
  name           TEXT NOT NULL,
  pubkey         TEXT NOT NULL,           -- base64url of the raw 32-byte Ed25519 public key
  owner_user_id  TEXT NOT NULL,           -- Discord id of the maintainer
  caps           TEXT NOT NULL,           -- 'act-as-user' | 'act-as-owner-only'
  discord_app_id TEXT,                    -- recorded for the human check (02 §3.3), never verified at runtime
  status         TEXT NOT NULL,           -- 'active' | 'revoked'
  created_at     TEXT NOT NULL, revoked_at TEXT
);
CREATE TABLE nonces (
  client_id TEXT NOT NULL, nonce TEXT NOT NULL, at TEXT NOT NULL,
  PRIMARY KEY (client_id, nonce)         -- the PK IS the replay check (below)
);
CREATE INDEX nonces_at ON nonces(at);
```

**`src/auth/client.ts`** — `verifyClientRequest(db, now, request, bodyBytes, deps: { verify?: VerifyImpl })`:

1. Headers: `X-Akl-Client`, `X-Akl-Timestamp`, `X-Akl-Nonce`, `X-Akl-Actor`, `X-Akl-Signature`. Any missing/malformed (timestamp not `^\d{1,12}$`, nonce not base64url of 16 bytes, actor not `^\d{17,20}$`, signature not base64url of 64 bytes) → `401 bad_signature` (one error for every malformed case — no oracle on which header was wrong).
2. `SELECT id, pubkey, owner_user_id, caps, status FROM clients WHERE id = ?` → none → `401 unknown_client`; `status = 'revoked'` → `401 client_revoked`.
3. `|epochSeconds(now) − timestamp| > 300` → `401 stale_timestamp { skew: <seconds> }`.
4. `signing_string = "akl-v1\n" + METHOD.toUpperCase() + "\n" + url.pathname + url.search + "\n" + TIMESTAMP + "\n" + NONCE + "\n" + ACTOR + "\n" + base64url(sha256(bodyBytes))` — `url.search` **as sent** (no query canonicalisation; the client signs the string it puts on the wire); an absent body hashes as zero bytes. `crypto.subtle.importKey('raw', pubkeyBytes, { name: 'Ed25519' }, false, ['verify'])` then `crypto.subtle.verify('Ed25519', key, sigBytes, utf8(signing_string))` (Ed25519 is in workerd's Web Crypto; `deps.verify` is injectable so a unit test can force a verifier failure). `false` → `401 bad_signature`.
5. `INSERT INTO nonces (client_id, nonce, at) VALUES (?, ?, ?)` — a `UNIQUE constraint failed: nonces.client_id, nonces.nonce` D1 error → `401 replay`. The insert is **after** the signature check so a forged request cannot burn a real nonce, and it is one statement so there is no check-then-insert window.
6. `caps = 'act-as-owner-only' && ACTOR !== owner_user_id` → `403 actor_not_allowed { actor, owner: owner_user_id }`.
7. → `Actor { user_id: ACTOR, name: <authors row name ?? ACTOR>, via: \`client:${id}\`, admin: EXISTS admins }` (the same admin read T1 does), and an `authors` row upserted like T1's (`first_seen_at` on insert, `name = ACTOR` when no row exists, an existing `name` never overwritten). The client lane carries **no display name**: cmini's `authors.update` recorded `message.author.name` on every `!add`; here a real name arrives the first time the person signs into akl.gg (T1), and until then `/v1/authors` shows the id as the name. Ledgered (D14); a signed `X-Akl-Actor-Name` header is the flip if `list [username]` needs names sooner — not built.

Body bytes: the middleware calls `await c.req.arrayBuffer()` once; Hono v4
caches the body (`HonoRequest`'s body cache), so a route's later
`c.req.json()` reads the same bytes — no request cloning.

**`src/auth/actor.ts`** — `resolveActor(env, request, deps)` becomes a
two-lane dispatcher: `Authorization: Bearer` present → `resolveBearer`
(T1); else `X-Akl-Client` present → `verifyClientRequest`; both present →
`400 bad_request { param: "Authorization" }` (`message: "use one lane per
request"`); neither → `401 unauthorized` + `WWW-Authenticate: Bearer`.
`Actor.via` widens to `"discord" | \`client:${string}\``.
`requireActorOnWrites` (T1) is unchanged. **`core/write.ts`** (T2) writes
`via: actor.via` instead of the literal `"discord"` — this is the one
phase-2 file C1 edits, and `tests/api/write.test.ts`'s `via` assertion
becomes "equals the actor's lane".

**Rate limit** (`core/ratelimit.ts`, T5): when `actor.via` starts with
`client:`, a second statement with `key = 'client:' || id`, limit **300**
(D8), same window; a 429 from either counter is the 429 (`limit` in the
body names which: `scope: "actor" | "client"`).

**Nonce prune:** the nightly cron (`0 3 * * *`) runs `DELETE FROM nonces
WHERE at < ?` with `now − 900 s` (a nonce is only accepted inside ±300 s
of its timestamp, so 15 minutes is a safe margin over `02 §3.2`'s "10 min").

**Admin routes** (`src/routes/admin.ts`, T3's pattern; every one requires
`admin`, counts as a write, emits an event):

```
POST   /v1/admin/clients          { name, pubkey, owner_user_id, caps, discord_app_id? }
                                  → 201 { id, name, pubkey, owner_user_id, caps, discord_app_id, status: "active", created_at }
                                    event admin.client_registered  detail { id, name, owner_user_id, caps }   (never the pubkey)
DELETE /v1/admin/clients/{id}     → 200 { id, status: "revoked", revoked_at }   event admin.client_revoked detail { id }; 404 unknown; 200 idempotent on revoked (no event)
GET    /v1/admin/clients          → 200 [ { …row minus nothing (pubkeys are public) } ]
```

`pubkey` must decode to exactly 32 bytes (`400 bad_request param /pubkey`);
`caps` ∈ the two values; `owner_user_id` 17–20 digits. `admin.client_*`
join `InfoKind` (T3's `appendAdmin`).

**`liked_by`** (`03 §2`; `src/routes/layouts.ts`): `GET /v1/layouts?liked_by=<user_id>`
adds `AND id IN (SELECT layout_id FROM likes WHERE user_id = ?)`;
combinable with every other filter and sort; malformed id → `400
bad_request param liked_by`. Also on `?full=1`.

**Errors** (`core/errors.ts`): `401 unknown_client`, `401 client_revoked`,
`401 stale_timestamp { skew }`, `401 replay`, `401 bad_signature`, `403
actor_not_allowed { actor, owner }`. Every 401 here carries
`WWW-Authenticate: Bearer` too (a client that fell into the wrong lane sees
the same hint).

**Vectors** — `scripts/gen-vectors.mjs` writes `tests/vectors/client-signing.json`
deterministically (`--check` exits 1 if the file would change; the test
suite runs `--check`, which is how the file is frozen):

```jsonc
{ "version": 1,
  "keys": [ { "id": "k1", "seed_hex": "<32 bytes, fixed in the script>", "pubkey_b64url": "…", "pkcs8_b64url": "…" } ],
  "vectors": [ { "name": "get-no-body", "key": "k1", "client_id": "01ARZ3NDEKTSV4RRFFQ69G5FAV",
                 "method": "GET", "path": "/v1/me", "timestamp": "1788000000", "nonce": "<b64url 16 B>",
                 "actor": "184412255822020608", "body": null,
                 "signing_string": "akl-v1\nGET\n/v1/me\n1788000000\n…", "signature_b64url": "…" }, … ] }
```

Node side: `crypto.createPrivateKey({ key: Buffer.concat([PKCS8_ED25519_PREFIX, seed]), format: 'der', type: 'pkcs8' })`
with `PKCS8_ED25519_PREFIX = 302e020100300506032b657004220420` (hex), then
`crypto.sign(null, msg, key)`. ≥ 12 vectors: `GET /v1/me`; `POST
/v1/layouts` with a JSON body; `PUT /v1/layouts/{id}` with body; `PATCH`;
`DELETE` no body; a path with a query (`/v1/layouts?liked_by=…&limit=5`);
a body with non-ASCII (`"name": "café"`); an empty-string body (`""`, hashes
as zero bytes — same as absent); `POST …/transfer`; `PUT …/like`; a
timestamp at `now + 300` (accepted) and one at `now − 300`; a 20-digit
actor. The workers test seeds a client with `k1`'s pubkey and a fixed
clock equal to each vector's timestamp.

| file (project) | asserts | invariant |
|---|---|---|
| `tests/auth/client.test.ts` (workers; fixed clock) | **every vector accepted** (`/v1/me` answers `via: client:<id>`, `user_id = actor`); **generated mutation matrix** over every vector × field ∈ {method, path, query (add `&x=1`), timestamp (±301 s → `stale_timestamp`; ±300 → accepted), nonce (reuse the previous vector's nonce → `replay`), one body byte, actor, signature byte, key (a second key's signature)} → the named 401/403, `layouts` and `events` unchanged (`canonical` of every row equal before/after); revoked client → `client_revoked` from the revocation on and `active` before; `act-as-owner-only` refuses a foreign actor and accepts the owner; both lanes on one request → 400; malformed headers (each of the five, each malformed one way) → `bad_signature`; the nonce table holds one row per accepted request and the nightly cron deletes rows older than 900 s and keeps newer; `gen-vectors.mjs --check` exits 0 | **LDB-A4**, **LDB-A8** (nonce single-use), LDB-A5 |
| `tests/api/write.test.ts` (extended) | the whole verb × actor matrix runs a second time on the client lane (a `signedFetch(vectorKey, actor, …)` helper); every 2xx event has `via = client:<id>`, `actor = X-Akl-Actor`; `followsUpstream` becomes false after a client-lane write (LDB-I2a holds for the new `via`) | **LDB-A5** (client half), LDB-I2a |
| `tests/api/clients.test.ts` (workers) | every admin client route × {anonymous 401, user 403, admin 2xx}; register → row + `admin.client_registered` event without the pubkey in `detail`; bad pubkey length → 400; revoke → `status revoked`, event; revoke twice → 200 no second event; `GET` lists both; a registered key signs a request that is accepted; the same key after revoke → 401 | LDB-A5 (admin half), **LDB-A9** (a revoked key is refused from the revocation onward, no cache) |
| `tests/api/ratelimit.test.ts` (extended) | 300 client-lane writes for 300 distinct actors pass, the 301st → 429 `scope: "client"`; 61 writes for one actor through the client → the 61st is 429 `scope: "actor"`; a bearer-lane write never touches `client:*` rows | **LDB-R7** |
| `tests/api/list.test.ts` (extended) | property: `liked_by=u` equals a JS filter over the seed's likes for every `u` in the seed, composed with every `sort` × `owner`/`has_magic`; unknown user → empty list; malformed → 400; `full=1&liked_by=` streams payloads | **LDB-R8** |
| `tests/api/conformance.test.ts` (extended) | the §6 pairs; the vectors' `k1` is the conformance client | LDB-P7, LDB-R3 |
| `tests/tools/runbook.test.ts` | no new binding (nothing to add; the test proves it) | LDB-G4 |

**DoD:** green; `npm run dev` + `bot/scripts/sign.mjs` (V3's signer, usable
standalone) → `curl` a signed `GET /v1/me` answers `via: client:…`; the
preview deploy (T7) has the migration applied and one client registered
(the bot's preview key). `02 §3.2`'s "the bot's Python client" sentence is
corrected to "the bot's TS client" in this PR.

### V1 — `bot/` skeleton

**Lands:** `bot/package.json` (`"type": "module"`; deps pinned at landing:
`discord.js ^14`, `@napi-rs/canvas ^0.1`, `dotenv ^17`; dev: `typescript
^5.9`, `vitest ^4.1` (the `db/` version — one vitest per repo), `esbuild
^0.25`, `fast-check ^4`), `tsconfig.json` (`strict`, `module: nodenext`,
`paths` for `@core/* → ../web/src/core/*` and `@formats/* → ../db/formats/*`
so the imports read as the packages they will become — `esbuild` resolves
them via `tsconfig`), `scripts`: `dev` (`node --env-file=.env --import tsx
src/main.ts` — **no**: tsx is one more dep; `dev` = `npm run build && node
--env-file=.env dist/main.js`), `build` (`esbuild src/main.ts src/engine/
worker.ts --bundle --platform=node --format=esm --target=node24
--outdir=dist --external:@napi-rs/canvas`), `test`, `typecheck`, `lint`
(the repo's eslint config). `src/main.ts` (gateway client, intents
`Guilds | GuildMessages | MessageContent | DirectMessages`; the message
router below; `help`), `src/config.ts` (env: `DISCORD_TOKEN`, `DB_BASE_URL`,
`SITE_BASE_URL`, `PREFIXES` (comma list, default `!spark`), `CLIENT_ID`,
`CLIENT_PRIVATE_KEY`, `DATA_DIR` (default `/data`), `TEST_GUILD_ID?`; every
one read in exactly one place, `config.ts`, and listed in `README.md`'s
table — LDB-B7), `Dockerfile` (`node:24-slim`, `npm ci --omit=dev`, `npm
run build`, `CMD node dist/main.js`), `fly.toml` (256 MB, one volume
`botdata` at `/data`, `auto_stop_machines = false` — a gateway bot must
stay up), `.github/workflows/bot.yml` (job `test` on PR/push under `bot/**`
+ `web/src/core/**` + `db/formats/**` — the bot's inputs; job `deploy`
`needs: test`, main + push only, `flyctl deploy --remote-only` with
`FLY_API_TOKEN`), `INVARIANTS.md`, `tests/tools/{boundary,invariants,
ciwiring,config}.test.ts`.

**The router** (cmini's `main.py`, ported): a message is a command iff
`args[0] ∈ PREFIXES` (case-sensitive, as cmini) or the channel is a DM (then
`args[0]` is the command); `command = args[1].toLowerCase()`; unknown →
`Error: <command> is not an available command`; bare prefix → ``Try `!spark help` ``
(the prefix substituted); bots ignored; the reply is sent with
`reference: message`. cmini's `RESTRICTED`/`CMINI_CHANNEL` DM redirection
is **not** ported (a `!spark` channel id is a saltorbit decision; every reply
goes where the command was typed — ledgered). Maintenance mode: `!spark
maintenance on|off` for admins (`GET /v1/admin/admins` cached 5 min tells the
bot who is admin — a signed read, the one exception to LDB-B3, made at boot
and on a 5-minute timer, never inside a verb).

| file | asserts | invariant |
|---|---|---|
| `tests/tools/boundary.test.ts` | every relative/`@core`/`@formats` import under `bot/src` resolves inside `bot/`, `web/src/core/`, or `db/formats/` — never `web/src/{data,state,ui,app}`, `db/src`, `scripts/`, `functions/`; and no file under `web/`, `db/`, `scripts/`, `functions/`, `workers/`, `tools/` imports a path containing `bot/` (the same regex scanner as `db/tests/tools/boundary.test.ts`, copied — LDB-G5's "nothing outside imports db/" gains the one named exception `bot/ → db/formats` in `db/INVARIANTS.md`'s row, and `db/tests/tools/boundary.test.ts`'s outside-scan gains `bot/` with `db/formats` allowed) | **LDB-B6** |
| `tests/tools/ciwiring.test.ts` | parses `bot.yml`: `test` job `working-directory: bot`, triggers' `paths` include the three cones, `deploy` needs `test`, main+push only, `flyctl` pinned to a major | **LDB-B8** |
| `tests/tools/config.test.ts` | every `process.env.X` under `src/` is read in `config.ts` only and appears in `README.md`'s table | **LDB-B7** |
| `tests/tools/invariants.test.ts` | LDB-T1's twin over `bot/INVARIANTS.md` × `bot/tests/**` | LDB-T1 (bot) |
| `tests/router.test.ts` | table: `!spark view x` in a guild → `view`, `["x"]`; `view x` in a DM → same; `!cmini view x` → ignored unless `PREFIXES` lists it; `!spark` alone → the Try line; `!spark nope` → the not-available line; a bot author → ignored | LDB-B1 (router rows) |

**DoD:** `cd bot && npm ci && npm test && npm run typecheck && npm run
build` green; `bot.yml` green on the PR; `node dist/main.js` with a real
token logs in and answers `!spark help` in the test server with cmini's
help layout (two columns, `ljust(16)`).

### V2 — the engine in Node

**Lands:** `src/engine/worker.ts`, `src/engine/host.ts`, `src/engine/compose.ts`,
`src/engine/site.ts`, `tests/engine/{protocol,numbers,site}.test.ts`.

**`worker.ts`** (bundled separately; runs in `new Worker(new URL('./worker.js', import.meta.url), { workerData: { siteBaseUrl } })`):

```ts
parentPort.on('message', async (msg) => {
  switch (msg.type) {
    case 'init':      // once: fetch wasm_exec.js + engine.wasm from siteBaseUrl/data/swap/, vm.runInThisContext(wasmExecText),
                      // new Go(), WebAssembly.instantiate, go.run, poll globalThis.swapengineReady; then ready() -> post {type:'ready', mana2Pin, statsVersion}
                      // failure -> {type:'error', error}  (id-less, exactly like web/swap-worker.js)
    case 'loadCorpus': // swapengine.loadCorpus(engine, corpus, space !== 'none', tables) -> {type:'corpusReady', engine, corpus, context} | {type:'error', error, corpus, engineName, context}
    case 'compute':    // swapengine.compute(engine, corpus, board, space, layoutJSON[, magicRulesJSON]) -> {type:'stats', reqId, ...cell} | {type:'error', reqId, error}
    case 'resolveMagicNgrams': // -> {type:'error', reqId, error: 'resolveMagicNgrams: extended tables not loaded'} in phase 4 (D4)
    default:           // ignored, as the site's worker does
  }
});
```

No coalescing (the host serialises through `withLock`). **`host.ts`** —
`createEngine({ siteBaseUrl, fetchImpl }): Engine`:
`createSwapEngine({ makeWorker: () => adapt(new Worker(...)), fetchText: url => fetchImpl(\`${siteBaseUrl}/${url}\`).then(text) })`
where `adapt(w): SwapWorkerLike` = `{ postMessage: m => w.postMessage(m),
addEventListener: (_, l) => w.on('message', d => l({ data: d })),
terminate: () => w.terminate(), set onerror(f) { w.on('error', f) } }`.
`Engine.compute(keys: Keys, cminiBoard: string, corpus: string):
Promise<Mana2Cell>` = `withLock(async () => { await ensure(); if
(!isCorpusLoaded('mana2', corpus, false)) await loadCorpus('mana2', corpus,
false, { context: CTX, tables: await fetchSwapTablesText('mana2', corpus,
false, loadText) }); return compute({ engine: 'mana2', corpus, context: CTX,
layout: swapLayoutPayload({ name, nativeBoard: cminiBoard, keys }) }); })`
with `CTX = { board: 'rowstag', space: 'none' }` (D5). `Engine.boot()`
loads every corpus in `defs.corpora` and asserts `ready().mana2Pin ===
build_id.mana2_pin && ready().statsVersion === build_id.stats_version`
(else throws `EngineSkew` with both — the `datasync` gate at boot).
`Engine.dispose()` terminates the worker; the host rebuilds on the next
call (the site's I-158 behaviour, inherited from `createSwapEngine`).

**`compose.ts`** — `cminiRow(cell, defs, board = 'rowstag')` =
`cminiStatsRowToFields(cminiRowFromMana2(cell, defs, cellHasThumb(cell), () => fingerIdx(defs)) ?? {}, board)`
— the site's `state/rowFields.ts:cminiCellToFields`, verbatim, with the
site's `getMana2Defs()` replaced by the fetched `defs`. **This is the only
composition function in the bot** (LDB-B5's "by construction" half:
`grep -rn cminiRowFromMana2 bot/src` hits `compose.ts` once —
`tests/engine/numbers.test.ts` asserts the grep).

**`site.ts`** — `fetchSiteAssets(siteBaseUrl, fetchImpl)` →
`{ defs, buildId, harvest: Map<corpus, Record<id, Mana2Cell>> }` from
`/data/mana2/defs.json`, `/data/mana2/build_id.json`,
`/data/mana2/<corpus>.rowstag.none.json` × `defs.corpora`; `refresh()`
re-fetches when `build_id.json`'s `code_hash`/`built_at` changed (10-min
timer, V3 wires it).

| file | asserts | invariant |
|---|---|---|
| `tests/engine/protocol.test.ts` | drives `worker.ts` through `createSwapEngine` against the real wasm (fetched from `SITE_BASE_URL`, default `https://akl.gg`, or read from `SITE_DATA_DIR` when set — one of the two must work, **no skip**): `init` → `ready` with the pins; `loadCorpus` for `reddit` → `corpusReady`; `compute(graphite)` → a `stats` reply whose `big[0]` equals `0.9701 ± 1e-4` (`smoke.js`'s own acceptance number) and whose cell equals `globalThis.swapengine.compute(...)` called directly in the test process on a second instance (same bytes in → same cell out — the protocol adds nothing); an unknown corpus → `error` with `reqId`; `resolveMagicNgrams` → the phase-4 error; a message with no `type` is ignored; a worker crash (`worker.terminate()` mid-request) rejects the pending promise and the next `compute` recovers | **LDB-B9** (the bot's worker answers every message type the site's driver sends, with the site's reply shapes) |
| `tests/engine/numbers.test.ts` | for **every** layout in `db/tests/fixtures/upstream-100/full.json` (read as a fixture file, LDB-B6 allows it) × **every** corpus in `defs.corpora` (13 × 100 = 1 300 computes ≈ 2 min): (a) `cell = engine.compute(keysFrom(detail), detail.board, corpus)`; (b) `harvestCell = harvest[corpus][detail.name.toLowerCase()]` from the **live site** (`SITE_BASE_URL`) — for the ids present there and whose site `modified_at` predates the site's `build_id.built_at` (read `/data/layouts.json`), every numeric field of `cell` equals `harvestCell`'s within relative `1e-9` (the deploy gate holds them to 1e-12; JSON adds nothing beyond double round-trip); (c) `cminiRow(cell, defs)` deep-equals `cminiRow(harvestCell, defs)` under the same tolerance — **the bot's numbers are the site's numbers**; (d) `grep` assertion above. Ids absent from the live harvest (renamed/deleted since the fixture) are listed in the test output and must number < 10, else fail (a drifted fixture, not a skipped test) | **LDB-B5** |
| `tests/engine/site.test.ts` | `fetchSiteAssets` against a recorded fixture server (the 13 harvest files trimmed to the 100 fixture ids, committed under `tests/fixtures/site/`): shapes; `refresh()` re-fetches iff `build_id` changed; `EngineSkew` thrown when `meta.json`'s pin ≠ `build_id`'s | LDB-B5 (boot half) |

**DoD:** green locally against `https://akl.gg`; in CI (`bot.yml`) the
same, real network, no skip (the `ci-gate-split-256` lesson — a
network-dependent test that fails is a red run, not a green one).

### V3 — the cache and the DB client

**Lands:** `src/cache/{store,boot,feed,cells}.ts`, `src/client/{sign,http,types}.ts`,
`scripts/{gen-key,sign}.mjs`, `tests/cache/*.test.ts`, `tests/client/sign.test.ts`.

**Cache** (`store.ts`): `records: Map<id, { record: RecordWire (03 §1, minus payload), payload: Akl1Payload, keys: Keys, likedBy: Set<user_id> }>`,
`byName: Map<lowercase name, id>`, `authors: { byName, byId }`,
`cursor: seq`. **Boot** (`boot.ts`): `GET /v1/dump/latest.json` → `GET
<url>` → gunzip (`node:zlib`) → for every non-deleted record:
`translate(rec, 'akl/1')` through `@formats` (`db/src/formats/registry.ts`
is `db/src` — not importable; the bot has its own 12-line `translateToAkl1(rec)`
calling `akl1.from[rec.format]` / identity, over `db/formats/{cmini,akl}/1`
— a held format is stored without keys and answers every verb with
``Error: `<name>` is in a format this bot cannot read (<format>) ``, a bot
string, ledgered); `likes` table → `likedBy`; `authors` → maps; `cursor =
dump.seq`. **Feed** (`feed.ts`): every 30 s `GET /v1/changes?since=<cursor>&limit=1000`
(with `If-None-Match` from the last `ETag` — a 304 is the quiet tick, one
request); per event: rev-bumping kind → `GET /v1/layouts/<layout_id>?as=akl/1`
(one GET per changed record; `deleted: true` → drop from `records`, keep the
id in a `tombstones` set for `!history`), `liked`/`unliked` → `likedBy` ±
actor, `like_count` from `after`; `renamed` → `byName` maintained; admin
events → refresh the admin set; `cursor = next`. A feed failure logs and
retries next tick (the cursor never advances past a failed GET).

**Superseded (D15, 2026-09-09): the 30 s poll above is gone.** `feed.ts`'s
`applyEvent`/`drainChanges` (the fold this paragraph describes) are
unchanged and still directly tested (LDB-B10) — only the PERIODIC CALLER
is retired. In its place: `cache/fresh.ts`'s `ensureFresh()` (one
conditional `GET /v1/meta`, folding `GET /v1/changes?since=<cursor>`
through `drainChanges` only when `seq` moved past the cache's own cursor)
runs before every read verb and is now the sole freshness guarantee
(LDB-B14) — a read verb's answer equals the DB's state at the moment it
ran, not a snapshot from whenever a poll last happened to land.
`cache/stream.ts`'s SSE `subscribe()` (`GET /v1/changes/stream`,
reconnecting with 1/2/4/8/16/30 s backoff, folding through the SAME
`applyEvent`) sits on top purely to keep `ensureFresh`'s own catch-up
almost always empty — losing the stream costs latency, never correctness,
so a stream failure is swallowed and retried rather than surfaced
anywhere. **Cells**
(`cells.ts`): `cellFor(id, corpus)` → harvest cell when `id`'s lowercase
name is in `harvest[corpus]` and `record.modified_at ≤ buildId.built_at`,
else memo `(id, rev, corpus)` → `engine.compute`. A rev-bumping event
deletes the id's memo entries. `rowFor(id, corpus)` = `cminiRow(cellFor(…))`.
`allRows(corpus)` for `rank`/`filter`: every record; the wasm part runs
under one lock and a `!rank` that needs > 50 wasm computes answers
`Computing <n> layouts, try again in a minute` (a bot string; ledgered) and
continues in the background — the site's harvest makes this the rare case
(only records changed since the nightly).

**Client** (`client/`): `sign.ts` — `signRequest(key: CryptoKey, clientId,
actor, method, url, body?: Uint8Array, now, nonce = randomBytes(16))` →
headers; Web Crypto (`crypto.subtle.importKey('pkcs8', …, { name:
'Ed25519' })`, `crypto.subtle.sign('Ed25519', …)`) so the same code would
run in a browser or Worker; `http.ts` — `dbFetch(method, path, { actor,
body?, as?, ifMatch? })` → parsed `{ status, body, etag }`; never a
bearer. **Superseded (D15, 2026-09-09):** `If-Match` is no longer never
sent — every mutating verb but `add` now fetches its record fresh and
sends the write with `If-Match` set to that fresh rev, unconditionally
(LDB-B2, extended); `dbFetch`'s own `If-Match` header is present iff a
caller supplies `opts.ifMatch`. `types.ts` — the wire types from `03`
(`RecordWire`, `Event`,
`ErrBody` with the phase-2 + C1 codes). `scripts/gen-key.mjs` (prints a
fresh seed/pubkey pair), `scripts/sign.mjs <method> <url> [body]` (prints
the five headers — the runbook's `curl` helper).

| file | asserts | invariant |
|---|---|---|
| `tests/cache/boot.test.ts` | from a recorded dump fixture (`tests/fixtures/db/dump.json.gz`, produced by `db/`'s own dump code over `upstream-100` — a `db/` test writes it, `db/tests/api/dump.test.ts` extended with `--write-bot-fixture`; committed): every live record present as `akl/1` with `keys`, tombstones absent, `likedBy` equals the dump's `likes`, `byName` case-insensitive, `cursor = dump.seq`; a `cmini/1` record and an `akl/1` record produce identical `keys` for the same layout | **LDB-B10** (cache = fold of dump + feed) |
| `tests/cache/feed.test.ts` | a fake DB (plain `fetchImpl`) serving `/v1/changes` pages + per-id details: every event kind from `03 §5` applied → the cache equals the fake's records; `next` chained across pages; a 304 makes no other request; a detail GET failure leaves `cursor` unchanged and the next tick retries; a `renamed` event frees the old name; `deleted` removes; `restored` re-adds with the same id | LDB-B10 |
| `tests/cache/cells.test.ts` | harvest hit iff name present and `modified_at ≤ built_at`; a rev-bumping event evicts; the memo key includes `rev`; `allRows` over the fixture equals per-id `rowFor` | LDB-B5 (cache half) |
| `tests/cache/readonly.test.ts` | with `fetchImpl` = `() => { throw }` after boot, every read verb (V5's list, called through the router with a fixture cache) answers without throwing and makes zero calls from its OWN body (the fake counts) — **superseded (D15): the WHOLE dispatch round trip (`ensureFresh()` then the verb) now costs exactly one conditional `GET /v1/meta` on a warm path; that whole-pipeline invariant moved to `tests/cache/fresh.test.ts`, LDB-B14** | **LDB-B3** |
| `tests/client/sign.test.ts` | reproduces every vector in `db/tests/vectors/client-signing.json` (read as a fixture) byte-for-byte: `signing_string` and `signature_b64url`; a test asserts `bot/tests/fixtures/client-signing.json` (the bot's committed copy) is byte-equal to the `db/` file while both live in this repo | **LDB-B4** |
| `tests/client/http.test.ts` | every `dbFetch` carries the five headers and `X-Akl-Actor = actor`; `Authorization` never present; a 429 body is surfaced as `{status: 429, retry_after}` — **superseded (D15): `If-Match` is present iff a caller supplies `opts.ifMatch`, asserted both ways** | **LDB-B2** (transport half) |

**DoD:** green; against the preview DB with the registered key: `node
scripts/sign.mjs GET https://akl-db-preview…/v1/me` → `curl` → `via:
client:…`; the bot boots, logs `cache: <n> records, cursor <seq>`, and a
`PUT …/like` made by hand through the preview shows up in the log —
**superseded (D15): "within 30 s" no longer applies (the poll it named is
gone); the SSE stream reflects it near-instantly when connected, and
`ensureFresh()` guarantees the NEXT read reflects it regardless**.

### V4 — the write verbs (parity, part 1)

**Lands:** `src/commands/{add,remove,rename,assign,setfingermap,swap!,cycle!,angle!,unangle!,mirror!,like,unlike}.ts`,
`src/render/{matrix,strings,find,grid}.ts`, `src/transforms.ts`,
`tests/parity/write.json`, `tests/parity-write.test.ts`,
`tests/render/{matrix,find,grid}.test.ts`.

Every command module exports `{ use(): string, desc(): string, exec(ctx):
Promise<string> }` — cmini's own module shape, and `help` renders them the
same way. `ctx = { args: string[], argText: string, codeBlock: string|null,
authorId, authorName, isDm, cache, engine, db, prefs }`.

**`render/matrix.ts`** — ports `util/layout.py`'s `get_matrix`,
`get_fingermatrix`, `get_commonmatrix` exactly (the Python is the spec;
copy it into the module's header comment): width = max col + 1, height =
max row + 1, cell `' '` default; `j == 0` → `'  ' + char`, `j == 4` → char
+ `' '`; board indents: `stagger` → row 1 `' '`, row 2 `'  '`; `angle` →
row 2 `' '`; `mini` → row 2 `'  '`; a row 3 → indent 6 when its first key's
finger is `LT` else 13 (`get_fingermatrix`: when the finger digit is `'8'`);
rows joined by `' '`. `FINGER_VALUES` = `CMINI_FINGER_VALUES` from
`core/export.ts` (`TB → '9'`). **`render/grid.ts`** — `toString(record,
row, corpus, likes)` = cmini's `to_string` minus the analyzer: 

```
```\n{name} ({author}) ({likes} like|likes)\n{matrix}\n\n{CORPUS}:\n{stats_str}```\n{x.cmini.link ?? ''}\n
```

`stats_str` is `util/layout.py:stats_str` with the composed row: `alternate
→ alt`, `roll-in → roll_in`, `roll-out → roll_out`, `oneh-in → oneh_in`,
`oneh-out → oneh_out`, `redirect → redirect`, `bad-redirect → bad_redirect`,
`sfb → sfb`, `dsfb-red → sfs_red`, `dsfb-alt → sfs_alt`, `LH → lh`, `RH →
rh`; Python's `{v:>6.2%}` ported as `pct(v, width, decimals)` (`'{:>6.2%}'.format(0.0123)` = `' 1.23%'`).
A row with `null` in any field (a pre-v6 cell) prints `   n/a`. The
`(magic rules not applied)` line (D4) follows the header when
`hasMagic(payload)`. **`render/find.ts`** — `find(name)`: exact
case-insensitive `byName`, else cmini's `memory.find` fallback verbatim:
candidates sorted by length, `argmin lev(filter(candidate.lower(), c ∈
name), name)` with Damerau–Levenshtein (a 25-line implementation in the
module; `jellyfish`'s `damerau_levenshtein_distance` is the *restricted*
DL — port that variant). `get(name)`: exact only (what `rename`/`remove`
use).

**`transforms.ts`** — `cycle(keys, cycles)`, `angle(keys, board)`,
`unangle(keys, board)`, `mirror(keys, board)` ported from the `modify()`
bodies quoted in §5, on the site's `Keys` (array of `{c,row,col,finger}`),
returning `{ keys, board }` or throwing `TransformError(cminiString)`.
Every string in §5's table.

**`!add`** (`commands/add.ts`): `parser.get_layout` → `name = args after the
command, joined with '-', lowercased`; `matrix = the first ``` block,
trimmed, lowercased`. `check_name` (`util/layout.py`, the same three rules
the DB's `check_name` ports; the bot prints the message **without** an
`Error: ` prefix here — `add.py` returns `ret.msg`), then the grid rules of
`add.py`: leading-space counts minus their min → `board` (`stagger` iff
`s0 < s1 < s2`; `mini` iff `s0 == s1 && s2 > 1`; `angle` iff `s0 == s1 < s2`;
`ortho` iff all equal; else `Error: board shape is undefined`); rows after
the first ≤ 3 (`ortho`/`mini`: ≤ 4) else `Error: improper number of rows in
layout definition`; columns by `zip_longest` with the gap rule (``Error:
missing gap before column `{col}` `` where `{col}` is Python's tuple repr
of the column, e.g. ``('a', 'b', 'c')`` — reproduce that repr); duplicate
char → ``Error: `{char} is defined twice` `` (cmini's misplaced backtick,
verbatim); `~` skipped; fingers `FMAP_STANDARD`/`FMAP_ANGLE` by
`min(j, 9)`, row 3 per D13. Body: `POST /v1/layouts { name, format: 'akl/1',
payload: { keys, free: [], board: { kind: word ∈ {stagger, angle} ? 'rowstag' : 'ortho', stagger: [0, 0.25, 0.75] for rowstag, cmini: word } } }`
(`01 §6.1`'s table). `201` → `Success!\n` + `toString(record, engine row,
corpus, 0)`; `409 name_taken` → ``Error: `{name}` already exists``; `400
invalid_name` → the DB's `message` (the bot's own three rules ran first, so
only the DB's two extra rules reach here — their messages are the DB's,
`09 §2.4`); other 4xx → `Error: ` + `message`.

| verb | `use()` | request | success reply | error → string (verbatim cmini) |
|---|---|---|---|---|
| `add` | `add [LAYOUT]` | `POST /v1/layouts` | `Success!\n` + to_string | above |
| `remove` | `remove [name]` | `DELETE /v1/layouts/{name}` (exact name; `get`) | ``` `{arg}` has been removed ``` | 404 / 403 → ``Error: you don't own any layout named `{arg}` `` (cmini conflated both) |
| `rename` | `rename [old_name] [new_name]` | `PATCH /v1/layouts/{old} { name: new }` | ``` `{old}` has been renamed to `{new}` ``` | bot pre-checks: `Error: names cannot start with an underscore` · `Error: names must be at least 3 characters long` · ``Error: names cannot contain `{c}` ``; 404 (old) → ``Error: `{old}` does not exist``; 409 `name_taken` → ``Error: `{new}` already exists``; 403 → ``Error: you don't own a layout named `{old}` `` |
| `assign` | `assign [LAYOUT] [AUTHOR]` | `POST /v1/layouts/{name}/transfer { to }` | `{name} has been assigned by {actor_name} to {target_name}` | not found → `{name} not found`; target unresolvable → `Error: invalid ID {target}` (numeric) / `Error: invalid name {target}`; 403 → `Unauthorized` (D11) |
| `setfingermap` | `setfingermap [layout name] [FINGERMATRIX]` | `PATCH /v1/layouts/{name} { fingermap, board? }` | `Success!\n` + `fingermap_to_string` | `Error: improper finger matrix shape provided` · `Error: board shape is undefined` · `Error: improper number of rows in matrix definition` · `No thumb values are allowed on rows 1-3.` · `Only thumb values are allowed on row {r+1}.` · `Error: cannot provide empty finger value for {key}` (all bot-side, cmini's order); 403 → ``Error: you don't own a layout named `{name}` `` |
| `swap!` / `cycle!` | `cycle! \| swap! [layout_name] [chars]` | local `cycle` then `PUT /v1/layouts/{id} { format: 'akl/1', payload }` | to_string + `Successfully updated!` | ``Error: couldn't find any layout named `{name}` `` · `Error: cannot swap letters that aren't in the layout` · `Error: cannot use duplicate letters in cycle command`; 403 → `Error: you don't own the layout {name}` |
| `angle!` | `angle! [layout_name]` | local `angle` then `PUT` | same | `Error: cannot angle mod mini layouts`; 403 as above |
| `unangle!` | `unangle [layout_name]` (cmini's own `use()` string, verbatim — it says `unangle`) | local `unangle` then `PUT` | same | 403 as above |
| `mirror!` | `mirror [layout_name]` (verbatim) | local `mirror` then `PUT` | same | 403 as above |
| `like` | `like [layout name]` | cache says already liked → no request; else `PUT /v1/layouts/{id}/like` | `You liked {name}. (Now at {n} likes)` | `You've already liked this layout` (bot-side); `400` (qwerty) → the DB's `message` = `You can't like Qwerty :yellow_circle:` |
| `unlike` | `unlike [layout name]` | symmetric | `You unliked {name}. (Now at {n} likes)` | `You've already unliked this layout` |

`{name}` in replies is the record's stored name (cmini printed `ll.name`);
`{actor_name}` is the cached authors name for the id, else the id. The
`PUT` payload for transforms is the cached `akl/1` payload with `keys` and
`board.cmini`/`board.kind` replaced (magic, `x`, `free` untouched). After
any 2xx the bot applies the response record to the cache immediately (`05
§4`: `!add` then `!view` in the same second works) — the feed's later
event for the same `rev` is a no-op.

| file | asserts | invariant |
|---|---|---|
| `tests/parity-write.test.ts` | **data-driven from `tests/parity/write.json`**: rows `{ id, setup: { records, likes, authors, actor }, message, expect: { reply, request?: { method, path, body?, actor } } }` — one row per cell of the table above (every success and every error string, 41 rows at landing), run against a fake DB whose responses come from the row (`setup`) so the test asserts the bot's *request* (method, path, body deep-equal, `X-Akl-Actor`) and its *reply* byte-for-byte; plus a second run of every row that makes a request against **miniflare with the real DB** (`db/`'s built Worker, started by the test via `wrangler dev --local` from `../db` — the one place the bot's tests touch `db/` code, as a black box over HTTP) with the vectors' client registered, asserting the same replies | **LDB-B1** (write half), **LDB-B2** (every request's `X-Akl-Actor` equals the message author — asserted on every row that has a request) |
| `tests/render/matrix.test.ts` | goldens: for every `upstream-100` layout with a board word, `getMatrixStr` equals a committed golden produced **once** by running cmini's `util/layout.get_matrix_str` over the same fixtures (`tests/fixtures/cmini-matrix/<id>.txt`, generated by `scripts/gen-cmini-goldens.py` — a 30-line script that imports the vendored `util/layout.py` from `git show a5b0fe35^` into a temp dir; run once, committed, never regenerated: the goldens are the spec, the script is how they were made) | **LDB-B1** (render half) |
| `tests/render/find.test.ts` | table: exact, case-insensitive exact, cmini's fuzzy picks for 10 misspellings recorded from the Python (`gen-cmini-goldens.py` prints them) | LDB-B1 |
| `tests/render/grid.test.ts` | the `add` parser over 12 grids (stagger/angle/ortho/mini, a thumb row left and right, every error) → keys deep-equal a golden produced by the vendored `add.py` **except the thumb column, pinned to the absolute rule (D13)**; `stats_str` formatting over a fixed row equals the Python's output (golden) | LDB-B1 |
| `tests/transforms.test.ts` | property: `cycle` twice with the reversed cycle is identity; `angle` then `unangle` is identity on a stagger layout; `mirror` twice is identity; every error string; the `graphite` fixture through each transform equals the vendored Python's output (golden) | LDB-B1 |

**DoD:** green; in the test server against the preview DB: `!spark add`
of a fresh grid → `Success!` and the record is visible on `/v1/layouts/
<name>`; `!spark swap! <it> ab` → updated; `!spark remove <it>` → removed;
every reply matched against the parity table by eye once.

### V5 — the read verbs (parity, part 2)

**Lands:** `src/commands/{view,fingermap,compare,mod,swap,cycle,angle,unangle,mirror,rank,filter,search,homerow,list,likes,authors,corpus,random,stats,sfbs,sfs,rolls,inrolls,outrolls,alternates,redirects,onehands,pattern,fingers,fspeed,freq,freqd,freqs,examples,help}.ts`,
`src/render/text.ts`, `src/prefs.ts`, `tests/parity/read.json`,
`tests/parity-read.test.ts`.

Groups, and what each reads:

- **row verbs** (`view`, `random`, `compare`, `mod`, `swap`, `cycle`,
  `angle`, `unangle`, `mirror`, `fingermap`): `rowFor(id, corpus)` /
  `engine.compute` for transforms (`name + ' (modified)'` /
  `' (angle modded)'` / `' (non angle modded)'` / `' (mirrored)'`,
  cmini's suffixes); `compare` prints `get_commonmatrix_str` and
  `stats_str` over the field-wise difference (`new − old`) — port `compare.py`.
- **catalog verbs** (`rank`, `filter`, `search`, `homerow`, `list`, `likes`,
  `authors`, `stats`): `allRows(corpus)` / the cache. `rank`'s `STATS`
  table and aliases verbatim (`rank.py`; note `sfb` is halved there —
  reproduce, it is what `!cmini rank sfb` printed); `filter`'s kwargs
  parser = `util/parser.py:get_kwargs` ported (the `--`/`—`/`––` prefixes,
  `Error: invalid kwarg: `x``), its metric comparisons (`compare_with_str`
  strings), `is_similar` = Jaro–Winkler > 0.7 (a 40-line port); `list
  [username]` → cache authors + `GET`-free (`owner = id` over the cache);
  `likes` → the cache's `likedBy` (the DB's `liked_by` filter exists for
  other clients; the bot has the data locally — LDB-B3); `stats` → counts
  from the cache + `Top Corpora` from `prefs`.
- **n-gram verbs** (`sfbs`, `sfs`, `rolls`, `inrolls`, `outrolls`,
  `alternates`, `redirects`, `onehands`, `pattern`, `fingers`, `fspeed`,
  `freq`, `freqd`, `freqs`, `examples`): the corpus tables the bot already
  fetched (`ngrams/<corpus>.json`'s `monograms`/`bigrams`/`trigrams`) and
  `/data/words/<corpus>.json` (fetched lazily, once per corpus) — the
  wording, columns and `.3%` formats are cmini's (`sfbs.py` etc. quoted in
  §5); the **classification** is the site's `core/stats/mana2-partitions.ts`
  (mana2's taxonomy — the same one the site's popovers show), not
  `table.json` (cmini's analyzer is gone with #214, and its corpus
  `mt-quotes` never existed on the site). This is the one place parity
  is *format* parity, not *number* parity, and `tests/parity/read.json`
  says so per row (`"numbers": "site"`). `fingers`/`fspeed` print the
  composed `fingers` table (use/fsp/wfsp per finger — `fspeed.py`'s
  `--stagger/--kps/…` flags are **not** ported; `!spark fspeed x` prints
  the site's board-aware fspeed, flags answer `Error: fspeed options are
  not supported; the numbers are akl.gg's` — a bot string, ledgered).
- **`corpus`**: `!corpus` lists `defs.corpora` (cmini's list format);
  `!corpus x` sets `prefs[authorId] = x` on the volume, `Your corpus
  preference has been changed to `x`.`; unknown → `The corpus `x` doesn't
  exist.`
- **`help`**: cmini's, over the registered modules.

| file | asserts | invariant |
|---|---|---|
| `tests/parity-read.test.ts` | data-driven from `tests/parity/read.json`: rows `{ id, verb, args, cache: "upstream-100", corpus, expect: "<golden file>" | "<inline>", numbers: "cmini" | "site" }`; goldens under `tests/fixtures/replies/<id>.txt`. **How the goldens were made, per row:** `numbers: "cmini"` rows (view/fingermap/compare/mod/transforms/list/likes/authors/help/corpus/random-with-seed — the layout-shape and social verbs) are produced by running the vendored Python over the same fixtures with the cmini analyzer's *numbers* replaced by the bot's composed row (`gen-cmini-goldens.py` monkeypatches `util.analyzer` to read `tests/fixtures/rows/<corpus>/<id>.json`, which V2's `numbers.test.ts` writes) — so the *format* is provably cmini's and the *numbers* are provably the site's; `numbers: "site"` rows (rank/filter/search/homerow/n-gram verbs) are recorded from the bot's first run and reviewed by hand against the same command on cmini for shape. Every row's reply must equal its golden byte-for-byte; a changed golden is a documented change (the `frozen.test.ts` idea: `git diff --name-only origin/main -- tests/fixtures/replies` must be empty or the PR says why) | **LDB-B1** (read half), LDB-B3 |
| `tests/render/kwargs.test.ts` | `get_kwargs` port: the docstring example and 8 more (em-dash prefix, unknown kwarg error string, list vs str vs bool, trailing list) | LDB-B1 |
| `tests/prefs.test.ts` | `prefs` round-trips through the file; a missing file is empty; a corrupt file is renamed aside and logged, never crashes | LDB-B11 (prefs survive a restart; a bad file never takes the bot down) |

**DoD:** green; the manual transcript (V6) covers every verb here.

### V6 — the image verb, the new verbs, the transcript

**Lands:** `src/commands/{image,magic,history,link}.ts`, `src/render/image.ts`,
`tests/render/image.test.ts`, `tests/transcripts/`.

- `!spark image [name]`: `src/render/image.ts` builds an `ImagePlan`
  (`core/copyimage/types.ts`) for the standalone card — keys, the composed
  row, `hasSwapList: false`, `cmpBase: null`, the corpus label, magic
  caption from `magicCaptionModel(payload.magic)` — and paints it with
  `drawImage(ctx, plan, { activeFingerColors: () => FINGER_COLORS,
  keyTextColor })` on `@napi-rs/canvas` (`createCanvas(CARD_W * 2, h * 2)`,
  dpr 2); fonts: `GlobalFonts.registerFromPath` for two files shipped in
  `bot/fonts/` (Liberation Sans + DejaVu Sans Mono, both OFL/GPL-with-font-
  exception — MIT-compatible distribution; the CSS stacks in `copy/copyimage.ts`
  are matched by registering the files under the stack's first family
  names). The PNG goes out as an attachment with the `to_string` header
  line as the message.
- `!spark magic [name]`: `magicCaptionTextLines(payload.magic)`
  (`core/rules.ts`) inside a code block; raw rules (`magic.rules`) listed
  as `inputs → output (type)`; no rules → `` `{name}` has no magic rules ``.
- `!spark history [name]`: the last 5 events from `GET /v1/layouts/{id}/history`
  — **a read that is not cache-only**, the one deliberate exception to
  LDB-B3 besides the admin poll, because history is not in the dump's hot
  set the bot keeps (it is in the dump; the bot does not index it — a
  memory decision). Rendered `{at} {kind} by {actor name} via {via}`.
- `!spark link [name]`: `SITE_BASE_URL/#` + the site's hash for "open this
  layout" — `encodeStateHash({ ... })` from `core/codec.ts` with the state
  the site's own "copy link" produces (the exact `HashState` fields are
  read off `web/src/state/urlstate.ts` at implementation time and pinned by
  a test that decodes the produced hash with `decodeStateHash`).

| file | asserts | invariant |
|---|---|---|
| `tests/render/image.test.ts` | determinism: two renders of the `graphite` plan are byte-equal PNGs; the plan for every `upstream-100` layout builds without throwing and its height equals `plan.cardH` (the measurement half of `image.ts` is reproduced, not imported); a committed PNG for `graphite` and one thumb layout, compared byte-for-byte (regenerated only with the PR saying why) | **LDB-B12** (the image is a pure function of the plan) |
| `tests/commands/link.test.ts` | `decodeStateHash(linkFor(record))` names the record's lowercase name as the selected layout | LDB-B1 |
| `tests/transcripts/` | `transcript-<date>.md`: every verb once in the test server, saved by hand after V6's manual pass; a later pass diffs against it (a document, not a test — the parity tests are the tests) | — |

**DoD:** green; the transcript exists; `!spark image graphite` in the test
server shows the site's card.

### V7 — deploy (saltorbit runs the production half)

1. `fly launch --no-deploy` in `bot/` (saltorbit), `fly volumes create botdata --size 1 --region <same as the machine>`, `fly secrets set DISCORD_TOKEN=… CLIENT_PRIVATE_KEY=… CLIENT_ID=…` — preview first (`DB_BASE_URL` = the preview DB, `SITE_BASE_URL=https://akl.gg`).
2. The preview key is already registered (V3); the **production** key is registered by saltorbit through `POST /v1/admin/clients` with his bearer once phase 3's proxy exists, or by `db/scripts/register-client.mjs` (C1 adds it: signs with an admin's client key — a chicken-and-egg only for the first client, which an admin registers with `wrangler d1 execute --remote` once; the runbook says so).
3. `bot.yml`'s `deploy` job on `main`; `fly scale memory` only after measuring: `fly logs` for OOM restarts during the transcript pass; the README records the measured peak RSS (`05 §5`).
4. README runbook: key rotation (register new → `fly secrets set` → revoke old), redeploy, logs, the volume, `EngineSkew` at boot (the site deployed a new pin — redeploying the bot is *not* needed, it fetches at boot; a restart is: `fly machine restart`).
5. ⚠ `DB_BASE_URL` → the production DB, and the `!cmini` transition — **saltorbit**.

## 5. cmini's strings and rules the parity contract needs (extracted from `a5b0fe35^:vendor/cmini-analyzer`, 2026-09-09)

Reproduced here so the agent never guesses. `{x}` are Python f-string
substitutions; backticks are literal.

**`util/consts.py`:** `TRIGGERS = ['!amini', '!bmini', '!cmini', '!dvormini', '!cnini']`; `NAME_SET = ascii_letters + digits + " _-'():~"`; `FREE_CHAR = '~'`; `FMAP_STANDARD = ['LP','LR','LM','LI','LI','RI','RI','RM','RR','RP']`; `FMAP_ANGLE = ['LR','LM','LI','LI','LI','RI','RI','RM','RR','RP']`; `FINGER_VALUES = {LP:'0', LR:'1', LM:'2', LI:'3', RI:'4', RM:'5', RR:'6', RP:'7', LT:'8', RT:'9', TB:'9'}`.

**`util/layout.py:check_name`:** `names cannot start with an underscore` · `names must be at least 3 characters long` · ``names cannot contain `{disallowed[0]}` `` (returned as `Error(msg)`; `add.py` prints `msg`, `rename.py` prints `Error: ` + its own copy).

**`util/layout.py:get_matrix`** (the display shape; port verbatim):

```python
max_width = max(x.col for x in ll.keys.values()) + 1
max_height = max(x.row for x in ll.keys.values()) + 1
matrix = [[' '] * max_width for _ in range(max_height)]
for char, info in ll.keys.items(): matrix[info.row][info.col] = char
for i, row in enumerate(matrix):
    for j, char in enumerate(row):
        if j == 0: matrix[i][j] = '  ' + char
        elif j == 4: matrix[i][j] += ' '
if ll.board == 'stagger': matrix[1][0] = ' ' + matrix[1][0]; matrix[2][0] = '  ' + matrix[2][0]
elif ll.board == 'angle': matrix[2][0] = ' ' + matrix[2][0]
elif ll.board == 'mini':  matrix[2][0] = '  ' + matrix[2][0]
if len(matrix) > 3:
    indent = 6 if ll.keys[matrix[3][0].strip()].finger == 'LT' else 13
    matrix[3][0] = ' ' * indent + matrix[3][0]
# get_matrix_str = '\n'.join(' '.join(x) for x in matrix)
```

`get_fingermatrix` is the same with `FINGER_VALUES.get(finger, finger)` in
the cells and `indent = 6 if matrix[3][0].strip() == '8' else 13`;
`get_commonmatrix(ll1, ll2)` fills `char1 if char1 == char2 else '~'`, board
indents only when both boards agree, thumb indent 6 if either first key is
`LT`.

**`util/layout.py:stats_str`** (the `view` body):

```python
(f' {"Alt:":>5} {stats["alternate"]:>6.2%}\n'
 f' {"Rol:":>5} {stats["roll-in"] + stats["roll-out"]:>6.2%}   (In/Out: {stats["roll-in"]:>6.2%} | {stats["roll-out"]:>6.2%})\n'
 f' {"One:":>5} {stats["oneh-in"] + stats["oneh-out"]:>6.2%}   (In/Out: {stats["oneh-in"]:>6.2%} | {stats["oneh-out"]:>6.2%})\n'
 f' {"Rtl:":>5} {stats["roll-in"] + stats["roll-out"] + stats["oneh-in"] + stats["oneh-out"]:>6.2%}   (In/Out: {stats["roll-in"] + stats["oneh-in"]:>6.2%} | {stats["roll-out"] + stats["oneh-out"]:>6.2%})\n'
 f' {"Red:":>5} {stats["redirect"] + stats["bad-redirect"]:>6.2%}   (Bad: {stats["bad-redirect"]:>9.2%})\n'
 '\n'
 f' {"SFB:":>5} {stats["sfb"]:>6.2%}\n'
 f' {"SFS:":>5} {stats["dsfb-red"] + stats["dsfb-alt"]:>6.2%}   (Red/Alt: {stats["dsfb-red"]:>5.2%} | {stats["dsfb-alt"]:>5.2%})\n'
 '\n'
 f'  LH/RH: {use["LH"]:.2%} | {use["RH"]:.2%}')
```

`to_string` wraps: `` ```\n{name} ({author}) ({likes} {like|likes})\n{matrix}\n\n{CORPUS}:\n{stats_str}```\n{external_link}\n ``; `like` when `likes == 1`.

**Transforms (`modify()` bodies; `keys` is char → `{row, col, finger}`):**

- `cycle` (`cycle.py`): every char of every cycle must be a key (`Error: cannot swap letters that aren't in the layout`); a cycle with a repeated char → `Error: cannot use duplicate letters in cycle command`; for each cycle `cmap = zip(cycle, cycle[1:] + cycle[0])`, `keymap = {k: keys[k]}`, `keys[key] = keymap[cmap[key]]` (positions rotate forward).
- `angle`: `board == 'mini'` → `Error: cannot angle mod mini layouts`; if `board != 'angle'`: for every key with `row == 2` and `col < 5`: `col == 0` → `col = 4, finger = 'LI'`, else `col -= 1`; then `board = 'angle'`.
- `unangle`: only if `board == 'angle'`: `board = 'ortho'`; for `row == 2 && col < 5`: `col == 4` → `col = 0, finger = 'LP'`, else `col += 1`.
- `mirror`: `angle_mod = board == 'angle'`; for every key with `col < 10`: if `row != 3` → `col = 9 − col`; `finger`: `L→R`, `R→L`, `TB → 'LT'`; if `angle_mod && row == 2`: `col == 0` → `col = 4, finger = 'LI'`; `col == 5` → `col = 9, finger = 'RP'`; else `col -= 1`.

**Verb strings not in §4's table:** `view` (`use`: `view [name]`); `fingermap` (`fingermap [layout_name]`, body = `fingermap_to_string`: header, matrix, blank, finger matrix); `compare [new_layout] [old_layout]` — `'`compare [new_layout] [old_layout] (new - old)`'` when no args, `Error: missing old layout name`, `Error: could not find layout(s)`, header `{new}(new) - {old}(old)`; `mod layout_name [--kwarg1, …]` (its multi-line `use()` verbatim); `rank [metric]\nSupported rank stats:\nalt sfb sfs red oneh inroll outroll roll inrollratio outrollratio inrolltal outrolltal rolltal`, `Error: Invalid starting index`, `Error: Cannot rank ascending and descending altogether`, `{stat} not supported`, lines `{index}: {value:.2%} -- {name}` under `{CORPUS}`; `filter`'s `use()`/`desc()` blocks verbatim, `No matches found`, `I found {n} matches, here are {all|k} of them:`; `search`'s `use()` verbatim, `The --vowel flag should be used with sfb arg(s).\n`; `homerow [string]`, `I found {n} matches{, here are {k} of them}`; `list [username]`, `{name}'s layouts:`, `... ({n} more)` past 100, ``Error: user `{arg}` does not exist``; `likes` → `{name}'s liked layouts:` + ` - {layout}` lines; `authors` → `Layout Creators:`; `corpus [corpus_name]` → `List of Corpora:` + `- {x}`; `stats` → the `--- CMINI STATS ---` block (title kept — it is what the command printed; **copy question for saltorbit**: `--- AKLGG STATS ---`?); `sfbs [layout name]` → `Top 10 {name} SFBs:` + `{gram:<6} {pct:.3%}` + `Total: {pct:.3%}`; `sfs`/`rolls`/`inrolls`/`outrolls`/`alternates`/`redirects`/`onehands` → `Top 10 {name} {SFS|Rolls|Inrolls|Outrolls|Alternates|Redirects|Onehands}:` + `{gram:<5} {pct:.3%}`; `pattern [layout name] [finger string]` → `Please provide a layout` · `Please provide finger values (e.g., LI, _, LI|RR)` · `Please provide no more than 3 finger values` · `Please provide valid finger values (e.g., LI, _, LI|RR)` · `Top {n} {name} Patterns for {A-B-C}:` + `Total {pct:.3%}`; `freq [ngrams ...]` → `Please provide at least 1 ngram between 1-3 chars` · `Please provide no more than 6 ngrams` · `All ngrams must be the same length` · `` `{query}` not found in corpus `{corpus}` `` · `{item}: {pct:.2%}` · `Total: {pct:.2%}`; `freqs`/`freqd` (their headers verbatim from the files); `examples [some_str]` → `Examples of `{part}` in {CORPUS}:`, `{total} / {all} words ({pct:.3%})`, `{item:<15} {"(" + count + ")":>6}`, ``Error: `{part}` does not appear anywhere in this corpus``; `help` → `Help page for `{cmd}`:` / `Unknown command `{cmd}`` / `Usage: `!spark (command) [args]`` (prefix substituted) + two `ljust(16)` columns.

## 6. Conformance enumeration added by C1 (for `db/`'s T6 sweep)

| route | 2xx | errors |
|---|---|---|
| every authenticated route (client lane) | as bearer | 401 `unknown_client`, 401 `client_revoked`, 401 `stale_timestamp`, 401 `replay`, 401 `bad_signature`, 403 `actor_not_allowed`, 400 `bad_request` (both lanes), 429 (`scope: client`) |
| `GET /v1/me` (client lane) | 200 `via: client:<id>` | the row above |
| `POST /v1/admin/clients` | 201 | A, 400, 403, 429 |
| `DELETE /v1/admin/clients/{id}` | 200 · 200 (idempotent) | A, 403, 404, 429 |
| `GET /v1/admin/clients` | 200 | A, 403 |
| `GET /v1/layouts?liked_by=` | 200 (list · `full=1`) | 400 `bad_request` |

## 7. Invariants added (phase 4)

`db/INVARIANTS.md` gains: **LDB-A4** (as `02 §6`, enforced by `tests/auth/client.test.ts`), **LDB-A5** (client half, `tests/api/write.test.ts` + `clients.test.ts`), **LDB-A8** (a nonce is accepted once; the PK insert is the check; pruned after 900 s), **LDB-A9** (a revoked key is refused from the revocation onward — no cache in front of `clients.status`), **LDB-R7** (client-lane writes are limited to 300 / 10 min per client on top of the actor limit; the 429 names its scope), **LDB-R8** (`liked_by` equals a filter over `likes`). `LDB-G5`'s row gains the `bot/ → db/formats` exception.

`bot/INVARIANTS.md` (rows for `bot/tests/tools/invariants.test.ts`):

| id | invariant | enforced by |
|---|---|---|
| LDB-B1 | Every parity-table row (verb × case) renders cmini's string byte-for-byte; matrices, transforms and the `add` grid equal goldens made from cmini's own code | `tests/parity-{write,read}.test.ts`, `tests/render/*.test.ts`, `tests/transforms.test.ts` |
| LDB-B2 | Every write the bot makes carries `X-Akl-Actor = message.author.id`; there is no code path that writes as anyone else (`grep -rn "X-Akl-Actor" src/` hits `client/sign.ts` once) | `tests/parity-write.test.ts`, `tests/client/http.test.ts` |
| LDB-B3 | A read verb performs no HTTP request; the only non-verb requests are the feed tick, the admin poll, `history`, and boot | `tests/cache/readonly.test.ts` |
| LDB-B4 | The bot reproduces every vector in `client-signing.json`; the two copies are byte-equal | `tests/client/sign.test.ts` |
| **LDB-B5** | **The bot's numbers are the site's numbers:** for every `upstream-100` layout × every corpus, the bot's cell equals the deployed site's harvest cell (rel 1e-9) and the composed cmini row equals the same composition over the harvest cell; the bot boots only when the wasm's pin equals the harvest's; `cminiRowFromMana2` is called from exactly one bot module | `tests/engine/numbers.test.ts`, `tests/engine/site.test.ts`, `tests/cache/cells.test.ts` |
| LDB-B6 | `bot/` imports only `web/src/core/**` and `db/formats/**` from this repo (by path until the packages exist); nothing imports `bot/` | `tests/tools/boundary.test.ts` (+ `db/tests/tools/boundary.test.ts`'s outside-scan) |
| LDB-B7 | Every env var is read in `config.ts` only and documented in the README table | `tests/tools/config.test.ts` |
| LDB-B8 | `bot.yml`: test on PR/push under the bot's three input cones; deploy needs test, main + push only | `tests/tools/ciwiring.test.ts` |
| LDB-B9 | The bot's worker answers every message type the shared driver sends with the site's reply shapes; a compute reply equals a direct wasm call | `tests/engine/protocol.test.ts` |
| LDB-B10 | The cache equals the fold of the dump and the feed (every event kind applied as `03 §5` defines) | `tests/cache/{boot,feed}.test.ts` |
| LDB-B11 | Preferences survive a restart; a corrupt prefs file never prevents boot | `tests/prefs.test.ts` |
| LDB-B12 | The image is a pure function of the plan (byte-equal across renders) | `tests/render/image.test.ts` |

## 8. Cut from the round-1 draft (and why)

- **`worker_threads` running `web/swap-worker.js`** — needs three global
  shims; the protocol is the shared thing (D1).
- **Shipping the wasm + tables in the image** and the "fetch with fallback
  snapshot" proposal — two engines is one way to drift (D2).
- **Computing every catalog layout at boot** — 78 minutes; the site's
  harvest is the same engine's output and already gated (D3).
- **Magic-resolved compute** — 115 MB of tables on a 256 MB machine (D4).
- **"Same pixels as the site"** — not achievable across rasterizers (D7).
- **The DB's `message` as the parity string** — cmini has three not-owner
  strings; the bot owns its strings (D6).
- **`RESTRICTED`/DM redirection, `xkb`, `gen`, `link`/`unlink`, the
  minigames, `fspeed`'s flags** — D12, V8.
- **`corpus.json` / `mana2-corpora-extended` / `web/lib/*.wasm`** — did
  not exist; §0 has the real paths.

## 9. Questions only saltorbit can answer

1. **Prefix and the `!cmini` transition** (`05 §8` Q1): `!spark` only, or
   both for a period? (`PREFIXES` is a one-line change either way.)
2. **A dedicated channel?** cmini redirected long replies to DMs outside
   `#cmini`; the port answers in place (V1). Fine, or name a channel id?
3. **Copy in replies that names cmini:** `--- CMINI STATS ---`, `Usage:
   `!cmini (command) [args]``, and the `Examples of … in MT-QUOTES` header
   family — keep verbatim (parity) or rebrand? Everything else prints the
   configured prefix.
4. **Production key registration** (V7 step 2) and **`DB_BASE_URL` →
   production** (V7 step 5) are yours.
5. **The `assign` superset** (D11: owner-transfer, not admin-only) — fine?
6. **Open finding, 2026-09-09 (V2's numbers.test.ts, LDB-B5):** a specific
   10-layout subset — `shale`, `slate`, `marble`, `onyx`, `kormite`,
   `neon`, `tenders`, `jeep`, `tomato`, `graphite-vimified` (`bot/tests/
   engine/numbers.test.ts`'s `HARVEST_DRIFT_OPEN`) — computes a
   *different* mana2 cell (every field: hb/big/skip/tri/trin/trix/fu/fsp/
   fspw, not just hand-balance) through the bot's wasm path than the
   deployed harvest reports, on every corpus, well past 1e-9. None are
   magic layouts (that's the separate, understood D4 case `opal` surfaced).
   Keys are byte-identical between the fixture, the live site's own
   `/data/layouts_keys.json`, and what the bot sends the wasm; no negative
   columns; `ConvertLayout`'s own doc comment says cmini's board word is
   ignored for wasm geometry (`PhysicalThumbSide`/`MirrorThumbCol` both
   ignore their `board` parameter too) — so it isn't a bot-side "wrong
   board string" bug, and `LDB-B9`'s protocol-identity test plus the other
   89% of the fixture (including other thumbed, non-'angle' layouts)
   confirms the compute PATH is correct. Most (not all — `graphite-
   vimified` is `ortho`) of the ten are cmini's legacy `angle` board word
   with a real thumb key. The site's own deploy gate
   (`tools/swapengine/engine/compute_test.go:TestComputeMana2MatchesHarvest`)
   doesn't cover any of these ten ids, so it hasn't validated this case
   either way. Best remaining lead: `tools/mana2bridge/harvest.go` builds
   the harvest by shelling out to the real mana2 CLI — a different code
   path from the wasm's `ConvertLayout`+`compute` this bot calls — worth
   comparing directly. `numbers.test.ts` carries the exclusion with a
   second `it` that fails the moment any listed id stops mismatching (so
   the list can't go stale) or a listed id isn't in the fixture at all;
   remove ids from `HARVEST_DRIFT_OPEN` as this gets root-caused.

## 10. What can start when

- **Now, no prerequisites:** U1, U2 (site PRs); V1 (skeleton); V2 (needs
  U1 merged — or a branch with it; the engine tests run against
  `https://akl.gg` today).
- **When `09` T1 + T2 are on the branch:** C1 (the two-lane `resolveActor`
  and `via: actor.via`); V3's cache half needs only phase 1 (`/v1/dump`,
  `/v1/changes` — S4/S7); V3's client half needs C1 for its live check.
- **When T7 (preview) + C1 are deployed:** V4 (write verbs against the
  preview DB), V5, V6.
- **Blocked on saltorbit:** V7's production steps; §9.
