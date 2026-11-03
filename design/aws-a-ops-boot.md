# akldb on AWS, design A: phase B ops (boot, snapshots, nightly jobs)

Companion to `design/aws-a-ops.md` (stacks, deploy, secrets). Everything here is `src/replica/`; the invariants are LDB-RP1..RP10
in `INVARIANTS.md`.

## What lives where

| Thing | Where | Written by |
|---|---|---|
| Commit log | DynamoDB `akldb-<stage>-log`, `LOG/<seq:12>` items (+ `HEAD/HEAD`) | every write |
| Spilled log bodies (> 300,000 bytes) | S3 `log/<unitId>.json.zst` | the append that needs it |
| Rolling snapshot | S3 `snap/slot-0..3.sqlite.zst`; items `SNAP/POINTER`, `SNAP/PREV` | the 5-minute tick |
| Daily snapshot | S3 `snap/daily/00..39.sqlite.zst` (one per UTC day, 40 slots, overwritten after 40 days); items `SNAP/DAILY#nn` | the nightly job |
| Retention mark, nightly claim | items `SNAP/EXPIRED`, `SNAP/NIGHTLY` | the nightly job |

Slots rotate by overwrite because the replica layer has no general delete (five AWS calls plus list/delete for `log/*` only). The
bucket keeps overwritten versions 35 days.

## Boot path

A cold container, at module load: `GetItem SNAP/POINTER` starts the S3 GET of that snapshot; the log head and the tail after it
are read beside the GET; the image is checked (size, sha256, object metadata), deserialized, the prefetched tail applied, and a
final strong head read must find nothing left. Nothing is served before that (RP2). Then one read-only `GET /v1/meta` warms the
app (no origin check, no SSM, never appends).

Fallbacks, in order, each taken one `akldb-alarm: boot: fallback: ...` line:

1. **POINTER** (the newest rolling snapshot)
2. **PREV** (the one before it)
3. **the newest daily snapshot that verifies**, plus its tail (each unusable daily falls to the next older)
4. **replay the whole log from seq 0** (only while the log still starts at seq 1: after retention it does not)

A snapshot is unusable when its object is missing or fails to download, does not decompress, has the wrong size or sha256, the
pointer is ahead of the log, or the log tail does not replay on it. A log read failure (DynamoDB down) is not a fallback: the boot
fails and the handler retries once. When all four fail the boot throws and logs `akldb-alarm: boot: no usable path: ...`.

The info line of a successful boot: `akldb-boot: path=pointer|prev|daily|replay snapshot=<key> snapshotSeq=N seq=N replayed=N [fallbacks=[...]]`.

## Log prefixes

| Prefix | Meaning |
|---|---|
| `akldb-alarm: <component>: <message>` | **a failure**; the metric filter and alarm sit on exactly this prefix. One event, one line. Components: `boot`, `snapshot`, `retention`, `proof`, `nightly`, `replica` |
| `akldb-boot:` | a boot finished: which path, the seq, how many entries were replayed |
| `akldb-snapshot:` | a snapshot was written: kind, seq, key, raw and compressed size, `zstd=<level> compressMs=<ms>`, pointer outcome |
| `akldb-retention:` | retention ran: boundary, entries marked, `spillsDeleted` |
| `akldb-proof: ok seq=N digest=... base=<key>@<seq>` | the nightly proof passed |
| `akldb-restore:` | `restoreAt` skipped an unusable snapshot (manual restores only) |

What each alarm means and what to do:

- `boot: fallback: pointer|prev|daily <key> unusable: <why>`: a snapshot could not be used; the container still booted, slower.
  Look at `<why>`. A damaged or missing object: the next tick writes a fresh rolling snapshot and moves POINTER. Repeated `daily`
  fallbacks mean POINTER and PREV are both bad: check the tick (`snapshot:` alarms).
- `boot: no usable path`: the stack cannot boot. The log no longer starts at seq 1 and no snapshot verifies. Restore: copy a
  noncurrent S3 version of a snapshot object (bucket versioning keeps overwritten ones 35 days) or find the damage with `restore-at.mjs --list`.
- `snapshot: rolling snapshot failed` / `daily snapshot failed`: upload, read-back verification or the pointer write failed;
  the pointer did not move (RP1). The next tick retries the rolling one; the nightly job retries after its lease.
- `retention: daily snapshot <key> (seq N) is unverified`: that daily slot does not read back (damaged or overwritten without its
  index entry). It only narrows what may expire. Rewrite it by running the nightly job after the lease, or wait for its slot to rotate.
- `retention: log retention failed` / `proof: nightly proof failed: ... digest ... !=`: **the proof mismatch is the serious one**:
  the live replica's database differs from what the log produces. Do not deploy; keep the log and snapshots (`restore-at.mjs`
  at the seq in the message gives the log's version to diff against the live database).
- `replica: halted at seq N: ReplicaDivergedError`: a replica's replay disagreed with the writer's changeset hash. The container
  reboots from a snapshot on its next invocation; if it repeats on a fresh container, treat it like a proof mismatch.
- `nightly: could not start the nightly job`: the tick could not invoke `JOBS_FUNCTION` (permission, name). The next tick retries.

## The tick and the nightly job

The 5-minute tick (35 s timeout) does the Worker's scheduled jobs and the **rolling snapshot** (50 units or an hour since POINTER;
about 3 s of compression for a 45 MB image at level 12). From 03:00 UTC, while no daily snapshot carries today's date, it also
**starts the nightly job**: an asynchronous invoke (`InvocationType: Event`) of the function named by `JOBS_FUNCTION` with
`{"akldb":"nightly"}`. With `JOBS_FUNCTION` unset (tests, a local stack) the tick runs it inline.

The nightly job (its own function, 600 s timeout, same bundle) claims the UTC day (an 11-minute lease in `SNAP/NIGHTLY`, so the
repeating ticks cannot run it twice: a second start answers `busy`), then:

1. writes today's daily snapshot if it is missing;
2. finds the oldest daily snapshot that verifies (one alarm per unverified slot);
3. **retention**: marks log entries up to that snapshot's seq for DynamoDB TTL, but only once it is 35 days old, and deletes `log/*`
   objects older than the oldest kept entry (less 3 days of grace for DynamoDB's lazy TTL), orphans of lost appends included;
4. **the nightly proof**: rebuilds a replica from that snapshot plus the log to the live seq and compares database images; a
   mismatch throws.

Run it by hand: invoke the jobs function with `{"akldb":"nightly"}` (synchronously, to see the result). Inside the lease it answers
`busy`. After the lease it skips the daily snapshot that exists and redoes retention and the proof.

Needs from the stack: the jobs function (600 s) with `LOG_TABLE`, `DATA_BUCKET`, `STAGE`, `SSM_PREFIX` as the API function; the API
function's role allowed `lambda:InvokeFunction` on the jobs function; both roles `s3:GetObject/PutObject/DeleteObject` on `log/*`
and `s3:ListBucket` (delete and list only ever touch `log/`; the code refuses any other prefix), `GetObject/PutObject` on `snap/*`;
DynamoDB GetItem, Query, PutItem/UpdateItem (TransactWriteItems). A metric filter on `"akldb-alarm: "` on both log groups.

## Point-in-time restore by hand

`restoreAt(k)` (src/replica/proof.ts): the newest verified snapshot at or below seq `k`, then the log to exactly `k`. It equals a
replay from 0 to `k` (RP3), for any `k` in the last 35 days.

```sh
aws-vault exec akldb -- node scripts/lab/restore-at.mjs --list --table akldb-prod-log --bucket akldb-prod-data-<account>
aws-vault exec akldb -- node scripts/lab/restore-at.mjs --seq 123456 --out /tmp/akldb-at-123456.sqlite \
    --table akldb-prod-log --bucket akldb-prod-data-<account>
sqlite3 /tmp/akldb-at-123456.sqlite 'select seq, kind, layout_id from events order by seq desc limit 5'
```

It only reads (log table, bucket) and writes the local file. Each log entry is a unit; map a time to a seq with the events table
(`events.seq` and `events.at` are the public feed, which is a different counter from the log seq) or by the unit ids in the log (ULIDs
carry their time). A `k` older than the oldest retained daily snapshot (about 40 days) cannot be restored.

## The zstd knob

Snapshots are zstd level 12 by default. `SNAPSHOT_ZSTD_LEVEL` on the API function changes it for the rolling snapshots; the nightly job
reads the same variable if it is set there. Measured on a synthetic 45 MB database (`node scripts/lab/boot-bench.mjs`, a loaded
Mac): level 19 took 24.5 s (5.81 MB), 15 took 11.7 s, 12 took 2.8 s (6.60 MB), 9 took 1.2 s, 3 took 0.27 s (7.64 MB). Decompression, which
a cold start pays, is 40-70 ms at every level. Read `compressMs` in the `akldb-snapshot:` lines before changing it.
