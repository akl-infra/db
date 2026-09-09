# Implementation — phase 1, the mirror

Status: plan, round 2 (2026-09-08; round-1 text reviewed and rewritten
against the live upstream and the real toolchain). Part of `00-plan.md` (§5
phase 1). Written so a strong-but-literal coding agent can land each slice
as a PR from this document alone: every slice names its files, signatures,
error bodies, tests and the `LDB-*` invariants those tests enforce.
Phases 2–5 get their own doc when phase 1 is on `main`.

## 0. What phase 1 delivers, and what it does not

Delivers: `db/` as a deployable Cloudflare Worker with its own D1 and R2;
two registered formats (`cmini/1`, `akl/1`) with lossless translation both
ways; a continuous one-way import from cmini; read-only `/v1` (meta, list,
detail with `?as=`, likes, history, revs, authors, formats, changes, dump);
the nightly dump; the D12 mirror diff as a daily CI job; the rehost drill as
a test. Nothing on akl.gg changes. No writes, no auth, no bot.

Does not deliver: any write endpoint, either auth lane, admin routes,
webhooks, the SSE stream, `mana2/1`, `layout_revs` compaction, `?fields`,
`Idempotency-Key`, rate limits, the site cutover. Those are phases 2–5 or
cut (§12).

### 0.1 Measured upstream facts (live `layoutapi/v3`, 2026-09-08)

Every schema decision below cites this table. Re-measure with
`db/tests/tools/profile-upstream.mjs` (S2) before changing a rule.

| fact | value | consequence |
|---|---|---|
| layouts / authors | 4174 / 420 | initial import ≈ 19 k D1 rows (§6 S5) |
| `board` | ortho 3333 · angle 545 · stagger 291 · mini 5 | all four words are fixtures |
| list fields | `id name user board tag blame key_count created_at modified_at` always; `has_thumbs like_count link has_magic has_combos` when non-zero/non-empty | `like_count` absent ⇒ 0; `link` is payload, not record (below) |
| detail fields | `name user board tag blame created_at modified_at keys` always; `likes free magic link combos` optional | the `cmini/1` payload keeps `tag blame combos link` (§5.1); `link` is **import fidelity only** — no record field, no verb (00 §6) |
| `id` vs `name` | `id == name.toLowerCase()` for all 4174; 184 differ by case (`AdNW`) | `import_map.upstream_id` is the lowercase id; `name` keeps case |
| names | 2–65 chars (`io` is 2); charset `a-zA-Z0-9 _ - . ' ( ) : ; < > ~`; no spaces, all ASCII; no case-insensitive duplicates; none ULID-shaped | imported names bypass `check_name` (LDB-I5); refs resolve id-first (03 §1) |
| `?full=1` | one 5.3 MB response, 4174 entries, **no `id`**; `name` unique | join by `name` (port of `batch_join_details`) |
| `keys` | rows 0–4 (row 4: 8 keys on 2 layouts); cols 0–25; no negative cols; fingers `LP LR LM LI RI RM RR RP LT RT TB`; row 3 carries non-thumb fingers on 39 keys, rows 0–2 carry thumb fingers on 9; 52 layouts have **empty** `keys`; no duplicate positions; every char one code point; keys sorted by char | validation is the measured envelope, not the bot's rule (§5.1) |
| `free` | 69 layouts; entries `{row, col, finger}` | |
| `magic` | 15 layouts, 343 rows; `type` ∈ `magic 164 · repeat 162 · adaptive 16` and **absent on 1 row** (whirl); `inputs` is **3 code points on 4 rows** (opal-e200, opalbetter: `he*→her`); no duplicate `inputs`; opal's `?◇` names a char not in `keys` | `type` optional; `inputs` ≥ 2 code points; rule chars need not be keys (01 §2.1) |
| `combos` | 2 layouts (crescent 33 rows, finch 8), `{inputs, output}` | carried verbatim in `cmini/1`; `x.cmini.combos` in `akl/1` |
| `tag` / `blame` | `tag` = `cmini` on all; `blame` = `cmini` 4053 / `dmini` 121 | opaque strings, preserved |
| `likes` | 2035 total; list `like_count` equals `len(likes)` on every layout; likes do **not** move `modified_at` | like drift detected from the list's `like_count` |
| `user` | JSON string on all | stored as text |
| `created_at` | spans 2022-12-07 … today; 1965 have `created == modified` | 06 §1's "stamped 2026-08-20" note is stale — see 06 Q1 |
| UA | default `urllib`/`fetch` UA is 403'd | send `User-Agent: akl-db-import/1.0` on every request |
| 404 on a listed id | happens (created-then-deleted between list and detail) | = deletion this tick, bounded like prune |

## 1. Before the first PR — decisions and hand-made things

| need | default if unanswered | blocks |
|---|---|---|
| Service name / hostname (`00 §6.2`) | Worker `akl-db`, served at `akl-db.<account>.workers.dev` until a hostname is picked. **The Cache API (`caches.default`) is inert on `*.workers.dev`**; ETag/304 works regardless (S6), so only the edge-cache half of `03 §5` waits on a hostname | nothing in phase 1 |
| Cloudflare account | **Decided (saltorbit, 2026-09-09): a NEW account for the community**, not the site's — saltorbit + the second admin as Super Administrators from day one, Workers Paid billed to it. Phase 1 serves from `akl-db.<account>.workers.dev`; a domain registered *inside* that account comes later (a Workers custom domain must live on a zone in the same account; `04 §1`) | deploy (S7) |
| D1 `akl-db`, R2 `akl-db-dumps` | created by hand once (`wrangler d1 create akl-db`, `wrangler r2 bucket create akl-db-dumps`); ids into `db/wrangler.toml`; R2 lifecycle rule "delete `dump-*` after 90 days" set by hand (runbook) | S7 |
| CI deploy token | an **Account-owned** API token (Manage Account → Account API Tokens — survives member changes; a user-owned token dies with its creator) with Workers Scripts:Edit, D1:Edit, R2:Edit, Account Settings:Read; repo secrets `CLOUDFLARE_DB_TOKEN` and `CLOUDFLARE_DB_ACCOUNT_ID` (the NEW account's id — the existing `CLOUDFLARE_ACCOUNT_ID` is the site's) | S7 |
| Day-1 admins (`00 §6.4`) | migration `0001` seeds only saltorbit's id; a second row is a phase-2 blocker | phase 2 |
| Confirmations in `00 §0` | assumed as written | nothing |
| Where `LDB-*` invariants are registered | `db/INVARIANTS.md` (moves with the code) + one pointer entry in `design/INVARIANTS.md` (§11) | S1 |

## 2. Toolchain (pinned; versions checked against npm 2026-09-08)

- **Runtime:** Cloudflare Workers, `compatibility_date = "2026-08-22"` (the
  newest date the installed workerd/miniflare accepts as of wrangler 4.130;
  bump when the toolchain does — S1 found `2026-09-01` refuses to boot),
  `compatibility_flags = ["nodejs_compat"]`, ESM, TypeScript compiled by
  wrangler's esbuild — no separate build. Node 24 for tooling. Every
  wrangler script passes `--config wrangler.toml` explicitly (S1: without
  it wrangler 4.130 intermittently misdetects the project as Pages).
- **Router:** `hono@^4.13`. Route handlers return `c.json()`; error bodies
  through `core/errors.ts` only (`ApiError` thrown, `app.onError` is the one
  place that renders it).
- **Validation:** `ajv@^8.20` with `ajv-formats`, JSON Schema 2020-12
  (`new Ajv2020({ allErrors: false, strict: true })`), one compiled
  validator per format at module load. The failing path is
  `error.instancePath` (`/keys/a/row`), surfaced in the 400 body.
- **Tests:** `vitest@^4.1` (NOT 5 — `@cloudflare/vitest-pool-workers@^0.22`
  peers on `^4.1`). **Real API of pool-workers 0.22 (S1, verified):** no
  `/config` subpath and no `defineWorkersProject`; `cloudflareTest` (a Vite
  plugin) and `readD1Migrations` are top-level exports, used inside
  `defineConfig(async () => ({ test: { projects: [...] } }))`. Per-test-file
  storage isolation is automatic (no `isolatedStorage` option). Migrations
  are read once in `vitest.config.ts` into a test-only `TEST_MIGRATIONS`
  binding and applied by `tests/setup-workers.ts` via `applyD1Migrations`
  from `cloudflare:test`. Two projects: `workers` (`tests/api tests/import
  tests/events tests/rehost.test.ts`, inside workerd with miniflare D1 + R2)
  and `node` (`tests/tools tests/core tests/formats
  tests/upstream-diff.test.ts`). Later slices extend the `include` arrays,
  nothing else. `fast-check@^4` for property tests. Outbound HTTP in the
  workers project goes through `fetchMock` from `cloudflare:test` (the
  FakeUpstream is a plain Fetch-shaped fake injected as `fetchImpl`,
  `tests/import/fake-upstream.ts` — S5 found pool-workers 0.22 exports no
  `fetchMock`). Crons are driven by calling the exported `scheduled()`
  with `createScheduledController` + `createExecutionContext` from
  `cloudflare:test` (`SELF.scheduled()` throws `DataCloneError` in 0.22).
  `scheduled()`'s event type is `ScheduledController` (modules format);
  `tsconfig` uses `@cloudflare/workers-types/experimental`.
- **Ids:** `ulidx@^2.4` (`ulid()`; Web Crypto, no Node dependency).
  Monotonicity is per isolate and not relied on — ordering is `events.seq`.
- **Canonical JSON:** `core/canonical.ts` `canonical(v: unknown): string` —
  object keys sorted (code-unit order) recursively, arrays in place, no
  whitespace, `JSON.stringify` scalar formatting. Used for `payload_json`,
  ETags, the D12 diff, the meta token and every byte-identity test. Not
  RFC 8785 (upstream carries only strings/ints/bools/null, so the two
  agree; documented so nobody "upgrades" it).
- **Dependencies rule:** `db/package.json` is its own; nothing in `db/`
  imports from `../web`, `../scripts` or `../functions`, and nothing
  outside imports `db/` (`tests/tools/boundary.test.ts`, LDB-G5). Ports
  are copies with a header comment naming the source file and commit.

## 3. Repository layout

```
db/
  README.md                 what it is · run locally · rehost procedure (04 §4) · secrets/bindings table (LDB-G4)
  INVARIANTS.md             the LDB-* registry: id · statement · enforcing test file (§11)
  package.json              scripts: dev · test · typecheck · migrate · import · deploy · rehost · diff-upstream · profile-upstream
  wrangler.toml             name, D1 + R2 bindings, [triggers] crons = ["*/5 * * * *", "0 3 * * *"], vars
  tsconfig.json             strict; "types": ["@cloudflare/workers-types"]
  vitest.config.ts          the two projects (§2)
  migrations/0001_init.sql  §4
  src/
    index.ts                Hono app + `scheduled(event)` dispatching on `event.cron`
    env.ts                  `Bindings` (DB: D1Database, DUMPS: R2Bucket, IMPORT_SOURCE_URL, IMPORT_MAX_WRITES_PER_TICK, IMPORT_UA)
    core/
      canonical.ts          canonical()
      records.ts            Record type, byRef(), list(), toWire(rec, as) — the only reader of `layouts`
      events.ts             appendWrite(), appendInfo(), foldRecord(), feed() — the only writer of `layouts`/`events`/`layout_revs`
      follows.ts            followsUpstream(db, layoutId)
      etag.ts               etagFor(), conditional(c, etag, cacheControl) + best-effort caches.default
      errors.ts             Err codes + bodies (§6 S6 table)
      time.ts               `now()` injected everywhere (tests pass a fixed clock)
    formats/registry.ts     loads ../../formats/*/N/index.ts; get(id); translate(rec, as)
    routes/                 meta.ts layouts.ts authors.ts formats.ts changes.ts dump.ts
    import/
      upstream.ts           UpstreamClient (UA, retries, 404 → NotFound, ?full=1 join)
      plan.ts               planTick(): pure — (list, local state) → actions
      apply.ts              applyActions(): D1 batches, bounded
      cmini.ts              tick(): meta gate → plan → fetch → apply → state
    dump/
      write.ts              nightly: R2 dump-YYYY-MM-DD.json.gz + latest.json (+ monthly/)
      restore.ts            restoreSql(dump) → string[]; used by `npm run rehost` and rehost.test
  formats/
    cmini/1/  schema.json  index.ts  README.md  OWNERS  fixtures/
    akl/1/    schema.json  index.ts  README.md  OWNERS  fixtures/
  scripts/                  node CLIs behind the package.json scripts (import-once, diff-upstream, rehost, profile-upstream, pick-fixtures)
  tests/
    setup-workers.ts        migrations into the isolated D1; fixed clock
    fixtures/upstream-100/  frozen snapshot: list.json, full.json, authors.json (100 layouts, §5.3) + dump-fixture.json.gz (S7)
    conformance/            <route>/<case>.json request/response pairs (S6)
    vectors/                (phase 2: client-signing.json)
    core/                   canonical.test.ts (property)
    formats/                goldens.test.ts · frozen.test.ts · mutations.test.ts · cmini-envelope.test.ts · roundtrip.test.ts · lift.test.ts · collisions.test.ts · intent.test.ts · x.test.ts
    events/                 fold.test.ts (property) · feed.test.ts · follows.test.ts · names.test.ts
    import/                 fake-upstream.ts · plan.test.ts · cases.test.ts (06 §2 matrix) · tick.test.ts · upstream.test.ts · diff-unit.test.ts
    api/                    meta.test.ts · conformance.test.ts · etag.test.ts · refs.test.ts · list.test.ts · held.test.ts · history.test.ts · dump.test.ts
    tools/                  boundary.test.ts · invariants.test.ts · ciwiring.test.ts · noconst.test.ts · runbook.test.ts
    rehost.test.ts          restore(fixture or REHOST_DUMP_URL) → replay → conformance
    upstream-diff.test.ts   the D12 diff (live; daily job only)
.github/workflows/db.yml    §7
```

## 4. Migration `0001_init.sql`

```sql
CREATE TABLE layouts (
  id            TEXT PRIMARY KEY,                 -- ULID
  name          TEXT NOT NULL COLLATE NOCASE,          -- ASCII case-insensitive (SQLite NOCASE); upstream names are ASCII (0.1)
  owner         TEXT NOT NULL,                    -- Discord user id, as text
  rev           INTEGER NOT NULL,
  created_at    TEXT NOT NULL, modified_at TEXT NOT NULL,
  deleted       INTEGER NOT NULL DEFAULT 0,
  format        TEXT NOT NULL,                    -- 'cmini/1' | 'akl/1'
  payload_json  TEXT NOT NULL,                    -- canonical()
  like_count    INTEGER NOT NULL DEFAULT 0,
  has_magic     INTEGER NOT NULL DEFAULT 0        -- lower(payload).length > 0
);
-- Uniqueness among LIVE records only: a tombstone keeps its literal name
-- (01 §1) and that name is reusable (LDB-P4), so the index is partial.
CREATE UNIQUE INDEX layouts_name_live ON layouts(name) WHERE deleted = 0;
CREATE INDEX layouts_owner ON layouts(owner);
CREATE INDEX layouts_modified ON layouts(modified_at);

CREATE TABLE layout_revs (                        -- every rev, never compacted in phase 1
  layout_id TEXT NOT NULL, rev INTEGER NOT NULL, event_seq INTEGER NOT NULL,
  format TEXT NOT NULL, payload_json TEXT NOT NULL,
  PRIMARY KEY (layout_id, rev)
);

CREATE TABLE likes (layout_id TEXT NOT NULL, user_id TEXT NOT NULL, at TEXT NOT NULL,
  PRIMARY KEY (layout_id, user_id));
CREATE INDEX likes_user ON likes(user_id);

CREATE TABLE authors (user_id TEXT PRIMARY KEY, name TEXT NOT NULL,
  first_seen_at TEXT NOT NULL, last_seen_at TEXT NOT NULL);

CREATE TABLE events (
  seq        INTEGER PRIMARY KEY AUTOINCREMENT,   -- first event is seq 1; /v1/changes?since=0 returns it
  at         TEXT NOT NULL,
  kind       TEXT NOT NULL,
  layout_id  TEXT, name TEXT, owner TEXT,
  rev        INTEGER,                             -- the record's rev AFTER this event; NULL = informational (no rev bump)
  actor      TEXT NOT NULL,                       -- user id | 'system:cmini-import'
  via        TEXT NOT NULL,                       -- 'import:cmini' in phase 1; 'discord' | 'client:<id>' in phase 2
  admin      INTEGER NOT NULL DEFAULT 0,
  detail_json TEXT,                               -- imported: {source, upstream_id, shadowed?}; upstream_changed: the upstream cmini/1 detail
  before_json TEXT, after_json TEXT               -- record minus payload, or NULL
);
CREATE INDEX events_layout ON events(layout_id, seq);
CREATE INDEX events_kind ON events(kind, seq);

CREATE TABLE admins (user_id TEXT PRIMARY KEY, added_by TEXT, added_at TEXT NOT NULL, note TEXT);
INSERT INTO admins VALUES ('184412255822020608', NULL, '2026-09-08T00:00:00Z', 'bootstrap: deeroh');

CREATE TABLE import_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  -- keys: 'cmini.meta_token' (canonical /meta response), 'cmini.last_full' (iso),
  --       'cmini.full_pass_cursor' (sorted upstream id an in-progress capped sweep has reached; S5),
  --       'cmini.paused' ('1'), 'cmini.stalled' (json {at, reason}), 'cmini.last_tick' (json stats)
CREATE TABLE import_map (upstream_id TEXT PRIMARY KEY, layout_id TEXT NOT NULL UNIQUE);
```

D1 facts the code relies on: `db.batch([...])` runs its statements in one
implicit transaction, sequentially, on one connection — so a write is one
batch of `INSERT events` → `INSERT layout_revs (… event_seq = last_insert_rowid() …)`
→ `INSERT OR REPLACE layouts` → (`import_map`, `likes`, like events); ≤ 100
bound parameters per statement (ours ≤ 16); ≤ 100 statements per batch by
our own rule (`apply.ts` chunks). `AUTOINCREMENT` accepts explicit `seq`
values on restore and advances `sqlite_sequence` past them. The write
budget: initial import ≈ 4174 × (layout + rev + event + import_map) + 2035
likes + 2035 like events + 420 authors ≈ 19 k rows; steady state tens/day;
both far under the 100 k/day free-tier cap (memory `d1-write-budget`) and
irrelevant on paid (50 M). Every import write is diff-only (LDB-I1).

`wrangler d1 migrations apply akl-db --remote` works on a
wrangler-created database (it creates `d1_migrations` itself); the site's
hand-created `cb-magic` is the exception, not the rule. S7's deploy job
asserts it by running it.

## 5. The two formats

A format module (`formats/<name>/<N>/index.ts`) exports exactly:

```ts
export const id: `${string}/${number}`;
export const schema: object;                                  // = schema.json
export function validate(p: unknown): ValidationResult;       // { ok: true } | { ok: false, error: ErrBody }
export function lower(p: Payload): Row[] | null;              // [{inputs, output, type}] ; null = format has no magic concept
export const to: Record<string, (p: Payload) => Payload | Held>;    // Held = { held: true, reason }
export const from: Record<string, (p: Payload) => Payload>;
export function hasMagic(p: Payload): boolean;                // lower(p)?.length > 0
```

`ErrBody` is `{ error, message, path?, ...details }` (03 §1). `validate`
runs the schema first, then the semantic rules, then (akl/1) `lower()` for
the collision check; it never throws.

### 5.1 `formats/cmini/1` — cmini's v3 detail minus the record fields

Payload = the upstream detail with `name user likes created_at
modified_at` removed (those are record fields). `link` stays **in the
payload** — the record has no `link` (00 §6), and keeping cmini's value
here is what keeps the D12 diff exact; nothing reads it. Everything else is kept
verbatim so `?as=cmini/1` of an imported record reproduces upstream (0.1):

```jsonc
{ "board": "stagger" | "angle" | "ortho" | "mini",
  "keys":  { "<one code point>": { "row": 0..4, "col": 0.., "finger": "LP|LR|LM|LI|RI|RM|RR|RP|LT|RT|TB" } },   // may be {}
  "free":  [ { "row", "col", "finger" } ],                     // optional
  "magic": [ { "inputs": "<≥2 code points>", "output": "<≥1>", "type"?: "<string>" } ],  // optional; no duplicate inputs
  "combos": [ { "inputs": "<≥2>", "output": "<≥1>" } ],        // optional, opaque to lowering
  "tag": "<string>", "blame": "<string>",                      // optional, opaque
  "link": "<string>" }                                         // optional, opaque: import fidelity only, never surfaced
```

`schema.json`: the above with `additionalProperties: false` at every
level. `validate`: schema, then no duplicate positions in `keys`∪`free`,
no duplicate `magic[].inputs`. **No thumb-row rule and no non-empty rule**
— both are violated by live upstream data (0.1) and the format's job is to
hold what cmini holds. `lower(p)` = `p.magic ?? []` with `type` defaulted
to `"raw"` when absent. `to["akl/1"]` = 01 §6.1; `from["akl/1"]` = 01 §6.2.

The record-level projection `cminiDetail(record)` (used by `?as=cmini/1`,
the D12 diff and the `full=1` list) is `{ name, user: owner, board, tag?,
blame?, created_at, modified_at, likes: <user ids sorted ascending>,
keys, free?, magic?, combos?, link? }`. Likes are emitted **sorted**, never in
upstream's order (03 §3); the diff sorts upstream's too.

### 5.2 `formats/akl/1` — 01 §2

`schema.json` is 01 §2 exactly, with the round-2 relaxations recorded
there: `keys` may be empty; rows 0–4, cols ≥ 0, finger enum; no thumb-row
rule; `magic.rules[].inputs` ≥ 2 code points; `except` on magic and
chiral keys; `x` is `type: object`, 16 KB cap enforced in `validate`.
`validate` runs the port of `functions/_lib/rules.mjs`'s `validateRuleSet`
(commit as of S3, header comment cites it) plus 01 §2.1's additions, then
`lower()` and the collision refusal with the `magic_collision` body (01 §3,
including the `except` hint).

`lower(p)` is the port of `scripts/magic_interop.py`'s `lower()` from
branch `magic-api-interop` (`git show origin/magic-api-interop:scripts/magic_interop.py`)
with three changes: `except` honoured (a key listed in `except` gets no
scaffold row), `chiral`/`default:<c>` tags emitted, and **no rank-based
dedupe** — two rows on one `inputs` return a collision error instead
(D4). Output order: per magic key (scaffold rows in sorted key order, then
explicit rules in author order), per chiral key, per adaptive swap (in
author order), then `rules[]` in author order. `liftRules(rows, keys)` is
the port of `lift()`, unchanged except: a row whose `inputs` is not 2 code
points, or whose tag is absent/unknown, is a leftover (kept as
`magic.rules` with its tag, `"raw"` when absent).

`to["cmini/1"]`: 01 §6.2 (`board.cmini` wins, else derived; `magic` =
`lower()`; `x.cmini.{tag,blame,combos}` copied back out; every other `x`
key dropped). `from["cmini/1"]`: 01 §6.1 (`tag blame combos` → `x.cmini`;
typed rows → exact lift, leftovers → `magic.rules`).

### 5.3 Fixtures (frozen from the day they merge — LDB-F6)

`tests/fixtures/upstream-100/` is a checked-in snapshot of 100 live
layouts (`list.json` entries + `full.json` details + `authors.json` for
their owners), picked by `scripts/pick-fixtures.mjs` so that every row of
the 0.1 table has a witness; it is the import fixture, the conformance
seed and the rehost seed. Named members (by upstream id): `graphite`
(ortho; the repo's canonical fixture), `opal` (35 magic rows all
`type: magic`, `?◇` names a non-key), `auditor` (`repeat` + `magic`
rows), `opal-dario` (`adaptive`), `whirl` (one untyped row), `opal-e200`
(3-code-point `inputs`), `crescent` (combos), `sanrie-cmini-test2` (row 4),
`adept` (`TB`), `test12222` (both thumbs; thumb fingers on rows 0–2),
`40kwh` (stagger with a row 3, non-thumb fingers on it), `apt26` (`free`),
`haul` (mini), `abyss` (angle), `adnw` (name `AdNW`, a payload `link`),
`00------higgs` (empty keys), `io` (2-char name),
`02_we've_been_in_this_room_too_long` (apostrophe), plus fill to 100 by
`modified_at` desc.

Per-format fixtures under `formats/<f>/<N>/fixtures/` are the same
payloads split: every cmini member above as `NNN-<id>.json` with its
`.akl-1.json` translation golden; the akl side holds each translation as
its own fixture with `.lowered.json` and `.cmini-1.json` goldens, plus
three hand-written akl-native fixtures that cmini/1 cannot express
(`900-colstag.json` with `board.kind: colstag`; `901-idioms.json` with a
repeat key + `except` + chiral key + adaptive swap + one raw rule;
`902-x.json` with `x.keymaxx` extras and `x.cmini` absent). Goldens are
generated once by `npm run goldens -- --write` and then never regenerated
(LDB-F6's frozen-dir diff fails on any change; a bug fix ships as a new
fixture).

## 6. Slices — PRs in order, each a self-contained brief

Order is a dependency order: S1 → {S2, S4} → S3 (needs S2) → S5 (needs
S2–S4) → S6 (needs S3–S5) → S7 → S8. S2 ∥ S4. Every slice's PR: (1) adds
its rows to `db/INVARIANTS.md`, (2) tags each enforcing test's title with
the id (`[LDB-F1]`), (3) passes `npm test` and `db.yml`. `tests/tools/
invariants.test.ts` fails the PR when an id in the registry has no tagged
test or a tag in a test is not in the registry (LDB-T1) — that is what
"definition of done" means below: the listed tests exist, are tagged, and
are green.

### S1 — `db/` skeleton

**Lands:** `package.json`, `wrangler.toml` (placeholder D1/R2 ids, both
crons, `vars`), `tsconfig.json`, `vitest.config.ts` (two projects),
`migrations/0001_init.sql` (§4), `src/index.ts` with `GET /v1/meta`
returning `{ layout_count: 0, author_count: 0, seq: 0, revision: null,
layouts_modified_at: null, authors_modified_at: null, formats: [] }` from
real D1 queries, `src/core/{canonical,time,errors}.ts`, `src/env.ts`,
`README.md` (skeleton + secrets/bindings table), `INVARIANTS.md` with the
first rows, `tests/setup-workers.ts`, `.github/workflows/db.yml` (§7,
test job only), one line in `web/tests/tools/gates.sh`: a `dbtest` step
running `cd db && npm test` when `db/node_modules` exists and printing a
visible `SKIP (run cd db && npm ci)` otherwise.

**Tests:**

| file (project) | asserts | invariant |
|---|---|---|
| `tests/api/meta.test.ts` (workers) | fresh DB → the zero body above, `Content-Type: application/json` | (S6 replaces) |
| `tests/tools/boundary.test.ts` (node) | no `import`/`require` under `db/src`, `db/formats`, `db/scripts` resolves outside `db/`; no file under `web/src`, `scripts`, `functions`, `workers`, `tools` imports a path containing `/db/` or `db/formats` | **LDB-G5** |
| `tests/tools/noconst.test.ts` (node) | no 17–19-digit numeric literal (a Discord id) under `db/src`; `migrations/` and `tests/fixtures` exempt | LDB-G2 |
| `tests/tools/invariants.test.ts` (node) | every `LDB-*` id in `INVARIANTS.md` appears as `[LDB-*]` in ≥ 1 `test(`/`it(` title under `tests/`; every tag in a title is in the registry; no id in the registry twice | **LDB-T1** |
| `tests/tools/ciwiring.test.ts` (node) | parses `db.yml`: `test` job runs `npm ci && npm test` with `working-directory: db`; `deploy` job `needs: test`, only on `push` to `main`; every `uses:` pinned to a major; triggers' `paths` cone includes `db/**` and `.github/workflows/db.yml` | **LDB-C1** |
| `tests/core/canonical.test.ts` (node) | property (fast-check): `canonical(x) === canonical(shuffleKeys(x))`; `JSON.parse(canonical(x))` deep-equals `x`; strings with `"`/`\`/U+2028/astral chars survive | **LDB-C2** |

**DoD:** `cd db && npm ci && npm test && npm run typecheck` green; `npm
run dev` answers `/v1/meta`; `db.yml` green on the PR; `gates.sh` shows the
`dbtest` step.

### S2 — format registry + `cmini/1`

**Lands:** `src/formats/registry.ts` (`get(id)`, `list()`, `translate(rec,
as)` returning `{ payload } | { held: true, format, see? }`),
`formats/cmini/1/{schema.json,index.ts,README.md,OWNERS,fixtures/}` (§5.1),
`scripts/profile-upstream.mjs` (prints the 0.1 table from the live API),
`scripts/pick-fixtures.mjs` (writes `tests/fixtures/upstream-100/` from
the live API by the §5.3 predicates), the snapshot itself, and the three
generic format test harnesses under `tests/formats/` that S3 reuses:

| file (node) | asserts | invariant |
|---|---|---|
| `goldens.test.ts` | for every registered format × every fixture: `validate` ok; `lower()` deep-equals `NNN.lowered.json` when present; for every `to[<f>]` declared, output deep-equals `NNN.<f>.json` and the target format's `validate` accepts it | LDB-F1, F2, **F7** (both generated from the registry — adding a format or fixture adds rows) |
| `frozen.test.ts` | `git diff --name-only --diff-filter=M origin/main -- db/formats/*/*/schema.json db/formats/*/*/fixtures/` is empty (deletions `D` also fail; additions `A` pass); skipped with a visible notice when `origin/main` has no `db/formats` yet | LDB-F6 |
| `mutations.test.ts` | generated matrix: for every fixture, for every leaf path in the payload, each mutation in {delete, wrong type, empty string, negative number, duplicate sibling (positions, `inputs`)} is refused by `validate` with `path` pointing at that leaf (or its parent for duplicates) — except mutations that produce another valid payload, which are enumerated in the test as `allowed` | LDB-F1 |
| `cmini-envelope.test.ts` | for every entry in `upstream-100/full.json`: `validate(detail minus record fields)` ok; `hasMagic` matches the list's `has_magic` | **LDB-F11** |

**Registry contract:** `translate` uses `to[as]` on the record's format
when `as !== format`; identity when equal; `held` when neither exists.
Unknown `as` → `400 unknown_format`.

**DoD:** the six test files green; `npm run profile-upstream` prints the
0.1 table; the snapshot is committed and ≤ 2 MB.

### S3 — `akl/1` + translations

**Lands:** `formats/akl/1/*` (§5.2), `to`/`from` on both formats, the
akl-side fixtures and goldens (§5.3).

| file (node) | asserts | invariant |
|---|---|---|
| `roundtrip.test.ts` | for every `upstream-100` detail `d`: `cminiDetail(fromCmini(d)) ≡ project(d)` under `canonical` (likes sorted both sides); for every akl fixture `a`: `fromCmini(toCmini(a))` deep-equals `a` minus `x` keys other than `x.cmini` (**colstag is the documented exception**: `board.kind` becomes `ortho` and `stagger` is lost — asserted exactly, not skipped) | LDB-F5 (fixture-level), F10 |
| `lift.test.ts` | property (fast-check generator over valid akl `magic` idioms on a random 20–35-key layout): `liftRules(lower(m)) == (m, [])`; for every cmini fixture with magic: `lower(lift(rows)) ≡ rows` (by `inputs`, `output`, `type`), leftovers ⊆ rows, and every leftover fails its tag's invariant or has a non-2-code-point `inputs`/absent tag | **LDB-F8** |
| `collisions.test.ts` | matrix over {repeat scaffold, `default:<c>` scaffold, explicit rule, chiral scaffold, adaptive half, raw rule}²: the pairs that produce one `inputs` twice are refused with `magic_collision`, `from` naming both paths, and `hint` naming the `except` entry when one side is a scaffold; the pair (scaffold, explicit rule on the same `after`) is NOT a collision (the explicit rule replaces the scaffold row); `except` removes the collision | LDB-F4 |
| `intent.test.ts` | `validate` + store of `901-idioms.json` reads back with `adaptive_swaps` intact (the registry never lowers a stored payload) | LDB-F3 |
| `x.test.ts` | property: random `x` (≤ 16 KB) survives `validate` and identity translation; `x.keymaxx` is absent after `to["cmini/1"]`; > 16 KB is refused with `path: "/x"` | LDB-F10 |
| `goldens.test.ts`, `mutations.test.ts` | (from S2, now over both formats) | F1, F2, F7 |

**What S3 found in the real data (and changed):** (a) `magic_interop.py`
excluded *every* magic/chiral key char from every other key's scaffold;
upstream disagrees (`auditor`: `b` is itself a magic key and still receives
`*`'s repeat row `b*→bb`) — a scaffold excludes only its own key. (b) A
naive lift invents scaffold rows upstream never had (uncovered keys: opal's
`,`) or collides with a real raw row (whirl's `y*→y,`), so `fromCmini` runs
`reconcileScaffoldsToTrueRows` — the `except` hint applied automatically,
exactly 01 §3's rule — and LDB-F8's fixture half is stated over
lift+reconcile, the real import step. (c) `adaptive` pairs are verified by
relowering before they are accepted (`vylet-v4`'s `nh→n'`/`nr→ny` cannot be
a swap); unverifiable halves are leftovers. Caught by running roundtrip
over the whole 100-layout snapshot, not the 18 named fixtures.

**Port notes for the agent:** `validateRuleSet`'s messages keep their text
(they are the bot-voice strings LDB-P7 will pin); the `${layoutId}:` prefix
becomes the record name at the call site. `lower()`'s Python
`_layout_chars(keys, special)` iterates keys sorted by code point — keep
that order. `_emission` (magic-key member of a swap) is ported as is.

**DoD:** all of the above green; `frozen.test.ts` sees no modification of
S2's cmini fixtures.

### S4 — records + events (the fold)

**Lands:** `src/core/{records,events,follows}.ts`. Types:

```ts
type RecordRow = { id, name, owner, rev, created_at, modified_at, deleted: boolean,
                   like_count, has_magic: boolean, format, payload };
type Write = { kind: WriteKind; layoutId?: string /* absent = create */; name; owner; created_at?;
               modified_at; format; payload; actor; via; admin?: boolean; detail?: object; deleted?: boolean };
type Info  = { kind: InfoKind; layoutId; actor; via; detail?: object };
type Like  = { kind: 'liked' | 'unliked'; layoutId; userId; via };

appendWrite(db, now, w): Promise<{ record: RecordRow; seq: number }>   // one batch: event(rev = old+1) → layout_revs → layouts
appendInfo(db, now, i):  Promise<{ seq }>                               // event with rev NULL; layouts untouched
appendLike(db, now, l):  Promise<{ seq; like_count }>                   // idempotent: no-op (no event) when the state already holds
foldRecord(events: Event[], revs: Map<number, {format, payload}>): RecordRow | null
feed(db, since, limit, kinds?): Promise<{ next, items }>
followsUpstream(db, layoutId): Promise<boolean>                         // latest event with rev NOT NULL has via = 'import:cmini'
```

`WriteKind` = `created updated renamed fingermap transferred
deleted restored imported upstream_deleted`; `InfoKind` = `upstream_changed
import_conflict` (phase 2 adds the admin kinds). **The fold rule is
uniform:** a write event sets the record to its `after` (record minus
payload) ⊕ the payload in `layout_revs[(id, rev)]`; `liked`/`unliked`
adjust `like_count` by ±1; info events change nothing. `appendWrite` is
the only code that touches `layouts` and `layout_revs`; `records.ts` only
reads. `rev` continues across `deleted` → `restored`/`imported`.

| file (workers) | asserts | invariant |
|---|---|---|
| `tests/events/fold.test.ts` | property (fast-check, 200 runs × ≤ 40 ops): random sequences of `appendWrite`/`appendInfo`/`appendLike` over ≤ 5 records (creates, updates, renames, deletes, restores, imported, upstream_deleted, likes/unlikes incl. repeats) → for every record, `foldRecord(events for id, revs)` deep-equals the `layouts` row; every write event's `rev` = previous `rev` + 1; info/like events have `rev NULL`; `layout_revs` has exactly one row per write event; `seq` is gapless from 1 | **LDB-P1** |
| `tests/events/feed.test.ts` | `feed(0, 1000)` returns everything in `seq` order; `since` is exclusive; `next` = last seq returned; `limit` capped at 1000; `kinds` filters; after a restore-from-dump (S7 extends) still from 0 | LDB-P6 |
| `tests/events/follows.test.ts` | matrix: sequences {imported}, {imported, updated}, {imported, liked}, {imported, upstream_changed}, {created}, {imported, upstream_deleted}, {imported, deleted(by owner)}, {imported, restored(by owner)} → expected follows = T, F, T, T, F, T, F, F | **LDB-I2a** (the derivation) |
| `tests/events/names.test.ts` | a write with a name equal (case-insensitively) to a live record's fails with `name_taken`; a tombstoned record's name is reusable; `renamed` frees the old name in the same batch | LDB-P4 |

**DoD:** the four files green; `grep -rn "INSERT INTO layouts\|UPDATE layouts" src/` hits only `events.ts`.

### S5 — the cmini import

**Lands:** `src/import/{upstream,plan,apply,cmini}.ts`, `scheduled()` wiring
for `*/5 * * * *`, `npm run import -- --once [--fixture]`.

**`upstream.ts`** — `UpstreamClient(baseUrl, ua, fetchImpl)`: `meta()`,
`list()` (dedupes ids, requires string `id`), `full()` (`?full=1`; returns
entries keyed by `name` with duplicates removed to a `dupNames` set),
`detail(id)` (404 → `NotFound`); 3 retries with 1 s/2 s/4 s backoff on
non-404 failures; every request `User-Agent: <ua>`; JSON parse errors are
failures. Ported from `scripts/sync_cmini_data.py` (`fetch_with_retry`,
`fetch_list`, `batch_join_details`, `parse_snowflake` — snowflakes accepted
as number or numeric string, stored as text).

**`plan.ts`** — pure: `planTick({ list, local, lastFull, now })` →
`Actions`, where `local` = every `import_map` row joined to its record's
`(name, modified_at, like_count, deleted)`. Rules (06 §2):

- listed id not in `import_map` → `fetch` (new);
- listed id in the map and `modified_at` differs, or `like_count ?? 0` ≠
  local `like_count`, or `name` ≠ local name, or the record is tombstoned,
  or `now − lastFull ≥ 24 h` (daily full pass) → `fetch`;
- map rows whose id is not listed → `delete` (bounded: if
  `delete.length > max(5, 0.05 × live records)` → the tick **stalls**:
  `import_state.cmini.stalled = {at, reason}` and no deletes are applied
  until an operator clears the key (runbook); the rest of the tick proceeds);
- list length < 0.5 × live records → the whole tick stalls (collapse guard).

**`apply.ts`** — for each fetched detail (via `?full=1` when > 50 ids are
to be fetched, else per-id GETs; `?full=1` misses fall back to per-id):
build `payload = detail minus {name user likes created_at
modified_at}` (`link` stays in the payload); `validate` (cmini/1) — a failure skips the record and adds
`{id, path, message}` to `cmini.last_tick.errors` (never a tick failure);
then, in one D1 batch per record:

| case | effect |
|---|---|
| new id, name free | `appendWrite({kind: 'imported', name, owner: user, created_at, modified_at, format: 'cmini/1', payload, actor: 'system:cmini-import', via: 'import:cmini', detail: {source: 'cmini', upstream_id}})`; `import_map` row; likes inserted with `appendLike` per user |
| new id, name held by a live local record, **same owner** | `import_map` row + `appendInfo({kind: 'upstream_changed', detail: cminiDetail})` — the local record is not following |
| new id, name held by a live local record, **different owner** | as "new", with `name = <name>~cmini` and `detail.shadowed = { upstream_name }`, preceded by `appendInfo({kind: 'import_conflict'})`; if `<name>~cmini` is taken too, `~cmini2`, … (unreachable until phase 2 writes exist; tested via S4's internal ops) |
| mapped, following, content differs | `appendWrite({kind: 'imported', layoutId, …same fields, deleted: false})` — name/modified_at/payload replaced from upstream; a tombstoned record comes back |
| mapped, following, only likes differ | like diff only: `appendLike` per added/removed user (`actor: user_id`, `via: 'import:cmini'`) |
| mapped, **not** following, content differs | `appendInfo({kind: 'upstream_changed', detail})` — only if `canonical(detail)` differs from the latest `upstream_changed` detail for the record (no repeat on the daily pass) |
| mapped, not following, likes differ | union: `liked` for users upstream has and we lack; never `unliked` |
| delete (or 404 on a listed id), following | `appendWrite({kind: 'upstream_deleted', deleted: true, …})` — the tombstone; name released |
| delete, not following | `appendInfo({kind: 'upstream_deleted'})` once |

"Content differs" = `canonical(cminiDetail(local)) !== canonical(project(detail))`
(likes excluded, compared separately). Writes are capped at
`IMPORT_MAX_WRITES_PER_TICK` (default 500) records per tick; the plan is
recomputed next tick, so the initial import completes in ≤ 9 ticks
(≈ 45 min). **The daily full pass carries a cursor** (`cmini.full_pass_cursor`,
S5): `plan.fetch` (real backlog) is served before `plan.fetchFullPassOnly`
(ids only due for re-verification), and a capped sweep resumes past the
cursor next tick — without it a corpus larger than one cap re-selected the
same ids every tick, never finished the pass, and never stored the meta
token (S5 caught this with the `IMPORT_MAX_WRITES_PER_TICK=20` convergence
test). The meta token is stored only after a
tick that applied everything it planned. Authors: `GET /authors` on every
non-quiet tick; upsert rows whose `name` differs (`first_seen_at = now` on
insert); no events. **An upstream rename is delete + create** (cmini's id
is its lowercase name; matching by content is a phase-2+ heuristic, 06 §2).

**`cmini.ts`** — `tick(env, now)`: `paused` → return; `meta()` → token
equal → return `{quiet: true}`; else list → plan → fetch → apply → authors
→ state. A thrown error leaves the token unchanged (the tick reruns).

| file (workers, FakeUpstream via `fetchMock`) | asserts | invariant |
|---|---|---|
| `tests/import/plan.test.ts` | table-driven over every rule above, including the ≥ 24 h full-pass trigger and both stall conditions; `planTick` is pure (same input → same output, no D1) | **LDB-I3** (prune bound), LDB-I6 (collapse) |
| `tests/import/cases.test.ts` | one `it` per row of the case table, seeded from `upstream-100`, asserting the exact events appended (kind, rev, via, actor, detail), the `layouts` row, `import_map`, `likes` | LDB-I2 (never overwrites a non-following record), **LDB-I4** (every import write carries `via: 'import:cmini'`), **LDB-I5** (imported names bypass `check_name`: `io`, `AdNW`, the apostrophe name all import verbatim) |
| `tests/import/tick.test.ts` | fixture upstream imported twice → second tick is quiet (meta token) → zero new events; same upstream with a changed `revision` but identical content → zero new events (daily pass); 100 layouts import in ≤ 1 tick with the default cap, 20 with `IMPORT_MAX_WRITES_PER_TICK=20` → 5 ticks, all idempotent; `?full=1` used when > 50 to fetch, per-id when ≤ 50 (assert the request log); a 404 on a listed id becomes a tombstone that tick; a shape-invalid detail is skipped and reported; `SELF.scheduled({cron: '*/5 * * * *'})` runs a tick | **LDB-I1** (idempotent), LDB-I7 (meta gate) |
| `tests/import/upstream.test.ts` | UA header on every request; 403 without it (the fake enforces it); 404 → `NotFound` without retry; 500 → 3 tries; `?full=1` join drops duplicate names to the per-id path | LDB-I8 |
| `tests/api/meta.test.ts` (extended) | after the fixture import, `layout_count` = 100, `author_count` = 32 (the snapshot's 48 author *names* map to 32 distinct user ids; `authors` is keyed by id), `seq`, `revision` = `at` of the last event | LDB-R2 |

**DoD:** all green; `npm run import -- --once --fixture` on a fresh local
D1 yields `layout_count: 100`; run twice → `quiet`.

### S6 — reads

**Lands:** `src/routes/{layouts,authors,formats,changes}.ts`, `src/core/etag.ts`,
`tests/conformance/**`.

Routes and semantics (03 §2; the parts round 1 left implicit):

- `GET /v1/layouts` — params `owner format has_magic since sort limit
  cursor as`. `sort` ∈ `name` (default, asc, NOCASE), `modified_at`,
  `created_at`, `like_count` (desc for the three); `limit` default 100, max
  1000; `cursor` opaque (base64 of `[sortValue, id]`, keyset). Rows are the
  record minus `payload`. `deleted` records excluded. `?full=1&as=<f>` —
  every live record with its payload translated, streamed (`TransformStream`,
  keyset pages of 500 from D1); a record held for `<f>` appears as `{ …record,
  held: true, format }` without `payload`. `since=<iso>` filters
  `modified_at > since`.
- `GET /v1/layouts/{ref}?as=` — `ref` matching `^[0-7][0-9A-HJKMNP-TV-Z]{25}$`
  (case-insensitive) is looked up as an id **first**, then as a name; any
  other ref is a name. A tombstone is `404 not_found` by name, `200` by id
  (record with `deleted: true`, payload included). Held → `409 { error:
  "held", held: true, format, see? }`.
- `GET /v1/layouts/{ref}/likes` → `{ user_ids: [sorted] }`; `/history` →
  every event for the id, oldest first, `[{ seq, rev, at, actor, via,
  kind, admin }]`; `/rev/{n}?as=` → the record as of rev `n` (from
  `layout_revs` ⊕ the write event's `after`), `404 not_found` when `n` >
  current or the rev row is missing.
- `GET /v1/authors` → `{ "<name>": "<user_id>" }` (cmini's shape, name-sorted);
  `/v1/authors/{user_id}` → `{ user_id, name, layout_count, liked_count }`.
- `GET /v1/formats` → `[{ id, owner, description, can_translate_to }]`;
  `/v1/formats/{name}/{N}/schema.json` → the file, `Content-Type:
  application/schema+json`.
- `GET /v1/changes?since=&limit=&kinds=` → `{ next, items }` (S4's `feed`).
- **ETag/304** (`core/etag.ts`): `/v1/meta`, `/v1/layouts` (list and
  `full=1`), `/v1/changes`, `/v1/authors` respond with `Cache-Control:
  public, max-age=10` and a strong `ETag: "<head seq>:<sha256(canonical
  query))[:16]>"`; `If-None-Match` equal → `304` with the same two headers
  and no body. The ETag is computed from one indexed read (`MAX(seq)`)
  before any other query, so a 304 costs one D1 read. `caches.default` is
  consulted/put best-effort around the handler (`try/catch`; inert on
  `workers.dev`).
- Error bodies (`core/errors.ts`), the complete phase-1 set:

| status | `error` | extra fields | when |
|---|---|---|---|
| 400 | `bad_request` | `param` | unparsable `limit`/`cursor`/`since`, unknown `sort`/`kinds` |
| 400 | `unknown_format` | `format`, `known: [...]` | `as` not registered |
| 404 | `not_found` | `ref` | no live record by that ref; unknown author; rev out of range; unknown format path |
| 409 | `held` | `held: true`, `format`, `see?` | translation impossible |
| 500 | `internal` | — | anything thrown; body never leaks the stack |

Every body has `error` and `message`; `message` is the human line
(`no layout named 'foo'`).

| file | asserts | invariant |
|---|---|---|
| `tests/api/conformance.test.ts` (workers) | seeds `upstream-100` at a fixed clock, then for every `tests/conformance/<route>/<case>.json`: `SELF.fetch(request)` → status equals, every listed header equals, body deep-equals after `canonical`. Cases are **enumerated**: every route × its success case × every error row above that applies to it, plus `304` for each cached route; a route or error with no case fails the test (the test lists routes from Hono's `app.routes` and errors from `errors.ts`) | **LDB-P7**, **LDB-R3** (conformance = the contract) |
| `tests/api/etag.test.ts` (workers) | matrix over the four cached routes × {no header, matching, stale}: 200/304/200; ETag changes after any event and not otherwise; `Cache-Control` present on 200 and 304 | **LDB-R1** |
| `tests/api/refs.test.ts` (workers) | property: for every record in the seed, lookup by id, by name, by upper-cased name all return it; a ULID-shaped name (seeded via S4's internal op) is reachable by id only; a tombstone by name 404s, by id 200s | LDB-P4, LDB-P8 (phase-1 half: unreadable by name from deletion) |
| `tests/api/list.test.ts` (workers) | property: walking every `sort` with `limit` ∈ {1, 7, 100} through `cursor` visits every live record exactly once, in order; every filter equals a JS filter over the seed; `full=1&as=cmini/1` streams 100 payloads whose `canonical` equals `project(fixture detail)` | LDB-F5 (seed-level), **LDB-R4** |
| `tests/api/held.test.ts` (workers) | a test-only format `held/1` registered in the test (no `to`): a record in it lists, reads as `held/1`, and 409s for `as=akl/1` with `see: "held/1"` | LDB-F9 |
| `tests/api/history.test.ts` (workers) | for every seed record: `/history` = its events; `/rev/{n}` for every n ∈ 1..rev reproduces the payload stored at that rev; `/rev/{rev+1}` 404s | **LDB-R5** |

**DoD:** all green; `tests/conformance/` has ≥ 1 case per (route, status)
pair the enumeration produces; `npm run dev` + `curl -i /v1/meta` twice with
`If-None-Match` shows a 304.

### S7 — deploy + dump + rehost

**Lands:** `src/dump/{write,restore}.ts`, `src/routes/dump.ts`,
`scripts/rehost.mjs`, `db.yml` deploy job, README runbook (secrets/
bindings table; rehost procedure; R2 lifecycle; how to clear
`cmini.stalled`).

- **Dump (cron `0 3 * * *`):** `{ version: 1, date, meta, records: [full
  records with payload], layout_revs, likes, authors, admins, events:
  <all>, import_state, import_map }` — **the whole event log**, not a
  tail (a rehosted service must serve `since=0`). Built from keyset pages
  (500 rows) into one string, gzipped with `CompressionStream('gzip')`,
  `sha256` over the gzip bytes via `crypto.subtle.digest`, put to R2 as
  `dump-YYYY-MM-DD.json.gz`; `latest.json` = `{ date, key, url, sha256,
  bytes, layout_count, seq }`; on the 1st of a month also
  `monthly/dump-YYYY-MM.json.gz`. Retention is the R2 lifecycle rule on
  `dump-` (90 days); `monthly/` is kept.
- **Routes:** `GET /v1/dump` → `302` to `/v1/dump/<latest key>`; `GET
  /v1/dump/latest.json`; `GET /v1/dump/dump-*.json.gz` streams the R2
  object (`Content-Type: application/gzip`, no `Content-Encoding`). No
  public bucket needed.
- **Restore:** `restoreSql(dump): string[]` — `DELETE FROM` every table,
  then batched multi-row `INSERT`s (≤ 100 params each) including explicit
  `events.seq`; `npm run rehost -- --dump <file|url> [--remote]` runs
  `wrangler d1 migrations apply akl-db --local|--remote` then `wrangler d1
  execute … --file restore.sql`; refuses a non-empty `layouts` table
  without `--force`.

| file | asserts | invariant |
|---|---|---|
| `tests/rehost.test.ts` (workers) | seed → run the dump cron (`SELF.scheduled({cron: '0 3 * * *'})`) → read the R2 object → gunzip → `restoreSql` into a **second** isolated D1 (the test's own binding, wiped) → for every record `foldRecord(events) == layouts` (P1 replay), `/v1/meta` equal on both, `/v1/changes?since=0` byte-equal, every conformance case green against the restored DB; when `REHOST_DUMP_URL` is set (the daily job) the dump comes from there instead of the cron | **LDB-G1**, LDB-P6 (from 0 after restore) |
| `tests/api/dump.test.ts` (workers) | `latest.json` fields; `sha256` matches the bytes served; `302` target exists; monthly key written on the 1st (fixed clock) | **LDB-D1** |
| `tests/tools/runbook.test.ts` (node) | every binding and `vars` key in `wrangler.toml`, and every `env.X` read in `src/`, appears in README's secrets/bindings table with a regeneration line | LDB-G4 |
| `tests/tools/ciwiring.test.ts` (extended) | deploy job: `needs: test`, `if: github.ref == 'refs/heads/main' && github.event_name == 'push'`, steps `migrations apply … --remote` before `wrangler deploy`; the daily job exists with both scripts | LDB-C1 |

**DoD:** all green; `db.yml` deploy job ran once on `main` and `GET
https://akl-db.<account>.workers.dev/v1/meta` answers; the first nightly
dump exists in R2 (`latest.json` resolvable).

### S8 — the D12 diff + first real import

**Lands:** `scripts/diff-upstream.mjs` + `tests/upstream-diff.test.ts`;
the daily job in `db.yml`.

`diff-upstream`: `GET upstream /layouts?full=1` + `/authors` (UA); `GET
ours /v1/layouts?full=1&as=cmini/1` + `/v1/authors`; for every upstream
entry: ours by `name.toLowerCase()` → missing / `canonical(project(up)) !==
canonical(ours)` → a diff line naming the first differing JSON path;
records here not upstream (that follow upstream) → extra; `/v1/meta
.layout_count` vs upstream; authors map equality. Prints a summary and
exits 1 on any difference. Not-following records are skipped (none in
phase 1). `upstream-diff.test.ts` runs it against `DB_BASE_URL` with
retries for 30 min on network failure, then **fails** — no skip semantics
(the `ci-gate-split-256` lesson: a skip nobody reads is a pass).

| file | asserts | invariant |
|---|---|---|
| `tests/upstream-diff.test.ts` (node, daily job) | zero differences | **LDB-P5** |
| `tests/import/diff-unit.test.ts` (node) | `project()`/compare over `upstream-100` against itself → zero; against a mutated copy → the mutated path is named | LDB-P5 (unit half) |

**DoD:** the daily job green three days running with `layout_count` equal
to upstream's; `npm run diff-upstream` locally reports zero.

## 7. CI — `.github/workflows/db.yml`

- **On PR and push touching `db/**` or `db.yml`:** job `test` —
  `working-directory: db`, `npm ci`, `npm run typecheck`, `npm test`
  (both vitest projects; `frozen.test.ts` needs `fetch-depth: 0` and
  `origin/main`).
- **On push to `main`:** job `deploy`, `needs: test`: `wrangler d1
  migrations apply akl-db --remote` then `wrangler deploy`. Secrets:
  `CLOUDFLARE_DB_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` (already present for
  Pages).
- **Daily 04:00 UTC** (`schedule` + `workflow_dispatch`): job `daily` —
  `REHOST_DUMP_URL=$(curl …/v1/dump/latest.json | jq -r .url) npx vitest
  run tests/rehost.test.ts` (LDB-G1) and `DB_BASE_URL=… npx vitest run
  tests/upstream-diff.test.ts` (LDB-P5). Real network; fails loud.
- Wiring is asserted by `tests/tools/ciwiring.test.ts` (S1/S7).

## 8. Local development

```
cd db && npm ci
npm run migrate                    # wrangler d1 migrations apply akl-db --local
npm run import -- --once --fixture # 100-layout snapshot into local D1 (offline)
npm run import -- --once           # one real tick against clemenpine.com (≈ 2 s quiet, ≈ 20 s cold)
npm run dev                        # wrangler dev; GET http://localhost:8787/v1/meta
npm test                           # both projects; `npx vitest run --project node` / `--project workers`
npm run diff-upstream              # S8; DB_BASE_URL defaults to http://localhost:8787
```

`IMPORT_SOURCE_URL` defaults to `https://clemenpine.com/layoutapi/v3`;
tests never touch it (`fetchMock` refuses unmatched requests). Driving the
cron by hand: `wrangler dev --test-scheduled` + `curl
"http://localhost:8787/__scheduled?cron=*/5+*+*+*+*"`; against production
D1: `wrangler dev --remote --test-scheduled`.

## 9. Definition of done (phase 1)

1. `akl-db` deployed; after the initial import (≤ 9 ticks) `/v1/meta
   .layout_count` equals cmini's `/v3/meta` on every quiet tick.
2. The daily `diff-upstream` job reports zero differences three days
   running.
3. The nightly dump exists in R2 and the daily `rehost.test.ts` against it
   is green.
4. Every `LDB-*` in §11 is in `db/INVARIANTS.md` with a tagged, green test
   (`invariants.test.ts`); `design/INVARIANTS.md` carries the one pointer
   entry (§11); `gates.sh` and `db.yml` are green.
5. Nothing on akl.gg has changed. The proposal pages may link to the live
   `/v1/meta` as "it exists" (one sentence; copy sign-off).

## 10. What phase 2 will need from phase 1 (so phase 1 doesn't paint over it)

- `events.via`/`admin` exist now; phase 2's lanes add no migration to the
  log. `via` vocabulary: `import:cmini` (phase 1), `discord`, `client:<id>`
  (phase 2).
- `appendWrite`/`foldRecord` are the only materialisation path; phase 2's
  routes are "validate, authorize, `appendWrite`". `WriteKind` already
  lists the phase-2 kinds.
- `followsUpstream` reads `via`, so a phase-2 write automatically stops a
  record following (LDB-I2a).
- Format `edits?: { setFingermap, setBoard, … }` for PATCH verbs are not
  built; the module shape leaves the slot.
- `has_magic` is maintained on every write from `hasMagic(payload)`.
- `check_name` (03 §3) is phase 2; phase 1 only guarantees imported names
  are stored verbatim (LDB-I5) and that ULID-shaped refs resolve id-first.

## 11. Invariant registry for phase 1 (seeds `db/INVARIANTS.md`)

Ids from `01`–`04` keep their numbers; new ones are added here and
back-filled into the docs' tables. `design/INVARIANTS.md` gets one entry —
**I-nnn `db/` is governed by `db/INVARIANTS.md`; `gates.sh` runs its
coverage check (LDB-T1)** (the next free number at landing — I-212 is
already taken on `main`) — rather than one `I-nnn` per `LDB-*`, because
the registry has to move with the code at the split (00 §7).

| id | invariant | enforced by |
|---|---|---|
| LDB-C1 | `db.yml`'s shape (test job on PR/push under `db/**`; deploy needs test, main+push only, migrations before deploy; daily job runs rehost + diff; actions pinned) is asserted from the parsed YAML | `tests/tools/ciwiring.test.ts` |
| LDB-C2 | `canonical()` is key-order-invariant and lossless | `tests/core/canonical.test.ts` |
| LDB-D1 | The nightly dump is complete (every table, the whole event log), its `latest.json` sha256 matches the object served, and the monthly copy is written on the 1st | `tests/api/dump.test.ts`, `tests/rehost.test.ts` |
| LDB-F1 | Every stored payload validates against its format's frozen schema; a write that does not is refused with the failing path | `goldens.test.ts`, `mutations.test.ts` |
| LDB-F2 | `lower()` is deterministic across versions | `.lowered.json` goldens |
| LDB-F3 | Intent is never lowered on store | `intent.test.ts` |
| LDB-F4 | Lowering collisions are refused with both sources named | `collisions.test.ts` |
| LDB-F5 | `cmini/1 → akl/1 → cmini/1` is identity on the projection, for every fixture and (P5) the live set | `roundtrip.test.ts`, `list.test.ts`, S8 |
| LDB-F6 | Merged format majors are immutable | `frozen.test.ts` |
| LDB-F7 | Every format has ≥ 1 fixture and a frozen golden per declared translation | `goldens.test.ts` (generated) |
| LDB-F8 | `liftRules(lower(m)) == (m, [])` for every valid idiom set; `lower(lift+reconcile(rows)) ≡ rows` for every typed row set (the import's lift, `except` hints applied); leftovers are exactly the rows that fail their tag's invariant, are untyped, not 2 code points, or an unverifiable `adaptive` half | `lift.test.ts` |
| LDB-F9 | A held record keeps name/owner/rev and reads as its own format | `held.test.ts` |
| LDB-F10 | `x` survives same-format round trips; only `x.cmini` survives `to["cmini/1"]` | `x.test.ts` |
| LDB-F11 | Every live upstream detail (snapshot) validates as `cmini/1` and `hasMagic` matches upstream's `has_magic` | `cmini-envelope.test.ts` |
| LDB-G1 | Restorable from a public dump + the public repo | `rehost.test.ts` (daily against the real dump) |
| LDB-G2 | No admin id is a constant in code (the migration seed is data) | `noconst.test.ts` |
| LDB-G4 | Every binding/var the Worker reads is in the runbook table | `runbook.test.ts` |
| LDB-G5 | Nothing imports across the `db/` boundary in either direction | `boundary.test.ts` |
| LDB-I1 | The import is idempotent: the same upstream state twice appends zero events | `tick.test.ts` |
| LDB-I2 | The import never overwrites a record that does not follow upstream | `cases.test.ts` |
| LDB-I2a | "Follows upstream" ⇔ the record's latest rev-bumping event has `via = import:cmini` | `follows.test.ts` |
| LDB-I3 | Tombstoning more than `max(5, 5 %)` of live records in one tick stalls the import instead | `plan.test.ts` |
| LDB-I4 | Every import event carries `via = import:cmini` and `actor = system:cmini-import` (likes: the liking user) | `cases.test.ts` |
| LDB-I5 | Imported names are stored verbatim (case kept, `check_name` not applied) and are unique case-insensitively | `cases.test.ts` |
| LDB-I6 | A list shorter than half the live record count stalls the whole tick | `plan.test.ts` |
| LDB-I7 | A tick whose `/meta` token is unchanged makes no further request and writes nothing | `tick.test.ts` |
| LDB-I8 | Every upstream request carries the UA; 404 is never retried; other failures are retried 3× | `upstream.test.ts` |
| LDB-P1 | Every write appends exactly one rev-bumping event and one `layout_revs` row; the record equals the fold of its events; `seq` is gapless | `fold.test.ts` |
| LDB-P4 | A name is released only by delete or rename | `names.test.ts`, `refs.test.ts` |
| LDB-P5 | Every following record read `?as=cmini/1` equals upstream on the projection (likes sorted) | `upstream-diff.test.ts` (daily) |
| LDB-P6 | `/v1/changes` serves from `since=0`, including after a restore | `feed.test.ts`, `rehost.test.ts` |
| LDB-P7 | Every error response carries `error` and `message`; every (route, status) pair has a conformance case | `conformance.test.ts` |
| LDB-P8 | A tombstone is unreadable by name from the moment of deletion (phase 1 half; the 30-day restore is phase 2) | `refs.test.ts` |
| LDB-R1 | Polled routes carry `Cache-Control` + strong `ETag` and answer `304` to a matching `If-None-Match`; the ETag changes iff the event head or the query changes | `etag.test.ts` |
| LDB-R2 | `/v1/meta` counts and `seq`/`revision` equal the tables | `meta.test.ts` |
| LDB-R3 | The conformance fixtures are the API contract; changing one is a documented API change | `conformance.test.ts` (+ review) |
| LDB-R4 | Every `sort` × `limit` cursor walk visits every live record exactly once | `list.test.ts` |
| LDB-R5 | `/rev/{n}` reproduces the payload stored at rev `n` for every n | `history.test.ts` |
| LDB-T1 | Every registry id has a tagged test and every tag has a registry row | `invariants.test.ts` |

## 12. Cut from the round-1 text for phase 1 (and why)

- **`layout_revs` compaction** — 4174 × ~1.3 KB per rev is nothing; a
  compaction rule is a bug surface with no payoff yet. P6 reworded.
- **`?fields=`** on the list — rows already omit `payload`; nothing else is
  heavy. Removed from 03 and 06.
- **`events_tail: last 10k` in the dump** — replaced by the whole log; a
  rehost that cannot serve `since=0` violates P5/P6.
- **`302` to a public R2 URL** — the Worker streams the object; no public
  bucket, no extra DNS.
- **"skip when unreachable" for the daily jobs** — they fail after 30 min
  of retries; a daily notification job may be red, a skip is invisible.
- **The bot's thumb-row and non-empty-keys rules in the formats** — live
  data violates both (0.1); the formats hold what cmini holds. New-write
  strictness, if wanted, is a phase-2 `check_*` at the route, not the
  format.
- **Rename heuristics for upstream renames** — delete + create, as cmini
  itself does (06 §2).
