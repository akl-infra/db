# akldb on AWS: design

Status: design only, for saltorbit's review (2026-10-24). Nothing here is built or deployed. The
production cutover needs saltorbit's explicit go.

Scope: move akldb (the API at `api.akldb.org`) from Cloudflare (Worker + D1 + R2 + cron) to its own
AWS account in us-east-2. Not in scope: the akldb.org site Worker (it is a client of the API and
can move separately), Spark, akl.gg.

Fixed constraints (from the brief): the public API does not change, byte for byte where clients
depend on it; every consistency rule holds; akldb stays permissive, client-neutral and public-API
only; ≲ $1-2/month at today's volume; one-command local dev with no AWS account; the existing suite
runs against the new storage with as few changes as possible; rewrite cost is not a concern.

## 0. Decisions in one screen

1. **Storage: DynamoDB, on-demand, two tables** (`akldb-main`, `akldb-ephemeral`). No GSIs, no
   Streams. Every read whose answer a response or a write depends on is a strongly consistent
   base-table read. Aurora DSQL is the runner-up (section 1).
2. **`seq` is a counter item (`META/HEAD`) moved by the same `TransactWriteItems` that puts the
   event items**, with `seq = :expected` as its condition. The committed events are always exactly
   `1..HEAD.seq`. Feed reads bound their key range by a HEAD read, so a page can never show a gap.
3. **SQL features are replaced by six mechanical rules** (section 2.2): index items written inside
   the same transaction (instead of indexes), claim items (instead of UNIQUE), counter items
   (instead of triggers and `COUNT(*)`), set-version guards (instead of set-based `UPDATE ...
   WHERE`), conditions (instead of `changes() = 1`), and an in-memory read model (instead of
   ad-hoc `ORDER BY`/`JOIN` over the catalog).
4. **The catalog read model**: each Lambda container keeps every layout (record, formats,
   payloads, likes), about 13 MB today. It boots from an S3 snapshot and catches up from the event
   log to an **exact snapshot at the HEAD seq** in the response's ETag, via `TransactGetItems`.
   Lists, `full=1`, counts and joins run over it in memory.
5. **Compute: Lambda Event Functions (Node 24, arm64), Function URLs in `RESPONSE_STREAM` mode,
   CloudFront in front with caching disabled.** Three functions from one bundle: `api`, `feed`
   (`/v1/changes*`, small memory, so 25 s long-polls stay cheap) and `jobs` (EventBridge
   Scheduler, every 5 min). Post-response work runs after the stream ends, as in the Spark lab.
6. **Code: a storage port under the domain logic.** Today's SQL moves verbatim into `store/d1`,
   and `store/ddb` implements the same interface. The same HTTP test files run against both
   backends, and a seeded differential fuzzer compares them response for response.
7. **Cutover: freeze writes, take a full private D1 export, load it, verify row for row and
   response for response, then switch.** The switch is a Worker deploy: `api.akldb.org` becomes a
   thin proxy to CloudFront. The DNS-level CNAME follows later. Rollback is the same pipeline in
   reverse, rehearsed before cutover.
8. **Local dev: `npm run dev`** starts DynamoDB Local (Docker, or the jar if Java is present),
   creates the tables, seeds them, and serves the API on `:8787` with a filesystem blob store. No
   AWS account is needed.
9. **Cost: about $1.5-3/month at the 10-23 peak volume (88k req/day), about $1-1.5 after Spark's
   poll backoff.** Nonce writes and consistent auth reads dominate (section 7).

## 1. Storage choice

### Candidates

| | Fits the model | Gap-free `seq` | Local dev, no account | Cost at our volume | Ops |
|---|---|---|---|---|---|
| **DynamoDB** (chosen) | All rules expressible with transactions + conditions; no SQL | Counter item in the write transaction (§2.4) | DynamoDB Local (Docker/jar), same API [10] | ~$1.5-3 (§7) | none |
| Aurora DSQL | SQL kept (PostgreSQL dialect) | Sequences are **not gap-free** and with `CACHE >= 65536` not ordered; "sequence objects cannot be used if 'gapless' assignment of sequence numbers is needed" [2]. Needs the same counter row, and OCC aborts on it like DynamoDB's conflicts | **No emulator.** A local Postgres differs in isolation (locks vs OCC), limits and DDL | 100k DPU + 1 GB free/month, then $8/M DPU (Ohio) [3]. AWS's only per-transaction figure is ~700k TPC-C-like txns per 100k DPU [3]. Our ~1.5-2.6M req/month gives ~$1.5-3 before list scans. Unproven | none |
| SQLite on EFS/S3 + Lambda | SQL kept verbatim | free (AUTOINCREMENT) | trivial | ~$0 | **No.** EFS needs a VPC (Discord calls then need egress). SQLite file locking over NFS is fragile, and N concurrent Lambda containers are N writers. Reserved concurrency 1 serializes long-polls behind writes |
| Aurora Serverless v2 / RDS | SQL | free | Postgres in Docker | $12-40+/month, VPC, patching | yes |

DSQL facts that also count against it: Repeatable Read is fixed (snapshot isolation, so write skew
on read-dependent writes needs `SELECT ... FOR UPDATE`). There are no triggers. Collation is `C`
only. A transaction can modify at most 3,000 rows [1]. DSQL **is** offered to new-experience
accounts on the Free Tier list, as is DynamoDB [4]. Neither needs a VPC: both have public
endpoints with IAM auth, so the Discord bearer lane's outbound calls need no NAT.

**Why DynamoDB.** DynamoDB and DSQL both need the hot counter row and both need every read-dependent
write re-validated, so DSQL's SQL buys less than it seems. DynamoDB wins on four counts:
contributors get a real local emulator; the cost is predictable and cheaper; there is no connection
management (no IAM-token Postgres connections per container); and the Spark lab already has the
operational lessons. The price is a full query rewrite, which the brief says is acceptable. What
would flip the choice: DSQL gaining a local emulator, and our access patterns turning out to need
ad-hoc relational queries the read model cannot answer (§7.3).

**Why two tables.** `akldb-ephemeral` holds `nonces`, `auth_cache` and `ratelimit`: TTL churn that
is never dumped, never restored and not backed up. A point-in-time restore of `akldb-main` must not
roll nonces back and reopen a replay window, and must not resurrect rate-limit windows.
Idempotency receipts stay in `akldb-main`, because a receipt must restore together with the write it
describes. Everything else is one table: transactions span tables anyway, but one table keeps PITR,
export and the row codec simple.

## 2. The DynamoDB model

### 2.1 Tables

Both tables use `pk` (S) and `sk` (S), on-demand billing, the Standard table class, deletion
protection on, and no GSIs or LSIs. `akldb-main` has PITR (35 days, replacing D1's 30-day time
travel). `akldb-ephemeral` has TTL on `ttl` (epoch seconds). Numbers in sort keys are zero-padded:
`seq` to 12 digits, revs to 8. Names are folded with **ASCII-only** lowercasing (`A-Z → a-z`),
which is exactly SQLite `NOCASE`. Unicode case folding would change which names collide.

### 2.2 Six rules that replace SQL

Every SQL construct in `src/` (the 249-statement inventory, plus dynamic SQL in `records.list`,
`events.feed`, the dump pagers and restore) maps onto one of these. They are the review checklist
for every port method.

- **R1. Consistent base-table reads only.** No GSIs: a GSI is eventually consistent [9], so a
  GSI-backed page could carry an ETag at seq *h* while missing a row committed at or before *h*,
  and get cached that way. Indexes are index items instead (R2).
- **R2. Index items written in the same transaction.** Each access path that SQL served with an
  index (`link_submissions_status`, `wpm_submissions_best`, ...) becomes a partition of small
  items. They are put and deleted in the transaction that changes the row they index. A generic
  row engine (`store/ddb/rows.ts`) declares each table's index functions; on update it emits
  Delete(old keys) and Put(new keys) for the keys that changed. An index checker (test-only, and
  a nightly job) rebuilds every index from the entity items and diffs them.
- **R3. Claim items for every UNIQUE constraint.** Each one is a `Put` with
  `attribute_not_exists(pk)` (or a CAS on the holder) inside the writing transaction: live layout
  names, nonces, idempotency keys, Discord interaction ids across the four interaction tables (the
  `UNION ALL` dedupe at `discord-interactions.ts:153`), outbox `event_seq`/`nonce`, and
  `(kind, submission_id, review_version, action)` in the review history.
- **R4. Counter items for triggers and hot `COUNT`/`MAX`.** `layouts_head.live`, the
  `authors_head` version/modified/count, the admin count (for `DELETE ... AND (SELECT COUNT(*) FROM
  admins) > 2`), `MAX(at) FROM events`, approved comment counts per layout and `like_count` are
  updated in the same transaction as the change they count. A count of a bounded small partition
  (e.g. likes by user) is a consistent `Query` with `Select: COUNT`.
- **R5. Set-version guards for set-based writes.** SQL such as `UPDATE link_submissions SET
  status='superseded' WHERE layout_id=? AND status='pending'` touches rows the writer never named.
  The port reads the set through its index partition, then writes each member conditioned on its
  current state. It also conditions on a guard item (e.g. `L#<id>/SET#link {ver}`) that every
  insert into that set bumps. A concurrent insert therefore fails the transaction, and the
  operation retries. This reproduces SQLite's single-writer outcome for every set-based statement.
- **R6. `changes() = 1` gates become conditions in one transaction.** D1 batches use a first CAS
  (`UPDATE ... WHERE status='pending' AND review_version=?`) and gate later statements on
  `changes() = 1`. They become one `TransactWriteItems` whose first item carries the CAS as its
  `ConditionExpression`. All-or-nothing gives the same outcome: on `ConditionalCheckFailed` at that
  index, the port returns "not pending" exactly as `meta.changes === 0` does today.
  `INSERT ... ON CONFLICT DO NOTHING` becomes a conditional `Put`, with `ConditionalCheckFailed`
  meaning zero changes. `RETURNING` becomes values computed client-side from the read the
  transaction is conditioned on, or `ReturnValues` on a single `UpdateItem`.

The general invariant: **every value a write's decision depends on is either written by that
transaction or checked by one of its conditions**. This is the OCC form of D1's serialized batches.
The lab's I-LAB-LANE-CONFLICT lesson applies: `TransactionConflict` and `ThrottlingError` are retried
at the operation with jittered backoff; `ConditionalCheckFailed` is never retried blindly.

### 2.3 Items

`akldb-main`:

| D1 table / concept | pk / sk | Notes |
|---|---|---|
| event head + `layouts_head` | `META` / `HEAD` | `seq`, `max_at` (= `MAX(at)`, kept as max, not "at of last"), `live`. **Touched only by event-appending transactions**, read with `GetItem`, which never conflicts with a transaction [9] |
| `authors_head` | `META` / `AUTHORS` | `version`, `modified_at`, `count` (R4, the three triggers) |
| admin count | `META` / `ADMINS` | `count` |
| `modqueue_delivery_gate` | `META` / `MQGATE` | lease/retry columns, same CAS updates |
| `import_state` | `STATE` / `<key>` | frozen cmini keys + `dump.last_at` |
| `layouts` + `layout_formats` | `CAT` / `<layout_id>` | **One item per layout**: every `layouts` column plus `fmt: {<lineage>: {format, rev, created_at, modified_at, payload_json, has_magic, has_alts, has_combos, source_client, source_version}}`. One `GetItem` is one snapshot of a layout and all its formats (LDB-B65 holds by construction). Largest payload today is 6.7 KB, median 1.7 KB; items stay far below 400 KB. A payload that would push an item past 350 KB spills to S3 `payloads/<sha256>` (written before the transaction, content-addressed) and the item keeps the pointer. That covers D1's 2 MB row ceiling with no new refusal |
| live-name claim | `NAME#<fold(name)>` / `LIVE` | `{id}`. Replaces the partial unique index `layouts_name_live` (R3) |
| `layout_revs` | `L#<id>` / `V#<lineage or '-'>#<rev>` | `n`, `event_seq`, `format`, `payload_json`. The sk is `UNIQUE (layout_id, lineage, rev)`; `n` uniqueness comes from the `CAT.n` condition |
| `likes` | `L#<id>` / `LK#<user>` + `U#<user>` / `LK#<id>` | both in one transaction; the second serves `liked_by`, `COUNT(*) WHERE user_id` and `likes_user` |
| `events` | `EV` / `<seq>` | the full row. One logical partition: without LSIs it may exceed 10 GB and DynamoDB splits it by sort key |
| event mirrors | `EVL#<layout_id>`, `EVK#<kind>`, `EVA#<actor>` / `<seq>` | full copies, same transaction. Serve `/history`, `latestRevBumpingEvent`, the link-event lookups in `revert.ts`, and the `kinds=`/`layout=`/`actor=` feed filters without scanning. Events are immutable (redaction happens on read), so copies cannot diverge |
| `authors` | `AUTHORS` / `<user_id>` | ~400 items; read whole for `/v1/authors` |
| `admins`, `bans`, `clients`, `import_map` | `ADMINS` / `BANS` / `CLIENTS` / `IMPORTMAP` + `/<id>` | small partitions |
| `idempotency` | `IDEM#<scope>` / `<key>` | the same reserve/takeover/complete/delete CASes; `ttl` = at + 25 h (the code still checks `isExpired`) |
| `link_submissions` | `SUB#link#<id>` / `ROW` + `IX#link#st#<status>` / `<submitted_at>#<id>`, `IX#link#lay#<layout>` / `<status>#<submitted_at>#<id>`, guard `L#<layout>` / `SET#link` | R2, R5 |
| `wpm_submissions` | `SUB#wpm#<id>` / `ROW` + `IX#wpm#st#<status>`, `IX#wpm#pair#<layout>#<user>` / `<status>#<id>`, `IX#wpm#user#<user>`, `IX#wpm#ok` / `<layout>#<user>#<id>` (approved, with `wpm`/`decided_at` projected) | `/v1/wpm`'s "best per pair" is computed in memory from `IX#wpm#ok` (or its layout/user slice), the same rows SQL reads |
| `layout_comments` | `SUB#comment#<id>` / `ROW` + `IX#cmt#st#<status>`, `IX#cmt#pair#<layout>#<user>` / `<submitted_at>#<id>`, `IX#cmt#ok#<layout>` / `<decided_at>#<id>` (approved with body), `IX#cmt#user#<user>`; counter `CC` / `<layout>` | `live_body`, `has_live`, supersede/replace sets via the pair index + guard |
| `comment_likes` | `CL#<layout>#<author>` / `<user>` + `U#<user>` / `CL#<layout>#<author>` + `CLA#<author>` / `<layout>#<user>` | per-author counts |
| `moderation_review_history` | `SUB#<kind>#<id>` / `H#<n>` + claim `SUB#<kind>#<id>` / `HK#<rv>#<action>` | per-submission ordinal replaces the global AUTOINCREMENT, which is only ever used to order within one submission. The original `id` is kept as an attribute for export round-trips |
| `modqueue_notifications` | `MQN#<kind>#<sid>` / `ROW` + dirty index `IX#mqn#dirty` / `<kind>#<sid>` | every submission state change marks its notification dirty in the same transaction; the reconciler reads only the dirty set, not a join over every submission ever |
| `discord_pending_actions`, `discord_reopen_actions` | `DPA#<table>` / `<interaction_id>` + claim `DINT#<interaction_id>` | small, pruned partitions: read whole and filter in memory (`ORDER BY created_at LIMIT 1`) |
| `discord_deny_modals`, `discord_reopen_confirmations` | `DMOD` / `<modal_id>`, `DCONF` / `<id>` + claims on `initial_interaction_id` | |
| `discord_rejection_dm_outbox` | `DMO#<delivery_key>` / `ROW` + claims `DMO#seq#<event_seq>`, `DMO#nonce#<nonce>` + due index `IX#dmo#due` / `<status>#<next_attempt_at>#<key>` (pending/leased only) | |

`akldb-ephemeral`: nonces `N#<client_id>` / `<nonce>` (conditional Put, `ttl` = at + 900 s);
`auth_cache` `AC#<token_hash>` / `AC` (`ttl` from `expires_at`); rate limits `RL#<key>` /
`<window_start>` (`UpdateItem ADD n :1`, `ReturnValues UPDATED_NEW`, `ttl`). Keying the window into
the sk removes the `CASE WHEN window_start = ...` reset. A client reactivation deletes the current
and previous window items (`DELETE FROM ratelimit WHERE key=?`).

TTL deletion is lazy: it can lag by days. Every reader of a TTL'd item checks expiry itself, as the
code already does for `auth_cache` and idempotency; TTL only collects garbage. DynamoDB Local does
not enforce TTL either, so tests see the same behaviour.

### 2.4 `seq`: the event-append protocol

Every event-appending write (`commitWrite`, `appendInfo`, `appendAdmin`, `appendModeration`,
`appendLinkChange`, `appendLike`, `appendInheritedLikes`, every moderation decision and comment
event) goes through one helper, `EventTx`:

1. `GetItem META/HEAD` (consistent) gives `s`.
2. Build the domain items. Events get `s+1..s+k`, `layout_revs.event_seq` and outbox `event_seq`
   are filled in from those numbers (replacing `last_insert_rowid()`), and the mirrors and counters
   are added.
3. `TransactWriteItems`, with `META/HEAD` as item 0: `SET seq = :s+k, max_at = :max(max_at, at),
   live = live + :dlive`, condition `seq = :s`. Plus `Put EV/<n>` (`attribute_not_exists`) and
   the mirrors.
4. The cancellation reason decides what happens next:
   - Item 0 alone fails (`ConditionalCheckFailed` or `TransactionConflict`): another append won.
     Re-read HEAD, renumber and resend. Nothing else is rebuilt, since no domain decision depends on
     `seq`. Retries use full-jitter backoff (15, 40, 90, 180, 350, 700 ms × 0.5-1.5, as in the lab),
     up to 8 attempts, then 503.
   - The `CAT/<id>` `n` condition fails: throw `RevConflictError`. `commitWithRetry` rebuilds from
     a fresh read, exactly as today (MF-6), and a moved own scope becomes `409 stale`.
   - The name claim fails: `nameTaken`, then a read of the holder (`commitAndMapErrors`, unchanged).
   - A like/unlike claim or `deleted = false` fails: `already_liked` / `not_liked` / `not_found`,
     told apart from the cancellation reasons rather than a fresh read.

**Gap-free and ordered.** Every commit moves HEAD from exactly `s` to `s+k` and atomically puts
events `s+1..s+k`. So the committed event set is always `{1..HEAD.seq}`, and seq order is commit
order. A rolled-back loser leaves nothing (D1's "the whole batch rolls back, `seq` stays gapless").

**No gaps on read.** A multi-item `Query` is only read-committed [9]: a page read while two
appends land could contain `s+2` without `s+1`. Every feed read therefore first reads HEAD = *h*
(consistent) and then queries `sk BETWEEN since+1 AND min(h, ...)` with `ConsistentRead`. Every
event ≤ *h* committed before the query began, so the page is a gap-free prefix. The same bound
applies to the mirror partitions. The unfiltered feed also asserts contiguity and refuses with a 500
rather than ever serving a gap.

**Contention, quantified.** Let *w* be the window from the HEAD read to the commit, about 25 ms
in-region (one `GetItem` plus one transaction, ~4 + 15-20 ms). Writes arrive at rate λ. The chance
that a given append overlaps another one is about 2λ*w*:

| λ (event-appending writes/s) | per day | P(first attempt retries) | note |
|---|---|---|---|
| 0.01 | 864 | 0.05% | about today's order of magnitude (the 10-24 measurements count ~9 non-Discord writes/day plus bot writes; `seq` grew ~47k in its first month including the full cmini import) |
| 0.1 | 8,640 | 0.5% | |
| 1 | 86,400 | 5% | |
| 5 | | ~25%, 1.3 attempts on average | |
| ~40 | | saturation (≈ 1/*w*) | the throughput ceiling of one counter item |

A single client issuing writes in sequence never conflicts with itself. The hazards the lab hit
(frequent non-transactional writes to an item that transactions also touch) are excluded by
construction: nothing but `EventTx` ever writes `META/HEAD`, and every HEAD reader uses `GetItem`.
Nonces, `last_seen_at` and rate limits never touch it. `TransactWriteItems` is limited to 100 items
and 4 MB [9]. The largest appends are a create (HEAD, 2 events, 6 mirrors, 2 revs, CAT, NAME: 13
items) and inherited likes. The latter are chunked at 15 likers per transaction (92 items: HEAD, CAT, and per
liker an event, 3 mirrors and 2 like items). Today's code already commits them in a batch separate
from the create, and each `liked` event stands alone.

### 2.5 If-Match, receipts, idempotency

- **If-Match / If-None-Match.** The domain checks are unchanged: `requireScopedIfMatch`,
  `requireLayoutRev`/`requireFormatRev` against a consistent `GetItem CAT/<id>`, and the
  `format_exists`/`format_absent`/`format_behind` checks. The transaction conditions on `CAT.n =
  :n`. That is D1's `layout_revs (layout_id, n)` PK guard: one counter for both scopes, so a
  different-scope race retries and a same-scope race becomes `409 stale` with the same body
  (`staleFromExhaustedRetry` included).
- **Idempotency-Key** (`core/idempotency.ts`): reserve is `Put` with `attribute_not_exists`;
  takeover is `Update` with `at = :expectedAt`; complete and delete map 1:1. The stored body is the
  exact bytes and is replayed byte for byte. Bodies over 350 KB (none today; a write response
  carries one payload) are stored gzip-compressed in a binary attribute.
- **Operation receipts.** `GET /v1/wpm/submissions/:id` is a consistent `GetItem`. The Discord
  receipt binding (`source_message_url IS NULL` CAS) becomes `attribute_not_exists(source_message_url)`.
- **Unknown outcomes.** The JS SDK's automatic `ClientRequestToken` makes its own retries of a
  `TransactWriteItems` idempotent for 10 minutes [9]. An outcome that stays unknown surfaces as a
  500, and the client resolves it by receipt, exactly as today.

### 2.6 Meta head and ETags

`readHead` becomes one consistent `BatchGetItem` of `META/HEAD`, `META/AUTHORS` and the
`STATE/<key>` items. `etagFor` is unchanged, so `/v1/meta` ETags have the same inputs:
`seq` + `authors_head` + the frozen `import_state` values + the format registry + `WIRE_VERSION`.
A 304 costs that one call (3-6 RRU).

The body fields map as follows:
- `layout_count` = `HEAD.live`
- `author_count` = `AUTHORS.count`
- `revision` = `HEAD.max_at`
- `layouts_modified_at` = max `modified_at` over live layouts, read from the read model at *h*
- `deletes_24h` = a consistent `Query` of `EVK#upstream_deleted` filtered by `at` (frozen; empty)

D1 bundled HEAD, `authors_head` and `import_state` into one SELECT. `BatchGetItem` gives each item
consistently but not as a single snapshot [9]. That is safe: each input is monotonic, and the D1
route already reads the body in later statements than the ETag.

### 2.7 The catalog read model

Every list-shaped read over layouts runs over a per-container in-memory model:
- `GET /v1/layouts` with every filter (`owner`, `has_magic`, `has_alts`, `has_combos`, `since`,
  `liked_by`), sort (`name`, `modified_at` = `MAX(l.modified_at, f.modified_at)` of the source
  lineage, `created_at`, `like_count`) and keyset cursor
- `full=1`
- `mana2/1` translation and `held` detection
- per-owner counts (`/v1/authors/:id`) and the tombstone-by-name lookup (`tombstoneLikers`)
- `MAX(modified_at)`
- the layout side of every moderation/WPM/comment join (name, owner, `deleted`)

The model is `Map<id, {CAT item, likes[]}>` plus authors: about 4.5k layouts and ~13 MB today.

**Freshness protocol** (every ETag'd read):
1. Read HEAD → *h*. Compute the ETag. On an `If-None-Match` match, return 304. Done.
2. If the model's cursor *c* < *h*: query `EV` in `(c, h]` (consistent, key-bounded) and collect
   the touched `layout_id`s.
3. `TransactGetItems` of `META/HEAD` plus every touched `CAT/<id>` (chunks of 99, each with HEAD).
   Reload likes for layouts with `liked`/`unliked` events. If any HEAD in the batch reads *h'* > *h*,
   set *h* = *h'*, fetch the new events and repeat.
4. It converges when every chunk sees the same HEAD *h*. Then every touched item is read at *h*;
   by invariant LDB-AWS-RM1 every untouched layout is unchanged in `(c, h]`; and the model is an
   **exact snapshot at *h***, the same guarantee as D1's single `SELECT`. The response uses the
   ETag for *h*. If convergence fails after 5 rounds, which needs sustained multi-writes per
   10 ms, the request returns 503 rather than serve a non-snapshot.

**LDB-AWS-RM1** (new invariant): every change to a `CAT` item or a like item happens in an
`EventTx` that appends an event naming that `layout_id`. The port enforces it structurally (only
`EventTx` can write those keys, checked by a boundary test like LDB-P1's onlywriter), and a
property test checks it: after random operation sequences, model == a fresh full scan.

**Boot.** A cold container reads `s3://akldb-data/replica/snapshot.json.gz` (written by `jobs`
every 5 minutes when HEAD moved, via conditional `PutObject` `If-Match` on the previous object, so a
stale writer can never regress it; the I-LAB-REPLICA-SNAPSHOT pattern). It then catches up. A
missing or unreadable snapshot falls back to a consistent `Scan` (~15k RRU, seconds). The rehost
tool writes the first snapshot, so the fallback is a safety net only. A nightly job rebuilds the
model from a full scan and compares it to the snapshot; any difference alarms (perf never changes
correctness).

**Ordering details that must match SQLite.**
- `NOCASE` compares ASCII-folded strings in UTF-8 byte order. JS `<` compares UTF-16 code units and
  differs above U+FFFF, so the comparator uses `Buffer.compare` on folded UTF-8.
- Cursor comparisons use SQLite's cross-type order (`NULL < numbers < text`) for hand-made
  cursors.
- `MAX(a, b)` over ISO strings is a `BINARY` string compare.

The differential fuzzer (§4.3) generates adversarial names (mixed case, non-ASCII, astral-plane)
and cursors.

### 2.8 The rest of the access paths

| Query family (source) | DynamoDB access |
|---|---|
| `byRef` / `byRefWithFormats` (`records.ts:312-448`) | ULID-shaped: `GetItem CAT/<id>`. Name: `TransactGetItems [NAME#fold/LIVE, then CAT/<id>]` (two round trips); the second read re-checks `fold(name)` and `deleted=0` and retries on a mismatch |
| layout detail likes, `/likes` (`layouts.ts:65,173`) | `Query L#<id> begins_with LK#` (consistent) |
| `/history`, `latestRevBumpingEvent`, revert link lookups (`layouts.ts:187`, `write.ts:93`, `revert.ts:276-280`) | `Query EVL#<id>` (desc, filter `rev`/`format`/`kind`) |
| `/rev/:n` (`layouts.ts:253-262`) | `GetItem L#<id>/V#<lineage>#<n>`, then `GetItem EV/<event_seq>` |
| `/v1/changes`, `/admin/changelog` (`events.ts:1145`) | §2.4; filters pick the most selective mirror (`layout` > `actor` > single `kind`), with the rest applied as a `FilterExpression` while paging inside the `(since, h]` key bound until `limit` matches |
| revert scan by `source_client` and time (`revert.ts:87`) | `Query EV` descending from HEAD until `at` < window start (≤ 1 h, `DESTRUCTIVE_WINDOW_SECONDS`), filter in memory |
| authors list/detail/counts (`authors.ts:44-76`) | `Query AUTHORS` (sorted in memory: by `user_id`, or by `name` in BINARY order); per-owner count from the read model; likes by user via `Query U#<user>` `Select COUNT` |
| author upsert (`discord.ts:198`, `client.ts:234`) | read, then `TransactWriteItems [author Put/Update (CAS), META/AUTHORS]` on insert or rename; a plain conditional `Update` for hourly `last_seen_at` (no head bump, so no 304 is broken: LDB-R9..R11) |
| roles (`roles.ts:27`) | `BatchGetItem ADMINS/<u>, BANS/<u>` |
| clients, nonces, auth cache (`client.ts`, `discord.ts`) | `GetItem CLIENTS/<id>`; ephemeral conditional `Put`; `GetItem AC#...` |
| admins add/remove (`admins.ts:51-74`) | transaction with `META/ADMINS` (`count > :2` condition on remove) + the `admin.*` event |
| link/WPM/comment submit, decide, reopen, supersede (`links.ts`, `wpm.ts`, `comments.ts`, `moderation-review.ts`, `events.ts:700-765`) | `EventTx` with the submission row CAS (R6), index items (R2), set guard (R5), review-history claim (R3), outbox rows and claims, MQN dirty mark |
| mod queues (`links.ts:172`, `wpm.ts:263`, `comments.ts:217`) | `Query IX#<kind>#st#<status>` + read-model join for layout names + `AUTHORS` names |
| `/v1/wpm` (`wpm.ts:339`) | `Query IX#wpm#ok` (or a layout/user slice), best-per-pair in memory, live-layout join from the read model |
| `/v1/comment-counts`, comments list, own/my comments (`comments.ts:350-506`) | `Query CC` / `IX#cmt#ok#<layout>` / `IX#cmt#pair#...` / `IX#cmt#user#...`; likes via `CL#...`/`CLA#...` |
| notifier, Discord drains, DM outbox (`modqueue.ts`, `discord-interactions.ts`, `rejection-dm.ts`) | dirty/due index partitions + the same lease CASes as conditional `UpdateItem`s |
| destructive budget (`destructive-budget.ts:78`) | `RL#client:<id>#destructive / <window>` `ADD` **inside** the write transaction (a losing attempt counts nothing, as today), then a `GetItem` after commit. `live_layouts` comes from the HEAD the transaction was conditioned on |
| prunes (`client.ts:267`, `discord.ts:67`, `idempotency.ts:205`, `ratelimit.ts:62`) | TTL; Discord-table prunes stay jobs over their small partitions |
| dump paging (`dump/write.ts:211-245`) | read HEAD first (MF-13 floor), then consistent `Scan` per entity prefix, re-encoded to the exact D1 row shape by the row codec (§4.1) so dump bytes are identical |

## 3. Compute and edge

**Functions.** All three are `nodejs24.x` [11] on arm64, built from one esbuild bundle with
different handlers. The Hono app is unchanged and runs through `hono/aws-lambda`'s `streamHandle`.
Function URLs use `InvokeMode: RESPONSE_STREAM`, which allows up to 200 MB per response; the first
6 MB is uncapped and the rest streams at 2 MB/s [12].

| Function | Serves | Memory / timeout (initial; tune by measurement) |
|---|---|---|
| `api` | everything except `/v1/changes*` | 1024 MB / 60 s |
| `feed` | `/v1/changes*` (long-poll holds are mostly sleep) | 256 MB / 35 s |
| `jobs` | EventBridge Scheduler `rate(5 minutes)` (`scheduledTime` passed in the input, same dispatch as `scheduled()`), the replica snapshot, nightly dump/prunes, migrations, index checker | 1024 MB / 900 s |

- **Long-poll.** The `waitForChanges` loop is unchanged: at most `wait+1` HEAD reads, which here
  are eventually consistent `GetItem`s. The final page read is consistent and bounded by HEAD. A
  25 s hold at 256 MB costs 6.25 GB-s ≈ $0.00008. That is negligible, but **one client holding
  continuously is ~650k GB-s/month ≈ $5-9/month** at list price [11]. That is why the feed has its
  own small function, and why §8 asks whether the server may decline holds. Today the only
  long-poller is the Fly gateway bot, which goes away with Spark's move.
- **Post-response work** (`executionCtx.waitUntil`, 12 sites: the Discord interaction drain,
  modqueue notify/update, rejection DMs): `platform.background(task)` queues the task. The
  streaming handler finishes the HTTP response, then awaits the queue before returning. This is
  the Spark lab's measured "ACK, then drain in the same invocation". Cron stays the recovery path,
  as it is today.
- **CloudFront.** The distribution has alternate domain `api.akldb.org` and an ACM certificate,
  which must be in us-east-1 (see §8). The origin is the two Function URLs, split by path behavior.
  - The cache policy is **CachingDisabled**, with an origin request policy forwarding all viewer
    headers except Host, so `Authorization`, the client-signature headers and `If-None-Match`
    reach the app untouched.
  - Not caching at the edge is deliberate. CloudFront ignores a viewer's `Cache-Control: no-cache`
    [7], so honouring `max-age=10` at the edge would let any client (Spark's freshness check
    included) read up to 10 s behind a write it just made. Today every request reaches the Worker.
  - The app answers 304s itself, as `conditional()` does now.
  - **No OAC.** Lambda-URL OAC requires viewers to send `x-amz-content-sha256` on PUT/POST and
    replaces the viewer's `Authorization` header [6]; either one breaks the public API. The URLs
    are `AuthType NONE`, CloudFront adds an `X-Origin-Verify` secret header (from SSM), and the
    app returns 403 without it.
- **Response cache.** `caches.default` was a validated cache: a hit counted only if its ETag
  equalled the current one. It becomes a per-container LRU keyed by method + URL +
  `Accept-Encoding`, storing `{etag, encoded body}`, with the same equality check. Compression
  moves into the app (gzip/br by `Accept-Encoding`), because CloudFront compresses only cached
  objects. Cloudflare weakens ETags (`W/"..."`) when it compresses; the app does the same, so
  clients see the same headers. `stripWeak` already accepts both. A header-level diff against
  production is a cutover gate (§5).
- **Dumps.** S3 bucket `akldb-data`, with the R2 keys unchanged (`dump-YYYY-MM-DD.json.gz`,
  `latest.json`, `monthly/...`). The `/v1/dump*` routes stream S3 objects through `api`. A
  single-part S3 ETag is the quoted MD5, the same shape as R2's `httpEtag`. Objects are never
  expired (R2 had no lifecycle either).
- **Secrets and config.** SSM Parameter Store SecureString (standard tier, free), read at init:
  the Discord bot token, application id and public key, the modqueue webhook, and the
  origin-verify secret. The `[vars]` become Lambda environment variables.
- **Logs and metrics.** One structured access-log line per request (method, route, status, ms,
  actor lane, client id, seq; the Logpush equivalent saltorbit asked to keep forever) goes to a
  CloudWatch Logs log group in the **Infrequent Access** class, with retention set to never
  expire. Lambda advanced logging uses JSON format and system level WARN, which drops the
  per-invocation START/END/REPORT lines; Lambda's built-in metrics still cover duration and
  errors. Alarms (within the free 10): `api`/`jobs` errors and throttles, DynamoDB system errors
  and throttles, an EMF metric for `EventTx` retries exhausted, a stale replica snapshot, and
  dump age > 48 h (mirrors `health.dump.stale`). AWS Budgets has an alert at $3 and one at $10.
- **No VPC.** Lambda reaches Discord, DynamoDB, S3 and SSM over public endpoints.
- **IaC.** One CloudFormation template (`infra/akldb.yaml`), tested with cfn-lint/cfn-guard like the
  lab's, plus a tiny us-east-1 stack for the ACM certificate. GitHub Actions deploys through an
  OIDC-assumed role, so there are no long-lived keys.

## 4. Code structure

### 4.1 The port

```
src/
  app.ts               Hono app; reads `c.var.platform`; no binding types
  core/**, routes/**   domain logic, unchanged in behaviour; take `Store`, never D1 or the AWS SDK
  store/port.ts        Store, BlobStore, Platform interfaces
  store/d1/**          today's SQL, moved as is (transition + differential oracle)
  store/ddb/**         keys.ts, rows.ts (row engine + index decls), eventtx.ts, replica.ts,
                       codec.ts (D1 rows <-> items, both directions)
  platform/workers.ts  CF entry: fetch, scheduled, caches.default, waitUntil
  platform/lambda.ts   streamHandle, scheduler events, background queue, LRU
  platform/node.ts     local dev server
```

`Store` is **operation-level, not key-value**. Each D1 batch or atomic unit becomes one method, so
each backend owns its atomicity:
- `commitWrite(input) → CommitResult` (throws `RevConflictError` / `nameTaken`)
- `appendLike`, `appendInheritedLikes`, `appendLinkChange`, `appendInfo`, `appendAdmin`
- `decideSubmission(kind, id, cas, effects)`, `reopenReview`
- `reserveIdempotency`, `takeoverIdempotency`, `completeIdempotency`, `deleteIdempotency`
- `insertNonce`, `takeRate`, `upsertAuthor`
- lease CASes for the outbox, Discord actions and modqueue
- reads: `head()`, `layoutByRef()`, `feed(range, filter)`, `catalog(h)` (the read model, or SQL on D1)

That is about 70 methods. Every one has a JSDoc stating its isolation contract, and the D1 and
DynamoDB implementations sit side by side.

The ~250 `db.prepare` sites in `src/core` move behind it. LDB-W1 widens: no file under `src/core`
or `src/routes` may import D1 types or `@aws-sdk/*` (a boundary test). `ulid()` and `now()` come
from `Platform`, so tests and the fuzzer can seed them.

`codec.ts` turns a SQLite database (a D1 export) into items and back, row for row, in the exact D1
row shapes (`0/1`, `payload_json` strings). It is the basis of migration, verification, rollback,
the dump writer and the test inspectors. Its property test: rows → items → rows is byte-identical
for every table.

### 4.2 Phases

- **P0.** Port refactor on D1 only: no behaviour change, deployed on Cloudflare, and the full suite
  green proves it.
- **P1.** `store/ddb`; both backends run the same suite in CI.
- **P2.** AWS prototype stack, a restore of a production export, and the diff gates (§5).
- **P3.** Cutover.
- **P4.** Delete `store/d1` and `platform/workers` after the rollback window (proposed: 90 days).

### 4.3 Differential testing

1. **Same tests, two backends.** The workers-project files (tests/api, tests/auth, tests/events,
   tests/rehost: ~720 `it/test` sites) import `env`, `SELF`, `createScheduledController` from
   `tests/harness`. A vitest alias resolves it to `harness.d1.ts` (workerd, as today) or
   `harness.ddb.ts` (Node, `app.fetch` against DynamoDB Local, one table pair per test file for
   isolation). The ~520 direct SQL calls in 61 test files become calls on a test-only `TestStore`
   (`seed.layout(...)`, `inspect.row("layouts", id)`, ...) that returns **D1-shaped rows from both
   backends**, so assertions keep their expected values. The node project (formats, tools,
   contract: most of the ~19.5k cases) is storage-free and does not change.
2. **Seeded organic fuzzer.** Random interleaved sequences cover every write and read route across
   several actors (owner, admin, Discord lane, client lane), with odd names, cursors, filters,
   moderation flows and restarts (a cold model mid-sequence). It runs with a fixed clock and a
   seeded ULID against D1 (workerd) and DynamoDB, and diffs every response (status, headers that
   matter, body bytes) plus the final full export row for row. Correctness is judged by equality
   with the oracle, not by "it replied".
3. **Conflict injection.** DynamoDB Local never throws `TransactionConflictException` [10]. A
   client wrapper injects it, along with throttling, into ~20% of calls, and the suite and fuzzer
   must stay green (the lab's I-LAB-HARNESS-CONFLICT). Real-parallel race tests (mf1/mf6/mf-l2
   style) run against DynamoDB Local with `Promise.all`.
4. **Read-model proof.** After every fuzzer step, `catalog(h)` equals a model rebuilt by a full
   scan (LDB-AWS-RM1).

## 5. Migration and cutover

The **public dump is not a migration vehicle.** It is redacted on purpose: non-approved
submissions, review history, outbox, Discord actions, idempotency receipts, nonces and private
event detail are left out (LDB-MD8). The migration source is a **full private D1 export**
(`wrangler d1 export akl-db --remote`, a read with the OAuth token). Restoring the public dump
stays a separate feature: `rehost --target aws` (with today's seq check and `--wipe` guards) is
how a third party rehosts akldb.

**Rehearsals (P2), repeatable at will:**
1. Export prod D1 → local SQLite. Convert with `codec` into a fresh `akldb-main` (BatchWrite, ~70k
   items, ~2 min on on-demand) plus the replica snapshot. Indexes, mirrors and counters are
   *generated*, never copied.
2. **Row for row:** convert back with `codec`; sha256 of `canonical(rows)` per table equals the
   export's. Also check `HEAD.seq == MAX(seq)`, events contiguous `1..seq`, every counter equal to
   its recount, and the index checker clean.
3. **Response for response:** start the D1 Worker locally on the *same* export, at the same seq
   and with a fixed clock, and the AWS stack on the restored table. A crawler then diffs bytes and
   headers over:
   - every layout detail in every format, `/history`, `/likes`, and sampled `/rev/:n`
   - every list sort × filter with its full cursor chain
   - `full=1`, `/v1/changes` from 0 to head in steps of 100 and with each filter
   - meta, authors, wpm, comments, comment-counts, formats
   - **a replay of a day of real GET URLs** taken from the permanent Logpush logs (R2 `akl-db-logs`)
4. **Rollback drill:** DynamoDB → `codec` → SQL → a scratch D1 → the same diffs.

**Prerequisite.** Every client names `api.akldb.org`, not `akl-db.akl-58a.workers.dev` (Spark's
`DB_BASE_URL`, the site Worker's `DB_BASE_URL`, akl.gg's pointer config). Alternatively the
`workers.dev` host is served by the proxy Worker below.

**Cutover runbook** (writes paused ~15 minutes; reads never stop):
1. Deploy the Worker with `READ_ONLY=1`. Writes return `503` + `Retry-After` (an additive error
   code, see §8). Disable the CF cron. Wait 6 minutes: this exceeds the client lane's ±300 s
   signature skew, so no write signed before the freeze can be replayed on the new side.
2. Final checkpoint as in CI today (D1 time-travel bookmark, fresh dump, db-backup snapshot).
   Then the full export, convert, load and the row-for-row check. Nonces, idempotency receipts and
   rate-limit windows are copied as well.
3. The crawler diff between the frozen Worker and the AWS stack: identical seq, so bytes must match.
4. **Switch:** deploy a ~30-line proxy Worker on `api.akldb.org` and `workers.dev` that forwards to
   the CloudFront domain, preserving method, headers and body. The switch is one deploy and
   reversible in seconds; there is no DNS propagation. Enable EventBridge Scheduler and repoint
   the Discord interactions URL (unchanged, it rides the hostname).
5. Watch: alarms, the access log, Spark's freshness checks and akl.gg.
6. Days later: replace the Workers custom domain with a DNS-only CNAME `api.akldb.org →
   dxxxx.cloudfront.net` (a Cloudflare dashboard step, plus the ACM validation CNAME, done earlier).
   Retire the proxy once the `workers.dev` traffic is zero.

**Rollback (within the window):** freeze AWS writes (same flag), export DynamoDB → SQL, restore into
D1 (`rehost` with `--wipe=akl-db`, and the seq guard compares against AWS's `/v1/meta`), point the
proxy Worker back at the D1 Worker code, unfreeze. Writes made on AWS are carried back; nothing is
lost.

**Rejected:** dual-write (two seq authorities cannot keep one gap-free identical log), and a
live-follower AWS copy tailing `/v1/changes`. The feed carries neither payloads nor the non-event
tables, so the follower would be a second replication protocol to prove.

## 6. Local dev and CI

- **`npm run dev`** (`scripts/dev.mjs`):
  - Starts DynamoDB Local, pinned: `docker run amazon/dynamodb-local:<ver> -inMemory`, or, without
    Docker but with Java 17+, the sha256-pinned jar under `.dev/`. `--persist` keeps a `.dev/ddb`
    file.
  - Creates both tables and seeds them: empty, `--seed fixture` (tests/fixtures), or
    `--seed latest` (downloads the public dump and restores it through `rehost`).
  - Serves the API on `http://localhost:8787` (`@hono/node-server`, `platform/node`: blobs in
    `.dev/blobs`, an in-process 5-minute tick, background tasks inline). Fake credentials; no AWS
    account.
  - The README's three commands become `npm ci && npm run dev`. While `store/d1` exists,
    `npm run dev:d1` keeps `wrangler dev`.
- **`npm test`**: the node project, plus the dual-backend workers suites. vitest `globalSetup`
  starts DynamoDB Local the same way. In CI the GitHub Actions `services:` container is the
  emulator.
- **CI deploy job:**
  1. test
  2. checkpoint: an on-demand DynamoDB backup, the PITR restorable time logged (replacing the D1
     bookmark), a fresh dump through `POST /v1/admin/dump`, and the db-backup snapshot confirmed
     (unchanged)
  3. data migrations
  4. `cloudformation deploy`

  **Migrations** become numbered, idempotent TypeScript data migrations
  (`migrations-ddb/NNNN_*.ts`, recorded in `STATE/migrations`). DynamoDB has no DDL, so a "column"
  is a backfill and a new index is a generated index-item backfill; the additive-only rule
  (migrations-additive test) carries over. db-backup keeps reading `/v1/dump/latest.json` with no
  change.

## 7. Cost, risks, what would change the design

### 7.1 Cost (us-east-2, list prices)

| Item | Assumption | Price | $/month |
|---|---|---|---|
| DynamoDB reads | 1.5-2.6M req/month × ~4 consistent RRU (HEAD/meta batch, client, author, roles, receipt) ≈ 6-10M RRU | $0.125/M RRU [5] | 0.75-1.30 |
| DynamoDB writes | nonces ≈ 1 WRU per signed request (~0.9-1.6M) + event transactions (2× WRU per item [9]) + rate/author ≈ 1-1.8M WRU | $0.625/M WRU [5] | 0.65-1.10 |
| DynamoDB storage + PITR | ~0.3 GB with mirrors and indexes | 25 GB free / $0.25 GB-month; PITR $0.20/GB-month [5] | ≤ 0.15 |
| Lambda | 1.5-2.6M req; ~75-130k GB-s | 1M req + 400k GB-s free/month, then $0.20/M [11] | 0.10-0.32 |
| Lambda streaming bytes | `full=1`/dumps past 6 MB | 100 GB/month free, then $0.008/GB [11] | 0 |
| CloudFront | ≤ 2.6M req, ≪ 1 TB | always-free 10M req + 1 TB (see `egress.md`) | 0 |
| EventBridge Scheduler | 8,640 invocations | 14M free [8] | 0 |
| S3 | ~1 GB of dumps/year + snapshot puts | $0.023/GB-month | 0.03-0.10 |
| CloudWatch Logs (IA) | ~0.3 GB/month ingested, kept forever | IA ingestion $0.25/GB; storage grows ~$0.01/month per month of history | 0.08-0.15 |
| SSM, ACM, KMS (`aws/ssm`) | standard tier | free | 0 |
| **Total** | | | **≈ 1.6-3.1** at the 10-23 peak; **≈ 1.0-1.5** at ~50k req/day (Spark poll backoff) |

Levers if this must come down:
- Eventually consistent reads for `clients`/`authors`/`bans` lookups (-$0.3-0.6). This would make
  a revocation take effect up to ~1 s later, a semantic change.
- Provisioned 25 RCU/25 WCU, if this account's free tier covers it [5]. That is ~$0 for DynamoDB,
  but bursts above it throttle and need retries.
- Fewer Spark polls; that change is already in flight.

The **long-poll caveat** (§3): ~$5-9/month per continuously held client.

### 7.2 Top risks

1. **Semantic drift in ~45 rewritten atomic batches**, above all set-based updates and races. A
   batch that reads fine can still differ under concurrency.
   *Mitigation:* rules R1-R6 as a per-method checklist; dual-backend suite; seeded fuzzer
   diff against D1; conflict injection; the race tests on real parallelism.
2. **Read-model bug, giving wrong lists under a valid ETag.**
   *Mitigation:* snapshot-exact freshness protocol (§2.7); LDB-AWS-RM1 enforced structurally;
   per-step model == full-scan proof in the fuzzer; nightly full-scan comparison with an alarm.
3. **The `META/HEAD` ceiling** (~40 commits/s) and retry storms if a bulk client parallelizes.
   *Mitigation:* nothing else touches HEAD; jittered retries; exhausted-retry metric; contention
   math (§2.4). Today's load is ~3-4 orders of magnitude below it.
4. **Edge and platform differences visible to clients.** These include:
   - ETag weakening and compression headers, `Content-Length` vs chunked
   - `full=1` past 6 MB streaming at 2 MB/s (~+3 s for 12 MB)
   - CloudFront's origin timeout (30 s default, set to 60 s)
   - +100-200 ms for non-US users on every request, since there is no edge compute. Today every
     request also reaches D1's single primary, so this is mostly a shift, not a new cost.

   *Mitigation:* header-level crawler diff and the prod-log replay as cutover gates; measure
   latency from Fly `lax`/`iad` and Europe before the go.
5. **Cutover data loss or a split brain.**
   *Mitigation:* the write freeze longer than the signature skew; a full private export, not the
   public dump; generated (not copied) indexes; byte-equal round trip; the switch is a reversible
   Worker deploy; the rollback is rehearsed before the go.

### 7.3 What would change the design

- **Sustained writes above ~20/s:** move the log to a single-writer sequencer (SQS FIFO + one
  consumer stamping `seq`), or batch several events per HEAD move.
- **Catalog above ~100k layouts:** the model would exceed ~300 MB, or cold load would exceed ~1 s.
  Lists would then move to consistent index-item partitions per sort, or the read side to DSQL.
- **DSQL ships a local emulator and its DPU cost proves lower:** reconsider it for SQL parity.
- **ACM in us-east-1 refused by the account's SCPs:** use an API Gateway HTTP API custom domain
  with a regional certificate (~$1/M requests, +$1.5-2.6/month).
- **Multi-region becomes a requirement:** DynamoDB transactions are single-region [9], so global
  tables cannot keep one gap-free `seq`. That would need a redesign.

## 8. Open questions for saltorbit

1. **Write freeze for the cutover:** OK to add an additive `503 read_only` error code (CHANGELOG-API
   entry, minor bump) and announce it first? The alternative is a quiet-hour cutover where writes
   fail with the generic 500.
2. **Long-poll holds:** accept ~$5-9/month per continuously holding client? Or let the server
   decline holds under a budget with a new `X-Wait-Ignored` value (additive; `wait=` is already
   documented as a hint)?
3. **ACM certificate in us-east-1** for CloudFront: allowed by this project's SCPs? If not, API
   Gateway (§7.3).
4. **`workers.dev` clients:** repoint every client to `api.akldb.org` before cutover, or keep the
   proxy Worker (and the Workers Paid plan) for a while?
5. **Auth lookups:** strong consistency (proposed; today's semantics) or eventual consistency to
   save ~$0.5/month?
6. **Logs:** CloudWatch IA kept forever (proposed), or archive to S3 after 30 days?
7. **akldb.org site Worker:** stays on Cloudflare for now (proposed), or part of this move?
8. **Rollback window** before `store/d1` is deleted: 90 days?

## Sources

1. Aurora DSQL, PostgreSQL compatibility and limits (Repeatable Read fixed, 3,000 rows/txn, `C`
   collation, no triggers/PL/pgSQL): https://docs.aws.amazon.com/aurora-dsql/latest/userguide/working-with-postgresql-compatibility-unsupported-features.html
2. Aurora DSQL `CREATE SEQUENCE` (`CACHE` 1 or ≥ 65536; not gapless): https://docs.aws.amazon.com/aurora-dsql/latest/userguide/create-sequence-syntax-support.html
3. Aurora DSQL pricing (100k DPU + 1 GB free; $8/M DPU Ohio; ~700k txns per 100k DPU): https://aws.amazon.com/rds/aurora/dsql/pricing/
4. Services in the new AWS experience (DynamoDB, Aurora DSQL, Lambda, CloudFront, EventBridge, S3 on the Free Tier list): https://docs.aws.amazon.com/accounts/latest/reference/supported-services-sign-up-new.html
5. DynamoDB on-demand pricing ($0.125/M RRU, $0.625/M WRU, 25 GB free, PITR $0.20/GB-month): https://aws.amazon.com/dynamodb/pricing/on-demand/
6. CloudFront OAC for Lambda function URLs (`x-amz-content-sha256` on PUT/POST): https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/private-content-restricting-access-to-lambda.html
7. CloudFront expiration (TTL vs `max-age`; viewer `Cache-Control` ignored): https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/Expiration.html
8. EventBridge pricing (Scheduler 14M invocations/month free): https://aws.amazon.com/eventbridge/pricing/
9. DynamoDB transactions (100 items/4 MB, isolation, conflicts, `GetItem` vs transactions, client tokens, 2× capacity): https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/transaction-apis.html
10. DynamoDB Local usage notes (no `TransactionConflictException`, eventually consistent reads, no PITR): https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/DynamoDBLocal.UsageNotes.html
11. Lambda pricing (1M req + 400k GB-s free; $0.20/M; streaming $0.008/GB past 6 MB, 100 GB free; Web Functions rates) and Node.js 24: https://aws.amazon.com/lambda/pricing/ , https://aws.amazon.com/about-aws/whats-new/2025/11/aws-lambda-nodejs-24/
12. Lambda response streaming (200 MB, 2 MB/s past 6 MB, Node.js): https://docs.aws.amazon.com/lambda/latest/dg/configuration-response-streaming.html

Local evidence: `akldb-free.md` and `egress.md` (usage and CloudFront free-tier figures, 2026-10-24),
the `arch-review.md` case for keeping D1, the Spark lab's `conflict-retry.mjs` and I-LAB-LANE-CONFLICT /
I-LAB-REPLICA-SNAPSHOT, the db-backup snapshot of 2026-10-10 (4,506 format rows, max payload 6.7 KB),
and the schema rebuilt from all 35 migrations.

Lambda Web Functions were considered for the HTTP tier (Hono runs as is; waits are not billed as
CPU). They were rejected: memory is billed for the environment's whole life at a fixed 2 GB
($0.0000036667/GB-s [11]). At a steady ~1 req/s the environment never goes idle, so that is about
$19/month.
