# Implementation — phase 1, the mirror

Status: plan (2026-09-08). Part of `00-plan.md` (§5 phase 1). Written so an
engineer or an agent can start from a clean checkout and land it as a series
of PRs, each carrying the invariants it introduces (`design/INVARIANTS.md`
covenant). Phases 2–5 get their own doc when phase 1 is on `main`.

## 0. What phase 1 delivers, and what it does not

Delivers: `db/` as a deployable Cloudflare Worker with its own D1 and R2;
two registered formats (`cmini/1`, `akl/1`) with lossless translation both
ways; a continuous one-way import from cmini; read-only `/v1` (meta, list,
detail with `?as=`, likes, history, revs, authors, formats, changes, dump);
the nightly dump; the D12 mirror diff in CI; the rehost script. Nothing on
akl.gg changes. No writes, no auth, no bot.

Does not deliver: any write endpoint, either auth lane, admins, webhooks,
the stream, `mana2/1`, the site cutover. Those are phases 2–5.

## 1. Before the first PR — decisions and hand-made things

| need | default if unanswered | blocks |
|---|---|---|
| Service name / hostname (`00 §6.2`) | Worker `akl-db`; served at `akl-db.<account>.workers.dev` until a hostname is picked | nothing in phase 1 |
| Cloudflare account | the site's account, same as Pages `cminibrowser`; members added at phase 5 | deploy (S7) |
| D1 database `akl-db`, R2 bucket `akl-db-dumps` | created by hand once (`wrangler d1 create akl-db`, `wrangler r2 bucket create akl-db-dumps`); ids into `db/wrangler.toml` | S7 |
| CI deploy token | a Cloudflare API token with Workers Scripts + D1 + R2 edit, as repo secret `CLOUDFLARE_DB_TOKEN` (separate from the Pages token) | S7 |
| Day-1 admins (`00 §6.4`) | migration `0001` seeds only saltorbit's id; a second row is a phase-2 blocker, not a phase-1 one | phase 2 |
| Confirmations in `00 §0` (bot lane, no write-back, no stats) | assumed as written | nothing in phase 1 |

## 2. Toolchain

- **Runtime:** Cloudflare Workers, `compatibility_date = 2026-09-01`, ESM,
  TypeScript (the Worker is compiled by wrangler's esbuild; no separate
  build step). Node 24 for tooling.
- **Router:** Hono (`hono@4`) — small, typed, Workers-native; the Pages
  Functions' no-dependency posture is right for four routes, not for a
  service with a registry, a feed and a cron.
- **Validation:** JSON Schema 2020-12 via `ajv@8` (compiled once at module
  load per format). Every format's `schema.json` is the same file the
  registry publishes at `/v1/formats/{name}/{N}/schema.json`.
- **Tests:** `vitest` with `@cloudflare/vitest-pool-workers` — tests run
  *inside* workerd against a real (miniflare) D1 and R2, so migrations, SQL
  and cache headers are tested for real, not mocked. Golden/fixture tests
  are plain vitest.
- **Dependencies rule:** `db/package.json` is its own; nothing in `db/`
  imports from `../web`, `../scripts` or `../functions`, and nothing outside
  imports `db/` (an archlint-style test in S1 enforces both directions).
- **Ids:** ULID (`ulid` package; monotonic factory per isolate).
- **Canonical JSON:** one `canonical(obj)` helper (sorted keys, no
  whitespace) used for payload storage and every byte-identity test.

## 3. Repository layout

```
db/
  README.md                 what it is · run locally · rehost procedure (04 §4) · secrets table
  package.json              scripts: dev · test · deploy · migrate · rehost · diff-upstream
  wrangler.toml             worker name, D1 + R2 bindings, cron triggers (import */5, dump 0 3 * * *)
  tsconfig.json
  migrations/
    0001_init.sql           §4
  src/
    index.ts                Hono app + scheduled() dispatcher
    env.ts                  Bindings type (DB, DUMPS, IMPORT_SOURCE_URL, …)
    routes/
      meta.ts  layouts.ts  authors.ts  formats.ts  changes.ts  dump.ts
    core/
      records.ts            get/list/byRef, canonical(), rev handling
      events.ts             appendEvent(), foldRecord() (replay), feed queries
      follows.ts            followsUpstream(layout_id) -- the D9 derivation
      cache.ts              edge-cache + ETag wrapper for the polled routes (03 §5)
      errors.ts             { error, message } helpers; the bot's strings
    formats/
      registry.ts           loads ../../formats/*/N, exposes get(id), translate(rec, as)
    import/
      cmini.ts              the cron: meta check → list → details → events (06 §2)
      upstream.ts           HTTP client for clemenpine.com/layoutapi/v3 (UA header, retries)
    dump/
      write.ts              nightly: R2 dump-YYYY-MM-DD.json.gz + latest.json
      restore.ts            used by `npm run rehost`
  formats/                  (the registry; also the future npm package, 06 §5)
    cmini/1/  schema.json  index.ts  README.md  OWNERS  fixtures/
    akl/1/    schema.json  index.ts  README.md  OWNERS  fixtures/
  tests/
    formats/                goldens, frozen-dir diff, mutation-refusal matrix
    api/                    conformance fixtures (request/response JSON) + route tests
    import/                 replay tests with a FakeUpstream
    events/                 fold/replay property tests
    upstream-diff.test.ts   the D12 diff (live; skips when unreachable, see §7)
    rehost.test.ts          migrations → restore(dump) → API suite
    boundary.test.ts        no imports across the db/ boundary
    conformance/            *.json request/response pairs
.github/workflows/db.yml    §7
```

## 4. Migration `0001_init.sql`

```sql
CREATE TABLE layouts (
  id            TEXT PRIMARY KEY,                 -- ULID
  name          TEXT NOT NULL COLLATE NOCASE UNIQUE,
  owner         TEXT NOT NULL,                    -- Discord user id
  rev           INTEGER NOT NULL,
  created_at    TEXT NOT NULL, modified_at TEXT NOT NULL,
  deleted       INTEGER NOT NULL DEFAULT 0,
  link          TEXT,
  format        TEXT NOT NULL,                    -- 'cmini/1' | 'akl/1' | …
  payload_json  TEXT NOT NULL,                    -- canonical JSON
  like_count    INTEGER NOT NULL DEFAULT 0,
  has_magic     INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX layouts_owner ON layouts(owner);
CREATE INDEX layouts_modified ON layouts(modified_at);

CREATE TABLE layout_revs (
  layout_id TEXT NOT NULL, rev INTEGER NOT NULL, event_seq INTEGER NOT NULL,
  format TEXT NOT NULL, payload_json TEXT NOT NULL,
  PRIMARY KEY (layout_id, rev)
);

CREATE TABLE likes (layout_id TEXT NOT NULL, user_id TEXT NOT NULL, at TEXT NOT NULL,
  PRIMARY KEY (layout_id, user_id));

CREATE TABLE authors (user_id TEXT PRIMARY KEY, name TEXT NOT NULL,
  first_seen_at TEXT NOT NULL, last_seen_at TEXT NOT NULL);

CREATE TABLE events (
  seq        INTEGER PRIMARY KEY AUTOINCREMENT,
  at         TEXT NOT NULL,
  kind       TEXT NOT NULL,
  layout_id  TEXT, name TEXT, owner TEXT, rev INTEGER,
  actor      TEXT NOT NULL,                       -- user id or 'system:cmini-import'
  via        TEXT NOT NULL,                       -- 'system' in phase 1
  admin      INTEGER NOT NULL DEFAULT 0,
  detail_json TEXT,                               -- imported: {source, upstream_id}; upstream_changed: upstream payload
  before_json TEXT, after_json TEXT
);
CREATE INDEX events_layout ON events(layout_id, seq);
CREATE INDEX events_kind ON events(kind, seq);

CREATE TABLE admins (user_id TEXT PRIMARY KEY, added_by TEXT, added_at TEXT NOT NULL, note TEXT);
INSERT INTO admins VALUES ('184412255822020608', NULL, '2026-09-08T00:00:00Z', 'bootstrap: deeroh');

CREATE TABLE import_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);   -- 'cmini.revision', 'cmini.paused', 'cmini.last_full'
CREATE TABLE import_map (upstream_id TEXT PRIMARY KEY, layout_id TEXT NOT NULL UNIQUE);
```

Phase 2 adds `clients`, `nonces`, `webhooks` and the second admin. Every
migration is applied by `npm run migrate` locally and by S7's deploy step
remotely (`wrangler d1 migrations apply akl-db --remote` — verify it works on
a wrangler-created DB; the site's hand-created `cb-magic` is why it fails
there, `DEPLOY.md`).

## 5. The two formats

### 5.1 `formats/cmini/1`

- `schema.json`: cmini's v3 detail minus record fields — `board` (enum),
  `keys` (map char → `{row, col, finger}`), `free` (array), `magic`
  (array of `{inputs, output, type}`), `additionalProperties: false`.
- `validate(p)`: schema, then the bot's own rules (`add.py`/`setfingermap.py`,
  ported: duplicate char, thumb rows, finger enum, `inputs` two chars).
- `lower(p)`: `p.magic` as is (already flat, typed).
- `to["akl/1"](p)`: `01 §6.1` — board word → `{kind, stagger, cmini}`;
  typed rows → exact lift (`liftRules`, ported from #221's
  `scripts/magic_interop.py` `lift()`), leftovers → `magic.rules` with tag.
- `from["akl/1"](p)`: `01 §6.2` — inverse; `x` dropped.

### 5.2 `formats/akl/1`

- `schema.json`: `01 §2` exactly; `x` is `type: object` unconstrained,
  16 KB cap enforced in `validate`.
- `validate(p)`: `01 §2.1`, including running `lower()` and refusing
  collisions with the `magic_collision` error body (`01 §3`).
- `lower(p)`: the compile from `functions/_lib/rules.mjs`, **ported, not
  imported** (boundary rule), with the two changes `01 §3` names: layout-key
  scaffold instead of a–z, and `except`. Emits typed rows.
- `to["cmini/1"]`, `from["cmini/1"]`: the inverses of 5.1.

### 5.3 Fixtures (frozen from the day they merge — LDB-F6)

From the live scrape, chosen for coverage: `graphite` (the repo's canonical
fixture), `opal` (typed magic rows — the #221 fixture, already in
`scripts/tests/fixtures/api_magic_opal.json`), one `angle`, one `mini`, one
`stagger`, one with `free` positions, one with thumbs on both hands, one
with an apostrophe/underscore in the name. Each cmini fixture gets
`.akl-1.json` (translation golden) and each akl fixture `.lowered.json` +
`.cmini-1.json`.

## 6. Slices — PRs in order, each with its invariants

| # | PR | lands | invariants (registered on merge) |
|---|---|---|---|
| **S1** | `db/` skeleton | package.json, wrangler.toml (placeholders), tsconfig, Hono `GET /v1/meta` returning zeros, migration 0001, `npm run dev` works, `db.yml` runs `npm test`, boundary test | LDB-G2 (no admin constant beyond the seed row — a test greps `src/`), boundary invariant (new: **LDB-G5** nothing imports across `db/`) |
| **S2** | format registry + `cmini/1` | `formats/registry.ts`, `cmini/1` with schema/validate/lower, fixtures, frozen-dir diff test, mutation-refusal matrix | LDB-F1, F2, F6, F7 |
| **S3** | `akl/1` + translations | `akl/1` schema/validate/lower/`except`/typed rows, both `to`/`from`, lift port, goldens | LDB-F3, F4, F5 (fixture-level), F10 |
| **S4** | records + events | `core/records.ts`, `core/events.ts`, `foldRecord()`, `layout_revs`; property test: random sequences of (create, update, rename, delete) as *internal* ops → stored record == fold of events; `/v1/changes` from 0 | LDB-P1, P6 |
| **S5** | cmini import | `import/cmini.ts` + `upstream.ts` + `follows.ts`; FakeUpstream tests for every bullet of `06 §2` (new, changed-following, changed-not-following, deleted, name collision → shadowed, likes, authors, >5 % prune refusal); cron wiring | **LDB-I1** import is idempotent (same upstream twice → no events), **LDB-I2** never overwrites a non-following record, **LDB-I3** prune bound |
| **S6** | reads | `/v1/layouts` (list/filters/cursor/`full=1`), `/{ref}?as=`, `/likes`, `/history`, `/rev/{n}`, `/v1/authors`, `/v1/formats` + schema, `409 held`; `core/cache.ts` (max-age 10 + ETag/304 on meta/list/changes); conformance fixtures for every route and error | LDB-P7 (error shape), LDB-P4 (names — via import paths), **LDB-R1** polled routes carry `Cache-Control`+`ETag` and answer 304 |
| **S7** | deploy + dump + rehost | R2 dump cron, `/v1/dump/latest.json` + redirect, `restore.ts`, `npm run rehost`, `rehost.test.ts` (migrate → restore fixture dump → API suite), `db.yml` deploy job on `main` (`wrangler deploy` + `migrations apply`), README runbook table | LDB-G1, G4 |
| **S8** | D12 diff | `upstream-diff.test.ts` + `npm run diff-upstream`: every following record `?as=cmini/1` vs upstream detail, canonicalised; scheduled daily in `db.yml`; first full import into the real `akl-db` | LDB-P5 |

Order is a dependency order: S2/S3 need S1; S4 needs S1; S5 needs S2–S4;
S6 needs S3–S5; S7 needs S6; S8 needs S7 (a real database to diff).
S2 and S4 can run in parallel.

## 7. CI — `.github/workflows/db.yml`

- **On PR and push touching `db/**` or `db.yml`:** `cd db && npm ci && npm
  test` (vitest in workerd), plus the frozen-format diff against `main`
  (`git diff --name-only origin/main -- db/formats` filtered to
  schema/fixtures/goldens of merged majors → fail on any modification).
- **On push to `main`:** the above, then deploy: `wrangler d1 migrations
  apply akl-db --remote`, `wrangler deploy`. Secrets: `CLOUDFLARE_DB_TOKEN`,
  `CLOUDFLARE_ACCOUNT_ID` (already present for Pages).
- **Daily 04:00 UTC:** `npm run rehost -- --dump <latest.json url>` (LDB-G1,
  proves the dump) and `npm run diff-upstream` (LDB-P5). Both are real
  network; on unreachable upstream/R2 they *skip with a visible notice* and
  a second consecutive skip fails (the `ci-gate-split-256` lesson).
- Wiring is asserted by a `ciwiring`-style test in `db/tests/` that parses
  `db.yml` (the site's I-135..I-139 pattern) — cones, pinned action majors,
  the deploy job gated on the test job.

## 8. Local development

```
cd db && npm ci
npm run migrate          # wrangler d1 migrations apply akl-db --local
npm run import -- --once # one import tick against the live upstream into local D1 (~2 s warm; ~5 MB full=1)
npm run dev              # wrangler dev; GET http://localhost:8787/v1/meta
npm test                 # everything; `npm test -- formats` etc. for a slice
```

`IMPORT_SOURCE_URL` defaults to `https://clemenpine.com/layoutapi/v3`; tests
point it at the FakeUpstream. A `--fixture` flag imports from a checked-in
100-layout snapshot instead (offline dev, and the seed for `rehost.test`).

## 9. Definition of done (phase 1)

1. `akl-db` deployed; `/v1/meta` reports the same `layout_count` as cmini's
   `/v3/meta` within one import tick.
2. `npm run diff-upstream` reports zero differences across the whole set.
3. The nightly dump exists in R2 and `npm run rehost` against it passes the
   API suite in CI.
4. Every invariant in §6 is in `design/INVARIANTS.md` (as `LDB-*` → `I-nnn`)
   with its catalog entry and tagged test; `gates.sh` and `db.yml` are green.
5. Nothing on akl.gg has changed. The proposal pages link to the live
   `/v1/meta` as "it exists" (one sentence; copy sign-off).

## 10. What phase 2 will need from phase 1 (so phase 1 doesn't paint over it)

- `events.via` and `events.admin` columns exist now (always `system`/`0`),
  so phase 2's auth lanes add no migration to the log.
- `foldRecord()` is the only way a record is materialised, so phase 2's
  writes are "append an event, fold" — no second write path.
- Format helpers `setFingermap`/`setBoard`/`rename` (for PATCH verbs) are
  *not* built in phase 1; the format `index.ts` shape leaves room
  (`edits?: {...}`).
- `has_magic` is maintained on write from `lower().length > 0`, so the list
  filter works from day one.
