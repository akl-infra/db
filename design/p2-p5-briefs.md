# P2 and P5 lane briefs (akldb on DynamoDB, and the proving-ground tools)

Eleven briefs for parallel Sonnet agents: seven P2 lanes (G, H, I, J, K, N, L) and four P5 lanes
(P, Q, R, S). Hand each one over **verbatim, together with "Common rules"**.

**The freeze they build on** is two commits on `aws-port`: "Freeze the P2 DynamoDB contracts
and the platform hook" and "Pin the item-model and fault-injection contracts".
- `src/store/port.ts`: the P1 port, unchanged.
- `src/store/ddb/contracts.ts`: `DdbContext`, `runEventTx`/`runTx`, `TxConditionFailed`,
  `Catalog`, `LaneSchema`, `D1TableName`.
- `src/store/ddb/index.ts`: the composition, with one stub file per lane.
- `src/store/ddb/schema/index.ts`: the item-model registry, with one stub per lane.
- `src/app.ts`: `platformFor` and the `PLATFORM` factory on the env.
- `tests/harness/port.ts`: `TestStore.faults`, implemented on D1.
- `@aws-sdk/client-dynamodb` and `@aws-sdk/lib-dynamodb` pinned at 3.1148.0.

**Launch order.**
- **Wave 1:** G and L start alone. G builds the foundation everyone writes against: `keys.ts`,
  `tx.ts` (runEventTx/runTx), `client.ts`, `tables.ts`. L builds the harness every lane tests
  with.
- **Wave 2:** H, I, J, K and N start once the main session has merged G's foundation commit and
  L's harness commit into `aws-port`. G and L continue in their own lanes.
- **P5:** lanes P, Q, R and S start after P2's phase gate. They need a working DynamoDB store to
  test against locally, and P4 for the real run.

**P2 phase gate** (main session, after every P2 lane is merged; design/aws-port.md §9):
- every workers-project test green on both backends, minus the exact D1-only list;
- the fuzzer at 10k sequences × 20 seeds with zero response or state diffs against D1;
- the suite and the fuzzer green with 20% injected conflicts;
- a byte-identical codec round trip of a production private export, every table;
- catalog == full scan after every fuzzer step;
- the index checker clean;
- the race packs green;
- the DynamoDB call-count bounds (the LDB-L8 analog) holding.

**P2 carry-overs from P1** (design/p1-briefs.md "Carried to P2") are assigned below:
- the `TestStore` fault hook: pinned, built by L for DynamoDB;
- DynamoDB equivalents of the D1-only rollback, race and fault tests: lanes G, J, K, each in its
  own brief.

The D1-only tests stay D1-only; LDB-W2 keeps that list exact.

---

## Common rules (every P2 and P5 lane)

**Where to work.**
- Create your worktree from the current tip of `aws-port`:
  `git -C /Users/dario/git/akl/wt-db-aws worktree add /Users/dario/git/akl/wt-db-<p2|p5>-<lane> -b <p2|p5>-<lane> aws-port`
  (lane letter lower-case, e.g. `wt-db-p2-g`, branch `p2-g`).
- Work only there. Run `npm ci` once.
- Commit as `saltorbit <hi@akl.gg>`, messages ending
  `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.
- Never push. Never use `git stash`.

**Read first:**
- `design/aws-port.md` §2 (the model: rules R1-R6, items, seq, the catalog), §3, §4.1, §5.1 and §9;
- `src/store/port.ts`, `src/store/ddb/contracts.ts`, `src/store/ddb/index.ts`,
  `src/store/ddb/schema/index.ts`;
- `src/store/d1/<your areas>.ts`: the exact behaviour you reproduce.

**No cloud, ever.**
- No call reaches AWS, Cloudflare, Discord, GitHub or production akldb, from code, tests, tools
  or the shell. That means no `aws` CLI, no `wrangler deploy`/`--remote`, and no fetch of
  `api.akldb.org`.
- Every DynamoDB client you construct points at `http://127.0.0.1:<your port>` with fake
  credentials. `src/store/ddb/client.ts` (lane G) refuses any other endpoint unless
  `AKLDB_DDB_ALLOW_REMOTE=1` is set, and only P4 deploys set that.
- Every outbound `fetch` in lab code goes to `127.0.0.1`.
- Inputs that come from production (exports, Logpush days) are copied in by the main session.
  You get local paths.

**Ports and containers.** Each lane has its own. Never touch another lane's, and never kill
processes by name pattern; stop only what you started, by PID.

| Lane | DynamoDB Local | Other local ports | Docker container name |
|---|---|---|---|
| G | 18301 | | `akldb-ddb-g` |
| H | 18302 | | `akldb-ddb-h` |
| I | 18303 | | `akldb-ddb-i` |
| J | 18304 | | `akldb-ddb-j` |
| K | 18305 | | `akldb-ddb-k` |
| N | 18306 | | `akldb-ddb-n` |
| L | 18307 | 18317-18319 (fuzzer: D1 Worker, DynamoDB server, spare) | `akldb-ddb-l` |
| P | 18401 | 18402 (fake Discord), 18403-18404 | `akldb-ddb-p` |
| Q | 18411 | 18412-18414 | `akldb-ddb-q` |
| R | 18421 | 18422-18424 | `akldb-ddb-r` |
| S | 18431 | 18432-18434 | `akldb-ddb-s` |

- **Off limits** to every lane: 8787, 8788, 4190, 18911-18913 (`p1-crawl-diff`), and anything else
  already listening (check with `lsof -i :<port>` first).
- **DynamoDB Local:** the local image `amazon/dynamodb-local:latest` (already pulled; do not pull
  again):
  `docker run -d --rm --name <container> -p 127.0.0.1:<port>:8000 amazon/dynamodb-local:latest -jar DynamoDBLocal.jar -inMemory -sharedDb`
- **Without Docker:** if Docker is not running, use the jar with Java 21 (installed). The main
  session puts it at `/Users/dario/git/akl/handoff/dynamodb-local/` and gives you the path.

**Heavy runs go through team-lead.**
- **You run:** `npm run typecheck`, and targeted `npx vitest run <files>` that finish in about two
  minutes.
- **You do not run** the full suite, the dual-backend suite at large, fuzzer runs past 200
  sequences, proving-ground runs, or anything over about 2 minutes or 2 GB. Send team-lead the
  exact command, the expected duration and what "green" means. The machine has 16 GB and runs
  several sessions' suites; overlapping heavy runs have OOMed it.

**Ids.** Invariant ids are claimed in `handoff/README.md` (row "akldb AWS port P2/P5"). Use only
your lane's range; every new invariant gets a row in `INVARIANTS.md` and a tagged test (LDB-T1).

| Lane | Ids | Lane | Ids |
|---|---|---|---|
| G | LDB-DDB1…DDB19 | P | LDB-PG1…PG14 |
| H | LDB-DDB20…DDB29 | Q | LDB-PG15…PG34 |
| I | LDB-DDB30…DDB39 | R | LDB-PG35…PG46 |
| J | LDB-DDB40…DDB54 | S | LDB-PG47…PG59 |
| K | LDB-DDB55…DDB69 | | |
| N | LDB-DDB70…DDB79 | | |
| L | LDB-DDB80…DDB99 | | |

`INVARIANTS.md` is a shared file: add your rows only at the end of the "DynamoDB" (P2) or "Proving
ground" (P5) section. If the section does not exist yet, create it there. The main session resolves
the append-only conflicts at merge.

**Frozen.** Do not edit:
- `src/store/port.ts`, `src/store/ddb/contracts.ts`, `src/store/ddb/index.ts`,
  `src/store/ddb/schema/index.ts`;
- `src/app.ts`, `src/platform/port.ts`;
- `tests/harness/port.ts`;
- `src/store/d1/**` and `tests/harness/d1.ts`. D1 is the oracle, and a D1 change needs the main
  session.

If you need a contract changed, stop and send the main session the exact signature.

**Behaviour.**
- The DynamoDB store must produce the same responses and the same rows (through the codec) as
  the D1 store, for every operation.
- Read your areas' `src/store/d1/*.ts` statement by statement and reproduce:
  - each batch's atomicity;
  - each `changes() = 1` gate, as a condition in the same transaction (design R6);
  - each set-based update, as a read set plus a set-version guard (R5);
  - each UNIQUE, as a claim item (R3);
  - each trigger or `COUNT`, as a counter item (R4);
  - each index, as index items in the same transaction (R2).
- **Reads are strongly consistent (R1)** except the auth lookups (saltorbit, 2026-10-25):
  `clients`, `authors` for the actor's name, `admins`/`bans` for roles. Those use eventual reads,
  and the contract comment in `src/store/port.ts` says which.
- **Every event goes through `runEventTx`.**
- **Nothing but `runEventTx` writes the `META/HEAD` item** (design §2.4; this is how the lab's
  TransactionConflict lesson is designed out).

**Your gate, before you report:**
- typecheck clean;
- every method of your areas implemented (no `notImplemented`/"not implemented yet" left in
  your files);
- your targeted tests green: listed per lane, run on DynamoDB Local at your port;
- `git diff --stat aws-port` touches only files you own.

**Report:**
- branch and commits;
- your targeted vitest summary lines;
- the heavy commands you want team-lead to run;
- any contract that felt wrong, with the exact signature you would want.

---

# P2: the DynamoDB store

## Lane G: foundation, head, events, layouts (wave 1, then wave 2)

**You own:**
- `src/store/ddb/{client,keys,tables,tx,head,state,layouts,events,holds,cutover}.ts`
- `src/store/ddb/schema/core.ts`
- `tests/ddb/{tx,head,events,layouts,keys,roundtrips,unlike-race,longpoll-fault}.test.ts`

**Wave 1 deliverable, as one commit you report the moment it is done:**
- **`client.ts`:**
  - `createDocClient({ endpoint, region })` returns a `DynamoDBDocumentClient` with
    `removeUndefinedValues: true` and `convertEmptyValues: false`;
  - it refuses a non-127.0.0.1 endpoint unless `AKLDB_DDB_ALLOW_REMOTE=1`;
  - it uses fake credentials locally.
- **`tables.ts`:** `createTables(doc, tables)` and `deleteTables(doc, tables)`.
  - Both tables use `pk`/`sk` (S), on-demand billing, and no GSIs or LSIs.
  - The ephemeral table gets TTL on `ttl`.
  - Callers: lane L's harness, the dev server (P3), and P4's template (by name).
- **`keys.ts`:** every key builder in design §2.3, as functions returning `{ pk, sk }`.
  - **Numbers in sort keys are zero-padded:** seq to 12 digits, revs to 8, history ordinals to 6.
  - `fold(name)` lowercases ASCII `A-Z` only, exactly SQLite NOCASE.
  - **Namespaces.** Each lane builds its own index and claim keys in its own file, inside the
    pk prefixes listed here, so lanes never collide:
    - G: `META`, `STATE`, `CAT`, `NAME#`, `L#`, `U#`, `EV`, `EVL#`, `EVK#`, `EVA#`, `IMPORTMAP`
    - I: `AUTHORS`, `ADMINS`, `BANS`, `CLIENTS`, `IDEM#`; ephemeral `N#`, `AC#`, `RL#`, `HOLD#`
    - J: `SUB#link#`, `SUB#wpm#`, `SUB#comment#`, `IX#link#`, `IX#wpm#`, `IX#cmt#`, `CC`, `CL#`,
      `CLA#`, and in `L#<id>` only sort keys starting `SET#`
    - K: `MQN#`, `IX#mqn#`, `DPA#`, `DINT#`, `DMOD`, `DCONF`, `DMO#`, `IX#dmo#`
- **`tx.ts`:** `runEventTx` and `runTx`, exactly as typed in `contracts.ts`.
  - Every event writes its `EV` item plus its `EVL#<layout_id>` mirror (when `layout_id` is
    set), `EVK#<kind>` and `EVA#<actor>` mirrors in the same transaction.
  - The HEAD update sets `seq`, `max_at = max(max_at, at)` and `live`, conditioned on
    `seq = :expected`.
  - Cancellation reasons map to the tags of the failed items. A failure on the HEAD item alone,
    or a `TransactionConflict`, re-reads HEAD and rebuilds. Retries use the backoff in
    `contracts.ts`, at most 8 attempts, then `internal()` with an `EVENTTX_EXHAUSTED` log line.
  - DynamoDB Local never throws `TransactionConflictException`. Your tests drive retries through
    lane L's fault wrapper. Until L lands, use a local stub of the same shape and replace it at
    merge.

**Wave 2:**
- `ddbHeadStore`, `ddbStateStore`, `ddbLayoutReadStore`, `ddbEventStore`; `ddbHoldStore` and
  `ddbCutoverStore` (see Holds and cutover below); `schema/core.ts` (layouts + layout_formats
  as one `CAT` item each, layout_revs, likes, events + mirrors, layouts_head into
  `META/HEAD.live`, import_state, import_map).
- **List-shaped reads use `ctx.catalog.current()` (lane H):** `list`, `tombstoneLikers`,
  `liveCountByOwner`, `formatsForLayouts`, and `metaCounts().layoutsModifiedAt`. Until H lands,
  write them against the `Catalog` contract and test them with a fake catalog built from a scan.
- **`commitWrite`:**
  - **Conditions:** `CAT.n = :n` → `RevConflictError`; the live name claim → `nameTaken(name)`;
    the destructive budget as an `ADD` on lane I's key
    `RL#client:<id>#destructive / <window>` inside the same transaction, read back after commit.
  - **Payload spill over 350 KB:** content-addressed blob `payloads/<sha256>` via `ctx.blobs`,
    written before the transaction.
- **`appendLinkChange`:** the claim on lane J's link submission item. Import J's key builder
  from `src/store/ddb/keys-community.ts` once J lands; until then pin the key shape
  `SUB#link#<id>/ROW` and attribute `status`, which J must keep.
- **`appendLike` / `appendInheritedLikes`:** chunk inherited likes at 15 likers per transaction.
- **`feed`:** bounded by HEAD, key range `since+1 .. min(head, since+limit)`, with the mirror
  partition chosen by the filter. For the unfiltered feed, check contiguity and fail with a 500,
  never a gap.
- **Holds and cutover:**
  - `ddbHoldStore`: the lease `HOLD#<client>`, plus the daily budget `RL#holds/<YYYY-MM-DD>`.
  - `ddbCutoverStore`: read `STATE/cutover.mode`, cached 1 s per container.
  - In P2 both must behave exactly like the D1 defaults: hold always granted, mode null. Build
    the real versions behind a constructor flag `{ realHolds: true }`, off by default and
    unit-tested.

**DynamoDB equivalents of D1-only tests:**
- `tests/ddb/unlike-race.test.ts`: `mf-l2-unlike-race`'s property on real parallelism;
- `tests/ddb/longpoll-fault.test.ts`: `changes-longpoll-d1`'s head-read fault, via
  `testStore.faults`;
- `tests/ddb/roundtrips.test.ts`: the LDB-L8 bounds as DynamoDB call counts, using L's counting
  wrapper. One number per operation, pinned in the test with a comment saying why.

**Targeted tests:** `tests/ddb/{tx,head,events,layouts,keys,roundtrips,unlike-race,longpoll-fault}.test.ts`.
Also the dual-backend run of `tests/events/` and of `tests/api/{write,patch,put-format,transfer,restore,likes,history,refs,names,ifmatch,meta,layouts-head}.test.ts`,
once L's project exists.

## Lane H: the catalog read model

**You own:** `src/store/ddb/catalog.ts`, `src/store/ddb/catalog-snapshot.ts`, and
`tests/ddb/catalog*.test.ts`.

**Build** `createCatalog(ctx)` per `contracts.ts` and design §2.7.
- **The model:** `Map<id, CatalogLayout>` (decoded `CAT` items including tombstones, with
  payloads; likers from `L#<id>` `LK#` items, ascending).
- **`current()`:**
  1. Read HEAD consistently.
  2. Fetch `EV` in `(cursor, h]` and collect the touched `layout_id`s.
  3. `TransactGetItems` of `META/HEAD` plus every touched `CAT/<id>`, in chunks of 99 with HEAD
     in each chunk.
  4. Reload likers for layouts touched by `liked`/`unliked` events.
  5. Repeat while any chunk sees HEAD > h. It has converged when every chunk sees the same h.
     Give up after 5 rounds with `internal()`.

  The returned view is an exact snapshot at h.
- **Boot:**
  - Read the snapshot blob `replica/snapshot.json.gz` through `ctx.blobs` (seq + layouts), then
    catch up.
  - If the snapshot is missing or unreadable, fall back to `rebuildFromScan()`, a consistent
    Scan of `CAT` and `LK#` items.
  - `writeSnapshot()` writes only when HEAD moved past the stored seq, with a
    compare-before-write on the stored seq so a stale writer never regresses it.
- **Ordering helpers** for lane G's `list`: export `compareNocase(a, b)`, using `Buffer.compare`
  on ASCII-folded UTF-8, and `compareSqlite(a, b)`, SQLite's cross-type order for cursors.
  Tests must cover astral-plane names, names differing only in case, and forged cursors of the
  wrong type.

**Invariant (yours, LDB-DDB20):** after any sequence of operations, `current()` deep-equals
`rebuildFromScan()`. It is a property test over random operation sequences, through the port.

**Targeted tests:** `tests/ddb/catalog*.test.ts`, and the dual-backend `tests/api/{list,mf7-derived-formats,alts-combos,row-minus-one}.test.ts`
once G's `list` is wired.

## Lane I: auth, admin, ephemeral

**You own:**
- `src/store/ddb/{auth,admin}.ts`
- `src/store/ddb/keys-auth.ts`
- `src/store/ddb/schema/auth.ts`
- `tests/ddb/{auth,admin,nonces,ratelimit,idempotency}.test.ts`

**Implement** `AuthStore` (20) and `AdminStore` (17).
- **Eventual reads:** `client`, `authorName`, `rolesOf`, `isAdmin`, and the auth-cache read
  (`GetItem`/`BatchGetItem` with `ConsistentRead: false`). Every other read is strongly
  consistent.
- **Nonces:** ephemeral `N#<client>/<nonce>`, a conditional `Put`, with `ttl` = at + 900 s.
- **Rate limits:** `RL#<key>/<window_start>` with `ADD n :1` and `ReturnValues UPDATED_NEW`.
- **TTL is lazy:** readers check expiry themselves, never TTL.
- **Author upserts:**
  - Use `runTx` with `META/AUTHORS` on an insert or a rename (version + 1, modified_at,
    count + 1 on insert).
  - Use a plain conditional `UpdateItem` for an hourly `last_seen_at` refresh, without touching
    the head.
  - Retry `TxConditionFailed` with a consistent re-read.
- **Admin removal:** a transaction conditioned on `META/ADMINS.count > 2`.
- **Idempotency:** `IDEM#<scope>/<key>`, with the same reserve/takeover/complete/delete CASes
  and `ttl` = at + 25 h. Bodies over 350 KB go in gzip-compressed as a binary attribute.
- **`schema/auth.ts`:** authors, authors_head, admins, bans, clients, nonces, auth_cache,
  ratelimit, idempotency.

**Invariants you prove (LDB-DDB30…):**
- after a nightly prune, an old nonce is still refused and a pruned window never resurrects (G4);
- a revoked client is refused within the eventual-read lag. Test it with a forced stale read
  from L's fault wrapper, then assert the refusal after a consistent read.

**Targeted tests:** `tests/ddb/{auth,admin,nonces,ratelimit,idempotency}.test.ts`, and the
dual-backend `tests/auth/{client,discord,moderation,routes}.test.ts` and `tests/api/{admin,clients,me,ratelimit,idempotency,authors-validator,moderation,rogue-client}.test.ts`.

## Lane J: links, WPM, comments, review history

**You own:**
- `src/store/ddb/{links,wpm,comments,review}.ts`
- `src/store/ddb/keys-community.ts`
- `src/store/ddb/schema/community.ts`
- `tests/ddb/{links,wpm,comments,review,reopen-fault}.test.ts`

**Implement** `LinkStore` (5), `WpmStore` (9), `CommentStore` (15) and `ReviewStore` (6).
- **Every decision is one `runEventTx`:** the claim CAS on the `SUB#...#<id>/ROW` item (R6), the
  gated event, index-item moves (R2), the set guard `L#<layout>/SET#<kind>` for set-based updates
  (R5), the outbox row and its claims, history and its claim (R3), and the MQN dirty mark.
- **K owns the outbox and MQN keys.** Build those items with
  `src/store/ddb/keys-discord.ts`'s builders (K's file). Until K lands, use the pinned shapes
  `DMO#<delivery_key>/ROW`, claims `DMO#seq#<event_seq>/CLAIM` and `DMO#nonce#<nonce>/CLAIM`,
  and dirty mark `IX#mqn#dirty/<kind>#<submission_id>`. K must keep exactly these.
- **Index partitions** are your design, inside your prefixes. Name each one in
  `keys-community.ts` with a comment saying which D1 index or query it replaces (design §2.3:
  status queues, pairs, approved-by-layout, by-user, counts).
- **Joins with layout names and owners** read the catalog (`ctx.catalog.current()`). Joins with
  author names use `AuthStore.authorName` through the store (eventual is fine for display).
- **The D1-only test you port:** `tests/ddb/reopen-fault.test.ts`, `moderation-reopen-d1`'s
  trigger fault, via `testStore.faults`.

**Targeted tests:** `tests/ddb/{links,wpm,comments,review,reopen-fault}.test.ts`, and the
dual-backend `tests/api/{links,wpm,comments,moderation-reopen}.test.ts`, `tests/core/{comments,links,wpm}.test.ts`
and `tests/events/moderation-events.test.ts`.

## Lane K: modqueue, Discord interactions, DM outbox, dump

**You own:**
- `src/store/ddb/{modqueue,discord,outbox,dump}.ts`
- `src/store/ddb/keys-discord.ts`
- `src/store/ddb/schema/discord.ts`
- `tests/ddb/{modqueue,discord,outbox,dump,outbox-rollback}.test.ts`

**Implement** `ModqueueStore` (17), `DiscordStore` (19), `OutboxStore` (9) and `DumpStore` (2).
- **Leases and claims:** conditional `UpdateItem`s with the same CAS columns as D1. The delivery
  gate is `META/MQGATE` (in G's `META` namespace; it is yours to write).
- **The four interaction tables:** each row plus the claim `DINT#<interaction_id>/CLAIM`.
  `DuplicateInteractionError` on a claim failure.
- **Due and dirty queues:** read the sparse index partitions (`IX#dmo#due`, `IX#mqn#dirty`),
  never a scan.
- **Keep J's pinned outbox and dirty-mark shapes** (see lane J).
- **`DumpStore.tables()`:** a consistent read of every table, through the codec (N's
  `exportRows`), as D1-shaped rows. Until N lands, write it against N's pinned signature
  `exportRows(ctx): Promise<RowsByTable>` (below).
- **`DumpStore.restore(dump)`:** `importRows(ctx, rowsFromDump)`, N's.
- **The D1-only test you port:** `tests/ddb/outbox-rollback.test.ts`, `rejection-dm-d1`'s atomic
  rollback, via `testStore.faults`.

**Targeted tests:** `tests/ddb/{modqueue,discord,outbox,dump,outbox-rollback}.test.ts`, and the
dual-backend `tests/auth/{discord-interactions,modqueue,modqueue-comments,modqueue-wpm,modqueue-delivery,rejection-dm}.test.ts`,
`tests/api/{dump,mf13-dump-floor}.test.ts` and `tests/rehost.test.ts`.

## Lane N: codec, DynamoDB TestStore, export/import, index checker, migrations, rehost

**You own:**
- `src/store/ddb/codec.ts`, `src/store/ddb/checker.ts`, `src/store/ddb/migrate.ts`
- `migrations-ddb/`
- `tests/harness/ddb-store.ts`, the DynamoDB `TestStore`
- `scripts/rehost.mjs`'s new `--target ddb` path only
- `tests/ddb/{codec,checker,schema-coverage,migrate,teststore}.test.ts`

**Pinned signatures** (others import them):
- `exportRows(ctx): Promise<RowsByTable>`: a consistent Scan of both tables, split per lane by
  `tableOf`, then each lane's `fromItems`. Rows are ordered by primary key.
- `importRows(ctx, rows): Promise<void>`: each lane's `toItems`, then `BatchWriteItem` chunks of
  25 with unprocessed-item retry. For empty tables only (restore, migration, tests).
- `rowsToItems(rows): { main: Item[]; ephemeral: Item[] }` and its inverse: the pure composition
  of the four `LaneSchema`s.
- `checkIndexes(ctx): Promise<{ ok: boolean; problems: string[] }>`: regenerate every derived
  item from the primary items and diff the result against what is stored.

**The DynamoDB `TestStore`** (`tests/harness/port.ts`):
- `rows`, `row` and `count` read `exportRows` and filter in memory.
- `insert`, `patch` and `remove`:
  1. export;
  2. change the affected table's rows;
  3. recompute that lane's items with `toItems`;
  4. apply the item difference with `BatchWriteItem`.

  It is slow per call and correct; tests use small data.
- `faults` delegates to L's fault wrapper. `failWrites(table)` makes the wrapper cancel any
  write touching an item whose `tableOf` is `table`.

**`schema-coverage.test.ts`:** the four schemas cover all 29 `D1TableName`s exactly once.
Round-trip property tests run per lane as each lane lands. Until then, skip that lane with a
reason, and the main session removes the skip at merge.

**Migrations:**
- `migrate.ts` runs numbered idempotent data migrations from `migrations-ddb/NNNN_*.ts`, recorded
  in `STATE/migrations`. Write one no-op migration (an item version bump) for P5's G6 check.
- The additive-only rule mirrors `tests/tools/migrations-additive.test.ts`.

**Rehost:** `rehost --target ddb --dump <file>`, local DynamoDB only, with the same seq-loss and
`--wipe` guards as the D1 path.

**Targeted tests:** `tests/ddb/{codec,checker,schema-coverage,migrate,teststore}.test.ts`, and a
round trip of `tests/fixtures/seed-upstream-100.dump.json`. Ask team-lead for the round trip of
a production private export (the P2 gate item).

## Lane L: harness, dual-backend suite, fault and call-count wrappers, fuzzer (wave 1, then wave 2)

**You own:**
- `vitest.config.ts`
- `tests/harness/{index.ts,ddb.ts,setup-ddb.ts,global-ddb.ts}`
- `src/store/ddb/{faults,counting}.ts`
- `src/platform/node-lab.ts`
- `scripts/lab/serve-ddb.mjs`
- `scripts/lab/fuzz/**`
- `tests/ddb/{faults,fuzz-smoke}.test.ts`
- `tests/tools/sql-boundary.test.ts`'s D1-only list, for new D1-only files only
- `package.json` scripts

**Wave 1 deliverable, as one commit reported at once:**
- **A vitest project `ddb`:**
  - node environment;
  - `globalSetup` starts DynamoDB Local on 18307 (Docker or the jar), reused if it is already
    up, and stops it on teardown;
  - `setupFiles` creates one fresh table pair per test file with G's `createTables`, using a
    prefix from the file path hash plus the worker id;
  - it includes `tests/ddb/**` and the dual-backend files: `tests/api/**`, `tests/auth/**`,
    `tests/events/**`, `tests/rehost.test.ts`, **minus the D1-only list** in
    `tests/tools/sql-boundary.test.ts`.
  - `tests/harness` resolves to `tests/harness/ddb.ts` through a project-level `resolve.alias`;
    the `workers` project keeps today's `tests/harness/index.ts`.
- **`tests/harness/ddb.ts`:** the same exports as `index.ts`.
  - `env`: a mutable object with the `[vars]`, `DB` set to the DynamoDB `Store` (core code calls
    `toStore(env.DB)`), and `PLATFORM` set to `node-lab.ts`'s factory. It honours the test-only
    `TEST_CLOCK`, `TEST_RATE_LIMITS` and `TEST_LONGPOLL_SLEEP` properties tests set on it.
  - `SELF`: `{ fetch: (input, init) => app.fetch(new Request(input, init), env, ctx) }`.
  - `createExecutionContext` / `waitOnExecutionContext` collect and await `waitUntil` promises.
  - `createScheduledController({ scheduledTime, cron })`.
  - `testStore`: N's, once it lands; until then a stub that throws a clear "N not merged"
    error.
  - `store`.
- **`src/platform/node-lab.ts`:** a `Platform` for Node:
  - the store as given, with an in-memory `BlobStore` and a validated in-memory LRU
    `ResponseCache`;
  - `now` from `env.TEST_CLOCK` or the system clock;
  - `ulid`;
  - `fetch` refuses any non-127.0.0.1 host (throws);
  - `background` collects promises for `waitOnExecutionContext`.
- **`src/store/ddb/faults.ts`:** `withFaults(doc, { rate, seed, kinds })` wraps a document
  client.
  - It injects `TransactionConflict`, `Throttling` or `InternalServerError` on a seeded fraction
    of calls; injected calls are never applied.
  - It also exposes `failWritesFor(predicate)` for `TestStore.faults` and `staleReads(n)`, which
    forces eventual reads to return the previous version, for I's lag test.
  - The suite runs under `LAB_FAULT_RATE=0.2`.
- **`src/store/ddb/counting.ts`:** `withCallCounter(doc)` counts each command type, for G's
  round-trip bounds.

**Wave 2:**
- **`scripts/lab/serve-ddb.mjs`:** a Node HTTP server running the app on the DynamoDB store at a
  given port. It applies the same lab `Date`/PRNG overrides as `p1-crawl-diff.mjs`'s
  `.lab-entry.ts`, keyed on `x-lab-now`/`x-lab-seed`.
- **`scripts/lab/fuzz/`:**
  - A seeded organic sequence generator over every route, with several actors on both lanes,
    odd names, cursors, filters and moderation flows, plus restarts (a fresh catalog
    mid-sequence).
  - A runner that drives the D1 Worker (lab entry, as `p1-crawl-diff.mjs`) and
    `serve-ddb.mjs` with the same requests, then diffs responses (status, contract headers,
    bytes) and the final state (D1 SQLite vs `exportRows`).
  - After every step, it asserts `catalog.current()` == `rebuildFromScan()` and that the index
    checker is clean.
  - Reuse `p1-crawl-diff.mjs`'s functions by importing them. If you must refactor it, keep its
    CLI and output identical, and say so in your report.
  - `tests/ddb/fuzz-smoke.test.ts` runs 50 sequences. Team-lead runs the 10k × 20 gate.

**Targeted tests:** `tests/ddb/{faults,fuzz-smoke}.test.ts`, and the `ddb` project on
`tests/api/meta.test.ts` and `tests/api/formats*.test.ts` as a harness smoke test.

---

# P5: proving-ground tools (start after the P2 gate)

These tools run locally against DynamoDB Local plus `serve-ddb.mjs` and the D1 Worker oracle.
Team-lead later points them at the deployed lab stack (P4). Every tool takes its base URLs and
data paths as arguments; none has a built-in remote default. Design: aws-port.md §5.1 and its
coverage map.

**Lab mode, superseding §5.1's `X-Lab-Actor` (pinned).** There is no auth bypass in the app:
- clock and ids are frozen by entry modules (`x-lab-now`, `x-lab-seed`);
- client-lane identities come from a lab client key re-registered under the real client ids in
  the lab copy, and the tools sign;
- bearer-lane identities come from fake Discord tokens `lab-<user_id>`.

## Lane P: lab entries, fake Discord, the Discord URL fix

**You own:**
- `src/platform/lab-entry.ts` (Node/Lambda lab entry)
- `scripts/lab/entry/workers-lab.ts` (the workerd lab entry, generalised from
  `p1-crawl-diff.mjs`'s inline one; that script then imports this file)
- `scripts/lab/fake-discord/**`
- `src/core/discord-interactions.ts`'s `API` constant only
- `tests/lab/{entry,fake-discord,discord-base}.test.ts`

**Build:**
1. **The entries.**
   - Freeze `Date`/`Date.now` and reseed `getRandomValues`/`randomUUID` from the headers.
   - Patch `fetch` to refuse non-127.0.0.1 hosts.
   - Refuse to start when `LAB_MODE` is unset, or when a request's host is `api.akldb.org`.
2. **The fake Discord:** an HTTP server that implements, enough for akldb's code paths:
   - `GET /api/oauth2/@me` (tokens `lab-<id>`);
   - the v10 bot routes akldb calls: channel messages GET/POST/PATCH, DM channel create,
     message create with nonce, and the interaction callback, followup and original-message
     routes;
   - the incoming-webhook route.

   It also:
   - records every request as NDJSON (method, path, body, headers minus auth) for S's differ;
   - injects 429 (with `Retry-After`) or 5xx on command, through its own control endpoint;
   - holds the lab application's Ed25519 key, and exposes a signer the simulator uses to sign
     interaction payloads.
3. **The fix:** `src/core/discord-interactions.ts` hard-codes `https://discord.com/api/v10`, the
   one Discord URL not taken from `DISCORD_API_URL`. Derive it from the config's
   `DISCORD_API_URL` + `/v10`.
   - Production's value is `https://discord.com/api`, so production URLs are unchanged.
   - Add a test proving the URL production builds is byte-identical.
   - This is the only core change any P5 lane makes.
4. **The Discord base is injectable everywhere, with a pinned default** (cross-component request,
   akl.gg aws-site.md §4.7, e91a347ea).
   - **Purpose.** akl.gg's `fake` stage points its `DB_BASE_URL` at the akldb lab, and that lab
     must use akl.gg's fake Discord as its `DISCORD_API_URL`. Then akldb's own bearer check gives a
     real `401 token_invalid` for a token the fake has revoked.
   - **One variable, `DISCORD_API_URL`,** is the only source of every Discord URL akldb calls:
     - the bearer check `GET {base}/oauth2/@me`, already today;
     - the bot routes `{base}/v10/...` (modqueue, DMs, proofs), already today;
     - the interaction callbacks, after fix 3.
   - **The default is pinned at `https://discord.com/api`:**
     - `wrangler.toml` `[vars]` (today's value);
     - `src/platform/lab-entry.ts` and P4's Lambda config, which fall back to exactly this string
       when unset.
     - Add `tests/lab/discord-base.test.ts` (LDB-PG range), asserting all three:
       1. with the variable unset or set to the default, every URL akldb builds (bearer check,
          bot routes, interaction callback) equals today's literal, byte for byte;
       2. with it set to `http://127.0.0.1:<port>/api`, all of them go there and nothing
          reaches `discord.com`, checked with a fetch spy;
       3. `wrangler.toml` still says `https://discord.com/api`.
   - **The contract a fake must meet** for akldb's bearer check, whichever fake it is (yours, or
     akl.gg's `platform/fake-discord/`):
     - `GET {base}/oauth2/@me` with `Authorization: Bearer <token>`;
     - 200 `{"application":{"id":"<snowflake>"},"user":{"id":"<snowflake>","username":"<name>"},"scopes":["identify"]}`;
     - 401 for an unknown or revoked token;
     - anything else = `503 identity_unavailable` on akldb's side.

     Make your fake meet it and akl.gg's tokens interchangeable: accept a token akl.gg's fake
     issued if you are given its token table. Simpler: document that a lab stage uses exactly
     one fake, which on the `fake` stage is akl.gg's.
   - **Caching caveat for akl.gg's suite** (state it in your fake's README): akldb caches a
     bearer success for 300 s and a failure for 60 s (`src/auth/discord.ts`, production
     constants, not changed for the lab).
     - A token revoked at the fake keeps passing akldb's check until its cached success expires.
     - akl.gg's "revoked → `token_invalid`" step must revoke a token akldb has not seen, or wait
       more than 300 s after akldb last saw it.
     - Lab-only cache overrides are not added: they would make the lab differ from production.
   - **For P4's templates** (main session): `DISCORD_API_URL` is a per-stage parameter, defaulting
     to the pinned string. The akldb lab stage that serves akl.gg's `fake` stage sets it to
     akl.gg's fake Discord URL.

## Lane Q: simulator, rare admin pack, generated bodies, interaction generator, race packs

**You own:** `scripts/lab/sim/**` and `tests/lab/sim*.test.ts`.

**Build** everything §5.1 "Simulated, organic" lists:
- the Spark, akl.gg and mana2 client shapes and the admin shapes;
- adversarial inputs;
- forced cold catalogs;
- the rare admin pack (magic-seed, relabel, client register/revoke/suspend/reactivate/revert,
  admin add/remove);
- generated submit bodies (comment, WPM incl. proofs and discord-message binds, link);
- signed Discord interactions for approve/deny/reopen × three queues, plus stale cards, non-admins
  and duplicates;
- the race packs with their invariant checks.

**Output:**
- a seeded request stream (JSONL);
- a driver that sends it to two targets and hands each response pair to S's differ through a
  pinned function: `diffPair(a, b, ctx) => Problem[]`, exported by
  `scripts/lab/diff/pair.mjs`. Until S lands, use the logic in `p1-crawl-diff.mjs`.

## Lane R: Logpush replay

**You own:** `scripts/lab/replay/**` and `tests/lab/replay*.test.ts`.

**Inputs** are local paths the main session provides:
- the Logpush days (R2 `akl-db-logs` layout `<YYYYMMDD>/<YYYYMMDD>/<start>_<end>_<id>.log.gz`;
  NDJSON trace events with URL, method, status, timing and outcome, but no headers or bodies);
- the before-window private export;
- the after-window private export.

**Build:**
- **The parser.**
- **Ordering:** replay by `EventTimestampMs`, at 1× and 10×.
- **304s:** a logged 304 is replayed with the then-current ETag.
- **Actor inference:** the submitter of the submission id for receipts, an admin for queues,
  else a lab actor.
- **Write-body rebuild:**
  - layout writes from the window's events and revs;
  - decisions from events plus the review history;
  - submit bodies and the discord-message bind from the after-window export, matched by
    submission id;
  - an erased comment gets a generated body of the same length.
- **Re-signing** with the lab client key.
- **The skipped-request report**, gated at ≤ 1%.

Hand pairs to S's `diffPair`, like Q.

## Lane S: differ, state diff, coverage and cost report

**You own:** `scripts/lab/diff/**`, `scripts/lab/report/**` and `tests/lab/{diff,report}*.test.ts`.

**Build:**
- **`diff/pair.mjs` `diffPair`:** status, contract headers and body bytes, with an allow-list
  file holding only `health.*.age_s`.
- **The state diff:** D1 SQLite vs DynamoDB `exportRows`, per table, first differing row.
- **The fake-Discord record diff.**
- **The daily coverage report:** every one of the 73 routes, 13 jobs and 4 background steps
  seen at least once, read against `handoff/aws-coverage-inventory.md`'s list (copied in as a
  fixture).
- **The latency report:** p50/p95/p99 per route and cold starts.
- **The cost projection:** from CloudWatch-shaped input files the main session exports
  (`ConsumedRead/WriteCapacityUnits`, Lambda GB-s, requests). Your tests use fixtures; you never
  call CloudWatch.

**P5 phase gate:** design/aws-port.md §9 P5 row, for N days; saltorbit sets N.
