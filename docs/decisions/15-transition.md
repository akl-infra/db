# 15 — Transitioning the community from `!cmini` to `spark`

Status: proposal (2026-09-09). Part of `00-plan.md`. Answers "how do we
actually move people" now that phase 1–4 are deployed (`13-ledger.md`):
`akl-db` mirrors cmini with zero diff, `spark` answers 46/46 of the live
e2e parity run, and the site's publish UX is built but not switched on.
Does not re-decide anything `00-plan.md`/`04`/`06`/`11` already settled —
it sequences what they built.

## 1. Goal and non-goals

**Goal:** move command traffic from `!cmini` (Pine's bot, cmini's API) to
`spark` (`!spark`/`!sp`/`!aklgg`/`!ag`, the layout DB), and publishing from
nowhere-on-the-site to akl.gg's publish UX, at a pace the community and
Pine are comfortable with, with no layout lost, no number silently wrong,
and no command that used to work suddenly not.

**Non-goals:**
- **No write-back to cmini.** The import is one-way (D9); a `spark`/akl.gg
  write never reaches cmini. cmini and the layout DB can diverge per-record
  ("forked", §3) — that is the point, not a bug to fix.
- **No forced migration.** `!cmini` keeps working in Pine's Discord for as
  long as Pine runs it, regardless of `spark` uptake; the import (§4.1)
  keeps mirroring it either way. Nobody's workflow breaks by standing still.
- **Not a reconciliation project.** No merge back to one truth — once a
  record forks, the two sides are allowed to just differ (D9, LDB-P5 only
  checks *unforked* records).
- **Not a new command surface.** `05-bot.md` §2 is the parity contract:
  same verb names, usage lines and wording; the only new things are
  additive (§3) and the prefix.

## 2. Phases

Each phase is reversible on its own (§6) and does not require the next.
These are *rollout* phases layered on top of `00-plan.md §5`'s already-shipped code phases 1–4 — separate numbering.

### (a) Parallel run in a test server — **underway today**

`spark` (and its `!spt` test twin) already run against production and
preview DBs in saltorbit's test guild (`13-ledger.md`). Nobody but the people
testing it sees it.

**Exit:** the e2e harness (`bot/tests/transcripts/`) green for 7 consecutive days against production, every failure fixed or explained (today: 46/46, LDB-B18); a second admin has redeployed the bot from `bot/README.md` alone, unassisted.

### (b) `spark` in the main Discord next to `!cmini`, read-only verbs first

`spark` joins Pine's server; `!cmini` stays untouched and primary. Write
verbs (`add remove rename assign setfingermap swap! cycle! angle!
unangle! mirror! like unlike`) are **not** offered yet — the bot has no
mode switch for this today, so **building one is a prerequisite of this
phase**: a config flag that makes write verbs reply "not yet — try
`!cmini <verb>`" instead of hitting the DB. Read verbs (`view stats
fingers fspeed sfbs sfs rolls …`, `compare rank filter search`, plus the
new `history magic image link`) are on from day one — most number-checking
and browsing already happens here, and it's the surface `LDB-B5` most
directly protects.

**Exit:** two weeks of real read-verb traffic with no unresolved "the number's wrong" report that isn't already in §3's table; the announcement (§7, first draft) posted and pinned.

### (c) Writes enabled

The read-only flag from (b) comes off; `spark`'s write verbs go live in
the main server. The moment anyone edits a layout through `spark` (or,
once (d) is on, akl.gg), that record **forks** from cmini and stops
receiving its updates, permanently (D9). One sentence for users: *"editing
a layout here disconnects it from cmini — cmini keeps its own copy, and
after that point they're free to drift apart."*

Before this phase: a **second admin** must exist (§5) — real users are
one `!spark remove` away from a mistake needing an undo even if saltorbit is
asleep, and `04 §1`'s "≥2 at all times" is standing, not someday.

**Exit:** a week of real writes with no unresolved D4/If-Match incident (a
`409`/`400 magic_collision` a user couldn't resolve by retrying), no
import-cron interference with a forked record (LDB-P5 stays green for
records that *haven't* forked), the second admin has performed one real
admin action unprompted.

### (d) akl.gg's publish UX on

`06-akl-integration.md §3` / `11 §1` W3–W4/W6 step 4: `functions/api/db/*`
proxy live on Pages Production, sign-in-to-publish, the draft/publish
sheet from the approved #215 round. Independent of (b)/(c) — it can go
out to the site's much larger silent-reader audience once the DB is
proven under `spark`'s smaller, louder user base.

**Exit:** W6 steps 1–4 done (`11 §1`), `LDB-S1` holds in production, a
handful of real publishes with no `LDB-S3`/`S4` mismatch, Discord sign-in
used at least once by someone who isn't saltorbit.

### (e) `!cmini` deprecation — **only when Pine agrees, or the community votes**

Never automatic, never date-driven — a governance event (`04`), not an
engineering one: either Pine retires `!cmini` (his bot, his call), or the
community reaches whatever consensus mechanism `04`'s org (§5) ends up
defining. Until then `!cmini` and `spark` coexist indefinitely; the import
(§4.1) has no reason to stop on its own. If it happens: an announcement
(§7, second draft), a pinned message pointing `!cmini` users at `spark`'s
equivalent verb, and — on Pine's own timeline — cmini's API going away,
the one thing that would force the import to freeze (§4.1).

**Exit:** Pine's explicit sign-off, or a documented community decision
per `04`'s (still-to-be-defined) vote mechanism. Not ours to date.

## 3. User-facing differences

Every row is something a `spark` user can hit today or once writes/publish
are on. "What to tell users" is the line to actually say, not a summary.

| difference | what changed | what to tell users |
|---|---|---|
| **Stats numbers** | cmini's own Python analyzer → mana2 (Go/wasm), composed into the classic row by `cminiRowFromMana2` — the same composition akl.gg uses since #214, so `spark`/site agree by construction (LDB-B5). Not cmini's code path. | "numbers come from the same engine as akl.gg, not cmini's analyzer. They match to the decimal for essentially everything (#214's 200-layout battery); if one looks off, say so — it's not a stale copy." |
| **`freqd`** | Not implemented — needs a tetragram table the bot doesn't have. | "`!spark freqd` answers *not available yet — needs a tetragram table this bot does not have*, on purpose. No ETA." |
| **`!spark image`** | New: renders a board PNG via headless canvas over the site's copy-image drawing code (same code, different pixels than a browser). cmini has no image verb. | "new — a PNG in Discord, like the site's copy-image button. Nothing to port from `!cmini`." |
| **`!spark history`** | New: last 5 events on a record, including whether it still follows cmini. | "new; shows recent activity and fork status." |
| **`!spark magic`** | New: a layout's magic as authored (`01-format.md`'s intent shape), not the flat lowered rules. | "new — shows the authored rules, not the compiled ones." |
| **`!spark link`** | Repurposed. cmini's `link` (an admin-set arbitrary URL) has no field in the DB (dropped, round-1 review, `00 §6`); `!spark link` now prints the layout's akl.gg permalink. | "no longer a personal URL — that field is gone. It's now the akl.gg page link." |
| **Default corpus** | Bot-local `corpus` pref defaults to `reddit`; cmini's `mt-quotes` doesn't exist here. | "`!cmini corpus mt-quotes` has no equivalent — default is `reddit`, pick with `!spark corpus`." |
| **Prefix** | `!spark`/`!sp`/`!aklgg`/`!ag`, alongside `!cmini` throughout. Same verbs, same wording. | "same commands, new prefix, both bots answer — nothing to relearn." |
| **Editing forks the record** | Per §2(c). | the one-sentence line in §2(c). |

## 4. Data questions

### 4.1 Import end state

**Recommendation: keep importing indefinitely, don't pick a freeze date.**
The cron is cheap (a quiet tick is one upstream GET every 5 minutes,
`06 §2`) and it's the only thing that lets people who never touch `spark`
still show up in the DB and stay current. Freeze only if cmini's API goes
away (nothing left to import) or the community/Pine formally sunsets
`!cmini` (§2e) and decides new cmini layouts shouldn't keep flowing in —
a governance call to make *then*, with real usage data, not now.

### 4.2 Renames of imported records

**Recommendation: accept the loss, as designed.** An upstream rename is
delete + create here too (`06 §2`, `11 §3.1` Q4/`00 §6` Q7) — cmini's id
*is* its lowercase name, so there's nothing to match a rename against but
content, and a heuristic is fragile. `import_map` (`03 §8`) stops the
import re-creating a name someone renamed locally; the freed old name
becomes available immediately, per `00 §6` Q7. This matches cmini's own
behavior (it loses the same history on a rename), so nobody's worse off.

### 4.3 The 10 layouts the magic migration forks

`11 §3` step 2 / `13-ledger.md` §6: migrating the site's D1 `magic_rules`
into records (W5, before W6's flip) forks exactly these from cmini, since
their rules already live in both places and the DB can't tell which is
newer without the PUT: `auditor, chog, echo, opal, opal-dario, opaline,
sunstone, vylet, vylet-v4, whirl`.

**Recommendation: proceed, with direct notice to those 10 owners before
the flip.** The DB's copy of their magic *is* the site's canonical copy
already (R2 of #221, `06 §4`) — cmini's flat rules are the derived,
staler artifact here, so forking is correct, not a side effect to avoid.
Short, known list; a DM to each owner ahead of W6 avoids anyone being
surprised by `!spark history` saying "forked" on a layout they didn't touch.

### 4.4 Likes on a diverged record

cmini likes arrive as `liked`/`unliked` events (actor = the liking
Discord user, `via: "import:cmini"`), replacing the imported set while a
record follows upstream (`06 §2`). Once forked, `06 §9` Q3 proposes
**union**: local likes accumulate; upstream's set merges in rather than
replacing wholesale.

**Recommendation: adopt the union proposal**, with one documented
limitation: an *unlike* on cmini after the fork point can't be reflected
here (union only grows) — a count that occasionally over-counts is less
confusing than one that silently drops from an event the user never took
here. Worth a line in `docs/formats.md` or the like tooltip once that
copy exists (`14`).

## 5. Governance milestones

- **Second admin.** Currently saltorbit alone (`13-ledger.md`), violating
  `04 §1`'s "≥2 at all times" rule. **Must exist before phase (c)** — an
  admin table with one row isn't `04`'s "no dictatorship" mechanism, it's
  a dictatorship with a spare key nobody's cut yet.
- **GitHub org.** Needed for `04 §1`'s code-ownership row to be true
  (per-format `OWNERS` files are aspirational without an org to grant
  access in) and for the phase-5 repo split. **Should exist before phase
  (e)** — deprecating `!cmini` is exactly the moment community ownership
  needs to already be true, not still pending.
- **Who can register bot clients.** Today: only an admin, via `POST
  /v1/admin/clients` (`02-auth.md §3`), and only saltorbit is one. Recommend a
  lightweight public process once a second admin exists — a GitHub issue
  naming the bot, maintainer and Discord user id it acts for; any admin
  registers it. Not self-service: the Ed25519 + `X-Akl-Actor` model
  (`02 §3`) means a bad registration is a bad actor with someone else's
  write access, so it stays an admin action, just no longer a
  single-person one.

## 6. Rollback per phase

| phase | rollback |
|---|---|
| (a) parallel test run | stop the test-server bot process; nothing else touched |
| (b) read-only in main | remove `spark` from the server, or flip its read-only flag off (never write-capable in this phase); `!cmini` untouched |
| (c) writes enabled | flip the read-only flag back on (§2b); already-forked records **stay forked** — not reversible per-record, only forward traffic stops. Say so in the announcement's fine print. |
| (d) akl.gg publish UX | `11 §1` W6 step 4: unset `DB_BASE_URL` on Pages Production (`/api/db/me` is the flag) — hides every publish surface; already-published records unaffected |
| (e) `!cmini` deprecation | nothing to roll back — an announcement + pinned message, not a technical flip; `!cmini` only stops if Pine stops running it |

## 7. Announcement drafts

**Flagged: copy needing saltorbit's sign-off before posting** — placeholders
only, in the spirit of `14-copy-signoff.md`; do not post as-is
(`CLAUDE.md`: never ship user-facing copy without sign-off).

**Draft 1 — phase (b), `spark` joins the server:**

> There's a second bot now: `spark` (try `!sp help`). It reads from a
> community-owned layout database, using the same engine as akl.gg for its
> numbers. Right now it only answers read commands (view/stats/compare/
> rank/…) — `!cmini` is still how you add/edit/remove layouts. Nothing
> about `!cmini` is going away; this is a second way to look things up.
> Report anything that looks wrong.

**Draft 2 — phase (e), `!cmini` deprecation (only once §2e is met):**

> `!cmini` is being retired on [date]. `!spark` already does everything it
> did — same commands, same wording, different prefix. Editing a layout
> with `!spark` (or on akl.gg) disconnects it from cmini's copy from then
> on, but nothing's lost: it's already in the new database. Questions →
> [channel/thread].

## 8. Open questions

### For saltorbit

1. Who is the second admin (§5), and when?
2. Timing of phase (b) — a specific week, or does it wait on the
   read-only flag (§2b) first?
3. Should the read-only flag be a real, tested feature, or just not
   deploying the write command handlers yet — worth a slice of its own?
4. `4.3`'s 10 owners — DM them yourself, or is `!spark history` enough
   disclosure once it ships?
5. Does the GitHub org (§5) need to exist before phase (b), or is phase
   (e) soon enough? `04 §7` Q1 is still open.

### For Pine

6. Any objection to `spark` in the main Discord alongside `!cmini`
   (phase b)? It only reads cmini's API via the import, never writes.
7. Is cmini's API expected to run indefinitely, or is there a rough date
   to plan the import (§4.1) and any eventual freeze around?
8. Any objection to importing `!cmini` renames as delete+create (§4.2) —
   same loss cmini has today, nothing changes for users?
9. Retire `!cmini` on your own timeline (§2e), or hand that decision to a
   community vote once the org (§5) exists?
