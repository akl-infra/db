// [LDB-I15] [LDB-I16] [LDB-I17] The cmini import's author names
// (src/import/authors.ts): one deterministic, stable name per id, however
// many names upstream's `/authors` lists for it and in whatever order.
// Pure properties over generated alias maps (order independence,
// idempotence, convergence, precedence), the same properties against real
// D1 through `applyAuthors`, a full `tick()` over the upstream-100 fixture,
// both auth lanes, the compare-and-set race, dump -> restore, and
// migration 0006's backfill.
import { env } from "cloudflare:test";
import fc from "fast-check";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { verifyClientRequest } from "../../src/auth/client";
import { resolveBearer } from "../../src/auth/discord";
import { fixedClock } from "../../src/core/time";
import { restoreInto } from "../../src/dump/restore";
import { buildDump, type AuthorDbRow } from "../../src/dump/write";
import type { Bindings } from "../../src/env";
import { applyAuthors } from "../../src/import/apply";
import {
  compareCodePoints,
  foldAuthorWrites,
  NAME_SOURCES,
  namesById,
  planAuthorNames,
  preferredName,
  readStoredAuthors,
  writeAuthorNames,
  type NameSource,
  type StoredAuthor,
} from "../../src/import/authors";
import { tick } from "../../src/import/cmini";
import { generateKeyPair, seedClient, signHeaders } from "../auth/client-support";
import { FakeDiscord } from "../auth/fake-discord";
import { FakeUpstream } from "./fake-upstream";

type Upstream = Record<string, string>;
type Entries = readonly (readonly [string, string])[];

const bindings = env as unknown as Bindings & { TEST_MIGRATIONS: { name: string; queries: string[] }[] };
const db = bindings.DB;
const DISCORD_URL = "https://fake-discord.example/api";

// The id the 2026-09-11 churn was measured on.
const VALORANCE = "657688933001330718";
const VALORANCE_NAMES: Upstream = { Valorance: VALORANCE, va1orance: VALORANCE, val0rance: VALORANCE };

const T0 = "2026-09-11T00:00:00.000Z";
const T1 = "2026-09-11T01:00:00.000Z";
const T2 = "2026-09-11T02:00:00.000Z";
const T3 = "2026-09-11T03:00:00.000Z";
const T4 = "2026-09-11T04:00:00.000Z";
const T5 = "2026-09-11T05:00:00.000Z";
const T6 = "2026-09-11T06:00:00.000Z";

// --- generators -------------------------------------------------------

const ID_POOL = [
  "100000000000000001",
  "100000000000000002",
  "100000000000000003",
  "100000000000000004",
  "100000000000000005",
  VALORANCE,
] as const;
const [ID_A, ID_B, ID_C, ID_D] = ID_POOL;

// Look-alikes, case pairs, and the pair where code-point order and JS's
// UTF-16 code-unit order disagree (U+E000 vs an astral character), mixed
// with arbitrary well-formed strings.
const NAME_POOL = ["Valorance", "va1orance", "val0rance", "valorance", "Eve", "_e.v.e_", "lilith.eve", "Oxey", "oxey_", "a", "B", "ß", "\uE000", "\u{1F600}"];

function wellFormed(s: string): boolean {
  return new TextDecoder().decode(new TextEncoder().encode(s)) === s;
}

const nameArb = fc.oneof(fc.constantFrom(...NAME_POOL), fc.string({ minLength: 1, maxLength: 5, unit: "binary" }).filter(wellFormed));
const idArb = fc.constantFrom(...ID_POOL);
const sourceArb = fc.constantFrom<NameSource>(...NAME_SOURCES);

// Upstream's `/authors` as entries: unique names, several names per id.
const entriesArb = fc.uniqueArray(fc.tuple(nameArb, idArb), { selector: ([name]) => name, maxLength: 14 });

// Those entries plus 1-4 listings of the same content, each in its own
// order -- upstream's key order is exactly what must never matter.
const listingsArb = entriesArb.chain((entries) =>
  fc.tuple(
    fc.constant(entries),
    fc.array(fc.shuffledSubarray(entries, { minLength: entries.length, maxLength: entries.length }), { minLength: 1, maxLength: 4 }),
  ),
);

// A starting table: any subset of ids, each holding an arbitrary name, a
// pool name (so "already one of upstream's names" comes up often), or the
// id itself (the client lane's placeholder), from any source.
const storedArb = fc
  .uniqueArray(fc.tuple(idArb, fc.option(nameArb, { nil: null }), sourceArb), { selector: ([id]) => id, maxLength: ID_POOL.length })
  .map((rows) => new Map<string, StoredAuthor>(rows.map(([id, name, source]) => [id, { name: name ?? id, source }])));

function asUpstream(entries: Entries): Upstream {
  return Object.fromEntries(entries);
}

function utf8Compare(a: string, b: string): number {
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) return x[i]! - y[i]!;
  return x.length - y.length;
}

function sortedRows(map: ReadonlyMap<string, StoredAuthor>): [string, StoredAuthor][] {
  return [...map].sort(([a], [b]) => compareCodePoints(a, b));
}

// --- D1 helpers ---------------------------------------------------------

interface Row {
  user_id: string;
  name: string;
  name_source: string;
  first_seen_at: string;
  last_seen_at: string;
}

async function snapshot(): Promise<Row[]> {
  const { results } = await db
    .prepare("SELECT user_id, name, name_source, first_seen_at, last_seen_at FROM authors ORDER BY user_id")
    .all<Row>();
  return results;
}

async function row(userId: string): Promise<Row | undefined> {
  return (await snapshot()).find((r) => r.user_id === userId);
}

// The exact query `/v1/meta` (src/index.ts) and the dump's own meta
// (src/dump/write.ts) derive `authors_modified_at` from. Read straight
// from D1 rather than through `GET /v1/meta`: that route's ETag is the
// event head alone, and an author-only change never moves it, so a
// second fetch at the same head could be answered from `caches.default`
// and pass vacuously.
async function authorsModifiedAt(): Promise<string | null> {
  const r = await db.prepare("SELECT MAX(last_seen_at) AS modified FROM authors").first<{ modified: string | null }>();
  return r?.modified ?? null;
}

async function seedAuthors(stored: ReadonlyMap<string, StoredAuthor>, at: string): Promise<void> {
  await db.prepare("DELETE FROM authors").run();
  if (stored.size === 0) return;
  await db.batch(
    [...stored].map(([id, r]) =>
      db
        .prepare("INSERT INTO authors (user_id, name, first_seen_at, last_seen_at, name_source) VALUES (?, ?, ?, ?, ?)")
        .bind(id, r.name, at, at, r.source),
    ),
  );
}

// vitest-pool-workers isolates storage per FILE, not per `it`.
beforeEach(async () => {
  await db.batch([db.prepare("DELETE FROM authors"), db.prepare("DELETE FROM auth_cache")]);
});

// --- the rule, pure -------------------------------------------------------

describe("[LDB-I15] [LDB-I16] [LDB-I17] the name rule (pure)", () => {
  it("[LDB-I15] compareCodePoints is UTF-8 byte order, not UTF-16 code-unit order", () => {
    fc.assert(fc.property(nameArb, nameArb, (a, b) => Math.sign(compareCodePoints(a, b)) === Math.sign(utf8Compare(a, b))));
    // the pair the two orders disagree on
    expect(compareCodePoints("\u{1F600}", "\uE000")).toBeGreaterThan(0);
    expect("\u{1F600}" < "\uE000").toBe(true);
  });

  it("[LDB-I15] preferredName is the code-point-greatest name, in any listing order", () => {
    const namesAndShuffle = fc
      .uniqueArray(nameArb, { minLength: 1, maxLength: 8 })
      .chain((ns) => fc.tuple(fc.constant(ns), fc.shuffledSubarray(ns, { minLength: ns.length, maxLength: ns.length })));
    fc.assert(
      fc.property(namesAndShuffle, ([names, shuffled]) => {
        const best = preferredName(names);
        expect(preferredName(shuffled)).toBe(best);
        expect(names).toContain(best);
        for (const n of names) expect(compareCodePoints(n, best)).toBeLessThanOrEqual(0);
      }),
    );
    expect(preferredName(["Valorance", "va1orance", "val0rance"])).toBe("val0rance");
  });

  it("[LDB-I15] on a byte-sorted /authors (Go's encoding/json order) a fresh import stores exactly what the old last-write-wins applier ended on", () => {
    fc.assert(
      fc.property(entriesArb, (entries) => {
        const wire = [...entries].sort(([a], [b]) => utf8Compare(a, b));
        const old = new Map<string, string>();
        for (const [name, id] of wire) old.set(id, name); // the old applier: every differing name rewrote the row
        const fresh = foldAuthorWrites(new Map(), planAuthorNames(asUpstream(entries), new Map()));
        expect(sortedRows(fresh).map(([id, r]) => [id, r.name])).toEqual([...old].sort(([a], [b]) => compareCodePoints(a, b)));
      }),
    );
  });

  it("[LDB-I15] the plan depends only on upstream's content, never its listing order", () => {
    fc.assert(
      fc.property(storedArb, listingsArb, (stored, [entries, listings]) => {
        const base = planAuthorNames(asUpstream(entries), stored);
        for (const listing of listings) expect(planAuthorNames(asUpstream(listing), stored)).toEqual(base);
      }),
    );
  });

  it("[LDB-I15] idempotence: after one pass, a pass over the same upstream (any listing order) plans nothing", () => {
    fc.assert(
      fc.property(storedArb, listingsArb, (stored, [entries, listings]) => {
        const after = foldAuthorWrites(stored, planAuthorNames(asUpstream(entries), stored));
        for (const listing of listings) expect(planAuthorNames(asUpstream(listing), after)).toEqual([]);
      }),
    );
  });

  it("[LDB-I15] [LDB-I17] outcome: user-lane rows and unlisted ids are untouched, a listed name is kept, every other listed id ends on preferredName", () => {
    fc.assert(
      fc.property(storedArb, entriesArb, (stored, entries) => {
        const upstream = asUpstream(entries);
        const listed = namesById(upstream);
        const writes = planAuthorNames(upstream, stored);
        const after = foldAuthorWrites(stored, writes);

        for (const w of writes) {
          const before = stored.get(w.userId);
          if (w.kind === "insert") expect(before).toBeUndefined();
          else expect(before?.source).not.toBe("user");
        }
        for (const [id, before] of stored) {
          const names = listed.get(id);
          if (names === undefined || before.source === "user" || names.includes(before.name)) {
            expect(after.get(id)).toEqual(before);
          }
        }
        for (const [id, names] of listed) {
          const before = stored.get(id);
          if (before?.source === "user") continue;
          if (before !== undefined && names.includes(before.name)) continue;
          expect(after.get(id)).toEqual({ name: preferredName(names), source: "import" });
        }
      }),
    );
  });

  it("[LDB-I16] convergence: any sequence of passes, in any listing orders, changes each id's stored name at most once", () => {
    fc.assert(
      fc.property(storedArb, listingsArb, (stored, [, listings]) => {
        let state: Map<string, StoredAuthor> = new Map(stored);
        const changes = new Map<string, number>();
        for (const listing of [...listings, ...listings]) {
          const next = foldAuthorWrites(state, planAuthorNames(asUpstream(listing), state));
          for (const [id, r] of next) if (state.get(id)?.name !== r.name) changes.set(id, (changes.get(id) ?? 0) + 1);
          state = next;
        }
        for (const n of changes.values()) expect(n).toBeLessThanOrEqual(1);
      }),
    );
  });

  it("[LDB-I15] [LDB-I16] [LDB-I17] regression 2026-09-11: 657688933001330718 (Valorance / va1orance / val0rance) settles at most once, then never moves", () => {
    const cases: [StoredAuthor | undefined, string][] = [
      [undefined, "val0rance"], // a fresh id: preferredName
      [{ name: "Valorance", source: "import" }, "Valorance"], // any listed name is kept
      [{ name: "va1orance", source: "import" }, "va1orance"],
      [{ name: VALORANCE, source: "client" }, "val0rance"], // the client lane's placeholder is replaced
      [{ name: "Valiant", source: "user" }, "Valiant"], // the user lane's name wins
      [{ name: "valorance_old", source: "import" }, "val0rance"], // a name upstream no longer lists
    ];
    const orders = [
      ["val0rance", "Valorance", "va1orance"],
      ["va1orance", "val0rance", "Valorance"],
      ["Valorance", "va1orance", "val0rance"],
    ];
    for (const [before, want] of cases) {
      const stored = new Map<string, StoredAuthor>(before === undefined ? [] : [[VALORANCE, before]]);
      const state = foldAuthorWrites(stored, planAuthorNames(VALORANCE_NAMES, stored));
      expect(state.get(VALORANCE)?.name).toBe(want);
      for (const order of orders) {
        expect(planAuthorNames(Object.fromEntries(order.map((n) => [n, VALORANCE])), state)).toEqual([]);
      }
    }
  });
});

// --- the same, against real D1 ---------------------------------------------

describe("[LDB-I15] [LDB-I16] applyAuthors against real D1", () => {
  it("[LDB-I15] the same upstream authors twice: the second pass leaves the table and authors_modified_at unchanged; the first equals the pure fold and moves last_seen_at only on a real change", async () => {
    await fc.assert(
      fc.asyncProperty(storedArb, listingsArb, async (stored, [entries, listings]) => {
        await seedAuthors(stored, T0);
        const upstream = asUpstream(entries);
        const expected = foldAuthorWrites(stored, planAuthorNames(upstream, stored));

        await applyAuthors(db, fixedClock(T1), upstream);
        const first = await snapshot();
        expect(first.map((r) => [r.user_id, { name: r.name, source: r.name_source }])).toEqual(sortedRows(expected));
        for (const r of first) {
          const before = stored.get(r.user_id);
          const changed = before === undefined || before.name !== r.name;
          expect(r.last_seen_at).toBe(changed ? T1 : T0);
          expect(r.first_seen_at).toBe(before === undefined ? T1 : T0);
        }

        const modified = await authorsModifiedAt();
        for (const listing of listings) {
          await applyAuthors(db, fixedClock(T2), asUpstream(listing));
          expect(await snapshot()).toEqual(first);
          expect(await authorsModifiedAt()).toBe(modified);
        }
      }),
      { numRuns: 25 },
    );
  });

  it("[LDB-I16] passes in shifting listing orders, each at a later time: each stored name changes at most once", async () => {
    await fc.assert(
      fc.asyncProperty(storedArb, listingsArb, async (stored, [, listings]) => {
        await seedAuthors(stored, T0);
        const changes = new Map<string, number>();
        let prev = new Map([...stored].map(([id, r]) => [id, r.name]));
        const passes = [...listings, ...listings];
        for (let i = 0; i < passes.length; i++) {
          const at = new Date(Date.UTC(2026, 8, 11, 1 + i)).toISOString();
          await applyAuthors(db, fixedClock(at), asUpstream(passes[i]!));
          const now = new Map((await snapshot()).map((r) => [r.user_id, r.name]));
          for (const [id, name] of now) if (prev.get(id) !== name) changes.set(id, (changes.get(id) ?? 0) + 1);
          prev = now;
        }
        for (const n of changes.values()) expect(n).toBeLessThanOrEqual(1);
      }),
      { numRuns: 20 },
    );
  });

  it("[LDB-I15] [LDB-I16] tick(): a later non-quiet tick over the same /authors, listed in reverse, writes no author row and leaves authors_modified_at where it was", async () => {
    await db.batch([
      db.prepare("DELETE FROM events"),
      db.prepare("DELETE FROM layout_revs"),
      db.prepare("DELETE FROM likes"),
      db.prepare("DELETE FROM layouts"),
      db.prepare("DELETE FROM authors"),
      db.prepare("DELETE FROM import_map"),
      db.prepare("DELETE FROM import_state"),
    ]);
    const fake = new FakeUpstream();
    fake.setAuthors({ ...fake.authors(), ...VALORANCE_NAMES });

    const first = await tick(bindings, fixedClock(T1), fake.fetchImpl, fake.sleepImpl);
    expect(first.quiet).toBe(false);
    const rows = await snapshot();
    expect(rows.find((r) => r.user_id === VALORANCE)?.name).toBe("val0rance");
    for (const [id, names] of namesById(fake.authors())) {
      expect(rows.find((r) => r.user_id === id)?.name, id).toBe(preferredName(names));
    }
    const modified = (await buildDump(bindings, fixedClock(T1))).meta.authors_modified_at;
    expect(modified).toBe(T1);

    fake.setAuthors(Object.fromEntries(Object.entries(fake.authors()).reverse()));
    fake.bumpMeta(); // the gate opens again; nothing changed upstream but the listing order
    const second = await tick(bindings, fixedClock(T2), fake.fetchImpl, fake.sleepImpl);
    expect(second.quiet).toBe(false);
    expect(await snapshot()).toEqual(rows);
    expect((await buildDump(bindings, fixedClock(T2))).meta.authors_modified_at).toBe(modified);
  });
});

// --- precedence across the lanes -------------------------------------------

describe("[LDB-I17] precedence across the three writers of authors.name", () => {
  const CLIENT_ID = "01AUTH0RSNAMETESTC11ENT000";
  let privateKey: CryptoKey;
  let tokenCounter = 0;

  beforeAll(async () => {
    const pair = await generateKeyPair();
    privateKey = pair.privateKey;
    await seedClient(db, fixedClock(T0), {
      id: CLIENT_ID,
      pubkeyB64url: pair.pubkeyB64url,
      ownerUserId: "184412255822020608",
      caps: "act-as-user",
    });
  });

  // The user lane: a fresh token every call, so `resolveBearer` always
  // takes the cache-miss path (the one that upserts `authors`).
  async function userLane(userId: string, name: string, at: string): Promise<void> {
    const fake = new FakeDiscord();
    const token = `tok-authors-${tokenCounter++}`;
    fake.setAnswer(token, { kind: "ok", id: userId, username: name.toLowerCase(), global_name: name });
    await resolveBearer(db, fixedClock(at), token, fake.fetchImpl, DISCORD_URL);
  }

  // The client lane: a real Ed25519-signed request, verified end to end.
  async function clientLane(userId: string, at: string): Promise<string> {
    const headers = await signHeaders({
      privateKey,
      clientId: CLIENT_ID,
      actor: userId,
      method: "POST",
      pathWithQuery: "/v1/layouts",
      timestamp: Math.floor(new Date(at).getTime() / 1000),
    });
    const request = new Request("https://example.com/v1/layouts", { method: "POST", headers });
    const actor = await verifyClientRequest(db, fixedClock(at), request, new Uint8Array(0), {});
    return actor.name;
  }

  it("[LDB-I17] a user-lane name is never overwritten by the import, whether the import saw the id before or after the user signed in", async () => {
    await userLane(VALORANCE, "Valiant", T0);
    expect(await row(VALORANCE)).toMatchObject({ name: "Valiant", name_source: "user", last_seen_at: T0 });
    await applyAuthors(db, fixedClock(T1), VALORANCE_NAMES);
    expect(await row(VALORANCE)).toMatchObject({ name: "Valiant", name_source: "user", last_seen_at: T0 });

    const oxey = { Oxey: ID_A, oxey_: ID_A };
    await applyAuthors(db, fixedClock(T1), oxey);
    expect(await row(ID_A)).toMatchObject({ name: "oxey_", name_source: "import", last_seen_at: T1 });
    await userLane(ID_A, "Oxford", T2);
    expect(await row(ID_A)).toMatchObject({ name: "Oxford", name_source: "user", last_seen_at: T2 });
    await applyAuthors(db, fixedClock(T3), oxey);
    expect(await row(ID_A)).toMatchObject({ name: "Oxford", name_source: "user", last_seen_at: T2 });
  });

  it("[LDB-I17] the client lane sets name = id only on first sight; the import replaces that placeholder once; the client lane never touches the name afterwards", async () => {
    expect(await clientLane(VALORANCE, T0)).toBe(VALORANCE);
    expect(await row(VALORANCE)).toMatchObject({ name: VALORANCE, name_source: "client", first_seen_at: T0 });

    await applyAuthors(db, fixedClock(T1), VALORANCE_NAMES);
    expect(await row(VALORANCE)).toMatchObject({ name: "val0rance", name_source: "import", last_seen_at: T1 });

    expect(await clientLane(VALORANCE, T2)).toBe("val0rance");
    expect(await row(VALORANCE)).toMatchObject({ name: "val0rance", name_source: "import", last_seen_at: T2 });

    await applyAuthors(db, fixedClock(T3), VALORANCE_NAMES);
    expect(await row(VALORANCE)).toMatchObject({ name: "val0rance", name_source: "import", last_seen_at: T2 });

    // A real name through the user lane then beats both: the client lane
    // leaves it alone, and so does the import.
    await userLane(VALORANCE, "Valiant", T4);
    expect(await clientLane(VALORANCE, T5)).toBe("Valiant");
    await applyAuthors(db, fixedClock(T6), VALORANCE_NAMES);
    expect(await row(VALORANCE)).toMatchObject({ name: "Valiant", name_source: "user", last_seen_at: T5 });
  });

  it("[LDB-I17] the import's writes are compare-and-set: a lane write between the import's read and its write is never clobbered", async () => {
    // Rename race: planned from a read that predates the user lane's claim.
    await seedAuthors(new Map<string, StoredAuthor>([[VALORANCE, { name: "valorance_old", source: "import" }]]), T0);
    const renamePlan = planAuthorNames(VALORANCE_NAMES, await readStoredAuthors(db));
    expect(renamePlan).toEqual([{ kind: "rename", userId: VALORANCE, from: "valorance_old", to: "val0rance" }]);
    await userLane(VALORANCE, "Valiant", T1);
    await writeAuthorNames(db, fixedClock(T2), renamePlan);
    expect(await row(VALORANCE)).toMatchObject({ name: "Valiant", name_source: "user", last_seen_at: T1 });

    // Insert race: planned for an absent id the client lane then first-sights.
    const neon = { Neon: ID_B, neon: ID_B };
    const insertPlan = planAuthorNames(neon, await readStoredAuthors(db));
    expect(insertPlan).toEqual([{ kind: "insert", userId: ID_B, name: "neon" }]);
    await clientLane(ID_B, T1);
    await writeAuthorNames(db, fixedClock(T2), insertPlan);
    expect(await row(ID_B)).toMatchObject({ name: ID_B, name_source: "client", first_seen_at: T1, last_seen_at: T1 });

    // ...and the next passes replace that placeholder exactly once.
    await applyAuthors(db, fixedClock(T3), neon);
    await applyAuthors(db, fixedClock(T4), neon);
    expect(await row(ID_B)).toMatchObject({ name: "neon", name_source: "import", last_seen_at: T3 });
  });

  it("[LDB-I17] dump -> restore keeps name_source; a dump written before migration 0006 restores every author as 'import'", async () => {
    await seedAuthors(
      new Map<string, StoredAuthor>([
        [ID_A, { name: "Imported", source: "import" }],
        [ID_B, { name: "Signed In", source: "user" }],
        [ID_C, { name: ID_C, source: "client" }],
      ]),
      T0,
    );
    const before = await snapshot();
    const dump = await buildDump(bindings, fixedClock(T1));
    expect(dump.authors.map((a) => a.name_source)).toEqual(["import", "user", "client"]);

    await restoreInto(db, dump);
    expect(await snapshot()).toEqual(before);

    const legacyAuthors = dump.authors.map((a) => {
      const copy: AuthorDbRow = { ...a };
      delete copy.name_source;
      return copy;
    });
    await restoreInto(db, { ...dump, authors: legacyAuthors });
    expect((await snapshot()).map((r) => r.name_source)).toEqual(["import", "import", "import"]);
  });

  it("[LDB-I17] migration 0006's backfill: the client placeholder becomes 'client', a name matching a successful auth-cache entry 'user', anything else stays 'import'", async () => {
    const migration = bindings.TEST_MIGRATIONS.find((m) => m.name.startsWith("0006_"));
    expect(migration, "migrations/0006_author_name_source.sql").toBeDefined();
    const backfill = migration!.queries.filter((q) => /\bUPDATE\s+authors\b/i.test(q));
    expect(backfill.length).toBe(2);

    await seedAuthors(
      new Map<string, StoredAuthor>([
        [ID_A, { name: ID_A, source: "import" }], // the client lane's placeholder
        [ID_B, { name: "Bee", source: "import" }], // signed in as "Bee"
        [ID_C, { name: "Cee", source: "import" }], // signed in as "Old Cee"; the import renamed it since
        [ID_D, { name: "Dee", source: "import" }], // only a failed auth-cache row
      ]),
      T0,
    );
    await db.batch([
      db
        .prepare("INSERT INTO auth_cache (token_hash, user_id, name, app_id, ok, expires_at) VALUES (?, ?, ?, ?, 1, ?)")
        .bind("hash-b", ID_B, "Bee", "app", T1),
      db
        .prepare("INSERT INTO auth_cache (token_hash, user_id, name, app_id, ok, expires_at) VALUES (?, ?, ?, ?, 1, ?)")
        .bind("hash-c", ID_C, "Old Cee", "app", T1),
      db
        .prepare("INSERT INTO auth_cache (token_hash, user_id, name, app_id, ok, expires_at) VALUES (?, ?, ?, NULL, 0, ?)")
        .bind("hash-d", ID_D, "Dee", T1),
    ]);
    for (const q of backfill) await db.prepare(q).run();

    expect((await snapshot()).map((r) => [r.user_id, r.name_source])).toEqual([
      [ID_A, "client"],
      [ID_B, "user"],
      [ID_C, "import"],
      [ID_D, "import"],
    ]);
  });
});
