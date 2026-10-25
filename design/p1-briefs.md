# P1 agent briefs (storage port extraction, D1 green)

Six briefs, A to F, for parallel Sonnet agents. Hand each one over **verbatim, together with the
"Common rules" section**. They run in parallel because of the freeze, which landed with this file
on branch `aws-port` (commit "Freeze the P1 storage port"):
- `src/store/port.ts`, the interface;
- `src/store/arg.ts`, the `StoreArg` transition;
- the D1 composition and the shared SQL helpers;
- `src/platform/*` and `src/app.ts`;
- `tests/harness/*`;
- every exported function that takes the database now accepts `StoreArg`.

So a caller in another area keeps compiling whichever side moves first.

Phase gate (main session, after all six are merged; design/aws-port.md §9, P1):
- full suite green, same test count;
- typecheck clean;
- no `.prepare(`/`.batch(` outside `src/store/d1/**` and the D1-only tests;
- no `legacyD1` left;
- `tests/tools/onlywriter.test.ts` back to its two final entries;
- a byte-equal crawler diff of a local Worker on one prod export, before vs after;
- 48 h on Cloudflare with no change in error rate or p95.

---

## Common rules (every P1 agent)

**Where to work.**
- Create your own worktree from the current tip of `aws-port`:
  `git -C ~/git/akl/wt-db-aws worktree add ~/git/akl/wt-db-p1-<letter> -b p1-<letter> aws-port`
- Work only there. Run `npm ci` once.
- Commit as `saltorbit <hi@akl.gg>`, with messages ending
  `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.
- Never push. Never use `git stash`.

**Read first:**
- `design/aws-port.md` §2.2 (rules R1-R6), §4.1 (the port) and §9 (P1);
- `src/store/port.ts` (your area's interface and its contract comments);
- `src/store/arg.ts`, `src/store/d1/index.ts`, `src/store/d1/sql.ts`;
- `src/platform/port.ts`, `src/app.ts`, `tests/harness/*`.

**What P1 is.** A pure move with no behaviour change: same SQL text, same statements per batch in
the same order, same binds, same number of D1 round trips (the LDB-L8 bounds in
`tests/api/l8-roundtrips.test.ts` must hold), same errors, same responses.

**Frozen.** Do not edit these files:
- `src/store/port.ts`, `src/store/arg.ts`;
- `src/store/d1/{index,stub,sql,holds,state}.ts`;
- `src/platform/*`, `src/app.ts`, `src/core/outbox-intent.ts`;
- `tests/harness/*`, `tests/tools/onlywriter.test.ts`.

If your area needs a method, parameter or return field the port does not have, **stop and message
the main session** with the exact signature you need. Do not work around it, add methods, or widen
types.

**The recipe, for every function in your files that touches D1:**
1. **Signature.** Exported functions already take `dbArg: StoreArg` and start with
   `const db = legacyD1(dbArg);`. Replace that line with `const store = toStore(dbArg);` and
   replace each statement or batch with the matching method of **your** area
   (`store.<area>.<method>(...)`). Keep `StoreArg` in the signature for all of P1.
   - Functions taking `env: Bindings` keep that signature and use `toStore(env.DB)`.
   - Non-exported helpers take `store: Store`.
2. **Move the SQL** verbatim into your `src/store/d1/<area>.ts`, replacing that file's
   `notImplemented` factory with a real object implementing the whole interface. Map rows to
   exactly the return shape the contract states.
   - A batch whose statements come from several builders becomes one method. Build it from your
     own statements plus the shared builders in `src/store/d1/sql.ts`: `gatedEventStatement`,
     `gatedOutboxStatement`, `gatedHistoryStatement`.
   - Never import another area's `store/d1` file.
3. **Calls into another area stay calls of that area's core function**, passing your `store`.
   Examples: `appendInfo(store, now, …)`, `byRef(store, ref)`, `roleOf(store, id)`. Never call
   another area's port method directly in P1, because it may still be a stub on your branch.
4. **Routes you own:**
   - `c.env.DB` becomes `platformOf(c).store` (import from `src/app.ts`);
   - `c.executionCtx.waitUntil(x)` becomes `platformOf(c).background(x)`;
   - type your Hono app with `AppEnv`.
5. **Domain logic stays where it is:** validation, error mapping, If-Match, folds and wire shapes.
6. **Tests are owned by agents E and F.** Do not edit test files. If one of your changes breaks a
   test, it is a behaviour change: fix your code. If you believe the test itself must change,
   report it instead of editing it.

**Your gate, before you report:**
- `npm run typecheck` is clean.
- `grep -nE "\.prepare\(|\.batch\(|legacyD1" <every file you own outside src/store/d1>` prints
  nothing.
- No `notImplemented` remains in your `src/store/d1` files.
- Your targeted tests are green, with the same test count as before: `npx vitest run <files>`.
  Run only the files listed in your brief. **Do not run the full suite**: it is heavy and the
  main session runs it (16 GB machine).
- `git diff --stat aws-port` touches only files you own.

**Report:** branch name and commits; the vitest summary lines of your targeted run (before and
after); any port contract that felt wrong, with the exact signature you would want.

---

## Agent A: head, layouts, events (the write path and the reads)

**You own:**
- `src/core/{records,events,write,likes,revert,relabelMagicThumbs,etag,meta,longpoll,destructive-budget}.ts`
- `src/routes/{layouts,write,likes,changes,changelog,formats}.ts`
- `src/index.ts` (the `/v1/meta` and `/v1/me` handlers, the error handler, and `scheduled()`'s
  wiring, without changing what it calls)
- `src/store/d1/{head,layouts,events}.ts`

**Implement in `store/d1`:**
- `HeadStore` (4): `readHead`, `headSeq`, `authorsHead`, `metaCounts`.
- `LayoutReadStore` (21): every method in the interface. The SQL is in `records.ts`, the
  `routes/layouts.ts` reads (`likesByLayout`, `/history`, `/rev/:n`), `write.ts`
  (`latestRevBumpingEvent`, `tombstoneLikers`, the transfer author check), `revert.ts`'s rev
  payload read, `routes/authors.ts`'s two counts, and the `SELECT id FROM layouts ...` presence
  checks.
- `EventStore` (10): `commitWrite`, `appendInfo`, `appendAdmin`, `appendModeration`,
  `appendLinkChange`, `appendLike`, `appendInheritedLikes`, `feed`, `revertCandidates`,
  `latestLinkEvent`.

  The destructive-budget statement and `readDestructiveBudgetRow` move into
  `store/d1/events.ts`, since only `commitWrite`/`appendLinkChange` batch it. The pure threshold
  functions stay in `core/destructive-budget.ts`.

**Also:**
- `core/etag.ts` `conditional()`/`cachePut()` use `platformOf(c).cache` instead of
  `caches.default`; the semantics are identical.
- `core/events.ts` `rejectionModerationStatement` becomes unused once agent C lands. Leave it
  exported and unchanged; the main session deletes it at the phase end.
- `StateStore` is already implemented (`store/d1/state.ts`); use it for `import_state` reads in
  your files.

**Other areas call your core functions** (`appendInfo`, `appendAdmin`, `appendModeration`,
`appendLinkChange`, `byRef`, `readById`, `byRefWithFormats`, `loadForWrite`, `readHead`,
`readMetaCore`, `headSeq`). Keep their names, parameters and results exactly as they are.

**Targeted tests:**
- `tests/events/`
- `tests/api/{list,list-plan,write,patch,put-format,transfer,restore,likes,mf1-like-race,mf-l2-unlike-race,mf2-exhausted-retry,mf6-http-races,mf7-derived-formats,history,refs,names,etag,meta,layouts-head,ifmatch,source-matrix,format-write-matrix,format-required-matrix,format-read-labels,held,bodies,alts-combos,row-minus-one,skip-magic-publish,l8-roundtrips,revert,changes-longpoll,changelog,conformance}.test.ts`
- `tests/core/{known-kinds,upstream,relabelMagicThumbs,destructive-budget}.test.ts`
- `tests/tools/`

---

## Agent B: auth and admin

**You own:**
- `src/auth/{client,discord,roles,actor,idempotency,ratelimit}.ts`
- `src/core/{clients,idempotency,ratelimit,admins,moderation}.ts`
- `src/routes/{admin,moderation,authors}.ts`
- `src/store/d1/{auth,admin}.ts`

**Implement in `store/d1`:**
- `AuthStore` (20):
  - `client`, `insertNonce` (return false on `UNIQUE constraint failed: nonces`; the caller
    throws `replay()`), `pruneNonces`, `touchClientAuthor`;
  - `authCache`, `cacheAuthFailure`, `cacheAuthSuccess` (the three-statement batch in
    `resolveBearer`), `pruneAuthCache`;
  - `rolesOf` (raw presence; `roleOf` keeps deriving `banned && !admin`), `authorName`,
    `authors`, `author`;
  - `hitWindow` and `pruneRateLimits`;
  - the six idempotency methods.
- `AdminStore` (17): admins (`removeAdmin` is today's conditional DELETE plus the two reads on
  refusal), bans, `setAuthorNameByAdmin`, and the client registry, including the
  `suspendClient`/`reactivateClient` batches. `clientsHealth` reads states through
  `store.state.getMany` (already implemented).

**Notes:**
- `routes/admin.ts` also calls agent A's and D's core functions: magic seed, relabel, dump,
  nightly. Only switch their database argument to the store (or keep `env`). Do not change those
  functions.
- `routes/authors.ts`: the list and detail reads go through your `AuthStore.authors`/`author`.
  The two counts belong to agent A (`LayoutReadStore.liveCountByOwner` / `likeCountByUser`).
  They have no core function to go through, and on your branch A's port methods are still stubs.
  So keep those two reads as today's SQL in a local helper marked `// P1: agent A`. That helper
  is the one exemption from your grep gate, and the main session switches it to the port when
  merging.

**Targeted tests:**
- `tests/auth/{client,discord,moderation,routes}.test.ts`
- `tests/api/{admin,admin-clients-site-fixture,clients,me,ratelimit,idempotency,authors-count,authors-validator,moderation,rogue-client}.test.ts`
- `tests/core/idempotency.test.ts`

---

## Agent C: links, WPM, comments, review history

**You own:**
- `src/core/{links,wpm,comments,moderation-review}.ts`
- `src/routes/{links,wpm,comments}.ts`
- `src/store/d1/{links,wpm,comments,review}.ts`

**Implement in `store/d1`:**
- `LinkStore` (5): `pending`, `get`, `submit`, `queue`, `reject`.
- `WpmStore` (9): `get`, `bindSourceMessage`, `sourceMessage`, `insertApproved`, `submit`,
  `queue`, `approve`, `reject`, `records`.
- `CommentStore` (15): every method in the interface.
- `ReviewStore` (6): `decisionState`, `history`, `submissionLayout`, `reopen`, `reopenRecorded`,
  `submissionDecision`. The last two serve agent D's `discord-interactions.ts`, which keeps its
  own SQL until D lands.

**Decision batches:**
- Build the event with `gatedEventStatement`, the DM row with `gatedOutboxStatement` from an
  `OutboxIntent` made by `core/outbox-intent.ts` `outboxIntent(input, "rejection" | "approval")`,
  and history rows with `gatedHistoryStatement`. Keep the batch order exactly as today.
- Return `DecisionOutcome` from the `meta.changes` of the claim and the event statement, as the
  code checks them now. The domain functions throw `reviewConflict`/`notFound` from that outcome,
  exactly as today.
- Link approve and clear stay calls of agent A's `appendLinkChange` core function.

**Routes:**
- Background work goes through `platformOf(c).background(...)`.
- The functions it runs (`notifyPending`, `announceComment`, `updateQueueNotification`,
  `dispatchRejectionDms`) are agent D's. Pass `platformOf(c).store` and the env as today.

**Targeted tests:**
- `tests/api/{links,wpm,comments,moderation-reopen}.test.ts`
- `tests/core/{comments,links,wpm}.test.ts`
- `tests/events/moderation-events.test.ts`

---

## Agent D: modqueue, Discord interactions, DM outbox, dump

**You own:**
- `src/core/{modqueue,modqueue-delivery,modqueue-message,modqueue-proof,discord-interactions,rejection-dm,nightly,jobs}.ts`
- `src/dump/{write,restore}.ts`
- `src/routes/dump.ts`
- `src/store/d1/{modqueue,discord,outbox,dump}.ts`

**Implement in `store/d1`:**
- `ModqueueStore` (17), including the delivery gate methods.
- `DiscordStore` (19): every method.
  - The interaction inserts throw `DuplicateInteractionError` (from `src/store/port.ts`) when D1
    reports a PRIMARY KEY or UNIQUE violation on the interaction or modal id. The handler keeps
    its `insertFailureResponse` path by catching it.
  - `claimAction` keeps today's two statements: the read, then the CAS.
- `OutboxStore` (9).
- `DumpStore` (2):
  - `tables()`: the pagers in `buildDump`, unfiltered. `buildDump` keeps the redaction and
    filtering, and still reads meta first (MF-13).
  - `restore()`: `restoreInto`'s chunked batches. **The restore SQL moves into
    `store/d1/dump.ts`**, which the relaxed `tests/tools/onlywriter.test.ts` already allows.
    `restoreSql()` (the pure SQL renderer used by `scripts/rehost.mjs`) stays in
    `src/dump/restore.ts`.

**Also:**
- `routes/dump.ts` and `writeDump` use `platformOf(c).blobs` / the platform's `BlobStore`
  instead of `env.DUMPS`. Build the platform with `workersPlatform(env, ctx)` where there is no
  request context (scheduled, nightly).
- Calls into agent C (`comments.*`, `wpm.*`, the review functions) and agent B (`roleOf`) stay
  core-function calls.
- `rejection-dm.ts`'s `rejectionOutboxStatement`/`approvalOutboxStatement` become unused once C
  lands. Leave them in place; the main session deletes them at the phase end.

**Targeted tests:**
- `tests/auth/{discord-interactions,modqueue,modqueue-comments,modqueue-wpm,modqueue-delivery,modqueue-message,rejection-dm}.test.ts`
- `tests/api/{dump,mf13-dump-floor,fixture-export,freeze-seed}.test.ts`
- `tests/rehost.test.ts`
- `tests/core/modqueue-proof.test.ts`

---

## Agent E: tests/api onto the harness

**You own:**
- every file under `tests/api/` except the D1-only list below;
- `tests/api/support.ts` and `tests/api/write-support.ts`.

**Do, for every owned file:**
1. Import the runtime from `tests/harness` (`env`, `SELF`, `createExecutionContext`, ...)
   instead of `cloudflare:test`/`cloudflare:workers`.
2. Replace every raw SQL call (`db.prepare(...)`, `db.batch(...)`, `e.DB.prepare(...)`: 274
   sites in 44 files) with `testStore` from `tests/harness`, using its D1-shaped rows:
   `rows`, `row`, `count`, `insert`, `patch`, `remove`.
   - Typical shapes: `SELECT COUNT(*) ... WHERE x = ?` becomes `testStore.count(table, { x })`;
     an `UPDATE` used to set up state becomes `testStore.patch(table, key, fields)`.
   - Aggregates or joins the inspector cannot express are written as JS over `testStore.rows(...)`.
     Keep assertions' expected values unchanged.
3. Where a test calls a core function with `env.DB`, pass `store` from `tests/harness`.

**D1-only, leave as they are** (they test D1 itself: migrations, query plans, D1 round-trip
counts): `migration-0016.test.ts`, `migration-0017.test.ts`, `list-plan.test.ts`,
`l8-roundtrips.test.ts`. Add one line at the top of each: `// D1-only (design/p1-briefs.md E).`

**Gate:**
- typecheck clean;
- `grep -nE "\.prepare\(|\.batch\(|cloudflare:(test|workers)" tests/api` prints only the four
  D1-only files;
- `npx vitest run tests/api` is green with the same count as on `aws-port` (record both numbers).

If the inspector cannot express something, report it to the main session; do not extend
`tests/harness`.

---

## Agent F: tests/auth, tests/events, tests/rehost onto the harness

**You own:** every file under `tests/auth/` and `tests/events/`, `tests/rehost.test.ts`,
`tests/auth/client-support.ts`, `tests/auth/fake-discord.ts`.

**Do:** the same three steps as agent E (255 SQL sites in 17 files).
- `tests/rehost.test.ts` restores a dump and compares tables. Rows go through `testStore.rows`
  instead of SQL.
- `tests/setup-workers.ts` stays as it is: it applies the D1 migrations, and P2 gives the
  DynamoDB variant its own setup.

**Gate:**
- typecheck clean;
- `grep -nE "\.prepare\(|\.batch\(|cloudflare:(test|workers)" tests/auth tests/events tests/rehost.test.ts`
  prints nothing;
- `npx vitest run tests/auth tests/events tests/rehost.test.ts` is green with the same count as on
  `aws-port` (record both numbers).

If the inspector cannot express something, report it to the main session; do not extend
`tests/harness`.

## Carried to P2 (main session)

- **TestStore fault-injection hook.** The atomic-rollback tests that inject faults with D1 triggers are D1-only for P1: `tests/auth/rejection-dm-d1.test.ts`. P2 must give TestStore a fault-injection hook, so the same rollback properties are proven on DynamoDB too. They must not stay D1-only.
- **D1-only test list** for the onlywriter and no-`.prepare(` gates: `tests/auth/rejection-dm-d1.test.ts`, `tests/auth/modqueue-migration-d1.test.ts`, `tests/api/p1-a-equivalence.test.ts`, `tests/api/authors-count.test.ts`, `tests/api/mf-l2-unlike-race.test.ts`, `tests/api/me-d1.test.ts`, `tests/api/authors-validator-d1.test.ts`, `tests/api/changes-longpoll-d1.test.ts`, `tests/api/moderation-reopen-d1.test.ts`, the migration tests (`migration-0016`, `migration-0017`), `list-plan` and `l8-roundtrips`. Several of these (unlike race, longpoll fault, reopen trigger) also need P2 DynamoDB equivalents through the fault-injection hook.
- **Phase-end cleanup:**
  - delete `rejectionModerationStatement` (core/events.ts), `rejectionOutboxStatement` and `approvalOutboxStatement` (core/rejection-dm.ts);
  - move `restoreSql` into `store/d1/dump.ts` and drop the onlywriter legacy entry;
  - no `legacyD1` may remain.
