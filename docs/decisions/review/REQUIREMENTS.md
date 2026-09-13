# layoutdb — consolidated requirements and decisions (review input)

Written 2026-09-12 from `design/layout-db/00–22, architecture.md`, `design/pipeline-313/01–04`, `design/publish-ux/{00,04,08}`, `design/federation/01`, `design/HARD-REQUIREMENTS.md` (HR), `db/INVARIANTS.md`, `db/README.md`, `bot/README.md`, and the layoutdb memory notes. Source keys: `LDB-nn` = `design/layout-db/nn-*.md`; `P313-nn` = `design/pipeline-313/nn-*.md`; `PUX-nn` = `design/publish-ux/nn-*.md`; `mem:x` = memory note `x`. Only rows marked **saltorbit** were stated by him; everything else is agent work he has not ratified.

## §0 Priorities (saltorbit, 2026-09-12)

1. **Correctness.** Changes are never lost, silently dropped or misreported. A good backup strategy.
2. **Simplicity.** The simplest architecture that meets 1. The DB stays separate and client-neutral (common infra, prefers no client). akl.gg and the bot may commingle and share services.
3. **Latency.** Bot commands under 1 s. Ranking may be slower only when a just-edited layout needs reparsing. Site latency targets to be set judiciously.
4. **Cost.** Cheap.

These rank above every row below; where a past decision conflicts with this order, the row is a candidate for revisiting.

## §1 Hard requirements (saltorbit)

| id | requirement | source | date |
|---|---|---|---|
| H1 | Bot lookups are well ordered and always correct: every edit layoutdb recorded before the command is included; numbers come from the layout's current keys **and magic rules**. "the bot can never give incorrect information." | HR R1; P313-02 "Decisions" | 09-11 |
| H2 | Every bot command answers in ~1 s or less; "5-10 seconds is unacceptable." Covers lookups and writes. | HR R2 | 09-11 |
| H3 | Sorts/rankings are near instant and incremental (changed layout = a diff against the prebuilt bulk); may be briefly stale. | HR R3 | 09-11 |
| H4 | A site publish checks with layoutdb before it is accepted; a stale basis is refused, never merged silently; what the site shows as published matches layoutdb. | HR R4 | 09-11 |
| H5 | Freshness is never proven by wall-clock; only by event seq, rev, or content hash. No bot command waits on the stats service, a GitHub job or a batch pipeline. No cold engine/corpus load on the request path. | HR "What these rule out" | 09-11 |
| H6 | No write-back to cmini, ever. Import is one-way; local edits win per record. | LDB-00 §0.4, D9; P313-03 §1.3 | 09-08 |
| H7 | The DB stores no stats and computes no analysis; it only stores layouts, ownership, likes, history and translates formats. Every client computes its own numbers. | LDB-00 §0.7; mem:db-separation-boundary | 09-08, 09-11 |
| H8 | DB separate and client-neutral: "the db is the only thing i would like to try to keep separate. Bot and aklgg are both owned by me and fair game to colocate." No private door for akl.gg or the bot (P7). | mem:db-separation-boundary; LDB-00 P7; LDB-04 §1 | 09-11 |
| H9 | Only the DB is co-owned (own Cloudflare account `akl`, ≥2 Super Admins, admins table ≥2 rows). akl.gg and the bot stay saltorbit's. | LDB-04 §1; LDB-07 §1 | 09-09 |
| H10 | No write to an existing record without naming the version it saw (`If-Match` required; absent = 400). `*` = explicit overwrite. | LDB-09 §2.3 | 09-09 |
| H11 | Per-part versions (layout fields vs each format); E1–E4 stale/exactly-one-wins/independent-parts/create-needs-no-version; L1 repeat like → `409 already_liked`; likes never bump a version. | LDB-21 D13 | 09-11 |
| H12 | layoutdb is disposable until it has outside users: test on prod, wipe and rebuild freely, no data migrations unless asked. | mem:layoutdb-is-disposable; P313-02 §6d | 09-11 |
| H13 | One layoutdb (prod `akl-db`); no preview layoutdb. Only prod akl.gg is fenced (Pages prod env, `cb-magic`, akl.gg zone, main's workflows, meta-watch). | mem:one-layoutdb; P313-02 START HERE | 09-11 |
| H14 | Every edit carries a proven source client (`client:<id>`, `discord-app:<id>`, `system:*`) "so we know what happened and can facilitate better rollbacks". | LDB-20 §1.14 | 09-10 |
| H15 | Magic rules: only akl.gg's; cmini's dropped on the floor. akl.gg publishes its rules to the DB and keeps its editor (PUT never becomes 410). | LDB-17 header; LDB-11 W6 3(b); bot LDB-B24 | 09-10 |
| H16 | spark/1 validation matches akl.gg's validation exactly ("take the rules as is"). | P313-02 §6b; LDB-F22 | 09-11 |
| H17 | Never repeat unvalidated user strings in bot replies (abuse vector). | LDB-16 header; #304 | 09-10 |
| H18 | Nothing merges to `main`; nothing deploys to prod akl.gg but saltorbit. Prod layoutdb migrations/deploys are delegated. User-facing copy needs sign-off. | P313-02 "Standing rules"; mem:prod-layoutdb-deploys-ok | 09-11 |
| H19 | Nothing ships to akl.gg users until the DB is a strict superset of what the site shows from cmini (verified by diff). | LDB-00 D12 | 09-08 |
| H20 | Site stays an SPA over bulk static files "for now … i just want to simplify where possible"; no live channel to the site. | HR R5 | 09-11 |
| H21 | Sync the live bot and trial site with in-flight work only at natural pause points, never when painful. | mem:sync-at-pause-points | 09-11 |
| H22 | The DB will eventually have its **own website**: mostly read-only for the public, plus a **moderation view** where admins change authors, ban users, rename layouts, etc. | saltorbit, 2026-09-12 (arch review session) | 09-12 |
| H23 | Layouts gain a **`link` field** (user-submitted URL to the layout's GitHub etc.) that passes through a **moderation queue** before it shows. | saltorbit, 2026-09-12 (arch review session) | 09-12 |

## §2 saltorbit's decisions

| decision | source | date |
|---|---|---|
| One database, not federation ("a Federation concept that I don't want to do"). | LDB-00 §0.3, D1 | 09-08 |
| Bot = TypeScript rewrite sharing akl.gg's core (mana2 wasm + `cminiRowFromMana2`), MIT, Fly.io, not a Python fork. Prefix `!spark` tentative. | LDB-05 §1, §5; LDB-00 D11 | 09-09 |
| New community Cloudflare account for the DB; Workers Paid confirmed. | LDB-07 §1; LDB-20 §8 Q4 (lead's answer, ledgered) | 09-09/10 |
| Bot: no stale reads, no clobbering writes; every read verb verifies freshness first; every write sends `If-Match`. 30 s poll retired. | LDB-10 D15 | 09-09 |
| Product name **layoutdb**; `akl-db` stays the Worker/app id; cmini = the upstream. | mem:layoutdb-naming | 09-10 |
| Command surface: drop `link`, `mod`, `pattern`, `freqd`, `search/filter/homerow` ("complex things should direct people to the site"); every personal link goes away; `history` → changelog link; `transfer` alias; `image a b`; akl.gg stat names everywhere (`3-Rolls` not `onehands`); `fingers/fspeed` usage only. | LDB-18 §1, §3 | 09-10 |
| Same-name re-add inherits the tombstone's likes ("a quirk people like"); rename never loses the id. | LDB-18 §2 D1/D2 | 09-10 |
| Magic edited on the site only (no `setmagic`); `view` stays text; `view` stays fuzzy. | LDB-18 D7; P313-02 F8 | 09-10/11 |
| spacegrams `off/left/right/auto` per user; `SG On`/`SG Off` footer + corpus line; T2 + I1 mockups; `!theme default/colorblind`; WCAG AA footer for all themes. | LDB-18 C13/C14; LDB-14 rounds 4–6 | 09-10 |
| spark/1 = the one stored format (akl/1 renamed, byte-identical); cmini = import source not a format; mana2/1 = output-only, writes refused; top-level `upstream {following|forked}`; **magic edits fork**; restore has no time limit; always store latest major with `up`/`down` chain. | LDB-20 §1.1–10; LDB-19 header; mem:layoutdb-format-round2 | 09-10 |
| Forking is transitional (only while the cmini import runs); no re-follow; no general fork concept. | LDB-20 §1.16 | 09-10 |
| API adoption guide + every layoutdb doc on the site, cross-linked, HTML with md copies. | LDB-20 §1.15 | 09-10 |
| Several formats per layout (D3), no default format (D4), cmini export deleted (D5), akl.gg editor unchanged (D6), no Fossil/WASM modules (D7), no data migration/wipe instead (D8), docs move with code (D9), drop `x` (D10), F6 freeze suspended until first outside adopter (D11). Repeated letters deferred (D2, #322). | LDB-21 §1 | 09-11 |
| Webhook delivery takes a lease (xsznix's CAS-race report). | LDB-21 D1 | 09-11 |
| Bot keeps following layoutdb itself (feed + per-command check); published numbers only with exact provenance (`db_seq`); computes the rest in wasm. Reversed "bot reads only the pointer". | P313-01 §7 B6; P313-02 Decisions | 09-11 |
| `db.yml` deploys prod layoutdb on PR pushes; PR #307 rebased onto main; write rate limit 1000/actor, 5000/client per 10 min; issue #321 filed. | P313-02 §5, §6c, §6e | 09-11 |
| Magic reset to akl.gg's file via the fork lane, knowingly. Later moot after the wipe. | P313-02 cutover 1, §6d | 09-11 |
| Publish UX (all CLOSED): the bench is where you publish; one sheet → later a popup modal; S1 Update/Publish-as-new radio; S4' auto-rebase, one Publish verb, no Overwrite; Discard/Keep draft/Publish footer; magic-only lane retired; no badge; DRAFTS/PUBLISHED shelves, K3 30-day window with always-visible choices; no destination tails; no ♥ button; no ⋯ on others' cards; `.jsonc` only export, site never emits bot commands; Similar dead; Author "me" chip retired. | PUX-04; PUX-08 §5c/§5d | 09-10/11 |
| Round-1 review cuts: no `link` field/verb, no `origin`/provenance field, no `core` field or format ("overkill"), no personal tokens ("this doesn't feel right"), no cmini-compat facade. | LDB-00 §6 resolved; LDB-02 §2.2; LDB-03 §2.1 | 09-08 |
| Bot naming constraints: ≤5 letters, mascot-able, no gendered names, cosmic/elemental. (Name `spark` in use; never formally picked.) | mem:bot-naming | 09-09 |

## §3 Agent-made decisions, not ratified (revisable)

| decision | source | complexity cost |
|---|---|---|
| Event-sourced model: `events` + `layout_revs` + fold; whole log in every dump. | LDB-07 §4 | Per-rev payload storage; dump grows unbounded. |
| ULID primary ids while site pipeline, patch tables and bot cache key by lowercase name. | LDB-07 §2; LDB-11 §3.1 | Permanent dual id space (`_dbId` side-fields). |
| Two auth lanes: Discord bearer (5-min hash cache) + Ed25519 client lane with nonces, caps, per-client limits. | LDB-02; LDB-10 D8/D9 | Three auth tables; a custom signing scheme; site proxy stores encrypted Discord tokens in `cb-magic`. |
| Bespoke `canonical()` JSON; `safejson.ts` double-parse for a V8 bug. | LDB-07 §2, §0.1 | Two hand-rolled serialization layers. |
| Per-layout `n` counter + PK as the concurrency guard, server-side retry ×3 (over a serial writer / Durable Objects). | LDB-21 §2.1–2.2 | Retry logic + race tests; satisfies D13 E3 but the mechanism is the lead's. |
| Webhooks (lease, backoff) **and** SSE stream (Paid-only) **and** `/v1/changes` polling; only the bot uses SSE, nothing uses webhooks. | LDB-12 §6; LDB-21 D1 | Three follower mechanisms; `webhooks` table + drain cron. |
| Import machinery: 5-min cron, stall guards, `<name>~cmini` shadow names, rename = delete+create, daily upstream diff, retry-then-fail jobs. | LDB-07 S5/S8; LDB-06 §2 | Operator runbook; synthetic names; four cron duties in one trigger. |
| Nightly R2 dump + daily CI rehost drill + Fly drill app + `cmini-backup` branch + D1 bookmarks. | LDB-04 §4; LDB-12 | Four overlapping backup proofs. |
| Format registry: `role`, `to/from`, `up/down` chain, `format_behind`, `written_as`, per-major dumps, stub lineage, `held` reads. | LDB-19 §3–6; LDB-21 §2.5 | A path engine for a system with one stored format. |
| Stats pipeline (#313): Fly Python service → R2 base/overlay behind a CAS pointer via a writer Worker; SPA pointer mode. | P313-01 §7; P313-03 §3 | Third runtime, second origin, a writer Worker, two stat-delivery paths (D1 patches vs R2 overlay). |
| Bot: own `worker_threads` engine; wasm + corpus tables fetched from akl.gg at boot (fatal on 530); harvest cells memoised per `(id, rev, corpus)`; `rank` >50 uncached → "try again"; prefs on a Fly volume. | LDB-10 §1 D1–D14, V3 | Availability coupled to akl.gg; a second worker implementation; stateful machine. |
| Magic rules: M2 seed from akl.gg's file; D1 `magic_rules` + sync workflow kept for a "parity window"; `db_site_write` dispatch with no consumer. | LDB-17 §4 M3; LDB-13 §6.6 | Two sources of truth until an undated retirement. |
| Hosting: DB on Cloudflare `akl`; bot, stats, data bucket, writer Worker, site all in saltorbit's Fly/Cloudflare accounts. | LDB-08; P313-01 §7 | Two clouds, two Cloudflare accounts, four apps. |
| `db/` hard boundary: ports are copies; `@akl/core` is a `file:`-linked build of `web/src/core`; repo split planned. | LDB-07 §2; LDB-11 §3.4 | Duplicated validators in two languages; bot breaks when core exports vanish. |
| Poll rate limiting deferred to a WAF rule that needs a hostname. | LDB-09 §6.2 | Read protection depends on an undated domain. |
| B6 lead's calls: proof by input equality; row table + sweeper; budgets 4× warm capped 1 s; magic engine assumed for rule-less keys (Q5 open). | P313-03 §3–4, §8.1 | New in-bot index structures over an open question. |
| Author-name policy LDB-I15..17 + migrations 0006/0007. | P313-02 | Schema growth predating the "no migrations" rule. |

## §4 Rejected by saltorbit

- **Federation** / multi-node sync (LDB-00 §0.3; `design/federation/` is superseded).
- **Personal/API tokens** for CLI writes; **no `core` field or format**; **no `link`**, **no `origin`/provenance field** on the record (LDB-00 §6; LDB-02 §2.2).
- **cmini-compat facade** `/compat/cmini/v3/*` (LDB-03 §2.1); later the whole **cmini export** `?as=cmini/1` (LDB-21 D5).
- **Fossil-style content-addressed revs; WASM format modules** ("idc about wasm") (LDB-21 D7).
- **Blind overwrite without `If-Match`** (LDB-09 §2.3); **wall-clock freshness**; **bot waiting on batch pipelines**; **bot reads only the pointer**; **stats service as the only follower** (HR; P313-01 §7 B6).
- **Separate preview layoutdb**; **data migrations** for the test-server DB (mem:one-layoutdb; P313-02 §6d).
- **Retiring akl.gg's rules editor (410)**; **cmini's magic rules** as a source; a **per-layout call** on the fork list (LDB-11 W6; LDB-17).
- **Bot DSL** `search/filter/homerow`; **personal links**; **`link/mod/pattern/freqd`**; **`onehands`** naming; long spacegrams footers (LDB-18; LDB-14).
- **Similar (#238)**; Overwrite/Re-apply conflict choice; `verifying` badge; ♥ buttons; `published <date>` subtitle; K1 folding; Author "me" chip; DRAFTS destination tails; cmini/mana2 command exports (PUX-04; PUX-08 §5d).
- **Live channel to the site** for now (HR R5).
- Round-1 `home()` rank letting older majors sit beside newer (LDB-19 header).

## §5 Open questions for saltorbit

1. **Stats machine size** for magic layouts (36–522 s each on shared-cpu-2x) (P313-03 Q3; TODOs A3/A4).
2. **Rule-less magic keys**: magic engine (bot) or plain (bench)? Are n-gram verbs inside R1? (P313-03 Q4/Q5.)
3. **Site freshness target** (today a 20-min pointer re-read) and owned layouts losing layoutdb identity in pointer mode (P313-02 §C).
4. **#325 latency**: p95 4.8 s vs H2; measured, not cold-start (mem:bot-hammer-fixes).
5. **Production path**: `code_hash` fix + forced re-harvest; `data.akl.gg` + prod bucket/writer; W6 `DB_BASE_URL` flips; #307 merge; where `ldb-formats` lands (P313-02 §C).
6. **Copy sign-off**: every `// COPY: sign-off pending` string (site, bot, integrator docs); stale-row and slow-command wording (LDB-14; P313-03 Q1/Q2).
7. **Governance**: second admin; GitHub org, npm scope, hostname; `mana2/1` owner; transition phase timing; Pine questions (LDB-15 §8; LDB-12 §8).
8. **Import end state**: import forever? renames as delete+create? upstream delete → tombstone? likes union after fork? (LDB-00 §6; LDB-06 §9.)
9. **Bot prefix** (never formally picked), dedicated channel, cmini naming in copy (LDB-10 §9).
10. **Parked design rounds**: layout-entry expressivity + board shape (D4/D8), mana stats as text (#309), color schemes (LDB-13 §6b).
11. **PUBLISHED date source** (`modified_at` bulk-stamped vs changelog "last published by you") (PUX-08 §5c).
12. Upcast details: `migrated` bumps rev? tombstones migrate? dump naming? (LDB-19 §11.)
13. Housekeeping: rotate `GITHUB_DISPATCH_TOKEN` (plain text in Pages env); delete `akl-db-preview` (P313-02 §7).
14. Deleted records' `before` payloads public? `like` on own layout allowed? (LDB-03 §10.)
15. ~~Could the DB-side website absorb akl.gg's Discord sign-in / token proxy / admin pages?~~ **Answered by saltorbit, 2026-09-12:** no. akl.gg keeps its own Discord auth. The DB website is a separate entity (a client) that does its own sign-in; the DB only validates the token it presents. Moderation = admin-gated API routes + events.

## §6 Contradictions and flips between docs

1. **DB stores no stats (H7) vs a stats service.** Held: the stats service writes only to R2, never to layoutdb (P313-01 §7 ans. 4). The bot's wasm, tables and "published bulk" all come from saltorbit-owned services; fine under §0 priority 2, but confirm it is intended.
2. **Free tier vs Workers Paid.** LDB-08 said free; LDB-07 §4 sized against the free cap; LDB-13 says Paid; LDB-20 §8 Q4 the lead answered "Paid"; LDB-12 §8 Q1 still asks saltorbit. SSE needs Paid. `mem:d1-write-budget` concerns the site's `cb-magic`, not `akl-db`.
3. **Magic-only edits fork or not.** LDB-11: fork. LDB-17 (09-10 am): never (LDB-I12). LDB-20 §1.6 (09-10 pm, saltorbit): fork. The 09-11 wipe made the grandfathered 67 moot; LDB-21 D12 deletes the legacy rule.
4. **Format name and count.** `akl/1` + `cmini/1` stored (LDB-07) → `spark/1` only (LDB-20) → several stored formats, cmini export and `x` gone (LDB-21). LDB-10/12 still say `akl/1`; LDB-12 makes `mana2/1` writable, LDB-19 output-only (stands).
5. **Auth lanes.** LDB-09 §0: "no client lane." LDB-10/11/15 build it; the bot depends on it.
6. **Preview vs prod layoutdb.** LDB-09/11/13 build on `akl-db-preview`; P313-02 START HERE (saltorbit) retires it. `db/README.md` "Preview environment" and LDB-C1 are stale.
7. **Who deploys the bot.** P313-02 says "saltorbit deploys `spark-bot`" and, in the same file, that the agent deployed it; v30 again by an agent. H18 exempts layoutdb, is silent on the bot.
8. **Where stats are computed.** Prod akl.gg: CI + live-sync D1 patches (cmini-sourced). Trial: Fly service → R2 (layoutdb-sourced). Bot: wasm in Node. Bench: browser wasm. P313-01 §6 F4: service and live-sync "must never both write"; both run today.
9. **Bot freshness proof.** 30 s poll → `ensureFresh` + SSE → wall-clock `harvestFresh` (broke H5: 7 layouts wrong live, P313-03) → S2 input-equality proof. LDB-12 §6.15 still says "the bot polls".
10. **Magic numbers in the bot.** LDB-10 D4: unresolved numbers with a caveat; H1 demands rules applied. LDB-B80 (09-12): every n-gram verb still ignored magic; fixed on `ldb-bot-fixes`.
11. **Magic rules source of truth.** LDB-17: after M2 the DB is the source. Reality: prod akl.gg still builds from `cb-magic` D1; layoutdb was re-seeded from that file twice on 09-11; 5–7 layouts exist only in the stale site file.
12. **How the site learns of changes.** LDB-00: meta-watch polls. LDB-11: `db_site_write` dispatch (no consumer built). P313: stats service polls 30 s, SPA re-reads pointer every 20 min. Webhooks and SSE unused by the site.
13. **Second admin.** Phase-2 blocker (LDB-07) → not needed (LDB-09) → before phase (c) (LDB-15) → "later" (LDB-13). Today saltorbit alone, violating LDB-A6.
14. **Rate limits.** 60/actor → 300/client → 1000/5000 (saltorbit). Poll limits wait on a hostname that does not exist.
15. **Transfer's `If-Match`.** Required but value ignored: a half-applied H10 (LDB-09 T2; LDB-21 §2.4).
16. **Naming drift.** Every `*-preview` app and `db.cmini-web.pages.dev` serve prod layoutdb; `db.yml pr-deploy` keys on `layout-db-pr` while the live branch is `ldb-formats`.
17. **Migration cadence.** Cron (LDB-19) → operator-driven (decision 11) → deleted (LDB-21 D12).
18. **`layout-dates.json`.** Open (LDB-06) → closed, no backfill (LDB-12 §0.6) → reopened (LDB-12 §8 Q5).
19. **`link` field.** Rejected in the round-1 review ("let's delete this too", LDB-00 §6, D2; cmini's `link` kept only for import fidelity, then dropped with `x` in LDB-21 D10; bot `link` verb dropped in LDB-18). Partially reversed 2026-09-12 (H23): a moderated, user-submitted `link` returns as a first-class field.

**Decision 2026-09-13 (saltorbit): moderators must NOT be able to override or adjust like counts** ("I take it back. Mods should not be able to override the like count"). `like_count` is the count of `likes` rows and nothing else. Reverses the 2026-09-12 wording of H22; moderation keeps bans, rename, author change, restore and the moderated `link` field.
