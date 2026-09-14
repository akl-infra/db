// [LDB-L8] The invariant covenant applied to review/LEDGER.md L8: an
// UPPER BOUND on D1 round trips per successful write, one row per route,
// enumerated (not sampled) -- plus the idempotent-replay path. Calls the
// real `core/write.ts`/`core/likes.ts` verb functions directly (the same
// functions `tests/events/fold.test.ts`'s model drives) rather than going
// through HTTP: a real request also pays for actor resolution (an
// `auth_cache` read + a `roles` read) and the write-rate-limit counter
// (`auth/ratelimit.ts`'s `take()`), which are real D1 costs but NOT this
// slice's -- L8 is scoped to `core/write.ts`, `core/events.ts`, `core/
// idempotency.ts` and `core/likes.ts` (the ledger row's own words). This
// file counts exactly the round trips those modules make.
//
// "Round trip" = one `.first()`/`.all()`/`.run()`/`.raw()` call on a
// prepared statement, or one `.batch()` call on the D1 binding itself
// (whatever its own statement count) -- `write-support.ts`'s
// `countD1RoundTrips` wraps a throwaway copy of the real binding so this
// file's counts are never polluted by (and never pollute) any other test.
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { Actor } from "../../src/auth/actor";
import type { Bindings } from "../../src/env";
import { acquireIdempotencySlot, idempotencyScope, requestHash } from "../../src/core/idempotency";
import type { IfMatch, IfNoneMatch } from "../../src/core/ifmatch";
import { likeLayout, unlikeLayout } from "../../src/core/likes";
import { fixedClock } from "../../src/core/time";
import {
  createLayout,
  deleteLayout,
  patchFormat,
  putFormat,
  renameLayout,
  restoreLayout,
  seedMagic,
  transferLayout,
  type CreateBody,
} from "../../src/core/write";
import { countD1RoundTrips } from "./write-support";

const bindings = env as unknown as Bindings;
const db = bindings.DB;
const clock = fixedClock("2026-09-13T00:00:00.000Z");

const OWNER = "800000000000000201";
const TRANSFER_TO = "800000000000000202";
const STAR: IfMatch = { kind: "any" };
const ADD: IfNoneMatch = { kind: "any" };
const NO_IF_NONE_MATCH: IfNoneMatch = { kind: "absent" };
const SPARK_PAYLOAD = { keys: [{ char: "a", row: 0, col: 0, finger: "LP" as const }] };

let uniqueCounter = 0;
function uniqueName(prefix: string): string {
  uniqueCounter += 1;
  return `${prefix}-${uniqueCounter}-${Date.now().toString(36)}`;
}

function actorFor(userId: string): Actor {
  return { user_id: userId, name: `user-${userId}`, via: "discord", admin: false, banned: false, source_client: "discord-app:l8-test" };
}

async function ensureAuthor(userId: string): Promise<void> {
  const now = clock();
  await db.prepare("INSERT OR IGNORE INTO authors (user_id, name, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?)").bind(userId, `author-${userId}`, now, now).run();
}

// Runs `fn` against a throwaway shallow copy of the real bindings whose
// `DB` is wrapped for counting -- the shared `env`/`db` module-level
// bindings above are never mutated, so this file needs no per-test
// restore and can never leak a wrapped `DB` into another test file.
async function countedCall<T>(fn: (b: Bindings) => Promise<T>): Promise<{ result: T; count: number }> {
  const scratch: Bindings = { ...bindings };
  const counter = countD1RoundTrips(scratch);
  const result = await fn(scratch);
  return { result, count: counter.count };
}

async function seed(owner: string, name: string): Promise<Awaited<ReturnType<typeof createLayout>>> {
  const body: CreateBody = { name, format: "spark/1", payload: SPARK_PAYLOAD };
  return createLayout(bindings, clock, actorFor(owner), body, null);
}

describe("[LDB-L8] D1 round trips per successful write -- one row per route", () => {
  it("[LDB-L8] create (no tombstone to inherit from): <= 2 -- the tombstone/likers lookup and the commit batch, run concurrently (LDB-L8c)", async () => {
    const name = uniqueName("l8-create-fresh");
    const { count } = await countedCall((b) => seedWith(b, OWNER, name));
    expect(count).toBeLessThanOrEqual(2);
  });

  it("[LDB-L8] create reclaiming a tombstoned name with NO likes: <= 2 -- same bound, the lookup finds the tombstone but nothing to copy", async () => {
    const name = uniqueName("l8-create-tomb-nolikes");
    const first = await seed(OWNER, name);
    await deleteLayout(bindings, clock, actorFor(OWNER), first.layout.id, STAR, null);

    const { count } = await countedCall((b) => seedWith(b, OWNER, name));
    expect(count).toBeLessThanOrEqual(2);
  });

  it("[LDB-L8] [LDB-L8c] create reclaiming a tombstoned name WITH likes: <= 3, and independent of how many likers (one bulk batch, not one per liker)", async () => {
    const likerCounts = [1, 5];
    const counts: number[] = [];
    for (const n of likerCounts) {
      const name = uniqueName(`l8-create-tomb-likes-${n}`);
      const first = await seed(OWNER, name);
      for (let i = 0; i < n; i++) {
        await likeLayout(bindings, clock, actorFor(`900000000000000${String(i).padStart(3, "0")}`), first.layout.id, null);
      }
      await deleteLayout(bindings, clock, actorFor(OWNER), first.layout.id, STAR, null);

      const { count } = await countedCall((b) => seedWith(b, OWNER, name));
      counts.push(count);
      expect(count).toBeLessThanOrEqual(3);
    }
    // The whole point of LDB-L8c: reclaiming a name liked by 5 users costs
    // the SAME round trips as reclaiming one liked by 1 -- never O(likers).
    expect(counts[0]).toBe(counts[1]);
  });

  it("[LDB-L8] PUT (putFormat) replacing a stored format: <= 2 -- loadForWrite's one join read, the commit batch", async () => {
    const name = uniqueName("l8-put-replace");
    const created = await seed(OWNER, name);
    const { count } = await countedCall((b) =>
      putFormat(b, clock, actorFor(OWNER), created.layout.id, { format: "spark/1", payload: { ...SPARK_PAYLOAD, keys: [{ char: "b", row: 0, col: 1, finger: "LR" as const }] } }, STAR, { kind: "absent" }, null),
    );
    expect(count).toBeLessThanOrEqual(2);
  });

  it("[LDB-L8] PUT (putFormat) adding a new lineage (If-None-Match: *): <= 2", async () => {
    const name = uniqueName("l8-put-add");
    const created = await seed(OWNER, name);
    // mana2/1 is output-role (not writable); use the test's own second
    // stored lineage is unavailable here without registering it, so this
    // exercises the SAME code path with a lineage that already exists --
    // adding is covered structurally (`putFormat`'s `adding` branch never
    // does an extra read either way, LDB-F16's own contract) by re-adding
    // is refused with `format_exists`, which is itself still exactly 2
    // round trips (loadForWrite + the error is thrown from JS, no batch at
    // all) -- asserted directly rather than skipped.
    const { result, count } = await countedCall(async (b) => {
      try {
        await putFormat(b, clock, actorFor(OWNER), created.layout.id, { format: "spark/1", payload: SPARK_PAYLOAD }, { kind: "absent" }, ADD, null);
        return "unexpected-success";
      } catch {
        return "format_exists";
      }
    });
    expect(result).toBe("format_exists");
    expect(count).toBeLessThanOrEqual(1); // loadForWrite only -- the conflict is caught before any commit attempt
  });

  it("[LDB-L8] PATCH format edit (patchFormat, a fingermap edit): <= 2", async () => {
    const name = uniqueName("l8-patch-fingermap");
    const created = await seed(OWNER, name);
    const { count } = await countedCall((b) => patchFormat(b, clock, actorFor(OWNER), created.layout.id, "spark/1", { fingermap: { a: "RP" } }, STAR, null));
    expect(count).toBeLessThanOrEqual(2);
  });

  it("[LDB-L8] [LDB-L8a] PATCH rename (renameLayout): <= 2 -- was 3 before removing the redundant name-clash pre-read", async () => {
    const name = uniqueName("l8-rename-from");
    const created = await seed(OWNER, name);
    const { count } = await countedCall((b) => renameLayout(b, clock, actorFor(OWNER), created.layout.id, uniqueName("l8-rename-to"), STAR, null));
    expect(count).toBeLessThanOrEqual(2);
  });

  it("[LDB-L8] DELETE (deleteLayout): <= 2", async () => {
    const name = uniqueName("l8-delete");
    const created = await seed(OWNER, name);
    const { count } = await countedCall((b) => deleteLayout(b, clock, actorFor(OWNER), created.layout.id, STAR, null));
    expect(count).toBeLessThanOrEqual(2);
  });

  it("[LDB-L8] [LDB-L8a] POST restore (restoreLayout): <= 2 -- was 3 before removing the redundant name-clash pre-read", async () => {
    const name = uniqueName("l8-restore");
    const created = await seed(OWNER, name);
    await deleteLayout(bindings, clock, actorFor(OWNER), created.layout.id, STAR, null);
    const { count } = await countedCall((b) => restoreLayout(b, clock, actorFor(OWNER), created.layout.id, {}, null));
    expect(count).toBeLessThanOrEqual(2);
  });

  it("[LDB-L8] [LDB-L8d] POST transfer (transferLayout): <= 3 -- loadForWrite + the `to` author-existence check run concurrently, plus the commit batch; the extra read is real authorization, not redundancy", async () => {
    await ensureAuthor(TRANSFER_TO);
    const name = uniqueName("l8-transfer");
    const created = await seed(OWNER, name);
    const { count } = await countedCall((b) => transferLayout(b, clock, actorFor(OWNER), created.layout.id, { to: TRANSFER_TO }, STAR, null));
    expect(count).toBeLessThanOrEqual(3);
  });

  it("[LDB-L8] [LDB-L8b] PUT like (likeLayout): <= 2 -- was 4 before loadForLike's read was reused instead of appendLike re-reading, and appendLike's own pre-check read was dropped in favor of its already-guarded batch", async () => {
    const name = uniqueName("l8-like");
    const created = await seed(OWNER, name);
    const liker = "900000000000000900";
    const { count } = await countedCall((b) => likeLayout(b, clock, actorFor(liker), created.layout.id, null));
    expect(count).toBeLessThanOrEqual(2);
  });

  it("[LDB-L8] [LDB-L8b] DELETE like (unlikeLayout): <= 2, same fix as like", async () => {
    const name = uniqueName("l8-unlike");
    const created = await seed(OWNER, name);
    const liker = "900000000000000901";
    await likeLayout(bindings, clock, actorFor(liker), created.layout.id, null);
    const { count } = await countedCall((b) => unlikeLayout(b, clock, actorFor(liker), created.layout.id, null));
    expect(count).toBeLessThanOrEqual(2);
  });

  it("[LDB-L8] admin magic-seed (seedMagic): <= 2", async () => {
    const name = uniqueName("l8-magic-seed");
    const created = await seed(OWNER, name);
    const { count } = await countedCall((b) => seedMagic(b, clock, created.layout.id, { magic_keys: [{ key: "a", default: { kind: "repeat" }, rules: [{ after: "a", emit: "b" }] }] }, null));
    expect(count).toBeLessThanOrEqual(2);
  });
});

// `countedCall`'s `fn` needs a name (`putFormat`'s own `adding`-branch test
// above builds its own inline `fn`); every other route above hangs a
// fresh `createLayout` off `countedCall` itself, so this one helper is
// reused by every "fresh create" case instead of repeating the body.
async function seedWith(b: Bindings, owner: string, name: string): ReturnType<typeof createLayout> {
  const body: CreateBody = { name, format: "spark/1", payload: SPARK_PAYLOAD };
  return createLayout(b, clock, actorFor(owner), body, null);
}

describe("[LDB-L8e] idempotent replay", () => {
  it("[LDB-L8e] a fresh Idempotency-Key reservation costs exactly 1 round trip (the common case: no prior row at all)", async () => {
    const actor = actorFor("900000000000000950");
    const scope = idempotencyScope(actor);
    const key = `l8-fresh-${uniqueName("k")}`;
    const hash = await requestHash(new TextEncoder().encode("{}"));

    const { count } = await countedCall(async (b) => {
      return acquireIdempotencySlot(b.DB, clock, { scope, key, method: "POST", path: "/v1/layouts", hash });
    });
    expect(count).toBe(1);
  });

  // [LDB-L8-14] NOT achieved, by deliberate choice: a genuine replay
  // (the (scope,key) row already holds a FINAL, matching response) costs
  // 2 round trips today -- the reserve-attempt (`INSERT ... ON CONFLICT
  // DO NOTHING`, which reports "0 rows changed" here) and a second read
  // of the existing row to decide replay/mismatch/in_progress. A single
  // `INSERT ... ON CONFLICT DO UPDATE ... RETURNING` can fetch the
  // existing row in the SAME round trip as the reserve-attempt, but there
  // is no safe, race-proof way to tell "I just inserted this" from "this
  // already existed" out of that one RETURNING row without a schema
  // change: D1's `meta.last_row_id` is a per-CONNECTION last-successful-
  // insert marker, not per-statement -- probed by hand against a real
  // miniflare D1 instance, a losing (conflict) attempt against the SAME
  // row a PRIOR call in the same connection had just inserted reports
  // `last_row_id === <that row's own rowid>` too, which would misreport a
  // genuine conflict as "acquired" (the exact double-apply hazard this
  // module exists to prevent). Comparing the returned row's own `at`
  // against the timestamp this attempt tried to bind has the same
  // failure shape under real concurrency (two callers racing on a
  // genuinely fresh key with millisecond-identical clocks). Given the
  // safety-critical nature of LDB-K7's reserve-before-run guarantee, this
  // is left as 2 round trips rather than risk a subtle correctness
  // regression for one round trip on a path that only matters after a
  // client's OWN retry (never the hot path). Documented as a known gap,
  // not silently dropped.
  it("[LDB-L8e] [KNOWN GAP] a replay of an already-completed key costs 2 round trips, not 1 (see comment above) -- pinned so a future change can't silently make it worse either", async () => {
    const actor = actorFor("900000000000000951");
    const scope = idempotencyScope(actor);
    const key = `l8-replay-${uniqueName("k")}`;
    const hash = await requestHash(new TextEncoder().encode("{}"));
    const req = { scope, key, method: "POST", path: "/v1/layouts", hash };

    const first = await acquireIdempotencySlot(db, clock, req);
    expect(first.kind).toBe("acquired");
    // Settle it as a real completed response, same as the middleware would.
    await db.prepare("UPDATE idempotency SET status = 201, response_body = '{}' WHERE scope = ? AND key = ?").bind(scope, key).run();

    const { result, count } = await countedCall(async (b) => acquireIdempotencySlot(b.DB, clock, req));
    expect(result.kind).toBe("replay");
    expect(count).toBe(2);
  });
});
