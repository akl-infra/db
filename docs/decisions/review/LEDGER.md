# layoutdb v2 — implementation ledger (pick up here)

**For whoever picks this up.** Read in order: `REQUIREMENTS.md` (binding), `PROPOSAL.md` (the target shape, with saltorbit's answers in §6 and the safety nets in §3c), then this file. Integration branch: **`ldb-arch-review`** (from `ldb-formats`; everything layoutdb lands here, never on `main`). Site preview of the docs: `https://db.cmini-web.pages.dev/artifacts/`. Started 2026-09-12.

## Standing rules (saltorbit)

- Correctness > simplicity > latency > cost. Hard requirements H1–H23 in `REQUIREMENTS.md`.
- layoutdb is disposable until the community uses it: wipe + rebuild over migrations; keep pushing to prod `akl-db` on every push (`db.yml`), no release gate yet.
- akl.gg keeps its own Discord auth; the layoutdb website is a separate client; the DB validates tokens, mints none.
- Prod akl.gg (Pages prod env, `cb-magic`, akl.gg zone, `main`'s workflows) is fenced. Nothing merges to `main` without saltorbit.
- Every addition states its invariants and tests them (`db/INVARIANTS.md`, `bot/INVARIANTS.md`, catalog rows). User-facing copy (bot replies, site strings) is a `// COPY: sign-off pending` stand-in until saltorbit signs it.
- Cheaper agents implement (Sonnet by default); the lead reviews every diff. **Agents run in parallel, each spawned with the Agent tool's `isolation: "worktree"`** (cwd set to its own `.claude/worktrees/<name>` at spawn, branch `worktree-<name>`, so no agent ever `cd`s and the session's worktree pin never moves — the 2026-09-09 livelock was cd/EnterWorktree-based). Because that worktree branches from `main`, an agent's first command is `git reset --hard ldb-arch-review`, then `npm ci`. Lead's cross-worktree git goes through scratchpad scripts (`lead-commit.sh`, `land-slice.sh`).
- Sync the live bot / db site only at natural pause points.
- **saltorbit, 2026-09-12: "implement this new way fully. don't merge to main or disrupt existing shipping aklgg, but otherwise you should push updates to the db etc."** Prod layoutdb deploys, spark deploys and the db-alias site are ours to push as slices land.

## Decisions taken 2026-09-12 (beyond PROPOSAL.md §6)

| decision | detail |
|---|---|
| feed = long-poll | `GET /v1/changes?since=&wait=25s`; Worker checks D1 1/s, returns on first event; `wait=` only for registered Ed25519 clients with cap `feed:wait`, ≤ 25 s, counted against the client rate limit; anonymous → immediate answer. Only spark holds it; akl.gg reads static objects. SSE + webhooks deleted. |
| host = Fly | shared-cpu-2x 2 GB; revisit with the per-verb latency histogram. |
| rebuilds | none weekly. Incremental per edit; daily fold/GC in spark; full harvest on GitHub only when `H` changes. |
| safety nets | S1 replica-vs-dump (daily + boot), S2 coverage walk (daily + boot), S3 publish smoke test (part of every publish), S4 daily spot recompute (edited-24h + 30 random, magic always sampled; wasm vs CLI), S6 monthly reference harvest diffed into a scratch line. S5 deferred. Every check writes last result + time to spark `/health`; not run in 48 h = failure; watchdog DMs. |
| likes | union with cmini's by user id; every like carries `via`; importer never emits `unliked`. |
| tombstones | never match in any resolver, fuzzy `view` included. |
| engines | native mana2 CLI publishes; wasm answers; nightly parity sample. |

## Waves and slices

Status: `todo` · `running (agent, branch)` · `review` · `landed <sha>` · `blocked (why)`.

### Wave 0 — docs (lead)
| id | slice | status |
|---|---|---|
| D0 | this ledger + REQUIREMENTS + PROPOSAL + data-flow page on the db preview | landed 89312ddb6 |
| D1 | layoutdb-focused architecture doc for outside reviewers (common infra only; spark/1 format flagged as still open; format rules table) | landed: `design/artifacts/layoutdb-arch.html`, /artifacts/layoutdb-arch/ |
| D2 | ecosystem page rewritten to the new target shape; artifacts index accurate; every SVG measured in Chrome for clipping | landed |
| D3 | retire `design/layout-db/00–22`, `design/pipeline-313/*` to `historical/` with one pointer; `REQUIREMENTS.md` becomes the standing file; CLAUDE.md pointer | todo (after D1) |

### Wave 1 — layoutdb (`db/`), serial
| id | slice | brief | status |
|---|---|---|---|
| L4 | **delete + long-poll** (running: impl-L4, worktree `.claude/worktrees/ldb-L4`, branch `ldb-L4`) | remove webhooks + lease (routes, core/webhooks.ts, drain job, migrations stay as empty tables or a drop migration — disposable, so a drop), SSE `routes/stream.ts`, Fly drill (`drill/`, `/v1/admin/drill`, `last_drill`), HTML `/admin/changelog`, per-major dump files (LDB-D6), multi-major chain machinery in `formats/registry.ts` + `write.ts` (assert one major per lineage), `[env.preview]` in wrangler.toml; shrink `import/diff.ts` to count + sampled compare. Add `wait=` long-poll to `/v1/changes` gated by client cap `feed:wait` (clients.caps), ≤ 25 s, 1 D1 read/s, ratelimited. Update INVARIANTS (remove rows, add LDB for long-poll gating), INTEGRATION.md, README. Suite green. | landed c6c003142 (db 15,756 tests green on the integration branch); chain machinery FROZEN not deleted (follow-up L6), /admin/changelog kept (bot history links to it). Deployed 2026-09-12 (v1fa2965c) with the live bot still on SSE — its keep-warm 404-loops harmlessly until B3; correctness path (`/v1/meta` per command) unaffected. |
| L1 | **import fixes** | B2 rename-collision → shadow name + `import_conflict` info event, never a wedge; B5 per-id try/catch, token stored only when every id succeeded or was recorded; B4 tick lock via CAS `import_state` row (10 min expiry; manual tick 409 while held); B3 revive tombstone on identical re-add (`deleted` in the differ); B1 likes union: importer adds missing likes, never `unliked`; likes get `via` column. Tests for each (property where it fits), INVARIANTS rows. | landed 515088dc6 (LDB-L5/I19 sticky shadow/I20/I21/C7; migrations 0011 + 0013; db 15,810 green) |
| L2 | **backups** | dump runs on any tick when `last_dump_at` > 24 h (store in import_state), staleness in `/v1/meta.health`; dump + restore `clients`; README: Time Travel procedure; `db.yml` daily job `upload-artifact` the dump 30 d; stream `buildDump` or set `[limits]`; document the fresh-D1 restore rehearsal steps (saltorbit/lead runs it once and records minutes). | landed 850388595 (LDB-D8/D9/M2/C6; `[limits] cpu_ms`; CI artifact; runbook written, fresh-D1 rehearsal NOT yet run) |
| L3 | **Idempotency-Key** | optional header on every mutating route; table `idempotency(client_scope, key, response, at)` 24 h; same key → replay stored response; conformance fixtures; INVARIANTS. | todo |
| L6 | **format chain freeze → delete** | delete the multi-major chain engine (`up/down/chainFn/chainViolations/path`, `chainToLatest`, `format_behind`, `written_as`, stub-lineage T2/T3 fixtures; LDB-F18/F19/P13) once a decision on how spark/2 will land is made — L4 froze it because put-format/held/list/docs-site tests exercise it. | todo (after W3) |
| L5 | **moderation** | `bans` (checked in requireActor on writes, 403 banned), admin overrides as events `via: admin` (rename, transfer, set author name, set likes, restore), `link` field + `link_submissions` queue (submit by owner → pending; admin approve/reject → event; approved writes `layouts.link`). Wave 3. | todo |

### Wave 2 — spark (`bot/` absorbs `stats/` + `workers/data-writer/`), serial
| id | slice | brief | status |
|---|---|---|---|
| B1 | **cell store + row tables + rank** | content-hash-keyed cell store persisted on `/data`; eager compute on rev bump (wasm, 39 cells); per-(corpus, space) row tables; `rank` sorts at once, footer stand-in for pending rows; delete `provenance.ts` + publish tracker + adoption resets; LDB-B rows. | landed 23435c60b (LDB-B90..B95; provenance deleted ~1.7k lines; seed script skipped; tier-2 sweeper folded into the engine budget) |
| B2 | **publisher module** (running: impl-B2) | native mana2 CLI in the image (from `stats/Dockerfile`), computes 108 cells per changed layout into the same store (CLI wins), emits overlay (catalog, rules, authors, per-corpus stats) → R2 via S3 API token (verify conditional PUT; else keep data-writer), pointer CAS with `db_seq`, daily fold + GC, S3 smoke test as part of publish. Delete `scripts/stats_service/`, `stats/`, `workers/data-writer/` when green. | todo |
| B3 | **boot + feed + write hardening** (running: impl-B3) | wasm + defs baked into image; boot from volume snapshot + cell store, catch up, warm default corpus, `ensureFresh` before login; long-poll client; write reconciliation after timeout/5xx + Idempotency-Key header; bounded table residency; LDB-B5 live parity off the deploy gate (nightly). | todo |
| B4 | **safety nets** (running: impl-B4) | S1, S2 (daily + boot), S4 (daily, magic always sampled), `/health` with last-run + age per check, 48 h rule, watchdog DM. | todo |

### Wave 3 — akl.gg
| id | slice | brief | status |
|---|---|---|---|
| A1 | (running: impl-A1, isolation worktree) pointer-only build as the only mode; owned-but-uncatalogued rows render from the record; pointer poll 60 s (+ until own publish covered); proxy timeout/body cap/`Secure`; delete `dispatchAfterWrite`. | todo |
| A2 | the atomic flip (Pages prod `DB_BASE_URL`, CI var, pointer build, meta-watch removal) — **saltorbit runs**; then delete the prod stats path (workflows, D1 tables, Functions, scripts, `layout-dates.json`, `cmini-backup`), rotate `GITHUB_DISPATCH_TOKEN`. | todo |
| A3 | S6 monthly reference harvest workflow (scratch line, diff, alarm). | todo |

### Verification (saltorbit, 2026-09-12: "once you are done, run a latency analysis … bot, aklgg, anything you can think of. are we meeting spec?")
| id | slice | brief | status |
|---|---|---|---|
| V1 | **latency analysis vs spec** | after B1–B4 and A1 land and are deployed: measure against PROPOSAL.md §3 targets. Bot: per-verb latency histogram (p50/p95/max) for view/stats/sfbs/add/swap!/rename/like/rank, cold first command after a restart, ruled (magic) layouts, under a burst (headless harness `bot/scripts/e2e-headless.mjs` + `scripts/e2e/bot_db_site.mjs`). layoutdb: `/v1/meta` 304 path, record GET, PUT round trip, long-poll wake latency, import tick duration. Publisher: edit → pointer swap (plain and magic layouts), daily fold time. Site: pointer age after an edit, own-publish visibility, page load in pointer mode (Lighthouse), tab poll pickup. Memory/CPU on the Fly machine over 24 h. Report as `design/layout-db/review/LATENCY.md` + a page on the site, with a pass/fail per requirement R1–R5 and what to change if anything fails. | todo (after wave 2 + A1) |

### Wave 4
| id | slice | status |
|---|---|---|
| W1 | layoutdb website (public read-only + moderation view) — own design round first | todo |
| W2 | governance: second admin row, domain in `akl` account | todo (saltorbit) |
| W3 | spark/1 format discussion (saltorbit: "not done yet") — own design round | todo |

## Agent recipe

1. Spawn with `isolation: "worktree"`; the brief's first two steps are `git reset --hard ldb-arch-review` and `npm ci` (+ `cd db && npm ci` / the bot build steps from `bot/README.md`).
2. Run slices in parallel when they touch disjoint files; name the sibling slices in each brief so agents avoid each other's files. Brief = the slice row above + the relevant audit section + "state invariants, add tests, run the suite, commit on your branch, do not push, do not deploy, report branch + sha + test counts".
3. Lead reviews the diff, runs the suite once more, rebases the slice onto `ldb-arch-review` (script), fast-forwards, pushes, updates this ledger, removes the worktree.
4. Deploy at pause points only: `cd db && npx wrangler deploy` (prod `akl-db`, delegated), `flyctl deploy` for spark (delegated), the db-alias site via the scratch-copy recipe in `design/pipeline-313/02-handoff.md` §Recipes.

## Log

- 2026-09-12 · **Wave 1 DEPLOYED to prod akl-db** (Worker version 1fa2965c, migrations 0010–0013 applied; D1 bookmark taken first). Smoke: /v1/meta 200 with `health` (dump stale:true until the first catch-up tick), `?wait=` anonymous → `X-Wait-Ignored: unauthorized`, `/v1/changes/stream` 404 (live bot's keep-warm loops harmlessly until B3). `db.yml` pr-deploy now rides pushes to `ldb-arch-review` (91a81670e).
- 2026-09-12 · L1 landed (515088dc6). Wave 1 complete: db suite 15,810 green on ldb-arch-review.
- 2026-09-12 · L2 landed (850388595). Bot suite on the integration branch: 961 pass, 1 known red (LDB-B5 live parity, B3 gates it).
- 2026-09-12 · B1 landed (23435c60b); B2, B3, B4 launched in parallel. L1/L2 rebasing.
- 2026-09-12 · L3 landed (5b5a96ea0).
- 2026-09-12 · L4 landed (c6c003142). A1 launched (isolation worktree).
- 2026-09-12 · L1, L2, L3, B1 launched in parallel (isolation worktrees) alongside L4.
- 2026-09-12 · D1 (layoutdb architecture page) + D2 (ecosystem rewrite) landed; all four artifact pages measured in Chrome for SVG clipping and fixed.
- 2026-09-12 · review round 1 (audits, requirements, proposal, data-flow) landed; saltorbit answered §6; long-poll, Fly, rebuild cadence, safety nets decided; implementation kicked off with L4 first.
- 2026-09-12 · L4 in review (branch `ldb-L4`): webhooks+lease, SSE stream, Fly drill, per-major dump files, `[env.preview]` deleted (nothing else calls any of them; the bot's SSE keep-warm still targets the deleted stream until Wave 2 B3 switches it to the long-poll — do not deploy `db/` ahead of that, or coordinate first); the daily upstream diff shrunk to layout-count + a random 50-record sampled compare; `GET /v1/changes?wait=` (long-poll) added, gated on client cap `feed:wait` (`clients.caps` is now a comma-separated set), rate-limited, clamped to 25s. **Deferred, not deleted**: the multi-major format chain (`formats/registry.ts`'s `up`/`down`/`chainFn`/`chainViolations`/`path` composition, `core/write.ts`'s `chainToLatest`/`format_behind`/`written_as`, LDB-F18/F19/P13) — frozen in place per the audit's own offered alternative; full removal touches `put-format.test.ts` (LDB-P13's own suite), `held.test.ts`, `list.test.ts` and `docs-site.test.ts`'s stub-lineage T2/T3 fixtures, real multi-major coverage, not dead weight, and didn't fit this slice's budget. Suite green (88 files/15,756 tests/40 skipped, was 94/15,897/1); `bot/` typechecks clean against the rebuilt `db/formats` package.
