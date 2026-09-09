# Governance — no single owner, no single point of failure

Status: proposal (2026-09-08). Part of `00-plan.md`. "I'm not a web person"
— so this is written as the concrete list of accounts, files and drills, not
as principles.

## 1. Who can do what

Four kinds of power, each held by more than one person, each in data or in
config that another holder can change:

| power | where it lives | held by | how it changes hands |
|---|---|---|---|
| **edit the data** as admin (force-transfer, delete/restore any record, register bots, add admins) | D1 `admins` table (`02 §5`) | ≥ 2 Discord users at all times (LDB-A6) | any admin adds another; removing needs the row not to be one of the last two |
| **change the code** | GitHub repo under an **org** (`00 §6.5`), `main` protected: 1 review, CI green | org owners ≥ 2; format dirs have their own `OWNERS` (§2) | org owner adds an owner; CODEOWNERS PR |
| **run the service** | one Cloudflare account: the Worker, D1 `akl-db`, R2 dumps, DNS for the API hostname | ≥ 2 members with Super Administrator | account member management; the runbook (§4) lists every secret and where it is set |
| **speak for it** | the API hostname (DNS), the Discord bot application | DNS in the same Cloudflare account; the bot app has ≥ 2 team members in Discord's developer portal | same as above |

The first maintainer is one of the ≥ 2 in every row and is not special in any
of them. That is the whole "no dictatorship" mechanism: there is nothing
saltorbit can do that a second admin cannot undo, and nothing that stops if
saltorbit stops.

## 2. Changing the format is a pull request, reviewed by the format's owners

`db/formats/<name>/<N>/OWNERS` lists GitHub handles; `.github/CODEOWNERS`
maps the directory to them. The author of an advanced engine owns their
format directory and merges changes to it themselves, subject only to the
compatibility gates (§3) — nobody else's review is required, and nobody
else's format is touched. `core/1` and `akl/1` are owned by the DB
maintainers as a group.

What a format PR must contain (the template enforces it):

1. `schema.json` — a new major is a new directory; a minor adds optional
   keys only.
2. `index.mjs` — `validate`, `toCore`, `lower`, optional `to`/`from`.
3. ≥ 1 new fixture with its `.core.json` and `.lowered.json` goldens.
4. `README.md` — what it is for, what it cannot express, what is lost in
   each `to` translation.
5. An entry in `docs/formats.md` (generated from the registry; the PR
   regenerates it).

## 3. Gates that stop anyone breaking anyone else

All run in `db.yml` on every PR and on `main`:

| gate | what it catches |
|---|---|
| **frozen-format diff** (LDB-F6) | any edit to a merged major's `schema.json` or existing fixtures; a tightened schema; a changed golden |
| **every fixture, every version** (LDB-F1/F2/F7) | a validator or lowering change that alters the output for any historical fixture of any format |
| **cross-format goldens** | `to["x/N"]` outputs for every fixture that declares them, frozen |
| **API conformance** | the request/response fixtures in `db/tests/conformance/` (every endpoint × every documented error) — the contract other clients build against; changing one is a documented API change |
| **client-signing vectors** (LDB-A4) | a change to the signing scheme that the bot would not reproduce |
| **D12 import diff** (LDB-P5) | a change that makes the compat facade drift from cmini for unforked records (runs against the live scrape; skipped when unreachable, never green-skipped on `main` twice in a row — the CI gate-split lesson, `ci-gate-split-256`) |
| **migration replay** | every migration applied in order to an empty local D1, then the API suite; and applied to a restored dump (§4) |
| **rehost drill** (§4) | the service can be brought up from yesterday's dump and last week's code by a script, without any secret that only one person has |

A PR that touches only its own format directory and passes the gates is
mergeable by its owners without the DB maintainers.

## 4. The rehost drill — "take over in an afternoon"

`db/README.md` §Rehost is a numbered procedure, and `db/tests/rehost.test`
executes the parts a machine can:

1. Clone the repo. `cd db && npm ci`.
2. `npm run rehost -- --dump <url or file>`: creates a local D1, applies
   migrations, imports the dump, starts the Worker locally, runs the API
   suite against it. (CI runs exactly this against the latest nightly dump
   — the one line that proves the dumps are complete.)
3. `wrangler login` as any Cloudflare member; `wrangler deploy` with
   `wrangler.toml` as committed (no per-person config); set the four
   secrets the runbook lists (`SESSION_SECRET`-class values that any admin
   can regenerate — none are shared with another system); `wrangler d1
   execute akl-db --remote --file dump.sql`.
4. Point DNS. Clients notice nothing: the API is stateless beyond D1.

Things the runbook lists explicitly: every secret (name, purpose, who can
regenerate it), the Discord application (owner team), the R2 bucket, the
cron schedule, the import source URL, the admins bootstrap.

## 5. Public by default

- The event feed, dumps, the changelog page and the format registry are
  public reads. Nothing about a layout was ever private in cmini; the DB
  keeps that.
- The code is public (the repo split in phase 5 makes it its own public
  repo; `db/` is licensed permissively — MIT — so a fork by anyone is legal
  as well as possible; `bot/` inherits GPLv3 from cmini's code).
- Decisions live in `design/layout-db/` (later `db/docs/decisions/`) as
  numbered ADRs; a proposal is a PR anyone can open.

## 6. Invariants

| id | invariant | enforced by |
|---|---|---|
| LDB-G1 | The service can be restored from a public dump plus the public repo with no artifact that exists only on one person's machine. | rehost drill in CI |
| LDB-G2 | No admin capability is a constant in code; all are rows. | grep test: no Discord id literal outside fixtures |
| LDB-G3 | A format directory's owners can merge a change to it that passes the gates without any other approval. | CODEOWNERS test against the registry |
| LDB-G4 | Every secret the Worker reads is listed in the runbook with a regeneration procedure. | test: `wrangler.toml`/`env` bindings ⊆ runbook table |

## 7. Open questions (governance)

1. Org and account names (`00 §6.5`).
2. MIT for `db/`? (cmini's code is GPLv3; `db/` shares none of it.)
3. Who owns `mana2/1` on day 1 if Zak declines — the DB maintainers as a
   group, with a note that it is a mirror of mana2's own spec?
