# layoutdb ecosystem: architecture proposal (round 1)

*2026-09-12 · branch `ldb-arch-review` (from `ldb-formats` @ 6f70590d5) · for saltorbit's review before any reimplementation.*

Inputs: `REQUIREMENTS.md` (23 hard requirements, saltorbit's decisions, unratified agent decisions), `audit-db.md`, `audit-bot.md`, `audit-site.md` (each with file:line evidence). Priorities as restated today: **correctness > simplicity > latency > cost.**

## 0. Verdict in one paragraph

Keep layoutdb's core and the bot's replica design; **throw out the rest of the stats plumbing and rebuild it as one publisher inside the bot's process.** The Worker + D1 + event log + `layout_revs` optimistic lock is correct, replayable and the best-tested code in the repo; restarting it would re-derive the same thing. The bot already holds a full in-memory replica verified per command with a 43 ms conditional GET, which is the simplest way to meet the 1 s / always-correct requirements. What is wrong is everything around *stats*: two complete pipelines (GitHub Actions + D1 patches on prod; a Python Fly service + writer Worker + R2 pointer on the trial) that disagree on source, a bot that borrows the site's harvest through a five-condition provenance proof, and a `rank` that still refuses. Collapse that to: **one publisher, colocated with the bot, computing with the native mana2 CLI, writing base + overlay + pointer to R2 directly; the site reads only the pointer; the bot reads its own local cell store.** Then delete two Workers, one Fly app, four workflows, six D1 tables, and ~2.5k lines of speculative layoutdb mechanisms. Cost drops from a projected ~$75/mo to ~$18–35/mo.

## 1. Target shape

```
                       cmini API (transitional, one-way)
                            │ import cron */5
                            ▼
 ┌────────────────────── layoutdb (Cloudflare account `akl`) ──────────────────────┐
 │ Worker akl-db  +  D1  +  R2 dumps                                                  │
 │  /v1: layouts · formats · likes · authors · changes · meta · dump · admin          │
 │  events (truth) → folded rows; If-Match per part; Idempotency-Key (new)            │
 │  auth: Discord bearer (any client) · Ed25519 registered clients (bots)             │
 │  moderation (new): bans · admin overrides · link + review queue — all events       │
 │  backup: D1 Time Travel + nightly dump (catch-up, incl. clients) + off-account copy│
 │  static assets (later): the layoutdb website — public read-only + admin view       │
 └──────────▲──────────────────────▲───────────────────────────────▲──────────────────┘
            │ bearer (user token)  │ Ed25519, acts for user        │ bearer (admin)
            │ PUT/POST If-Match    │ + GET /v1/changes every 2 s   │
            │                      │ + GET /v1/meta per command     │
 ┌──────────┴──────────┐  ┌────────┴──────────────────────────┐  ┌─┴──────────────────┐
 │ akl.gg (Pages)      │  │ spark (ONE Fly machine, saltorbit's)  │  │ layoutdb website   │
 │ SPA + Functions:    │  │ ┌ bot: replica, order tickets,    │  │ (its own client;   │
 │  Discord OAuth,     │  │ │  wasm for single-layout answers │  │  its own sign-in;  │
 │  /api/db proxy,     │  │ ├ cell store on volume, keyed by  │  │  calls /v1 like    │
 │  analytics          │  │ │  hash(keys,board,rules,pin)     │  │  anyone else)      │
 │ reads pointer only  │  │ └ publisher: mana2 CLI (native),  │  └────────────────────┘
 │ code-only deploys   │  │    base+overlay+pointer → R2      │
 └──────────▲──────────┘  └────────────────┬──────────────────┘
            │ GET pointer (15 s cache)      │ S3 API, conditional PUT
            └───────────── R2 data bucket ◀─┘  lines/H/current.json · b/<base>/ · o/<overlay>/
```

Three deployables plus one static site. Every arrow between systems is a public API or a static object. Nothing on GitHub Actions is in the data path; CI does tests, code deploys, and a full harvest only when the line key `H` (engine pin + corpora) changes.

## 2. Decisions, by subsystem

Legend: **keep** = as built · **fix** = defect, same design · **change** = redesign · **delete** = remove now · **new** = add.

### 2.1 layoutdb (`db/`)

| piece | verdict | why (audit ref) |
|---|---|---|
| Worker + D1 + events + `layout_revs` PK guard + folded rows | **keep** | one-batch atomicity, replay tested by property model + dump→restore (db §A) |
| `layout_formats` (several formats per layout), scoped If-Match, spark/1, mana2/1 translate, cmini import adapter | **keep** | landed, tested, saltorbit's D13 |
| Discord bearer lane + Ed25519 client lane + rate limits | **keep** | no owner-bypass hole found (db §E); document that any Discord app's `identify` token writes as the user |
| cmini import: rename-collision wedge (B2), following-layout **likes silently reverted** (B1), tombstone never revives (B3), no tick lock (B4), one bad id aborts the tick (B5) | **fix** | all real, all untested; B1 and B2 violate priority 1 outright |
| nightly dump only if the 03:00 slot fires; `clients` never dumped or restored; no off-account copy; Time Travel unused | **fix** | RPO up to 24 h and worse after a cron outage the account already had (db §C/§D) |
| `Idempotency-Key` on mutating routes (24 h key→response cache) | **new** | client-neutral fix for the bot's lost-response double-apply hazard (bot §H3); benefits every client |
| moderation: `bans` table checked in `requireActor`; admin routes for rename / transfer / set-author-name / set-likes / restore, recorded as events with `via: admin`; `link` field + `link_submissions` queue (pending → approved/rejected by an admin, approval writes the field as an event) | **new** | H22/H23; the event log already gives the audit trail and rollback H14 asks for |
| webhooks + lease, SSE stream, Fly drill + `/v1/admin/drill`, HTML `/admin/changelog`, per-major dump files, multi-major chain engine (`up/down/walk/path`, `format_behind`, `written_as`) | **delete** | no consumer; ~2.5k src + ~4k test lines of surface for a spark/2 and third parties that don't exist (db §F). SSE goes because the bot's keep-warm becomes a 2 s `/v1/changes?since=` poll, which is what SSE was internally anyway |
| daily upstream diff (900 lines) | **change** | shrink to a count + sampled compare; the importer's per-tick plan already compares state |
| `akl-db-preview` Worker + D1 | **delete** | H13, one layoutdb |
| the layoutdb website (public read-only + admin moderation view) | **new, own design round** | static assets on the Worker or a Pages project in the `akl` account; signs in with Discord itself, calls `/v1` as a normal client (saltorbit, today) |

### 2.2 spark (`bot/` + publisher; `stats/` and `workers/data-writer/` fold in or die)

| piece | verdict | why |
|---|---|---|
| in-memory replica from dump + `/v1/changes`, per-command conditional `GET /v1/meta`, order tickets, exact-name write targets with scoped If-Match | **keep** | this *is* the R1/R2 design; 43 ms verify, rev-guarded folds (bot §B) |
| `provenance.ts` + publish sandwich + hourly re-adoption of akl.gg's harvest | **delete** | 5 equality conditions over 4 fetched files; every site deploy wipes the bot's memo (bot §H1) |
| **cell store on the volume**, keyed `hash(keys, board, resolved rules, engine pin, corpus, space)`; eager compute on every rev bump; per-(corpus, space) row tables so `rank` answers at once and footnotes stale rows | **change** | R3 today is violated (`rank` blocks ≤50 misses, refuses above); this is the "diff against the prebuilt bulk" saltorbit described |
| **publisher module in the same process**: follows the same feed, computes changed layouts with the **native mana2 CLI** (child process, niced), writes them into the cell store, emits overlay files (catalog, rules, authors, per-corpus stats), swaps the pointer with a conditional PUT; folds overlay→base daily; rebuilds a base when `H` changes | **new** (replaces `scripts/stats_service/` + `stats/` Fly app) | one follower, one engine for published numbers, one machine. Native CLI is ~10× the wasm per cell (site §B); wasm stays for the bot's *own* single-layout answers (39 cells in 0.14–0.7 s) |
| `workers/data-writer` | **delete** (verify first) | it exists because `wrangler login` can't mint R2 tokens; a dashboard-created R2 API token + S3 conditional PUT gives the same CAS. If R2's conditional PUT proves unreliable, keep the Worker (480 lines) |
| wasm + `defs.json` baked into the image; boot from volume (dump + cell store) then catch up; `ensureFresh` + default-corpus tables warmed before `login()` | **change** | today boot dies on an akl.gg 530 and the first command pays a 1 s catch-up (bot §A, §H5/H8) |
| write reconciliation after timeout/5xx (re-GET and compare) + `Idempotency-Key` | **fix** | a committed `swap!` reported as "Error" then retried undoes itself (bot §H3) |
| bounded wasm table residency / dispose-and-recreate worker | **fix** | 1 GB machine can OOM on a few ruled lookups across heavy corpora (bot §H4) |
| LDB-B5 live parity test as the deploy gate | **change** | move to nightly; deploy gates on offline tests only (it is red today on a stale fixture) |
| fuzzy `find` on read verbs after a delete | saltorbit's call | cmini parity vs "never incorrect"; recommend labelling a fuzzy hit |
| machine | shared-cpu-2x, 2 GB, one volume (~$12/mo). If magic compute needs more, Hetzner CX22 (2 vCPU / 4 GB, ~€4) beats Fly performance tiers 10:1 on price at the cost of a VM to own | cost |

### 2.3 akl.gg (`web/`, `functions/`, `.github/`)

| piece | verdict | why |
|---|---|---|
| SPA pointer mode (`core/dataorigin.ts`, `data/origin.ts`), base ⊕ overlay loaders | **keep**, make it the only mode | already built on the trial |
| Discord OAuth + `/api/db/*` proxy holding the user's token server-side; publish UX (read-then-PUT with If-Match, local 409 rebase, promoted row) | **keep** | R4 holds by construction (site §C); saltorbit: akl.gg keeps its own auth |
| owned-but-uncatalogued rows render nothing (`Body.tsx:143`); pointer re-read every 20 min | **fix** | a publish must be visible to its author on reload; poll the 15 s-cached pointer every 60 s and, after an own publish, until `db_seq` covers it |
| proxy hardening: upstream timeout, body cap, `Secure` on the session cookie | **fix** | site §G10 |
| `dispatchAfterWrite` → `db_site_write` + `GITHUB_DISPATCH_TOKEN` in Pages env | **delete**, rotate the token | dead path, plaintext token |
| meta-watch Worker, `live-sync.yml`, `magic-rules-sync.yml`, `magic-rules-backup.yml`, `/api/stat-patches/*`, D1 tables `stat_patches`, `stat_patch_atoms`, `stat_patch_ngrams`, `layout_patches`, `layout_authors`, `sync_markers`, `cmini_sync_log`, `magic_rules`, `magic_rules_log`, `compact_stat_patches.py`, `sync_prod_authors.py`, `data/layout-dates.json` + `--update-dates`, the `cmini-backup` branch | **delete** at the flip | the whole prod stats path; ~250 CI min/day; three copies of rules, authors and dates (site §D/§E) |
| `build.yml` data work on every push; nightly build; Sunday full rebuild | **change** | push = gate + pointer build + Pages deploy, no data. Full harvest = `workflow_dispatch` when `H` changes, publishing a base |
| cb-magic D1 | **keep** only `discord_tokens`, `handoff`, analytics | |
| the production flip | one change: Pages prod `DB_BASE_URL` + `vars.DB_BASE_URL` + pointer-only build + remove meta-watch, together | two writers from two sources flap; a half flip loses site publishes from the catalog (site §G1/G2) |

## 3. How the four priorities are met

**Correctness.** One writer per fact: layouts/likes/authors/rules in layoutdb events; stats in one cell store, published by one process. Every write names the part version it read (H10/H11) and, new, an idempotency key, so a retry after a lost response is a no-op rather than a second swap. The bot answers only after a live conditional GET; cells are keyed by content hash, never by wall clock (H5). The importer stops being able to wedge or to revert a user's like. The publisher compares state (content hash + rules signature), not events, so dropped or duplicated feed events cannot leave it wrong. Site publishes are visible to their author from the record itself, not only from the pipeline.

**Backups.** Four layers, cheap: (1) D1 Time Travel, 30-day point-in-time, documented and rehearsed once; (2) nightly full dump to R2 with a catch-up rule (any tick when the last dump is >24 h old) and a staleness alarm; the dump now includes `clients`; (3) an off-account copy: spark pulls the nightly dump onto its volume, and the daily CI job uploads it as a 30-day artifact; (4) a rehearsed restore into a fresh D1 with the time written down. RPO minutes (Time Travel) / 24 h (dump); RTO one afternoon, proven.

**Simplicity.** From 5 deployables + 2 pipelines + 3 change-followers to 3 deployables + 1 pipeline + 1 follower pattern (poll `/v1/changes`, verify `/v1/meta`). Delete list totals two Workers, one Fly app, four workflows, eight D1 tables, ~2.5k layoutdb lines, ~600 bot lines, 2.7k Python. The DB stays client-neutral: akl.gg, spark and the layoutdb website all go through `/v1` with the same two auth lanes; no client has a private door.

**Latency.** Targets, with the enforcing measurement in brackets:

| path | target | how |
|---|---|---|
| bot lookup / write | p95 ≤ 1 s, no cold load on the request path | replica + 43 ms verify; tables warmed at boot; own edits fold before the ticket settles [per-verb latency histogram, alert on p95] |
| bot sort | answer at once; stale rows footnoted; a changed layout's 39 cells within ~1 s of the rev bump, full 108 within ~5 s | row tables + eager compute [R3 test: rank never blocks on compute] |
| site: author's own tab | immediate | own wasm (exists) |
| site: everyone else | p50 ≤ 2 min, p95 ≤ 10 min (magic layouts) | publisher tick on feed event, native compute, pointer swap, 60 s poll [pointer `db_seq` vs event time, logged] |
| cmini edit → everything | + ≤ 5 min | import cron (transitional) |

**Cost.** Workers Paid $5 · Fly shared-cpu-2x 2 GB + volume ≈ $12 · R2 < $1 · Pages free · CI back under the free tier by dropping the data work from pushes. **≈ $18/mo** (≈ $35 with a performance-1x machine), versus the branch's projected $5 + $8 bot + ~$62 stats machine ≈ $75.

## 4. What I am *not* proposing, and why

- **Not restarting layoutdb.** The data model is right and the moderation features want exactly an event log.
- **Not moving stats into the DB Worker.** Native Go binaries over multi-MB corpus parses cannot run in a Worker, and H7 says the DB computes nothing.
- **Not having the site read layoutdb live.** H20; the pointer over R2 is the right static snapshot.
- **Not a thin-client bot over a stats service.** Adds a hop and a second freshness protocol to every command; cannot meet R2/R3 (bot verdict).
- **Not the DB as identity provider for akl.gg.** saltorbit: akl.gg keeps its own auth; the DB website is a separate client.
- **Not changing the site's name-keyed catalog to ULIDs.** Real debt (`_dbId` side fields), not worth a frontend rewrite now; the publisher maps id→name.
- **Not Durable Objects / a serial writer.** saltorbit kept the server-side retry (D13 E3); audit found it sound.

## 5. Sequence

Each step ships alone; layoutdb may be wiped and rebuilt at any step (H12).

1. **Ratify this doc.** Convert `REQUIREMENTS.md` into the standing requirements file (replacing the scattered ones) and retire superseded design docs to a `historical/` folder with one pointer.
2. **layoutdb hardening** (`db/`): fix B1–B5 + the dump slot + `clients` + Time Travel + off-account copy; add `Idempotency-Key`; delete the §2.1 list; shrink the diff. Gate: existing suite green, new invariants for each fix, a rehearsed fresh-D1 restore with its time recorded.
3. **spark v2** (`bot/`): cell store + row tables + eager compute; publisher module (CLI in image, R2 direct, pointer CAS); baked wasm; warm boot; write reconciliation; table residency bound; live parity test off the gate. Delete `provenance.ts`, `scripts/stats_service/`, `stats/`, `workers/data-writer/`. Gate: R1–R3 tests, per-verb latency histogram, an e2e run through bot → layoutdb → R2 → site.
4. **akl.gg cutover**: pointer-only build; owned-row rendering; 60 s poll; proxy hardening; the one atomic flip; then delete the prod stats path and the dead dispatch, rotate the token.
5. **Moderation + `link`** in layoutdb, then the layoutdb website as its own design round.
6. **Governance**: second admin row (violated since phase 2), domain in the `akl` account, `db.yml` prod deploy gated on a release branch rather than every PR push.

## 6. Questions for saltorbit

1. **Publisher engine.** Native mana2 CLI for published numbers, wasm for the bot's immediate answers (two builds of one pinned Go source). OK, or do you want one engine even at 10× compute cost?
2. **Likes on following layouts** (B1): fork the layout on a like, or union semantics with cmini's likes? Recommend union (a like never forks, never gets reverted).
3. **Fuzzy `view` after a delete** answers a different layout unlabelled. Keep cmini parity as-is, or label the fuzzy hit?
4. **Machine**: Fly shared-cpu-2x 2 GB (~$12) to start, or a Hetzner VM (~€4, 4 GB) if magic compute needs it?
5. **Retire the design corpus**: move `design/layout-db/00–22` and `design/pipeline-313/*` under `historical/` once `REQUIREMENTS.md` + this doc + `architecture.md` are the living set?
6. **`db.yml` deploys prod layoutdb on every push to the PR branch.** Keep (H12 says disposable) or gate on a release branch now that the bot and trial site depend on it?
