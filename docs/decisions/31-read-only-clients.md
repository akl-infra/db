# 31. Read-only clients (`read-only` cap)

Status: design, for the main session and saltorbit (2026-10-25). Not implemented.

**Why.** Spark's shadow (spark-migration.md §2.3, D3) reads production akldb with a registered
client, `spark-shadow`, so actor-scoped reads (`/v1/me`, `/v1/me/comments`, WPM receipts, signed
`wait=` long-polls) work exactly as for the real bot. Today every registered client can also
write. This adds a generic, additive way to register a client that cannot.

It is independent of the AWS port. It lands on `main` first, and `aws-port` rebases onto it.

## Decision

**A new extra cap, `read-only`.** It sits beside `feed:wait` in `EXTRA_CAPS` and combines with
either scope cap:

| `caps` | May act as | May send |
|---|---|---|
| `act-as-user` | any user | any method |
| `act-as-owner-only` | its owner only | any method |
| `act-as-user,read-only` | any user | GET and HEAD only |
| `act-as-owner-only,read-only` | its owner only | GET and HEAD only |

`spark-shadow` registers as `act-as-user,read-only`, because it reads as each command's user.

**The refusal.** In `verifyClientRequest` (`src/auth/client.ts`), a new step 4b runs right after
the signature verifies (step 4) and before the nonce (step 5). A request whose method is not GET
or HEAD, from a client whose caps include `read-only`, gets:

```
403 {"error":"client_read_only","message":"this client is read-only: it may send only GET and HEAD requests","method":"<METHOD>"}
```

There is no `WWW-Authenticate` header: the key is fine, and the capability refuses the request,
like `actor_not_allowed`.

Placing it after the signature means an unsigned or forged request can't probe a client's caps.
Placing it before the nonce means a refused request writes nothing at all: no nonce, no author
row, no idempotency reservation, no rate-limit count. The actor middleware runs before the
idempotency and rate-limit middlewares, so the refusal short-circuits both.

**What "read-only" guarantees.**
- **Nothing in the data model changes:** no event, no `layouts`/likes/submission/comment/WPM row,
  no admin or client row, and **no `authors` row**.
- **Step 7 changes for a read-only client:** it reads the actor's name (`store.auth.authorName`)
  and does not upsert. A read-only client's first sight of a user therefore creates no
  placeholder author and moves neither `authors_head` nor any `/v1/meta` or `/v1/authors` ETag.
- **The response body is unchanged:** an unknown actor's name falls back to the actor id, which
  is exactly the placeholder an upsert would have stored.
- **Auth bookkeeping is still written:** the nonce (replay protection), rate-limit windows, and
  long-poll hold accounting. It is ephemeral and not part of the dump.
- **GET and HEAD behave exactly** as for the same client without the cap, apart from that skipped
  author upsert.

**Registration (the ops path).** No new route.
1. Generate an Ed25519 keypair locally (`node scripts/client-sign.mjs` helpers, or `crypto`). The
   private key goes straight into the consumer's secret store: Spark's SSM parameter for
   `spark-shadow`, which spark-migration's owner provisions. It is never committed and never
   pasted into a doc.
2. Register with the ops client (memory `akldb-ops-client`):
   `sh scripts/ops-call.sh POST /v1/admin/clients '{"name":"spark-shadow","pubkey":"<b64url raw 32-byte key>","owner_user_id":"<saltorbit's id>","caps":"act-as-user,read-only"}'`.
   This appends the usual public `admin.client_registered` event with the caps.
3. Caps never change in place: revoke and re-register. Suspend and revert work as for any client.

`validateCaps` (`src/core/clients.ts`) already accepts any extra cap in `EXTRA_CAPS`, so adding
the constant is the whole validation change. Its error message lists the extras, and now reads
"…plus any of feed:wait, read-only". That changes a 400 body's text, so it goes in the changelog.

## Changes (one PR on akl-infra/db, branch `read-only-cap`, worktree `wt-db-readonly`)

- `src/auth/client.ts`:
  - `ExtraCap = "feed:wait" | "read-only"` and `EXTRA_CAPS`;
  - step 4b;
  - step 7's branch on `hasCap(caps, "read-only")`.
- `src/core/errors.ts`: `clientReadOnly(method)`. `scripts/gen-error-table.mjs` regenerates
  adoption.md's error table (`tests/tools/error-table.test.ts`).
- `src/core/etag.ts`: `WIRE_VERSION` 29 → 30, with its changelog comment.
- `CHANGELOG-API.md` 1.30, additive: a new extra cap, a new error code, the extended
  `validateCaps` message, and read-only clients not upserting authors.
- `docs/adoption.md`:
  - the caps paragraph (§ registration);
  - the verification-steps table gets the new row after the signature row;
  - the generated error table.
- `INVARIANTS.md`: three rows, ids claimed in `handoff/README.md` before minting (LDB-A16…A18;
  LDB-A15 is the last used on main):
  - **LDB-A16:** a read-only client's non-GET/HEAD request is refused with exactly the
    `client_read_only` body, and leaves every table unchanged (nonces included). This is checked
    for every non-GET route in `app.routes`.
  - **LDB-A17:** a read-only client's GET/HEAD gets the same status, headers and body as the same
    request from an otherwise identical client without the cap, and writes no data table. The
    `authors` row is not created; `/v1/meta` and `/v1/authors` ETags don't move.
  - **LDB-A18:** `caps` accepts `read-only` with either scope cap and with `feed:wait`, still
    refuses it alone or with two scopes, and the refusal message lists every extra cap.
- **Tests.** No raw SQL: use `tests/harness` (`SELF`, `env`, `testStore`), so LDB-W2 holds and the
  same tests run on the DynamoDB backend later.
  - `tests/auth/read-only-client.test.ts`:
    - the route sweep, from `app.routes`: every non-GET method and path with a signed body. It
      asserts the 403 body, no `WWW-Authenticate`, and `testStore.count` unchanged on every
      table;
    - the GET parity pairs: `/v1/me` (a known and an unknown actor), `/v1/me/comments`,
      `/v1/wpm/submissions/:id`, `/v1/changes?wait=1`, `/v1/layouts/:ref`, a HEAD;
    - the step order: a bad signature still gets 401, a revoked client 401, a suspended client
      403 `client_suspended`. Only a verified request reaches 4b.
  - `tests/api/clients.test.ts`: the registration cases for LDB-A18.

## Shipping

1. **Implementation:** a Sonnet agent in `wt-db-readonly` (branch `read-only-cap`, off
   `origin/main`). Brief below.
2. **Verification:** the main session runs the full suite locally; the count goes up by the new
   tests only. It also reruns `scripts/lab/p1-crawl-diff.mjs --base origin/main --head
   read-only-cap` on the fixture and the public dump.
   - Expected differences, and nothing else:
     - `X-AKLDB-API: 1.30` instead of `1.29`;
     - every ETag, because `WIRE_VERSION` is hashed into them;
     - `/v1/meta`'s `api.minor`.
   - The crawl's own client is not read-only, so no write changes.
3. **Landing:** PR to `akl-infra/db`; the main session merges it (`gh pr merge --rebase`). The
   merge deploys through CI, with the standing checkpoint (D1 bookmark, a fresh dump, the
   db-backup snapshot) before migrations. There is no migration: `clients.caps` is TEXT.
4. **Registering `spark-shadow`:** done by the main session after the deploy shows
   `X-AKLDB-API: 1.30`, through ops-call (above). Spark's shadow config gets the client id and
   the SSM parameter name.
5. **`aws-port`:**
   - PR #32 (P1) is already merged into `main`. `aws-port` now only adds the P2 contracts and
     design commits, which touch none of these files except `INVARIANTS.md`, where the conflict
     is append-only.
   - Rebase `aws-port` onto `main` after this lands, so the P2 lanes branch from a tree that has
     the cap.
   - P2 lane I needs no change: the logic sits in `src/auth/client.ts` above the port and uses
     `store.auth.authorName`, which already exists on both backends.

## Brief (hand over verbatim)

> **Task: the `read-only` client cap for akldb.** Work in the worktree `wt-db-readonly`
> (branch `read-only-cap`, already created off `origin/main`). Commit as
> `saltorbit <hi@akl.gg>`, ending messages with
> `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`. Never push, never `git stash`, no
> cloud calls of any kind (no `wrangler --remote`/deploy, no fetch of api.akldb.org).
>
> **Read:** `docs/decisions/31-read-only-clients.md` (this design, the spec), `src/auth/client.ts`,
> `src/core/clients.ts` (`validateCaps`), `src/core/errors.ts`, `docs/adoption.md` §1.3 and the
> error table, `CHANGELOG-API.md`'s latest entries, `tests/harness/`.
>
> **Do exactly the "Changes" section of the design:**
> - the cap constant;
> - step 4b, placed after the signature check and before the nonce;
> - step 7's read-only branch, which reads the name and does not upsert;
> - `clientReadOnly(method)`;
> - `WIRE_VERSION` 30 with its changelog comment, and CHANGELOG-API 1.30;
> - adoption.md, with the error table regenerated by `node scripts/gen-error-table.mjs`;
> - the three INVARIANTS rows LDB-A16…A18, already claimed;
> - the tests named there.
>
> **Test rules:** use `tests/harness` only, with no `.prepare(`/`.batch(` anywhere
> (`tests/tools/sql-boundary.test.ts` enforces it). Every test title carries its `[LDB-A1x]` tag.
> The route sweep must derive its list from `app.routes`, not from a hand-written list.
>
> **Gate:**
> - `npm run typecheck`;
> - `npx vitest run tests/auth/read-only-client.test.ts tests/api/clients.test.ts tests/auth/client.test.ts tests/tools`
>   green;
> - `git diff --stat origin/main` touches only the files the design lists.
>
> Do not run the full suite; report the exact command and the main session runs it.
>
> **Report:** commits, the vitest summary lines, and anything in the spec that didn't fit the
> code.
