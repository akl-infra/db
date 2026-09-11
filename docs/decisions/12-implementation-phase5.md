# Implementation — phase 5, open it up

Status: plan, round 2 (2026-09-09; the round-1 draft reviewed against the
phase-1–4 code on `worktree-layout-db` at T7/C1/V2, mana2's own layout
loader (`vendor/mana2/core/load_layout.go`), the site's cmini→mana2
converter (`tools/mana2bridge/bridgecore/convert.go`), Cloudflare's
published limits, and a measured run of the D12 diff over the live
4174-layout body; rewritten as closed briefs). Part of `00-plan.md` (§5
phase 5). Written like `07`/`09`/`10`/`11`: every slice names its files,
signatures, SQL, bodies, error rows, tests and the `LDB-*` ids those tests
enforce, so a strong-but-literal coding agent can land it from this
document alone. **Every step that touches production, an account, a
registry or a repo is marked ⚠ and is saltorbit's.**

Decisions not reopened here: the feed is truth and webhooks are a nudge
(P5/D8, LDB-P3); no Cloudflare Queues (paid add-on; the 1-minute cron is
the retry scheduler); the stream is polling-backed inside the request;
`mana2/1` is a registered format with `to`/`from` `akl/1`; the split is
saltorbit's; no prod flips by agents; `appendWrite` is the only writer of
`layouts`/`layout_revs`/`events`.

## 0. Measured facts (2026-09-09) — every brief below cites this table

### 0.1 Platform limits (Cloudflare docs, read 2026-09-09)

| limit | value | consequence |
|---|---|---|
| CPU per invocation | **Free: 10 ms. Paid: 30 s default, up to 5 min** (`workers/platform/limits`) | the import's daily full pass already parses a 5.3 MB body (0.3 measured 264 ms CPU in Node) — impossible under 10 ms, so the `akl` account is on **Workers Paid** as `07 §1` decided (`08 §1`'s "free tier" row is stale; Q1 confirms). Phase 5's stream (§2.2) and diff cron (0.3) both need Paid |
| HTTP request wall-clock | "No limit" while the client stays connected; `ctx.waitUntil()` gets **30 s after the response** (shared across all `waitUntil` calls of one request; unsettled promises are cancelled) | the SSE stream runs as long as the client reads; a webhook nudge from `waitUntil` has 30 s, so one nudge posts a bounded batch and leaves the rest to the cron |
| Cron Triggers | **15 min wall-clock** per scheduled invocation; scheduled handlers get an `ExecutionContext` too | the diff cron (0.3: ≈ 5 s wall) and the 1-minute webhook drain both fit with two orders of magnitude to spare |
| Subrequests | Free 50 / Paid 10 000 per invocation; **6 simultaneous** connections waiting for headers | a drain posts sequentially per hook; ≤ 25 POSTs per invocation (§2.1 step 2) |
| Memory | 128 MB per isolate | the diff holds one parsed upstream corpus + one D1 page at a time (0.3) |
| Requests | Free 100 k/day; Paid unmetered per request beyond the plan's 10 M/mo | a `*/1` cron is 1 440 invocations/day |
| D1 (`d1/platform/pricing`, `limits`) | Free **100 k rows written/day**, 5 M read/day; Paid 50 M written/mo included; **an indexed column write counts one extra row**; 30 s max query; 100 bound params; 2 MB max row | §2.1's delivery ledger is one `webhooks` row per hook per drain, never one row per delivery attempt |

### 0.2 The code phase 5 builds on (branch `worktree-layout-db`, verified)

| fact | value | consequence |
|---|---|---|
| `scheduled()` (`src/index.ts`) | a `switch (event.cron)` over `*/5 * * * *` (import) and `0 3 * * *` (auth-cache/ratelimit prune + dump); throws on an unknown cron; receives `ctx: ExecutionContext` (unused) | phase 5 adds two cases (`*/1`, `0 4`); every cron handler awaits its own work (a cron's `waitUntil` has no documented bound; don't rely on it) |
| `feed(db, since, limit, kinds?)` (`core/events.ts`) | `seq > since ORDER BY seq LIMIT ≤ 1000`; `next` = last seq returned or `since` | the stream, the changelog and webhook drains all read through it — one reader, one order |
| `changes.ts` | `KNOWN_KINDS` (17 kinds, `satisfies` the two kind unions) is module-private | X1 exports it: webhook `kinds` and the stream's `kinds` validate against the same list |
| `etag.ts` | `headSeq()` = one `MAX(seq)` read; `conditional()`/`cachePut()` best-effort edge cache | the changelog page uses the same three calls; a webhook drain uses `headSeq()` to skip hooks already at the head |
| `handleFullDump` (`routes/layouts.ts`) | `TransformStream` + `writer` + `c.executionCtx.waitUntil(pump)`; a failing write is logged, never surfaced | the SSE stream is the same shape with a poll loop inside `pump` |
| `ratelimit.ts` `take()` | one atomic upsert per attempt; the `rateLimitWrites` middleware runs after `requireActorOnWrites` on `/v1/*` | webhook CRUD and `POST /v1/admin/drill` are counted by placement, nothing to add |
| `admin.ts` | glue only; `core/admins.ts` holds the SQL; `GET` routes resolve their own actor | `POST /v1/admin/drill` follows T3's shape; the drill's `import_state` write lives in `core/admins.ts` |
| `import/diff.ts` | imports only `core/safejson.ts`, `formats/cmini/1/index.ts`, `core/canonical.ts` (all extension-explicit, no `node:*`); `setTimeout` in `realSleep`; `fetchImpl`/`sleepImpl` injected; the pure core (`parseUpstreamRaw`, `compareRecords`, `diffCorpus`, `diffAuthors`) has no I/O; `diffUpstream()` reads **our** side over HTTP (`dbBaseUrl`) | workerd-clean as written. The cron must not fetch the Worker from itself: X4 splits "our side" behind an interface with a D1 implementation (§3 X4) |
| `dump/write.ts` | `Dump` lists every table by name (`auth_cache: []` "never dumped"); `restore.ts` re-inserts by table | the `webhooks` table joins the "never dumped" list (secrets; §2.1) — an explicit `webhooks: []` field, so LDB-D1's completeness test sees the decision, not an omission |
| migrations | `0001_init.sql`, `0002_phase2.sql` on the branch; C1 (`ldb-c1`) takes `0003_clients.sql` | X1's file is the **next free number at landing** (`0004_webhooks.sql` if C1 has merged) |
| `wrangler.toml` | `[env.preview]` redeclares every binding/var; `tests/tools/wrangler-envs.test.ts` (LDB-C3) and `runbook.test.ts` (LDB-G4) fail on a var present in one block or missing from the README table | every new var (`STREAM_MAX_MS`, `STREAM_POLL_MS`, `WEBHOOK_MAX_POSTS`) goes in both blocks and the README table, same PR |
| `db.yml` | jobs `test`, `deploy` (main), `preview` (the feature branch), `daily` (rehost drill + upstream diff, `schedule`/`dispatch` only); `tests/tools/ciwiring.test.ts` asserts the shape | X4 leaves `daily` intact; a later PR (X4b) deletes it and edits that test in the same change |
| `bot/` | V1 + V2 landed: `tsconfig.paths` `@core/* → ../web/src/core/*`, `@formats/* → ../db/formats/*`; `bot.yml` triggers on `bot/**`, `web/src/core/**`, `db/formats/**`; secret `FLY_API_TOKEN` only | X5 replaces the two path aliases with the packages; the cones shrink to `bot/**` |
| `web/src/core` | **zero** npm imports; **13 files import `web/src/copy/*`** (`colors`, `rules`, `export`, `cardIslands`, `rowChrome`, `explainer-board`, `legacyBoardDrawer`, `stats/ngtip*`, `copyimage/*`); `web/src/core/swap-engine.ts` and `core/copyimage/` exist (U1/U2 landed) | `@akl/core` must ship `copy/` inside it (§3 X5); no runtime dependency |
| `db/formats` | depends on `ajv`, `ajv-formats`; every intra-format import is extension-explicit (`./magic.ts`); `src/formats/registry.ts` imports `core/errors.ts` (`unknownFormat`) — not packageable as is | the pure registry moves to `db/formats/registry.ts`; `src/formats/registry.ts` becomes the throwing wrapper (§3 X5) |
| archlint (`web/tests/tools/archlint.mjs`) | layer edges only (`core → core, copy`); **no bot rule exists** — the `bot → web/src/core \| db/formats` exception is enforced by `bot/tests/tools/boundary.test.ts` and `db/tests/tools/boundary.test.ts`'s outside-scan, not by archlint | "the site's archlint rule change" (round 1) is nothing: the two boundary tests change (§3 X5) |
| `design/INVARIANTS.md` | carries `I-223..I-226` (the `LDB-S*` site invariants) and the `db/INVARIANTS.md` pointer | the split rewrites the pointer to the new repo's URL, nothing else |
| `git` tooling (this machine) | `git subtree` present; `git filter-repo` present (`a40bce548d2c`) | §3 X5 uses filter-repo (multi-path + rename with history); subtree is the fallback |
| `data/layout-dates.json` | `{ last_sha, last_date, layouts: { <lowercase id>: { created, modified } } }`, **7 369** entries | §0.6 |

### 0.3 The diff's cost, measured (Node 26.8, M-series laptop, live `?full=1` body of 2026-09-09: 5 334 635 bytes, 4174 layouts, 1.43 s to fetch)

| step | wall | CPU | note |
|---|---|---|---|
| `unescapeGoHtml` + `JSON.parse` ×2 + `canonical` ×2 (LDB-I9's self-check) | 181 ms | 264 ms | the two parses agree |
| `parseUpstreamRaw` × 4174 (`cmini/1` `validate` each) | 42 ms | — | 0 invalid |
| `diffCorpus` (4174 matched against a deep copy) | 128 ms | — | 0 diffs |
| **total** | **382 ms** | **553 ms** | heap 89 MB with BOTH parsed copies, the two canonical strings and the raw text all alive |

Consequence: inside a Paid Worker (30 s CPU, 15 min cron wall) the whole
diff is one invocation, no batching over ticks. Memory is the only number
near a limit: X4 keeps **one** parsed upstream corpus (the second parse
and the raw text are function-local and collectable before our side is
read) and pages our side from D1 in 500-record pages; estimated peak
≈ 60 MB, asserted on the preview deployment before the cron is enabled in
production (§3 X4 DoD), with `wrangler tail` as the instrument.

### 0.4 mana2's layout file, as `core/load_layout.go` actually reads it

| rule (Go) | consequence for `mana2/1` |
|---|---|
| each `layout.fingers[y]` is `strings.TrimSpace`d, then tokenised on spaces (runs of spaces = one separator); a token's **column is its index `x`**; a row's leading spaces are decorative | no hand split, no column offset from indentation — `01 §6.3`'s "hand split after the 5th column" is **wrong** and is replaced by §2.5. Hand comes from the finger digit |
| token forms: one code point → that key; `space` → `' '`; `skip` → an empty cell that **still occupies column `x`**; `(a b)` tap-hold; `<a b>` directional magic; `repeat`, `$name` → layer/repeat tokens; any other multi-char word → error `Unrecognisable word` (+ `Did you mean "a b"` for 2 chars) | `space` and `skip` translate; tap-hold, directional, `repeat`, `$` → the payload is **held** for `akl/1` |
| a key char seen twice (fingers ∪ thumbs) → `Duplicate keys are not allowed. If you need them, implement them through magic` | `validate` refuses with that message |
| `fingermap[y]` is `strings.Fields`; entry `x` → finger for the token at `(x, y)`; a token with no entry keeps finger `-1` (the engine then indexes out of range); **extra** entries beyond the token count are ignored | `validate`: `fingermap.length == fingers.length`; each row has **≥** as many entries as tokens; every entry an integer 0–9. Extra entries are legal and are dropped by translation (lossy, §2.5) |
| digits: `0 LP · 1 LR · 2 LM · 3 LI · 4 LT · 5 RT · 6 RI · 7 RM · 8 RR · 9 RP` (= `defs.fingers`, `10 §0`) | the letter table both directions; `TB` has no digit (§2.5) |
| `layout.thumbs` is `[2]string`: `[0]` = left thumb (finger 4), `[1]` = right (5); each is tokenised like a finger row; thumb row `y = fingers.length`; **right-thumb column = number of left-thumb tokens + index**; `""` = no keys; `skip` allowed | a compact index, not an absolute column — §2.5's anchoring rule maps it onto cmini's absolute thumb columns |
| `board.isRowStaggered: true` → `X = rowOrColumnStagger[row] + col` (needs ≥ one entry per finger row, else `…must match the height of the layout`); `false` → `Y = row + rowOrColumnStagger[col]` (the Go check compares against the row count — a bug; fewer entries than the width panics at `[col]`) | `validate`: rowstag needs `≥ rows` entries, colstag needs `≥ width` entries; `board` and `rowOrColumnStagger` are required (the zero value panics) |
| `mirrorLeftRowStagger: bool`, `splitAngle: degrees` (rotates each hand) | `akl/1` cannot say either → non-default values are **held** |
| `magic.rules[{inputs, output}]`, flat; a later rule with the same `inputs` **replaces** the earlier one; `magic.magicKeys` parsed but unimplemented (`TODO`) | translation to `akl/1` keeps the **last** duplicate (mana2's semantics); `magicKeys` non-null → held |
| `combos[{inputs: [string…], output}]` (every char must be a key); `layers` parsed, unused | non-empty `combos` or non-null `layers` → held for `akl/1` (stored, readable as `mana2/1`) |
| the file has no name; the name is the filename | the payload carries no `name`; the record's `name` is the file name |
| JSONC: `github.com/tidwall/jsonc` strips comments and trailing commas | the API takes JSON; the module exports `parseJsonc(text)` for clients and the fixture script |

### 0.5 The vendored layouts (`vendor/mana2/data/layouts`, 75 files — the submodule is checked out in the main checkout only)

| fact | files |
|---|---|
| shape: 74 carry the loader's full key set (`mirrorLeftRowStagger`, `splitAngle`, `layers: null`, `magic.magicKeys: null`); `hours.jsonc` is the older docs shape (no such keys) | both shapes must validate |
| `skip` in a finger row | `stand_iso` (11 tokens on row 2, ISO key at column 5; stagger `[0, 0.25, -0.25]`) |
| column-stagger (`isRowStaggered: false`, 10 entries) | `whirl` (thumb `*` is its magic key), `nstd-repeat`, `d5` |
| row-stagger with all-zero stagger (= ortho) | `bunya`, `chantries`, `sturdy_ortho`, `gallium_ortho`, … |
| ragged rows (12 / 11 / 10) + empty right thumb | `graphite` |
| two keys on one thumb | `chantries` (`"l h"`, `"space"`) |
| fingermap rows longer than the token row (extra digits, legal) | `cyclone`, `knightest`, `nystyc`, `standlight`, `vigil` |
| 11-wide rows with `9 9` | `vigil`, `knightest`, `standlight` |
| uppercase and punctuation keys | `nystyc` (`Y`, `\|`) |
| non-ASCII keys | `lucens_de` (`ä ö ü ß`) |
| tap-holds, directionals, `$layers`, `repeat` — **held** | `d5` (the only one) |
| duplicate `magic.rules[].inputs` · non-empty `combos` · non-null `layers` · `splitAngle ≠ 0` · `mirrorLeftRowStagger: true` | **none** — every held reason except `d5`'s needs a hand-written fixture |
| thumbs `["space", "e"]` (a letter on the right thumb) | 6 files incl. `hours`, `nstd-repeat`, `stand-magicthemb` |

### 0.6 `layout-dates.json` vs upstream `created_at` (06 Q1, answered by data)

Over the 4174 live upstream layouts: **3 969** dates equal, **85** one day
older in the file (a timezone boundary: the file was derived from git
commit dates), **16** older by more — layouts cmini deleted and re-created
(`auditor`, `finch`, `night-e`, …; upstream's `created_at` is the
re-creation), **79** newer in the file, 25 upstream layouts absent from
the file, and **3 220** file entries for layouts that no longer exist
upstream (never imported, no record to backfill). The file adds one
fact for 16 records (0.4 %) that no verb can set (`created_at` is fixed at
create and the record is the fold of its events, LDB-P1). **X7 is closed:
no backfill** (§6.10); the file retires when the site reads dates off the
record (`06 §1` item 3, site work).

### 0.7 The split's edges (what references `db/` and `bot/` from outside them)

`.github/workflows/db.yml`, `.github/workflows/bot.yml`, `web/tests/tools/
gates.sh` (`dbtest` step), `design/INVARIANTS.md` (the pointer + the
`LDB-S*` rows), `CLAUDE.md` (one line), `bot/tsconfig.json`'s two path
aliases, `db/tests/tools/{ciwiring,boundary,frozen}.test.ts` (each assumes
`db/` sits inside this repo: `../../.github/workflows/db.yml`, the
outside-scan over `web/ scripts/ functions/ workers/ tools/`, `git diff
origin/main -- db/formats`), and `scripts/tests/fixtures/db-responses/`
(exported by `db/tests/api/fixture-export.test.ts`, LDB-S1a). Nothing
else (`db/tests/tools/boundary.test.ts` proves the import half).

## 1. Before the first PR

| need | default if unanswered | blocks |
|---|---|---|
| **The `akl` account's plan** (0.1) | assumed **Workers Paid** (`07 §1`); if it is Free, the stream and the diff cron are cut and the import's full pass is already broken | X1 (stream half), X4 |
| `mana2/1` owner (`04 Q3`) | `OWNERS` = the DB maintainers; `README.md` says "a mirror of mana2's loader at `<submodule commit>`"; Zak's handle added when he says yes | nothing |
| npm scope | `@akl` if free, else `@aklgg` (⚠ saltorbit reserves it; `NPM_TOKEN` repo secret) | X5's publish step only — `file:` links prove the wiring before any publish |
| GitHub org + repo names | `akl-db`, `akl-bot` under the org from `00 §6.5` | X6 |
| Fly app for the drill | `akl-db-drill` in saltorbit's Fly account (`08 §1`), a client-lane key registered on production for it (C1) | X4's drill half |
| hostname (`08 §2` item 4) | none; everything below works on `workers.dev` (edge cache stays inert, `07 §1`) | nothing |

## 2. Cross-cutting contracts

### 2.1 Webhook delivery is the feed pushed from a cursor

Round 1 had a `webhook_deliveries` ledger (one row per attempt) and a
`secret_hash`. Both are wrong: an HMAC needs the secret itself, and a
per-attempt row is a D1 write per delivery when the free-tier budget is
100 k rows/day (0.1). The model here has **no delivery table**: each
subscription carries a cursor into the one event log, and delivery is
"advance the cursor by POSTing what lies past it" — LDB-P3's "feed is
truth" made literal. At-least-once, in order per hook, idempotent by
`seq`.

```sql
-- migrations/000N_webhooks.sql (N = next free at landing, 0.2)
CREATE TABLE webhooks (
  id            TEXT PRIMARY KEY,          -- ULID
  owner_user_id TEXT NOT NULL,
  url           TEXT NOT NULL,             -- https:// only, ≤ 2048 chars
  secret        TEXT NOT NULL,             -- the HMAC key, verbatim (16–256 chars); never read back out, never dumped
  kinds         TEXT,                      -- JSON array ⊆ KNOWN_KINDS, or NULL = every kind
  owner_filter  TEXT,                      -- a user id: only events whose `owner` equals it; NULL = all
  status        TEXT NOT NULL,             -- 'active' | 'failing' | 'disabled'
  cursor        INTEGER NOT NULL,          -- last seq delivered; starts at the head seq at registration
  failures      INTEGER NOT NULL DEFAULT 0,-- consecutive failed drains; reset to 0 by a success
  failing_since TEXT,                      -- first failure of the current run, NULL when healthy
  next_at       TEXT NOT NULL,             -- earliest time the cron may try again
  last_error    TEXT,
  created_at    TEXT NOT NULL
);
CREATE INDEX webhooks_due ON webhooks(status, next_at);
CREATE INDEX webhooks_owner ON webhooks(owner_user_id);
```

**Amended (LDB-H6, `migrations/0008_webhook_lease.sql`, 2026-09-11):**
`webhooks` gains `lease_id TEXT` and `lease_until TEXT`, both NULL when the
hook is free. The cursor-only CAS below (step 3, as originally landed)
turned out not to be enough: two overlapping drains reading the SAME
`cursor` can both pass its `WHERE cursor = ?startCursor` guard and both
POST the same range concurrently (interleaved delivery at the receiver), a
failed batch with no cursor movement lets both drains compute
`failures + 1` from the same stale read (a lost increment), and a short
failing batch's commit can land after a longer concurrent success's and
silently void it. `lease_id`/`lease_until` fix this at the root: see the
amendment after the numbered steps below.



**`src/core/webhooks.ts`** — all the SQL and the delivery loop; routes
are glue (LDB-W1's rule extended: `grep prepare src/routes/webhooks.ts`
is empty).

```ts
export const WEBHOOK_BACKOFF_S = [60, 600, 3600];       // after failure 1, 2, ≥3 (03 §5's 10 s is below the cron's granularity; §6.2)
export const WEBHOOK_FAILING_AFTER = 3;                  // consecutive failures → status 'failing'
export const WEBHOOK_DISABLE_AFTER_MS = 7 * 86_400_000;  // failing_since older than this → 'disabled'
export const WEBHOOKS_PER_USER = 5;

create(db, now, owner, body): Promise<WebhookRow>         // cursor = headSeq(db); 409 too_many_webhooks past the cap
listForOwner(db, owner) · listAll(db) · remove(db, id)   // rows minus `secret`
sign(secret, timestamp, body): Promise<string>           // hex HMAC-SHA-256 over `${timestamp}.${body}` via crypto.subtle
drain(env, now, deps: { fetchImpl; maxPosts: number }): Promise<DrainStats>
```

`drain` (called from the after-write nudge and from the `*/1` cron; both
callers are safe to overlap):

1. `head = headSeq(db)`; `due = SELECT … FROM webhooks WHERE status != 'disabled' AND next_at <= ?now AND cursor < ?head ORDER BY next_at LIMIT 20`. **A quiet tick is two indexed reads and zero writes** (LDB-H5).
2. Per hook, in order: `{ items } = feed(db, hook.cursor, 10, kinds)`, then `owner_filter` applied in JS; POST each event in `seq` order (body = `canonical(event)`; headers `Content-Type: application/json`, `User-Agent: akl-db-webhooks/1.0`, `X-Akl-Webhook-Id`, `X-Akl-Seq`, `X-Akl-Timestamp: <unix seconds>`, `X-Akl-Signature: v1=<hex>`; `AbortSignal.timeout(10_000)`; 2xx = delivered, anything else or a throw = failure, and the hook's batch stops at the first failure). Events filtered out by `kinds`/`owner_filter` count as delivered (the cursor passes them) — the feed page is fetched with `kinds` so a hook subscribed to rare kinds skips ahead in ≤ 1000-seq strides, not 10. Global bound: `deps.maxPosts` (var `WEBHOOK_MAX_POSTS`, default `25`) POSTs per drain across all hooks; what is left waits for the next tick.
3. After the hook's batch, **one** statement — compare-and-set on the cursor so two overlapping drains cannot double-advance and a lost race is simply "the other drain did it":
   ```sql
   -- success (all posted, or the page was empty/filtered):
   UPDATE webhooks SET cursor = ?newCursor, failures = 0, failing_since = NULL, last_error = NULL,
                       status = 'active', next_at = ?now
     WHERE id = ? AND cursor = ?startCursor
   -- failure at seq s (events before s were delivered):
   UPDATE webhooks SET cursor = ?lastDeliveredSeq, failures = failures + 1,
                       failing_since = COALESCE(failing_since, ?now), last_error = ?,
                       status = CASE WHEN failures + 1 >= 3 THEN 'failing' ELSE status END,
                       next_at = ?nowPlusBackoff
     WHERE id = ? AND cursor = ?startCursor
   ```
   `changes = 0` → another drain moved the cursor: skip. A hook whose `failing_since < now − 7 d` is set to `'disabled'` in step 1's pass (one UPDATE, no POST); disabled hooks stay listed for their owner with `status`, `last_error`, `failing_since`.
4. Returns `{ hooks, posted, failed, disabled }` (logged by the cron).

**Amended (LDB-H6, 2026-09-11): claim-before-send lease.** Step 2 no
longer reads a due hook's feed page or POSTs anything until step 1.5
claims it:

```sql
UPDATE webhooks SET lease_id = ?newUlid, lease_until = ?claimIso+90s
  WHERE id = ? AND status != 'disabled' AND next_at <= ?claimIso AND cursor < ?head
    AND (lease_until IS NULL OR lease_until <= ?claimIso)
  RETURNING *
```

`?claimIso` is read fresh, per hook, right here -- NOT the `now` step 1's
`due` SELECT used. A drain can run far longer than one lease across many
hooks (`deps.maxPosts` POSTs at up to `POST_TIMEOUT_MS` each, cumulatively,
across everything the `due` page holds), so a hook claimed late in a long
drain with a stale clock read would get a `lease_until` that could already
be in the past by the time anyone else checks it -- reopening the exact
concurrent-claim race this lease exists to close. The claim also re-checks
every `due` condition, not just the lease: a hook can stop being due
between step 1's `due` SELECT and this claim -- most commonly, a
DIFFERENT drain's own commit landing a failure in between, which pushes
`next_at` into the future. Without this re-check, a drain holding a
now-stale `due` snapshot would claim and retry immediately anyway,
bypassing that backoff (the lease alone only prevents two POSTs in flight
at once, not a premature retry once the lease has already been cleanly
released). `changes = 0` (no row returned) means the hook is no longer due
OR another drain already holds an unexpired lease -- skip this hook this
call, not an error. The `RETURNING *` row (not the possibly-stale `due`
read) is what the batch is built from, so a drain never bases its work on
a cursor/failures snapshot another drain has since moved past. Step 3's
CAS moves from `cursor` to the lease: `WHERE id = ? AND lease_id =
?leaseId`, clearing both lease columns in the same statement:

```sql
-- success:
UPDATE webhooks SET cursor = ?, failures = 0, failing_since = NULL, last_error = NULL,
                     status = 'active', next_at = ?, lease_id = NULL, lease_until = NULL
  WHERE id = ? AND lease_id = ?
-- failure:
UPDATE webhooks SET cursor = ?, failures = failures + 1, failing_since = COALESCE(failing_since, ?),
                     last_error = ?, status = ?, next_at = ?, lease_id = NULL, lease_until = NULL
  WHERE id = ? AND lease_id = ?
```

Only the drain holding `leaseId` can ever match, so two drains can never
race the same commit, and `failures + 1` (computed from the row the claim
returned) can never lose a concurrent increment -- nothing else is writing
that row's counters while the lease is held. No POST may START once less
than `POST_TIMEOUT_MS` (10 s) + a 5 s margin remains on the lease (real
wall-clock time, tracked independently of the injected business clock a
caller passes as `now`) -- a batch long enough to approach that bound
stops there and commits what was delivered as a (possibly partial)
success, so the lease is always released well before it could lapse under
a live, healthy drain. The one case a lease outlives its holder is a
drain that dies (crash, isolate eviction) between claiming and
committing: the hook simply waits out `lease_until`, then the next drain
reclaims it and redelivers from the last actually-committed cursor -- if
the dead drain's own last POST had already landed, that one `seq` is the
one possible duplicate. Quiet-tick cost is unchanged (LDB-H5: the `due`
SELECT plus `headSeq`'s read, zero writes, since the claim only runs for
hooks the SELECT found due); a delivered batch now costs exactly two
`webhooks` UPDATEs (the claim, then the commit) instead of one.

**Idempotency contract (documented in `README.md` § Webhooks, the public
API doc):** delivery is at-least-once, in order, and never concurrent per
hook (LDB-H6's lease). A receiver may see a `seq` twice ONLY after a drain
dies holding a hook's lease (its last POST may have already landed before
it died) -- outside of that, every matching event reaches the receiver
exactly once. Either way, the contract is the same: treat a `seq` ≤ the
highest one already applied as a no-op; a `seq` never arrives lower than
one already seen from the same hook. A gap in `seq` means the hook's
`kinds`/`owner_filter` skipped events, or (after `disabled`) a gap to fill
from `/v1/changes?since=` — D8. Signature check for receivers:
`hex(hmac_sha256(secret, X-Akl-Timestamp + "." + raw_body)) == signature`,
reject `|now − X-Akl-Timestamp| > 300 s`.

**Secrets.** Stored verbatim (the HMAC needs the bytes), never returned by
any route (`GET /v1/webhooks` rows omit `secret`; `POST` returns the row
the same way — the caller supplied it), never in an event (`admin.*`
events are not emitted for webhooks: they are owner-scoped state, not
governance; §6.4), never in the dump (`Dump.webhooks: []`, LDB-H4). A
rehost starts with no subscriptions; subscribers re-register (§6.5).

**URL rules.** `https://` only; host is not an IP literal; ≤ 2048 chars;
otherwise `400 bad_request param /url`. (Cloudflare's fetch cannot reach
its own internal addresses; nothing more is done about SSRF.)

**The nudge** — one middleware in `src/index.ts`, registered after
`rateLimitWrites`:

```ts
app.use("/v1/*", async (c, next) => {
  await next();
  if (!READ_METHODS.has(c.req.method) && c.res.ok) {
    c.executionCtx.waitUntil(drainWebhooks(c.env, systemClock, { fetchImpl, maxPosts: Number(c.env.WEBHOOK_MAX_POSTS) }));
  }
});
```

Every accepted write, like and admin action nudges once, from one place
(no route or `core/write.ts` change). The 30 s `waitUntil` bound (0.1) is
why `maxPosts` exists: a nudge posts a bounded batch; the cron finishes.

### 2.2 The stream is the feed, framed

`GET /v1/changes/stream?since=&kinds=` → `200`, `Content-Type:
text/event-stream; charset=utf-8`, `Cache-Control: no-store`. A
`Last-Event-ID` request header overrides `since` (that is what
`EventSource` sends on reconnect). The body is written by a `pump` over a
`TransformStream` exactly as `handleFullDump` does (0.2):

```
id: <seq>\nevent: <kind>\ndata: <canonical(event)>\n\n     one per feed item, in seq order
: ping\n\n                                                    every 25 s of silence
event: close\ndata: {"next":<cursor>}\n\n  then close        at STREAM_MAX_MS (default 300000)
```

Loop: `feed(db, cursor, 100, kinds)` → write items → `cursor = next`; an
empty page sleeps `STREAM_POLL_MS` (default `2000`); a write that throws
(client gone) ends the pump. Cost per open stream: one indexed D1 read per
poll — 150 reads and (estimated) 20–60 ms CPU over 5 minutes, which is why
the stream is **Paid-plan only** (0.1) and why the bound exists (a Worker
has no wall-clock limit on an open response, but the CPU budget is per
request and the isolate is held). Vars `STREAM_MAX_MS`/`STREAM_POLL_MS` in
both `wrangler.toml` blocks and the README table (LDB-C3/G4); tests set
`STREAM_POLL_MS=20`, `STREAM_MAX_MS=500` through `vitest.config.ts`'s
miniflare bindings.

### 2.3 New error rows (`core/errors.ts`)

| status | `error` | extra | when |
|---|---|---|---|
| 400 | `bad_request` | `param` | webhook body: `url` not https / IP / too long, `secret` length, `kinds` not ⊆ `KNOWN_KINDS`, `owner_filter` not 17–20 digits; stream: `since` (as `/v1/changes`), `Last-Event-ID` not an integer; drill body shape |
| 404 | `not_found` | `ref` | `DELETE /v1/webhooks/{id}` for an id that is not the actor's (and the actor is not admin) — never a 403, so ids are not enumerable |
| 409 | `too_many_webhooks` | `limit: 5` | a 6th subscription for one user |
| 503 | `stream_unavailable` | — | `STREAM_MAX_MS` is `0` (the Free-plan setting; Q1) |

### 2.4 `scheduled()` grows two cases

```ts
case "*/1 * * * *": await drainWebhooks(env, systemClock, { fetchImpl: fetch, maxPosts: Number(env.WEBHOOK_MAX_POSTS) }); return;
case "0 4 * * *":   await diffTick(env, systemClock); return;                       // X4
```

`wrangler.toml` `[triggers] crons = ["*/1 * * * *", "*/5 * * * *", "0 3 * * *", "0 4 * * *"]` in both env blocks (LDB-C3). Tests drive each through the exported `scheduled()` with `createScheduledController` (`07 §2`).

### 2.5 `mana2/1` ↔ `akl/1` — the exact algorithm (replaces `01 §6.3`)

Letters ↔ digits: `LP 0 · LR 1 · LM 2 · LI 3 · LT 4 · RT 5 · RI 6 · RM 7 · RR 8 · RP 9`; `TB` → `4` when `col < 4.5` else `5` (the site's `PhysicalThumbSide`, `bridgecore/cmini.go`).

**`mana2/1 → akl/1`** (`to["akl/1"]`; returns `{ held: true, reason }` where marked):

| mana2 | akl/1 | lossy? |
|---|---|---|
| `fingers[y]` token `x` (1 code point, or `space` → `" "`) | `keys[c] = { row: y, col: x, finger: letters[fingermap[y][x]] }` | no (leading spaces, extra fingermap digits dropped — they carry nothing) |
| `skip` at `(x, y)` | `free[] += { row: y, col: x, finger: letters[fingermap[y][x]] }` | no |
| `(a b)`, `<a b>`, `repeat`, `$…` tokens | **held**: `tap-hold/directional/layer tokens have no akl/1 idiom` | — |
| left thumb tokens `i = 0..n−1` (n ≤ 5) | `row = fingers.length`, `col = 4 − (n − 1 − i)`, `finger: "LT"` (`skip` → `free`) | no |
| right thumb tokens `j` | same row, `col = 5 + j`, `finger: "RT"` | no |
| `n > 5` on one thumb | **held**: `more than five keys on one thumb` | — |
| `board.isRowStaggered: true`, stagger all zero | `board: { kind: "ortho", cmini: "ortho" }` | no (the zeros are the docs' own "ortho" spelling) |
| `isRowStaggered: true`, stagger `[a, b, c, …]` | `board: { kind: "rowstag", stagger: [a, b, c] }` (+ `cmini: "stagger"` iff `[0, 0.25, 0.75]`); entries past the 3rd must equal the 3rd (the site's padding rule) else **held** | no for 3-row files |
| `isRowStaggered: false`, stagger per column | `board: { kind: "colstag", stagger: <first width entries> }`; all zero → `ortho` | no |
| `mirrorLeftRowStagger: true` or `splitAngle ≠ 0` | **held**: `akl/1 cannot express mirrored stagger / split angle` | — |
| `magic.rules` (last duplicate wins, as mana2 loads them) | `magic.rules[] = { inputs, output, type: "raw" }` — no lift (untyped rows are never lifted without the author, `01 §3`) | earlier duplicates dropped |
| `magic.magicKeys` non-null · `combos` non-empty · `layers` non-null | **held** | — |
| (none) | `x` absent | — |

**`akl/1 → mana2/1`** (`from["akl/1"]` on `mana2/1` = `to["mana2/1"]` on `akl/1`; mirrors `bridgecore.ConvertLayout` except that it carries the board instead of forcing one, and trims trailing `skip`s so mana2's own files round-trip):

| akl/1 | mana2 | lossy? |
|---|---|---|
| `keys`/`free` with finger ∉ {LT, RT, TB} | a grid `rows 0..maxRow × cols 0..maxCol`; token = char (`" "` → `space`), gap → `skip`; **trailing `skip`s of a row trimmed**; `fingermap[y][x]` = digit of the key's finger, `0` for a gap with no `free` entry, the `free` entry's finger otherwise | no |
| a key with finger LT / RT / TB (on **any** row — 9 live upstream keys sit on rows 0–2) | thumbs: side = `col < 4.5` (finger label ignored, as the site does), each side sorted by `(col, row)`, joined with single spaces; `" "` → `space`, a `free` thumb → `skip` | **yes**: absolute thumb columns and the row become an index; `TB` becomes a side |
| `board.kind: rowstag`, `stagger: [a, b, c]` | `isRowStaggered: true, rowOrColumnStagger: [a, b, c, c, …]` (padded to the row count with the last value) | no |
| `board.kind: ortho` / `board` absent | `isRowStaggered: true, rowOrColumnStagger: zeros(rows)` | `cmini: "mini"` lost |
| `board.kind: colstag` | `isRowStaggered: false, rowOrColumnStagger: <per column, padded with 0 to the width>` | no |
| always | `mirrorLeftRowStagger: false, splitAngle: 0, layers: null, magic.magicKeys: null` (the loader's full key set) | — |
| `magic` (idioms + raw) | `magic.rules = lower(p)` minus `type`/`note` | **yes**: intent and tags |
| `x` (incl. `x.cmini`) | dropped | yes (LDB-F10) |

`cmini/1 ↔ mana2/1` is the composition through `akl/1`, declared on both
modules (`to["mana2/1"] = p => toMana2(fromCmini(p))`, `to["cmini/1"] = p => toCmini(fromMana2(p))` with `held` passed through) so a `cmini/1` record answers `?as=mana2/1` and a `mana2/1` record answers `?as=cmini/1` (the site's sync reads the latter; a `" "` key from a `space` token reaches it — §6.8).

Round trips, exactly as the tests state them: `akl → mana2 → akl` is identity on `keys` (non-thumb), `free`, `board.kind/stagger` and `lower(magic)` — thumb keys re-anchor to columns 4/5 and `TB` becomes `LT`/`RT` (asserted, not skipped); `mana2 → akl → mana2` is identity under `normalizeMana2()` = trim each row, drop fingermap digits past the row's token count, drop stagger entries past the rows (rowstag) / width (colstag), treat `layers: null`/`magicKeys: null`/`mirrorLeftRowStagger: false`/`splitAngle: 0` as absent, and key order.

## 3. Slices — PRs in order

Order: **X1 → X2 ∥ X3 → X4 → X5 → X6 ⚠**. X7 is closed (§0.6). Every
slice's PR adds its rows to `db/INVARIANTS.md`, tags each enforcing test's
title with the id, extends the conformance enumeration with its (route,
status) pairs (§4), and passes `npm test` + `db.yml`. Every new var gets
both `wrangler.toml` blocks and a README row in the same PR (0.2).

### X1 — webhooks + the stream

**Lands (db/):** `migrations/000N_webhooks.sql` (§2.1), `src/core/webhooks.ts`,
`src/routes/webhooks.ts`, `src/routes/stream.ts`, the nudge middleware and
the `*/1` cron case in `src/index.ts`, `changes.ts` exporting
`KNOWN_KINDS`, `core/errors.ts` +`tooManyWebhooks streamUnavailable`,
`Dump.webhooks: []`, vars `WEBHOOK_MAX_POSTS` `STREAM_MAX_MS`
`STREAM_POLL_MS`, README § Webhooks (the receiver contract of §2.1) and
§ Stream, `tests/api/webhooks.test.ts`, `tests/api/stream.test.ts`,
`tests/events/feed.test.ts` extended, `tests/import/tick.test.ts` extended
(the `*/1` cron dispatch).

```
POST   /v1/webhooks                { url, secret, kinds?, owner_filter? }   → 201 { id, url, kinds, owner_filter, status, cursor, failures, failing_since, next_at, last_error, created_at }   (no secret)
GET    /v1/webhooks                                                        → 200 [rows…]   the actor's; an admin with ?all=1 sees every row (owner_user_id included)
DELETE /v1/webhooks/{id}                                                   → 200 { removed: id }   own, or any as admin; else 404
GET    /v1/changes/stream?since=&kinds=      Last-Event-ID                 → 200 text/event-stream (§2.2)
```

Rules: the three webhook routes are under `requireActorOnWrites` (the
`GET` resolves its own actor like `GET /v1/admin/admins`) and the rate
limiter; bodies are strict schemas (`schemas.ts`, LDB-A7's pattern);
`cursor` starts at the head, so a new hook receives only what happens
after it exists; `secret` is client-supplied (16–256 chars). No test
endpoint, no manual redelivery, no per-hook pause (§7).

| file (workers) | asserts | invariant |
|---|---|---|
| `tests/api/webhooks.test.ts` (FakeDiscord actors via `write-support.ts`; a `FakeReceiver` with a request log, configurable answer per `seq`, injected as `fetchImpl` into `drain()` and as the stubbed global `fetch` for the `SELF.fetch` path) | CRUD matrix: owner/other/admin/anonymous × {create, list, delete} → 201/200/404/401 as the rule table says; a 6th hook → `409 too_many_webhooks`; bad `url` (http, IP literal, 2049 chars), bad `secret`, unknown `kinds`, bad `owner_filter` → 400 with `param`; **no response body, event or `Dump` ever contains a secret** (every route's body and `writeDump()`'s object are scanned for the literal) — **LDB-H4**; a write via `SELF.fetch` → exactly one POST reaches the receiver with `X-Akl-Seq` = the new event's seq, `X-Akl-Webhook-Id`, and `X-Akl-Signature` that `sign(secret, ts, body)` reproduces (and a different secret does not); three writes with the receiver answering 500 → cursor unchanged, `failures = 1`, `next_at = now + 60 s`, `status: active`; the cron at `now + 59 s` posts nothing, at `+60 s` retries; three consecutive failed drains → `failing`, `next_at + 3600 s`; a success → `active`, `failures 0`, `failing_since NULL`; `failing_since` older than 7 d → `disabled` and no POST; `kinds: ["liked"]` receives only like events yet its cursor reaches the head; `owner_filter` likewise; a hook with 30 undelivered events and `maxPosts: 25` → 25 POSTs then the next drain posts 5; **overlap**: `Promise.all([drain(), drain()])` against 10 pending events → the receiver saw every seq ≥ once, in non-decreasing order per hook, and the cursor equals the head; **budget**: a drain with every hook at the head performs zero D1 writes (a statement-counting proxy on `env.DB`, `09 §3 T1`'s pattern) and one delivered batch performs exactly one `webhooks` UPDATE — **LDB-H5** | **LDB-H1**, **LDB-H4**, **LDB-H5** |
| `tests/api/stream.test.ts` | `SELF.fetch` the stream, read with `res.body.getReader()`: events appended during the stream arrive as `id: <seq>` frames in order with `data` equal to `canonical(feed item)`; `since` exclusive; `Last-Event-ID` beats `since`; `kinds` filters; a `: ping` frame after the idle interval; the `close` frame at `STREAM_MAX_MS` carries `next` = the last seq sent, and a reconnect with `Last-Event-ID: <next>` while more events were appended yields no gap and no duplicate (the union of the two streams' ids equals the feed's seqs > the original `since`); `STREAM_MAX_MS = 0` → `503 stream_unavailable`; `Content-Type`/`Cache-Control` headers | **LDB-H2** |
| `tests/events/feed.test.ts` (extended) | property (fast-check, 100 runs): a random write/like/admin sequence; follower A folds `/v1/changes` from 0; follower B folds only what a `FakeReceiver` delivered while dropping 30 % of POSTs (so the cron redelivers) and delivering the rest shuffled within each batch, deduping by `seq` and sorting before folding; B's state after the last drain equals A's, and the stored rows | **LDB-P3** (enforced at last; phase 1 promised it) |
| `tests/import/tick.test.ts` (extended) | `scheduled({ cron: "*/1 * * * *" })` runs `drain()`; the `0 3` prune leaves `webhooks` alone | — |

**DoD:** green; on the preview deployment: register a hook pointing at a
`https://webhook.site` URL through `curl` with a real bearer, `PUT …/like`
a record, see one signed POST within a second and the row's `cursor`
advance; `curl -N …/v1/changes/stream` shows the like event live and the
`close` frame at 5 minutes; `wrangler tail --format json` over that stream
shows `cpuTime` under 100 ms (record the number in the PR).

### X2 — `mana2/1`

**Lands (db/):** `formats/mana2/1/{schema.json,index.ts,translate.ts,jsonc.ts,edits.ts,README.md,OWNERS,fixtures/}`,
`akl/1/index.ts` +`to["mana2/1"]`/`from["mana2/1"]` and `cmini/1/index.ts`
+`to["mana2/1"]` (compositions; `index.ts` is not frozen — only
`schema.json` and `fixtures/` are, LDB-F6), the goldens those declarations
require (`akl/1/fixtures/NNN.mana2-1.json` × 20, `cmini/1/fixtures/NNN.mana2-1.json`
× 18 — generated once by `npm run goldens -- --write`, then frozen),
`src/formats/registry.ts` +`mana21`, `scripts/pick-mana2-fixtures.mjs`
(reads `vendor/mana2/data/layouts/*.jsonc` **from the main checkout path
given on the command line** — the submodule is not checked out in
worktrees, 0.5 — converts with the module's own `parseJsonc`, writes the
14 named fixtures and `tests/fixtures/mana2-vendored/{<name>.json × 75,
SOURCE}` where `SOURCE` records the submodule commit), `scripts/check-convert-parity.mjs`
(below), `tests/fixtures/mana2-convert/<id>.json` (frozen), `tests/formats/mana2.test.ts`,
`tests/formats/mana2-convert-parity.test.ts`, `tests/formats/jsonc.test.ts`.

`schema.json` (draft 2020-12, `additionalProperties: false` at every
level — a future mana2 key is a `mana2/2`, not a silent pass):

```jsonc
{ "layout":    { "fingers": ["<row>", …1..5], "thumbs": ["<left>", "<right>"] },   // thumbs: 0..2 strings
  "fingermap": ["<digits>", …],                                                    // same length as fingers
  "board":     { "isRowStaggered": bool, "mirrorLeftRowStagger": bool, "splitAngle": number,
                 "rowOrColumnStagger": [number, …] },                              // board + rowOrColumnStagger required (0.4)
  "magic":     { "rules": [{ "inputs": "<≥2 code points>", "output": "<≥1>" }], "magicKeys": null | [] },
  "combos":    [{ "inputs": ["<string>", …], "output": "<string>" }],
  "layers":    null | [ … ] }                                                      // opaque
```

`validate`: schema, then 0.4's rules in the loader's order and with the
loader's own messages where it has them — token grammar
(`Unrecognisable word` / `Did you mean "a b"`, path `/layout/fingers/<y>`),
duplicate chars (`Duplicate keys are not allowed. If you need them,
implement them through magic`, path of the second occurrence),
`fingermap.length == fingers.length`, per-row entries ≥ tokens, entries
0–9, ≤ 2 thumbs, stagger length (`…must match the height of the layout` /
`…must match the width of the layout`), combo chars ∈ keys. `lower(p)` =
the rules deduped last-wins with `type: "raw"`; `hasMagic` = non-empty.
`edits.setFingermap` only (`setBoard`/`setMagic` → `unsupported_for_format`,
§6.9). `owner`/`description` exports per `07 §6 S6`; `OWNERS` per §1.

**Fixtures** (`NNN-<file name>.json`, the vendored file's parsed object,
with `.lowered.json`, `.akl-1.json`, `.cmini-1.json` goldens; held ones
have a `.akl-1.json` golden of `{ "held": true, "reason": "…" }`):
`001-hours` (docs shape, right-thumb `e`, thumb magic), `002-graphite`
(12/11/10 ragged, empty right thumb), `003-stand_iso` (`skip`, negative
stagger), `004-whirl` (colstag, thumb `*` magic), `005-bunya` (zeros =
ortho, thumb `s`), `006-chantries` (two left-thumb keys), `007-vigil`
(11-wide, extra fingermap digits), `008-cyclone` (short row 2, extra
digits), `009-nystyc` (`Y`, `|`), `010-lucens_de` (non-ASCII),
`011-opal`, `012-sturdy`, `013-sturdy_ortho` (one layout, two boards),
`014-d5` (tap-holds, directionals, `$layers`, `repeat` — **held**); hand-written
`900-held-combos.json`, `901-held-splitangle.json` (`splitAngle: 15`),
`902-held-mirror.json`, `903-held-sixthumbs.json`, `904-dup-rules.json`
(two rules on one `inputs`, last wins), `905-colstag-zeros.json` (→ ortho).

| file (node) | asserts | invariant |
|---|---|---|
| `tests/formats/mana2.test.ts` | **envelope**: all 75 `mana2-vendored/*.json` validate (`d5` included — validity and translatability are different questions); `to["akl/1"]` succeeds for 74 and returns `held` for exactly `d5` with the tap-hold reason (a list, so a new vendored file that is held fails the test until listed); every non-held result passes `akl1.validate`; **algorithm rows** (§2.5, one `it` per row): `hours` → `e` at `{3, 5, RT}`, space at `{3, 4, LT}`; `chantries` → `l {3,3,LT}`, `h {3,4,LT}`; `stand_iso` → `free[0] = {2, 5, LI}`; `cyclone` row 2 col 0 is `k` with `LR`; `graphite` cols reach 11; `whirl` → `colstag` with 10 entries; `bunya` → `ortho`; `904` keeps the last rule; `900–903` held with the stated reasons; **round trips** exactly as §2.5's last paragraph: for every non-held vendored file `normalizeMana2(toMana2(fromMana2(f))) ≡ normalizeMana2(f)`; for every `akl/1` and `cmini/1` fixture the `akl → mana2 → akl` identity on non-thumb keys/free/board/`lower(magic)` and the enumerated thumb re-anchoring (`test12222`'s rows-0–2 thumb fingers, `adept`'s `TB`) asserted exactly; a `mana2/1` record read `?as=cmini/1` carries `keys[" "]` when the file had `space` (§6.8) | **LDB-F5** (mana2 pair), F1/F2/F7 (generated rows), **LDB-F13** (held reasons are enumerated) |
| `tests/formats/mana2-convert-parity.test.ts` | for every `cmini/1` fixture: `toMana2(fromCmini(p)).layout.{fingers, thumbs}` and `fingermap` equal the committed `tests/fixtures/mana2-convert/<id>.json` (the site's `swapengine.convertLayout("rowstag", "none", detail)` output, recorded once by `scripts/check-convert-parity.mjs` from `../web/data/swap/{wasm_exec.js,engine.wasm}` — a file read, not an import, LDB-G5 untouched) modulo trailing `skip` tokens and the fingermap digits under `skip` cells (the site emits `0`, we emit the `free` entry's finger; mana2 ignores both). The script's `--check` mode is the runbook's way to re-verify after a site engine change | **LDB-F12** (the DB's mana2 grid is the site's mana2 grid — the "integrate via the real tool" bar) |
| `tests/formats/jsonc.test.ts` | `parseJsonc` strips `//` and `/* */` outside strings, trailing commas before `]`/`}`, leaves `//` inside strings; every vendored `.jsonc` (read from `SOURCE`'s path when present, else skipped **with the 14 committed copies asserted equal to the committed vendored snapshot**) parses to its committed `.json` | — |
| `goldens.test.ts`, `mutations.test.ts`, `edits.test.ts`, `frozen.test.ts` | now over three formats (generated) | F1, F2, F6, F7, E1 |
| `tests/api/held.test.ts` (extended) | a `mana2/1` record (`014-d5`) reads as `mana2/1`, lists, and `409 held` for `as=akl/1` and `as=cmini/1` with `see: "mana2/1"` | LDB-F9 |
| `tests/api/write.test.ts` (extended) | the verb matrix runs with `format: "mana2/1"` too; `has_magic` from `hasMagic` | LDB-P1 |

**DoD:** green; `GET /v1/formats` lists `mana2/1` with `can_translate_to:
["akl/1", "cmini/1"]`; `POST /v1/layouts { format: "mana2/1", payload:
<hours> }` on preview, then `?as=cmini/1` shows `e` on row 3 col 5 `RT`
and the 28 rules; the parity script reports 18/18 against the deployed
site's wasm (number in the PR).

### X3 — the changelog page

**Lands (db/):** `src/routes/changelog.ts` (`GET /admin/changelog`, `03 §7`'s
path — public, read-only, no auth, no JS, one inline stylesheet),
`feed()` gains an optional `filter?: { layoutId?: string; actor?: string }`
(indexed by `events_layout`; `actor` is a scan — acceptable at this
volume) and `/v1/changes` exposes them as `layout=` (id or name, resolved
by `byRef`) and `actor=` (§6.6), `tests/api/changelog.test.ts`, conformance
cases for both routes.

Query: `since=` (exclusive seq, default `max(0, head − 100)` so the first
page is the newest 100), `kinds=`, `layout=`, `actor=`, `limit` fixed at
100. Rendered newest-first with *newer* / *older* links (`?since=<last
seq>` / `?since=<max(0, pageStart − 100)>`); each row: `seq`, `at`,
`kind`, `name` (linked to `/v1/layouts/{id}`), `actor`, `via`, `rev`,
`admin` mark, and for `renamed`/`transferred` the `before → after` field.
Same ETag/`Cache-Control` as `/v1/changes` (`etagFor(head, {page: …})`).
Every interpolated string goes through one `escapeHtml()` (`0.1` measured
`<`/`>` in live names). Not rendered into the dump (§7).

| file (workers) | asserts | invariant |
|---|---|---|
| `tests/api/changelog.test.ts` | for every `(since, kinds, layout, actor)` in a small matrix the set of `data-seq` attributes in the page equals the seqs `/v1/changes` returns for the same params (limit 100); newest-first order; a record named `<b>x` (seeded via `appendWrite`) renders as `&lt;b&gt;x` and no `<b>` tag appears; *older*/*newer* links chain to the same sets `/v1/changes` paging gives; 304 on `If-None-Match`; `layout=` by name and by id agree | **LDB-H3** |
| `tests/api/etag.test.ts` (extended) | `/admin/changelog` and `/v1/changes?layout=` join the R1 matrix | LDB-R1 |

**DoD:** green; the page renders on preview; `06 §6`'s retirement of the
site's `/admin/cmini-log` is a site PR after W6 (not here).

### X4 — the diff as a cron, the drill on Fly, `last_*` on `/v1/meta`

**Lands (db/):** `src/import/difftick.ts`, `src/import/diff.ts` refactor
(below), `scheduled()` `0 4` case, `core/admins.ts` +`recordDrill`,
`POST /v1/admin/drill`, `GET /v1/admin/health`, `/v1/meta` +`last_diff`/`last_drill`,
`drill/{Dockerfile,run.sh}`, `scripts/report-drill.mjs`, README § Drill,
`tests/import/difftick.test.ts`, `tests/api/{admin,meta}.test.ts` extended,
conformance cases.

**`diff.ts` refactor** — `diffUpstream(opts)`'s I/O half is split into
sources; the pure core is untouched (0.2):

```ts
export interface OursSource {
  full(): AsyncIterable<OursEntry | { held: string }>;   // every live record as cminiDetail, or the name of a held one
  authors(): Promise<Record<string, string>>;
  layoutCount(): Promise<number>;
  followsUpstream(ref: string): Promise<boolean>;
}
export function httpOurs(dbBaseUrl: string, fetchImpl, sleepImpl): OursSource   // today's code, moved (the CLI and the CI test)
export async function diffUpstream(opts: { upstreamUrl; ua; ours: OursSource; fetchImpl?; sleepImpl? }): Promise<DiffSummary>
```

`src/import/difftick.ts` — `d1Ours(env): OursSource` (`listRecords` pages of 500 + `likesByLayout` + `translate(rec, "cmini/1")` + `followsUpstream` — the same functions the routes use, no self-HTTP; **LDB-C4**) and `diffTick(env, now, fetchImpl?)`: `summary = await diffUpstream({ …, ours: d1Ours(env) })`, then one row: `import_state['cmini.last_diff'] = canonical({ at, ok, duration_ms, upstream_count, our_count, held, layout_count: {upstream, ours, equal}, authors: {missing, extra, alias_count}, corpus: {matched, missing, invalid_upstream, content_diffs, extra}, samples: { missing[≤10], content_diffs[≤10 {name, path}], extra[≤10] } })`. A thrown fetch/parse failure still writes the row as `{ at, ok: false, error }` — a stale `at` never hides an outage. `d1Ours` is in `src/import/` (extensionless imports are fine there; only `diff.ts` itself must stay plain-Node-loadable, 0.2).

`/v1/meta` gains `last_diff: { at, ok } | null` and `last_drill: { at, ok } | null` (from `import_state` keys `cmini.last_diff` and `drill.last`; the full bodies are admin-visible via `GET /v1/admin/health` → `{ last_diff: <full>, last_drill: <full> }`, admin-only, §6.7). `POST /v1/admin/drill { ok: boolean, detail?: object ≤ 4 KB }` → `200 { recorded: true }`, writes `import_state['drill.last'] = { at: now, ok, actor, detail }`; no event (§6.4); admin-only; counted as a write.

**The drill on Fly** (`08 §2` item 2): `db/drill/Dockerfile` = `node:24-slim`, `COPY db/ /app`, `npm ci`; `drill/run.sh`:

```sh
set -u
latest=$(curl -sf "$DB_BASE_URL/v1/dump/latest.json") || { node scripts/report-drill.mjs --ok false --detail '{"step":"latest.json"}'; exit 0; }
url="$DB_BASE_URL$(echo "$latest" | node -pe 'JSON.parse(require("fs").readFileSync(0)).url')"
if REHOST_DUMP_URL="$url" npx vitest run tests/rehost.test.ts --project workers; then ok=true; else ok=false; fi
node scripts/report-drill.mjs --ok "$ok" --detail "{\"dump\":\"$url\"}"
```

`scripts/report-drill.mjs` signs `POST /v1/admin/drill` on the client lane (C1's five headers; Web Crypto Ed25519, 40 lines — the DB's own copy of the signer, kept honest by reproducing `tests/vectors/client-signing.json`'s vectors in `tests/tools/report-drill.test.ts`) with `CLIENT_ID`/`CLIENT_PRIVATE_KEY`/`DRILL_ACTOR` from the environment. ⚠ saltorbit: `fly launch --no-deploy` in `db/drill`, `fly secrets set`, register the drill's key on production as `act-as-owner-only` with an admin owner, `fly machine run <image> --schedule daily`. Until the Fly drill has posted `ok: true` seven days running **and** the site's meta-watch warns on a stale `last_*` (`LDB-M1`'s site half, a one-line W-lane change), `db.yml`'s `daily` job stays; **X4b** (one PR) then deletes both `daily` steps and updates `ciwiring.test.ts` — the `08 §2` handover rule, applied to both jobs at once.

| file | asserts | invariant |
|---|---|---|
| `tests/import/difftick.test.ts` (workers; `FakeUpstream` as `fetchImpl`, seeded `upstream-100`) | identical upstream → `last_diff.ok: true`, `corpus.matched = 100`, zero samples; one upstream layout mutated → `ok: false`, `content_diffs = 1`, the sample names it with the path; a fake 500 on every attempt → `ok: false` with `error`, row still written with `at`; `/v1/meta.last_diff` equals `{at, ok}`; the tick performs **no** request to the Worker's own origin (the fake refuses any URL not under the upstream base); `scheduled({cron: "0 4 * * *"})` runs it; a statement-counting proxy shows ≤ ⌈records/500⌉ list queries + likes chunks — no per-record query | **LDB-C4**, **LDB-M1** (DB half) |
| `tests/import/diff-unit.test.ts` (extended) | `httpOurs` reproduces today's behaviour against a fake DB (the moved code's regression) | LDB-P5 (unit half) |
| `tests/api/admin.test.ts` (extended) | `POST /v1/admin/drill` × {anonymous 401, user 403, admin 200}; body shape 400; `GET /v1/admin/health` admin-only; `/v1/meta.last_drill` after a post | LDB-A5 (admin routes), LDB-M1 |
| `tests/tools/report-drill.test.ts` (node) | the script's signer reproduces every vector | LDB-A4 (a second consumer of the vectors) |
| `tests/tools/runbook.test.ts` | the drill's env names (`DB_BASE_URL`, `CLIENT_ID`, `CLIENT_PRIVATE_KEY`, `DRILL_ACTOR`) appear in the README table with a regeneration line | LDB-G4 |

**DoD:** green; on **preview**: `wrangler dev --remote --env preview --test-scheduled` + `curl "localhost:8787/__scheduled?cron=0+4+*+*+*"` writes a `last_diff` with `ok: true` (preview mirrors upstream too); `wrangler tail --env preview --format json` for that invocation shows `cpuTime` and no `Exceeded Memory` outcome — both numbers in the PR; the Fly image runs the drill once by hand (`fly machine run … --rm`) and `last_drill.ok` is true on preview.

### X5 — packages and the split, prepared (nothing published, nothing split)

**Lands:**

1. **`@akl/layout-formats` from `db/formats`.** `db/formats/package.json` (`name`, `version 0.1.0`, `type: module`, `license: MIT`, `exports`: `"."` → `dist/index.js` (+ `types`), `"./cmini/1"`, `"./akl/1"`, `"./mana2/1"` → their `dist/<f>/1/index.js`, `"./*/schema.json"` → the files; `files: ["dist", "*/*/schema.json", "*/*/README.md", "*/*/OWNERS"]`; `dependencies: ajv, ajv-formats`), `db/formats/index.ts` (the barrel: `export * as cmini1 …; export * as akl1 …; export * as mana21 …; export { list, get, translate } from "./registry.ts"`), **`db/formats/registry.ts`** — the pure registry moved out of `src/formats/registry.ts` (`translate` returns `{ unknown: true, known }` instead of throwing; `src/formats/registry.ts` keeps `registerForTest` and maps `unknown` to `unknownFormat()` — one wrapper, no second list of formats), `db/formats/tsup.config.ts` (`entry: ["index.ts", "cmini/1/index.ts", "akl/1/index.ts", "mana2/1/index.ts"]`, `format: ["esm"]`, `dts: true`, `splitting: true`, `external: ["ajv", "ajv-formats"]`, `clean: true`), `db/formats/tsconfig.json` (extends `../tsconfig.json`, `emitDeclarationOnly` for the dts pass), `db/package.json` script `build:formats`.
2. **`@akl/core` from `web/src/core` (+ `web/src/copy`, 0.2).** `packages/akl-core/{package.json,tsup.config.ts,tsconfig.json}` — stays in this repo (the site owns it): `entry` = every `web/src/core/**/*.ts` and `web/src/copy/**/*.ts` except tests, `bundle: true`, `splitting: true`, `format: esm`, `dts: true`, `outDir: dist` (the tree under `dist/core/…`, `dist/copy/…`); `exports: { "./*": { "types": "./dist/core/*.d.ts", "import": "./dist/core/*.js" } }`; no runtime dependencies; `version 0.1.0`; the site keeps importing by path — the package is for the bot and anyone else.
3. **Consumers by `file:` link, proving the wiring without publishing:** `bot/package.json` `dependencies` +`"@akl/core": "file:../packages/akl-core"`, `"@akl/layout-formats": "file:../db/formats"`; `bot/tsconfig.json` loses both `paths`; every `@core/x` import becomes `@akl/core/x`, every `@formats/akl/1/index.ts` becomes `@akl/layout-formats/akl/1`; `bot.yml`'s `test` job builds both packages first (`npm run build:formats` in `db/`, `npm run build` in `packages/akl-core/`) and its trigger cones shrink to `bot/**` + the workflow; `bot/tests/tools/boundary.test.ts` forbids **every** relative import that leaves `bot/` (the exception retires); `db/tests/tools/boundary.test.ts`'s outside-scan drops the `bot/ → db/formats` allowance. The site's `web/tests/core/akl1.test.ts` (LDB-S3, `11 §3` D4) may switch from the schema-file read to `@akl/layout-formats`'s `validate` through a `devDependency` `file:` link — a test import, so no archlint change.
4. **`LICENSE` (MIT) in `db/`**; `db/scripts/codeowners.mjs [--check]` generates `.github/CODEOWNERS` lines from every `formats/*/*/OWNERS` (`db/formats/akl/1/ @a @b`; in the split repo the prefix drops) — **LDB-G3**, promised in `04 §6`, unenforced until now.
5. **`db/tests/tools/repo.ts`** — `repoLayout()` → `{ dbPrefix: "db/" | "", workflowPath, hasSiteTree }` by probing for `../web`; `ciwiring`, `boundary`, `frozen` (`git diff … -- ${dbPrefix}formats`) and `fixture-export` (skips its site write when `!hasSiteTree`) read it, so the same tests run unchanged inside the split repo.
6. **`scripts/split-db.sh --dry-run`** (repo root):

   ```sh
   set -euo pipefail
   work=${SPLIT_WORK:-/tmp/akl-split}; rm -rf "$work"; mkdir -p "$work"
   git clone --no-local --quiet . "$work/akl-db"
   git -C "$work/akl-db" filter-repo --quiet \
     --path db --path design/layout-db --path .github/workflows/db.yml \
     --path-rename db/: --path-rename design/layout-db/:docs/decisions/ \
     --path-rename .github/workflows/db.yml:.github/workflows/ci.yml
   git clone --no-local --quiet . "$work/akl-bot"
   git -C "$work/akl-bot" filter-repo --quiet \
     --path bot --path .github/workflows/bot.yml \
     --path-rename bot/: --path-rename .github/workflows/bot.yml:.github/workflows/ci.yml
   # the proof: both repos test green with no edits
   (cd "$work/akl-db"  && npm ci && npm run typecheck && npm test)
   (cd "$work/akl-bot" && npm ci && npm run typecheck && npm test)   # needs the two packages PUBLISHED (file: links point outside the repo) — until then this half runs with SPLIT_BOT_PACKAGES_DIR pointing at built tarballs
   [ "${1:-}" = "--dry-run" ] || echo "push: cd $work/akl-db && git remote add origin <url> && git push -u origin main   (⚠ saltorbit)"
   ```

   `git subtree split --prefix=db -b split/db` is the fallback when filter-repo is unavailable; it cannot carry `design/layout-db/` with history (one prefix per split), which is why filter-repo is the default (§6.11). The dry run is a `db.yml` job `split-dry-run` (`workflow_dispatch` + weekly `schedule`, `needs: test`) — **LDB-G6**.
7. What moves, what stays: **moves** — `db/` (root of `akl-db`), `design/layout-db/` (→ `docs/decisions/`), `db.yml` (→ `ci.yml`); `bot/` (root of `akl-bot`), `bot.yml`. **Stays** — `web/`, `scripts/`, `functions/`, `workers/`, `tools/` (incl. `mana2bridge`), `vendor/`, every other `design/*`, `packages/akl-core/`, `scripts/tests/fixtures/db-responses/` (the site's copy; regenerated by the split repo's `fixture-export` test into a path the site vendors — `11` W1's LDB-S1a becomes "the site's fixture equals the tag of `@akl/layout-formats` it pins"; noted, not built here). **Deleted from this repo at X6:** `gates.sh`'s `dbtest` step, `CLAUDE.md`'s `db/` line, the `design/INVARIANTS.md` pointer rewritten to the new URL.
8. **Secrets/vars to recreate** (⚠, listed in `README.md` § Split so the runbook test sees them): `akl-db` — `CLOUDFLARE_DB_TOKEN`, `CLOUDFLARE_DB_ACCOUNT_ID`, var `DB_BASE_URL`, `NPM_TOKEN` (publish job on tag `formats-v*`); `akl-bot` — `FLY_API_TOKEN`; this repo — `NPM_TOKEN` for `packages/akl-core` (workflow `packages.yml`, tag `core-v*`). Branch protection on both: 1 review, CI green, *Require review from Code Owners* (that is what makes `CODEOWNERS` = `04 §2`'s "owners merge their own format").

| file | asserts | invariant |
|---|---|---|
| `db/tests/tools/package.test.ts` (node) | `npm pack --dry-run --json` in `db/formats` lists `dist/index.js`, every `dist/<f>/1/index.js`, every `schema.json`, no test or fixture file; the `exports` map names every registered format id (derived from the registry, so a fourth format cannot be forgotten); a temp dir `npm i <the packed tarball>` then `node -e 'import("@akl/layout-formats/akl/1").then(m => m.validate({keys:{}}))'` exits 0 | **LDB-G7** |
| `web/tests/tools/package.test.mjs` (site) | the same for `packages/akl-core`: every `web/src/core/**/*.ts` non-test file has a `dist/core/*.js` twin; `import("@akl/core/stats/merge")` resolves `cminiRowFromMana2` | LDB-G7 (site twin; registered as an `I-nnn`) |
| `db/tests/tools/codeowners.test.ts` | `codeowners.mjs --check` passes; every format dir has exactly one line naming exactly its `OWNERS` | **LDB-G3** |
| `db/tests/tools/ciwiring.test.ts` (extended) | `split-dry-run` job exists with the exact triggers; `test` unchanged; the `repoLayout()` prefix logic is unit-tested on both branches (a temp dir with and without a sibling `web/`) — the dry-run job is the proof for the real split | LDB-C1, LDB-G6 |
| `bot/tests/tools/boundary.test.ts` | no relative import leaves `bot/`; `@akl/*` are the only cross-repo imports | LDB-B6 (tightened) |

**DoD:** `npm run build:formats` and the core build green; `bot` tests green on the `file:` links; `scripts/split-db.sh --dry-run` green locally for `akl-db` (saltorbit's machine or CI); the `split-dry-run` job green once; nothing published, nothing pushed.

### X6 — ⚠ the split, the org, the packages, the domain (saltorbit, in this order)

1. Reserve the npm scope; `NPM_TOKEN` into this repo; tag `core-v0.1.0` → `packages.yml` publishes `@akl/core`; tag `formats-v0.1.0` in `db/` → `db.yml` publishes `@akl/layout-formats`.
2. `bot/package.json` and the site test switch the `file:` links to the published versions (one PR, agents may prepare it).
3. Create the org, add the second owner; `scripts/split-db.sh` (no `--dry-run`), push both repos; recreate the secrets of X5 item 8; branch protection; enable *Require review from Code Owners*.
4. In the new `akl-db` repo: `ci.yml` green, `deploy` runs once (same Worker, same D1 — nothing moves in Cloudflare), `vars.DB_BASE_URL` set; in this repo: delete `db/`, `bot/`, `design/layout-db/`, both workflows, the `gates.sh` step, the CLAUDE.md line; rewrite the `design/INVARIANTS.md` pointer.
5. Domain (`08 §2` item 4): register inside the `akl` account, attach as a Workers custom domain, `vars.DB_BASE_URL` on the site → the hostname; the WAF rate-limit rule from `09 §6.2`.

### X7 — layout-dates backfill: **closed** (§0.6, §6.10). Nothing to run.

## 4. Conformance enumeration added (the T6 sweep's table grows)

| route | 2xx | errors |
|---|---|---|
| `POST /v1/webhooks` | 201 | A, 400 `bad_request` (url / secret / kinds / owner_filter), 409 `too_many_webhooks`, 429 |
| `GET /v1/webhooks` | 200 (own) · 200 (`?all=1` admin) | A, 403 `not_admin` (`?all=1` by a user) |
| `DELETE /v1/webhooks/{id}` | 200 | A, 404, 429 |
| `GET /v1/changes/stream` | 200 (`text/event-stream`; the case asserts headers and the first frame only) | 400 `bad_request` (since / Last-Event-ID / kinds), 503 `stream_unavailable` |
| `GET /v1/changes` (+`layout=`, `actor=`) | 200 | 400 `bad_request`; `layout` unknown → 404 `not_found` |
| `GET /admin/changelog` | 200 (`text/html`) · 304 | 400 `bad_request` |
| `POST /v1/admin/drill` | 200 | A, 400, 403, 429 |
| `GET /v1/admin/health` | 200 | A, 403 |
| `GET /v1/meta` | 200 (now with `last_diff`, `last_drill`) | (unchanged) |
| `GET /v1/layouts/{ref}?as=mana2/1` · `?as=akl/1` of a held mana2 record | 200 · 409 `held` | (unchanged rows) |

## 5. Invariants added (phase 5) — rows for `db/INVARIANTS.md`

| id | invariant | enforced by |
|---|---|---|
| LDB-H1 | Webhook delivery is at-least-once and in order per hook: every matching event past a hook's cursor is POSTed with a valid signature before the cursor passes it, and never concurrently -- the cursor is advanced only by the drain holding that hook's lease (LDB-H6), never by a bare cursor CAS. A duplicate `seq` reaching a receiver is possible only after a drain dies holding a lease (its last POST may have landed before it died); otherwise every matching event is delivered exactly once | `tests/api/webhooks.test.ts` |
| LDB-H2 | The stream is the feed: the frames of any stream, and of any chain of streams reconnected by `Last-Event-ID`, are exactly `/v1/changes`' items past the original `since`, in order, no gap, no duplicate; every stream closes at the bound with `next` | `tests/api/stream.test.ts` |
| LDB-H3 | The changelog page shows exactly the feed's events for its parameters, with every interpolated value HTML-escaped | `tests/api/changelog.test.ts` |
| LDB-H4 | A webhook secret never leaves the `webhooks` table: no response body, no event, no dump carries it | `tests/api/webhooks.test.ts` (scans), `tests/api/dump.test.ts` (`webhooks: []`) |
| LDB-H5 | A drain with nothing to deliver writes zero D1 rows; a delivered batch writes exactly two `webhooks` rows per hook (the LDB-H6 lease claim, then the commit) | `tests/api/webhooks.test.ts` (statement counter) |
| LDB-H6 (2026-09-11) | A hook is claimed (one CAS UPDATE on `lease_id`/`lease_until`, re-checking EVERY due condition -- `status`, `next_at`, `cursor < head` -- not just the lease) before `drain()` reads its feed page or POSTs anything, and `commitOutcome()` CASes on that same `lease_id` (never on `cursor`) and releases it in the same statement -- so no two drains ever have a POST in flight to the same hook at once, `failures`/`cursor` can never be lost or clobbered by a racing second attempt, a hook another drain is mid-batch on is never disabled out from under it, and a drain holding a stale `due` snapshot (from before a concurrent commit pushed `next_at` into the future) can never bypass that backoff. The claim's clock and lease-until are read FRESH per hook, right at the claim -- never a `now`/`wallNow` sample taken once at the top of `drain()` -- since a drain can run far longer than one lease across many hooks. The lease is real-time bounded and always NULL again once every concurrent `drain()` call touching a hook has resolved -- except when a drain dies while holding it, in which case the hook simply waits out `lease_until` before the next drain reclaims it | `tests/api/webhooks.test.ts` (`[LDB-H6] claim-before-send lease`: real interleaving, concurrent failures, the partial-failure-vs-success race, lease expiry, the stale-claim-clock and due-recheck regressions, and a property test) |
| LDB-P3 (now enforced) | A follower's state from webhooks alone (drops, reorders, duplicates) equals its state from the feed alone | `tests/events/feed.test.ts` |
| LDB-F5 / F7 (mana2 rows) | `mana2 → akl → mana2` is identity under `normalizeMana2()`; `akl → mana2 → akl` is identity off the thumb row; every declared translation has a frozen golden | `tests/formats/mana2.test.ts`, `goldens.test.ts` |
| LDB-F12 | The DB's `akl/1 → mana2/1` grid and thumb strings equal the site's `bridgecore.ConvertLayout` output for every cmini fixture (modulo trailing `skip`s) | `tests/formats/mana2-convert-parity.test.ts` + the frozen converter snapshot |
| LDB-F13 | The set of vendored mana2 layouts held for `akl/1` is enumerated with reasons; a new held case fails until listed | `tests/formats/mana2.test.ts` |
| LDB-C4 | The diff cron reads our side from D1 directly and never fetches its own origin; it is one invocation, bounded by ⌈records/500⌉ pages | `tests/import/difftick.test.ts` |
| LDB-M1 | `/v1/meta.last_diff` and `.last_drill` are `{at, ok}` written on every run including failures; the site's meta-watch warns when either is older than 48 h (site half, W-lane) | `tests/import/difftick.test.ts`, `tests/api/admin.test.ts`; the site's `web/tests/backend/metawatch.test.js` |
| LDB-G3 (finally enforced) | `.github/CODEOWNERS` is generated from every format's `OWNERS` | `tests/tools/codeowners.test.ts` |
| LDB-G6 | The split repos test green with no edits (`split-db.sh --dry-run`) | `db.yml` `split-dry-run` job |
| LDB-G7 | `@akl/layout-formats` packs every format's entry and schema and imports cleanly in a clean install; the `exports` map is derived from the registry | `tests/tools/package.test.ts` |

## 6. Decisions taken in this round (ledger; flip any of them)

1. **No `webhook_deliveries` table; the hook's cursor is the ledger** (§2.1). Cheaper by two orders of magnitude, idempotent by construction, and literally "the feed pushed". Round 1's per-attempt rows are cut.
2. **Backoff 1 min / 10 min / 1 h, then hourly until 7 days → `disabled`.** `03 §5`'s "10 s / 1 min / 10 min" is below the cron's granularity; the immediate attempt is the `waitUntil` nudge.
3. **`secret` is stored, not hashed** — an HMAC needs it; the compensations are LDB-H4 and dump exclusion.
4. **Webhook CRUD and drill reports emit no events.** They are owner-scoped/ops state, not governance; the feed stays about layouts and admins.
5. **A rehost has no subscriptions** (`Dump.webhooks: []`). Subscribers re-register; the feed (which the dump carries in full) is their recovery anyway.
6. **`/v1/changes` gains `layout=` and `actor=`** so the changelog page is a rendering of the API, never a second query path (LDB-H3 is checkable only because of this).
7. **`GET /v1/admin/health`** carries the full `last_*` bodies; `/v1/meta` only `{at, ok}` — the public poll stays small (meta-watch reads it every 2 min).
8. **A mana2 `space` token becomes a `" "` key** in `akl/1` (and so in `?as=cmini/1`). Lossless, and the site's engine already maps `" "` to mana2's `space` (`GridToken`); the site's UI shows a blank thumb cap for such a record. Dropping it would break `mana2 → akl → mana2` for 75/75 vendored files.
9. **`mana2/1` edits: `setFingermap` only.** `setBoard`/`setMagic` are `unsupported_for_format` — a mana user edits the file.
10. **X7 cut** (§0.6): 16 records' `created_at` older in the file, no verb can set it, and the site keeps reading the file until it reads records.
11. **`git filter-repo`, not `git subtree split`,** for the split: two prefixes with renames and history in one pass; subtree is the documented fallback.
12. **`@akl/core` includes `web/src/copy`** (13 core files import it); the package's `exports` are the `core/` tree only.
13. **The pure registry moves to `db/formats/registry.ts`**; `src/formats/registry.ts` wraps it. One list of formats, importable by the package.
14. **X4b (deleting `db.yml`'s daily steps) is a separate dated PR** after 7 green days of both crons **and** the site-side stale warning — never a test with a date in it.
15. **The stream is Paid-plan only** and self-reports `503 stream_unavailable` when disabled; nothing else in the design depends on it (the bot polls with ETag, `05 §4`).

## 7. Cut from the round-1 draft (and why)

- **`webhook_deliveries`** — §6.1.
- **`changelog.html` in the nightly dump** — nobody reads a static HTML in R2; the dump is a restore artifact (`03 §5`'s sentence is removed).
- **A `ciwiring` row asserting "the daily step is gone after <date>"** — a test that flips on a calendar day; X4b edits the test when it deletes the step.
- **The retry cron "draining `webhook_deliveries` rows whose `next_at` passed"** — replaced by the cursor drain.
- **X7 and the dates migration** — §0.6.
- **Per-hook test/redeliver/pause endpoints, a webhook `admin.*` event, secret rotation** — none asked for; `DELETE` + `POST` is rotation.
- **Batching the diff over ticks** — measured unnecessary (0.3).
- **A `mana2/1` lift of untyped rules** — `01 §3` forbids lifting untyped rows without the author.
- **A site archlint rule for the bot** — never existed (0.2); the two boundary tests are the enforcement.

## 8. Questions only saltorbit can answer

1. **Plan:** is the `akl` account on Workers Paid (as `07 §1` decided)? If not: the stream and X4's cron are off, and the import's full pass is already over the 10 ms CPU cap — check `wrangler tail` for `Exceeded CPU` on the `*/5` cron before anything else.
2. **Names:** the npm scope (`@akl` vs `@aklgg`), the org, the two repos, the hostname.
3. **`mana2/1` `OWNERS`:** Zak (needs a GitHub handle for CODEOWNERS), or the maintainers with the "mirror of the loader at `<commit>`" note (§1's default)?
4. **§6.8** — a `" "` key on akl.gg for mana2-authored records: fine, or should the site's card hide it?
5. **§6.10** — X7 stays cut, or do you want those 16 `created_at` values patched by hand (a one-off SQL, outside the covenant's writer rule, auditable in the PR)?
6. **X4b's trigger** — delete `db.yml`'s daily steps after 7 green days (as written), or keep the CI copy indefinitely as the red-mail channel?
7. **X6** — every step is yours; the PR descriptions carry the commands.

## 9. What can start when

- **Now:** X1 (needs T3/T5 on the branch — present), X2 (needs S3 — present; the vendored files are read from the main checkout), X3 (needs S6), X4's DB half (needs S8 and T3 — present; the Fly half waits on §1).
- **After X2:** X5 (the package's `exports` map enumerates three formats; U1/U2 are on the branch, so `@akl/core` has nothing to wait for).
- **Blocked on saltorbit:** X6 entirely; the Fly drill; §8.
