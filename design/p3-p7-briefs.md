# P3, P4, mirror and cutover briefs (akldb)

Eight briefs, one per lane: M, O, V, F, T, Z, U, X. Hand each over **verbatim, with "Common rules"
from `design/p2-p5-briefs.md`**: the worktree and branch scheme, commit identity, never push,
never `git stash`, frozen files, the gate and report format. Two of those rules change here, as
stated per lane.
- **"No cloud":** lanes O and V write templates and deploy scripts but **never run them**. The
  main session deploys with `aws-vault exec akldb` (profile `akldb`, account 335937358231,
  us-east-2).
- **"Never push":** lanes T and U produce **production runtime PRs**. The main session pushes
  and merges them; saltorbit granted the runtime push on 2026-10-25.

The design these implement: `design/aws-port.md` §3, §3a, §5.2 (stages, the mirror, the cutover
PR, the DNS switch, rollback, go/no-go) and §6.

**Facts every lane uses:**
- the managed SCP denies `iam:*Provider*`, so there is **no GitHub OIDC** anywhere;
- AWS-side automation runs from the main session's machine;
- CI's only AWS identity is the IAM user `akldb-ci`. It can only `sts:AssumeRole` the narrow role `akldb-cutover-role`, and its key lives in the GitHub environment `akldb-production`, restricted to `main`. This is the same pattern as the site and Spark designs. Lane O writes both policies; the main session creates them (the SCP allows `iam:CreateUser`/`CreateAccessKey`);
- spend limit set on the project;
- the ACM certificate lives in us-east-1. Its DNS validation records are saltorbit's, in one
  batch (§5.2's user-hands list).

**Ports:** M 18501-18503, O none, V 18511-18513, T 18521-18522, Z 18531-18533 (DynamoDB Local
18531), U 18541-18545, X 18551-18553. Avoid 8787, 8788, 4190 and 18911-18913.

**Ids:** `handoff/README.md`, row "akldb AWS port P3/P4/mirror/cutover":

| Lane | Ids | Lane | Ids |
|---|---|---|---|
| M | LDB-DEV1…DEV9 | Z | LDB-MIR20…MIR39 |
| O | LDB-INF1…INF19 | U | LDB-CUT1…CUT19 |
| V | LDB-SITE1…SITE9 | X | LDB-CUT20…CUT29 |
| T | LDB-MIR1…MIR19 | F | LDB-FZ1…FZ9 |

**Order:**
1. M, O and F start at once. V starts with O, since it shares the stack.
2. T and Z start at once; they share only the pinned record format below.
3. U starts once T is merged.
4. X starts once U is merged.

## Pinned cross-lane contract: the tee record (T writes it, Z reads it)

`src/mirror/record.ts` (lane T creates it first, verbatim, as its first commit):

```ts
// One recorded storage write (design/aws-port.md §5.2). FROZEN once T's first commit lands.
export interface TeeCall {
  v: 1;
  /** "<area>.<method>", e.g. "events.commitWrite". */
  method: string;
  /** Arguments encoded with encodeTee(); a Clock argument becomes {"$clock": [iso, ...]}, the values it returned. */
  args: unknown[];
  /** The outcome, encoded. */
  outcome: { ok: unknown } | { error: { name: string; status?: number; body?: unknown; message: string } };
  /** Event seqs this call committed, ascending ([] if none). */
  seqs: number[];
  /** Date.now() when the call returned. */
  atMs: number;
}
export interface TeeBatch {
  v: 1;
  /** Which way the mirror runs: "d1->ddb" before the cutover, "ddb->d1" after. */
  direction: "d1->ddb" | "ddb->d1";
  /** A random id; ingest dedupes on it. */
  batchId: string;
  calls: TeeCall[];
}
/** Headers: X-Akldb-Tee-Ts (epoch s, ±300 s), X-Akldb-Tee-Sig = hex HMAC-SHA256(secret, ts + "\n" + body). */
export const TEE_TS_HEADER = "X-Akldb-Tee-Ts";
export const TEE_SIG_HEADER = "X-Akldb-Tee-Sig";
/** Tagged JSON: Map -> {"$map": [[k, v], ...]}, Set -> {"$set": [...]}, Uint8Array -> {"$bytes": b64}, undefined -> {"$u": 1}. */
export declare function encodeTee(value: unknown): unknown;
export declare function decodeTee(value: unknown): unknown;
```

T implements `encodeTee`/`decodeTee` in that file. The property test: `decodeTee(encodeTee(x))`
deep-equals `x` for every argument and result type the port uses.

---

## Lane M (P3): local dev and CI

**You own:**
- `scripts/dev.mjs`, `src/platform/node.ts`;
- the README's "Run locally";
- `package.json` scripts (`dev`, `dev:d1`, `test:ddb`);
- `.github/workflows/ci.yml` changes, **prepared as a diff file**
  `design/lab/ci-ddb.patch`. The classifier blocks committing workflows, so saltorbit commits it.

**Build design §6:**
- `npm run dev` starts DynamoDB Local (the local `amazon/dynamodb-local:latest` image, else the
  jar via Java 21), creates the tables with lane G's `createTables`, seeds them (`--seed empty`,
  `--seed fixture`, or `--seed <dump file>`), and serves on `127.0.0.1:18501`, overridable;
- `platform/node.ts`: filesystem blobs under `.dev/blobs`, an in-process 5-minute tick, and
  background tasks awaited after the response;
- `npm run dev:d1` keeps `wrangler dev`;
- the CI patch adds a DynamoDB Local `services:` container and runs the `ddb` project beside
  `workers`.

**Gate:**
- from a fresh clone with no AWS credentials, `npm ci && npm run dev` answers `/v1/meta` in
  under 2 minutes, with Docker and with Docker stopped (jar);
- `tests/lab/dev.test.ts` (LDB-DEV) boots it on a free port and makes one signed write;
- the CI patch applies cleanly to `main`.

## Lane O (P4): the akldb stacks

**You own:**
- `infra/akldb.yaml`: one template with a `Stage` parameter, `lab` | `staging` | `prod`;
- `infra/acm-us-east-1.yaml`;
- `infra/iam-akldb-ci.json` (the user: `sts:AssumeRole` on the role only) and `infra/iam-akldb-cutover-role.json` (the trust policy for that user, plus the role policy);
- `infra/*.guard`, `infra/*.test.mjs`;
- `scripts/deploy-aws.sh`.

**The template, per design §3 and §5.2:**
- the two tables: on-demand, PITR on, deletion protection on `prod`, TTL on ephemeral;
- the `api`, `feed` and `jobs` Lambdas: Node 24, arm64, `RESPONSE_STREAM` Function URLs with
  `AuthType NONE` behind the origin-verify header;
- **`prod` only,** with `MirrorMode` = `apply` | `record`:
  - `mirror-ingest`: a Function URL with HMAC, which writes batches into the ephemeral table
    under `MQ#<direction>`;
  - `mirror-apply`: no URL; woken by the ingest's async invoke and by a 1-minute schedule;
- the CloudFront distribution, caching disabled, with the hostname taken from `Stage`
  (`staging-api.akldb.org`, or `api.akldb.org` attached on `prod` but unused until the DNS
  switch);
- EventBridge Scheduler `rate(5 minutes)` → `jobs`. On `prod`, disabled until the cutover
  (`ScheduleEnabled`);
- S3 buckets: data, dumps and snapshot;
- SSM parameters: Discord, origin-verify, the tee HMAC secret;
- the log group in the IA class, retention never; alarms (within the free 10); a budget;
- `DISCORD_API_URL` as a parameter with the default pinned at `https://discord.com/api` (lane P's
  contract);
- no VPC.

**Also:**
- `deploy-aws.sh <stage>`: build with esbuild, then `aws cloudformation deploy`. It refuses to
  run without `AWS_PROFILE=akldb` or `aws-vault`, and the main session runs it.
- `iam-akldb-cutover-role.json`: least privilege for the orchestrator (U), trusting only the `akldb-ci` user, with a 1 h session:
  - the `prod` tables;
  - the `MirrorMode`/`ScheduleEnabled` parameter updates through `cloudformation:UpdateStack`
    on the `prod` stack only;
  - `lambda:InvokeFunction` on `mirror-apply`;
  - the SSM parameters it reads;
  - nothing else.

**Gate:**
- cfn-lint and cfn-guard green, including the rejected mutations: a VPC, a wildcard action,
  `prod` without PITR, a URL on `mirror-apply`;
- `infra/akldb.test.mjs` asserts each stage's resource set (LDB-INF).

## Lane V (P4): akldb.org on AWS

Unchanged from aws-port.md §9's P4 row (the site distribution, S3, the site Lambda, the two
CloudFront Functions, the OAuth URLs as env vars, the deploy script).

Two additions:
- a `Stage` parameter, so `next.akldb.org` (staging) and `akldb.org` (prod) come from one
  template;
- `site/scripts/deploy-aws.mjs` refuses to run without the akldb profile.

**Gate:** the site checks in §3a, run locally against `wrangler dev` vs the Lambda handler on
`127.0.0.1`.

## Lane T (mirror, production side): the recording Store

**You own:**
- `src/mirror/{record,recorder,observe-d1,observe-ddb,sender}.ts`
- `src/platform/workers.ts`, only the wrapper hook
- `tests/mirror/{record,recorder}.test.ts`

**Build:**
- **`record.ts`:** verbatim as pinned, plus `encodeTee`/`decodeTee`.
- **`recorder.ts`:** `recordingStore(inner: Store, sink: (c: TeeCall) => void): Store`. It wraps
  every write method listed in §5.2 item 1, and passes reads through untouched.
  - It replaces each `Clock` argument with a wrapper that logs the returned values.
  - It records the outcome, or a thrown error's class, status and body, and rethrows it.
  - **Seqs committed, with no port or D1-store change:** the recorder runs each call inside an
    `AsyncLocalStorage` context (`node:async_hooks`, available under `nodejs_compat`), and hands
    the store a database that is observed:
    - **D1:** a proxy over `D1Database` tags each prepared statement by its SQL. On `run`/`batch`
      results, every `INSERT INTO events` with `meta.changes === 1` adds its `last_row_id` to the
      current context.
    - **DynamoDB (the reverse direction):** a proxy over the document client does the same for
      every committed `TransactWrite` item whose `pk` is `EV`.

    Both proxies sit in your files; `createD1Store`/`createDdbStore` just receive the observed
    handle.
- **`sender.ts`:** one `TeeBatch` per unit of work: a request, a background task, or a scheduled
  run. It is HMAC-signed and POSTed through `platform.background`, with three tries.
- **The wiring:** `platform/workers.ts` wraps the store only when `TEE_URL` and `TEE_SECRET` are
  set, so the default build is byte-identical.

**Gate:**
- `p1-crawl-diff.mjs` byte-identical against `origin/main` with `TEE_URL` unset and with it set
  to a local sink (LDB-MIR);
- a test proving the recorded calls of a full write session replay into a fresh D1 store and
  produce identical rows;
- the recorder adds no D1 round trip (LDB-L8 holds).

This is a production runtime PR. The main session reviews, pushes and merges it, and it deploys
**dormant**: `TEE_URL` stays unset until lane Z's ingest is deployed.

## Lane Z (mirror, AWS side): ingest, applier, checks, reseed, daily proof

**You own:**
- `src/mirror/{ingest,apply,verify}.ts`
- `scripts/mirror/{reseed,daily-proof}.mjs`
- the `mirror-ingest` and `mirror-apply` handler entries under `src/platform/lambda-mirror.ts`
- `tests/mirror/{apply,verify,reseed}.test.ts`

**Build:**
- **Ingest:** verify the HMAC and the timestamp, dedupe on `batchId`, enqueue each call by
  `(first seq | atMs)`, then async-invoke the applier.
- **The applier, per §5.2 item 2:**
  - event-committing calls in strict seq order; the others by `atMs` between them;
  - each call decoded and run against the target `Store` (DynamoDB for `d1->ddb`, D1 for
    `ddb->d1`; platform-neutral), with replayed clocks;
  - outcome, seqs and clock-read counts compared;
  - a halt on any mismatch, raising `MIRROR_DIVERGED` with the kept record;
  - lag reported (applier lag p99).
- **`reseed.mjs <export.sqlite>`:** wipe, `importRows`, replay the queue from S+1, verify.
- **`daily-proof.mjs`:** pause the applier at a seq, export both sides, row for row over every
  non-ephemeral table, resume.
- **The reverse direction's D1-side receiver:** a Worker route `/__mirror`, HMAC-only, off unless
  `MIRROR_SECRET` is set, into the same `apply.ts`. This is a production runtime file; it ships
  dormant in T's or U's PR, coordinated by the main session.

**Gate:** tests on DynamoDB Local (port 18531):
- the recorded calls of the fuzzer's sequences (from L's fuzzer, recording D1) apply to a
  DynamoDB store and give byte-identical `exportRows`;
- a corrupted record halts the applier;
- a gap waits, then times out into reseed;
- the reverse direction applies into D1 and gives identical rows (LDB-MIR).

## Lane U (cutover modes, orchestrator, cutover PR plumbing)

**You own:**
- `src/core/cutover.ts`, and its single gate call in `src/index.ts`
- `src/core/errors.ts` `readOnly()` only
- `CHANGELOG-API.md` (its entry)
- `src/core/etag.ts` (`WIRE_VERSION` bump, with its comment)
- `scripts/cutover/{run,steps,proof}.mjs`
- `cutover/akldb.json`
- `design/lab/ci-cutover.patch` (the workflow job, which saltorbit commits)
- `tests/cutover/**`

**Build:**
- **The Worker modes**, read from D1 `import_state['cutover.mode']` with a 1 s cache per isolate:
  - **`read_only`:** non-GET/HEAD requests get `503 {"error":"read_only","message":…}` with
    `Retry-After`. The gate sits right after actor resolution, before idempotency and the rate
    limit. It is an additive error code: CHANGELOG-API entry and minor bump.
  - **`proxy`:** forward method, headers and body to `CUTOVER_PROXY_URL` (the `prod`
    CloudFront domain), returning the response as is.
- **The orchestrator `run.mjs --to aws|d1`:** exactly §5.2's steps 1-7, and the rollback's steps.
  - Each step logs, checks, and aborts or rolls back as §5.2 says.
  - It uses `CLOUDFLARE_DB_TOKEN`, the ops client, and the `akldb-ci` key from the `akldb-production` environment, which it uses to assume `akldb-cutover-role`. It uses
    nothing else.
  - **`--rehearse <worker-name>`** runs against the rehearsal Worker `akl-db-rehearsal` with its
    own D1, the `lab` or `staging` AWS stage, and the simulator writing throughout.
- **The CI job patch:** a job under `environment: akldb-production`, so only `main` can read the key, running on a change to `cutover/akldb.json` on `main`:
  1. run the standing checkpoint;
  2. run `run.mjs --to <primary>`;
  3. on failure, leave the mode as the orchestrator left it, and fail the job.

**Gate:**
- the full orchestrator against local stand-ins (a local D1 Worker in `wrangler dev`, DynamoDB
  Local, a local applier): pause measured and ≤ 30 s, both directions;
- every abort path tested (LDB-CUT);
- `p1-crawl-diff.mjs` byte-identical with the modes off.

The modes and the orchestrator are a production runtime PR, deployed dormant. The cutover PR
itself is the one-line `cutover/akldb.json` flip (plus `MirrorMode`), and the main session pushes
it only on saltorbit's go.

## Lane X (P6): rehearsals

**You own:** `scripts/cutover/rehearse.mjs`, `design/lab/cutover-rehearsals.md` (the log), and
`tests/cutover/rehearse.test.ts`.

**Build:** a driver that runs `run.mjs --rehearse` three times and the rollback once, against
`akl-db-rehearsal` plus the `staging` stage, with Q's simulator writing throughout. It records
the pause, each proof, and the full-proof diff. The main session runs it; you build and test it
locally against stand-ins.

**Gate (the P6 gate in aws-port.md §9):** three runs with a pause ≤ 30 s, a clean rollback, and
every proof clean.

## Lane F: the fuzzer gate on AWS

**You own:**
- `infra/fuzz.yaml`, `infra/fuzz.Dockerfile`
- `scripts/lab/fuzz/{task,aws-run,aggregate}.mjs`
- the `--from <i>` option in `scripts/lab/fuzz/fuzz.mjs` and `run.mjs` (lane L's files; L is
  merged)
- `tests/lab/fuzz-units.test.ts`

**Build design §4.3 "Running the fuzzer gate on AWS":**
- **`--from i`:** make sequence *i* of seed *s* a pure function of (s, i). If `run.mjs` derives
  sequences from a running RNG today, change it to derive each sequence's RNG from
  `hash(s, i)`. Prove the change with a test that runs a sequence alone and inside a range, and
  diffs the two transcripts.
- **The image:** Node 24 + Java 21 + the DynamoDB Local jar (copied from
  `/Users/dario/git/akl/handoff/dynamodb-local/`; no download inside the build) + the repo at a
  commit + `npm ci` for linux/arm64.
- **`task.mjs`:** the container entry. It starts DynamoDB Local, runs six fuzz lanes over its
  unit's range in parallel, writes the unit result JSON to `$RESULT_URL`, and exits 0 only when
  clean.
- **`aws-run.mjs`:** build, push, deploy `fuzz.yaml`, launch the units (Spot capacity provider
  first, with on-demand as a flag), poll, `--resume`.
- **`aggregate.mjs`:** the gate verdict, the missing units, and the first diffs.
- **The template** is per the design: a public subnet, no inbound, no NAT, a task role limited
  to `s3:PutObject` on the run prefix, logs kept 3 days, a 30-day bucket lifecycle, and an ECR
  lifecycle keeping two images. cfn-guard rules reject any NAT, VPC endpoint, inbound rule or
  wildcard action.

**Rules:** you never run `aws-run.mjs` or touch AWS. Test `task.mjs` locally:
`node scripts/lab/fuzz/task.mjs --seed 1 --from 0 --count 6 --result file:///tmp/x.json` on
DynamoDB Local at 18561. Test `aggregate.mjs` on fixture results.

**Ids:** LDB-FZ1…FZ9. **Port:** 18561, plus 18562-18574 for the six local lanes in the
`task.mjs` test.

**Gate:**
- typecheck clean;
- the `--from` determinism test passes;
- one local `task.mjs` unit of 6 sequences runs clean;
- `aggregate.mjs` passes on its fixtures;
- cfn-lint and cfn-guard pass.
