# 26 — Magic reseed: akl.gg prod as a periodic source until the flip

*2026-09-14 · branch `magic-reseed` · scope: `db/` only (a script, a CI
job, two invariants). No Worker change, no API change. Refines
`17-magic-ownership.md` §4 M2 ("the last time akl.gg's copy is read as a
source") and `23-geometry.md` §10.1's one-time `POST /v1/admin/magic-seed`.*

saltorbit, 2026-09-14, on saltorbit/aklgg#1 ("Magic rules storage must go
fully through akldb"): "the shipping magic on akl.gg must be undisrupted
... for now, we need to add akl.gg (prod) as an import to akldb, same way
as cmini as an import-only ... maybe we don't need a whole pipeline, but
we do need a way to periodically reseed akldb with magic rules."

## 1. The gap

The M3 live half (17 §4) is built: with `DB_BASE_URL` set, akl.gg's rules
editor reads and writes akldb. It is not flipped on in production. So a
rule set published on akl.gg today lands in the site's own D1 table, and
akldb only ever saw the one seed run after the 2026-09-13 wipe (81 records).
Measured 2026-09-14 against the live index (`https://akl.gg/api/magic-rules`,
111 rule sets):

| | count |
|---|---|
| identical to akldb | 79 |
| drifted since the seed (`finch`, `vylet-v4`) | 2 |
| new on akl.gg, no magic in akldb yet (`nightwts-magic`) | 1 |
| no akldb record at all | 29 |

The 29 are not on cmini and not in akl.gg's own catalog either: rule sets
for layouts deleted upstream, or workbench experiments that never became a
layout. Nothing to seed onto; they are reported, not created (a record needs
an owner, and that is a decision, not a reseed).

Flipping akl.gg to akldb with that gap would drop shipping rules. Closing
the gap once is not enough either: the site keeps publishing to D1 until
the flip, so the copy in akldb has to be kept current, not migrated.

## 2. Decision

**A periodic reseed, not an importer.** `scripts/reseed-magic.mjs` reads
akl.gg's public index and, per rule set, akldb's public record read; it
writes only through the existing `POST /v1/admin/magic-seed` (a system
write, `seed:aklgg`, never forks -- 20-spark.md decision 14), and only
what differs and is safe. `.github/workflows/db.yml`'s `reseed-magic` job
runs it daily and on dispatch. Nothing in the Worker changes: no new
upstream source, no follow state for magic, no new route or error.

Why not "same way as cmini": the cmini importer is 2 400 lines of plan /
fetch / apply / authors / recovery for a corpus of 4 000 records that
changes constantly and whose keys and board akldb *follows*. akl.gg's rules
are ~100 objects on one public endpoint, changing a few times a week, on
records akldb already has -- and the import invariants say an import never
touches magic (LDB-I10/I11, 17 §3). Bolting a magic-only source onto that
machinery would mean a second upstream per record and a magic-scoped
follow state, for a job that retires in weeks. A script over the public
API and the one admin route already built for exactly this write is the
right size.

## 3. The guard

The seed route is a raw tool: it replaces `magic` and resets
`upstream.state` to `following` (a post-wipe recovery needs both). A
periodic caller cannot use it unguarded -- after the seed, people write to
these records in akldb through the bot (magic, renames, key edits), and a
blind reseed would clobber a person's magic with akl.gg's older copy, or
un-fork a record they forked and hand its keys back to the cmini importer.

So the script decides from the public read alone, and seeds a record only
if:

- its spark/1 row's `source.client` is `system:magic-seed` or
  `system:cmini-import` (the last write was ours: a seed, or the import
  carrying a seeded magic forward -- the import never writes a forked
  record, so this can never mask a person's edit), **or**
- it has no magic **and** is not forked (a fresh import, a bot-native
  record: nothing to clobber, nothing to un-fork).

Every other record is reported `edited` and left alone, every run, until
the person's magic and akl.gg's agree or the flip makes the question moot.
The window between the read and the seed is seconds, once a day, on a
route only this job calls; a Worker-side check would need a new request
field and a new error code through the `/v1` contract (25-api-versioning)
for a job that is retired with the flip. Not worth it; revisit if the
reseed ever outlives the flip.

Refusals are the DB's: `400 magic_collision` / `invalid_payload` are
reported and fail the job. The one-time migration applied the DB's
collision hint automatically (01-format.md D4); the reseed does not --
akl.gg's rules must land in akldb verbatim (saltorbit/aklgg#1's round-trip
invariant), so a collision is a human's call.

## 4. Ordering, relative to saltorbit/aklgg#1

1. This lands; the job runs; `missing` settles at the orphan count and
   `seeded` at zero on quiet days.
2. Dispatch it once more, then flip akl.gg prod's `DB_BASE_URL` (Pages env
   + repo variable; the private production repo, saltorbit's action).
   From then on `/api/magic-rules` reads akldb, so the job only ever finds
   `identical`.
3. saltorbit/aklgg#1 deletes the site's D1 rules path.
4. Retire this: the job, the script, its test, LDB-C8 and LDB-P25, and
   this doc's "until the flip" framing (the route stays, 23 §10.1). The
   one-time migration script in saltorbit/aklgg and its open issue #338
   retire with it -- the reseed is its replacement.

## 5. Invariants

- **LDB-P25** (`tests/tools/reseed-magic.test.ts`): the candidate is
  akl.gg's rule set stripped and retagged to spark/1's wire shape; an
  identical record sends nothing (a re-run is zero writes); the guard in
  §3, exactly; `missing` is reported never created; collision/invalid are
  classified and fail, never amended; the signer reproduces the Worker's
  own `client-signing.json` vectors.
- **LDB-C8** (`tests/tools/ciwiring.test.ts`): the `reseed-magic` job runs
  the script live (never `--dry-run`, never a skip) on schedule/dispatch
  only, serialized, key from secrets, actor from a variable (LDB-G2).

## 6. Setup (saltorbit, once)

Repo secrets `RESEED_CLIENT_ID` / `RESEED_CLIENT_PRIVATE_KEY`: the ops
client (a plain admin-actor client, registered via `POST /v1/admin/clients`;
NOT `act-as-owner-only`, the seed writes records owned by many users) and
its base64url PKCS8 Ed25519 private key. Repo variable `RESEED_ACTOR`: the
admin Discord user id the writes act as. `DB_BASE_URL` already exists.
Then `workflow_dispatch` the workflow once and read the summary line.
