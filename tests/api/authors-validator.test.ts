// [LDB-R9] [LDB-R10] [LDB-R11] The authors validator (migrations/0007,
// core/etag.ts's `readHead`/`authorsHead`). `/v1/meta` and `/v1/authors`
// show author data, and an author-only change (the import adding an id or
// renaming one, a sign-in that renames, the import replacing a client-lane
// placeholder, the client lane's first sight of an id) appends no event --
// so a seq-only ETag let a conditional GET, and the edge cache, answer the
// OLD body until an unrelated event moved the seq (the spark bot trusts
// that 304: design/HARD-REQUIREMENTS.md R1).
//
//   LDB-R9  the ETag changes iff the body does (`/v1/meta`, `/v1/authors?
//           by=id`; the name-keyed `/v1/authors` iff the stored (user_id,
//           name) set does -- it collapses duplicate names), and a
//           conditional request costs one D1 query;
//   LDB-R10 a conditional GET after an author-only change is never 304,
//           and a plain GET never gets the pre-change edge-cached body;
//   LDB-R11 pure bookkeeping (`last_seen_at`, `name_source`, a name set to
//           itself) never moves either validator.
import { createExecutionContext, env, SELF } from "cloudflare:test";
import fc from "fast-check";
import { beforeAll, describe, expect, it } from "vitest";
import { app } from "../../src/index";
import type { Bindings } from "../../src/env";
import { verifyClientRequest } from "../../src/auth/client";
import { resolveBearer } from "../../src/auth/discord";
import { canonical } from "../../src/core/canonical";
import { appendAdmin } from "../../src/core/events";
import type { Clock } from "../../src/core/time";
import { restoreInto } from "../../src/dump/restore";
import { buildDump } from "../../src/dump/write";
import { applyAuthors } from "../../src/import/apply";
import { generateKeyPair, seedClient, signHeaders } from "../auth/client-support";
import { FakeDiscord } from "../auth/fake-discord";

const bindings = env as unknown as Bindings;
const db = bindings.DB;

// One monotonically advancing clock for every writer in this file (the
// client lane's ±300 s skew check reads it too, so request timestamps are
// taken from the same value).
let clockMs = Date.parse("2026-07-01T00:00:00.000Z");
const clock: Clock = () => new Date((clockMs += 1000)).toISOString();
const peekSeconds = (): number => Math.floor((clockMs + 1000) / 1000);

const fake = new FakeDiscord();
let tokenCounter = 0;
const CLIENT_ID = "authors-validator-client";
let clientKey: CryptoKey;

beforeAll(async () => {
  const pair = await generateKeyPair();
  clientKey = pair.privateKey;
  await seedClient(db, clock, { id: CLIENT_ID, pubkeyB64url: pair.pubkeyB64url, ownerUserId: "100000000000000000", caps: "act-as-user" });
});

// --- the real writers ------------------------------------------------------

async function importPass(upstream: Record<string, string>): Promise<void> {
  await applyAuthors(db, clock, upstream);
}

async function signIn(userId: string, name: string): Promise<void> {
  const token = `tok-${tokenCounter++}`; // a fresh token: a cached one never reaches the authors write
  fake.setAnswer(token, { kind: "ok", id: userId, username: name, global_name: null });
  await resolveBearer(db, clock, token, fake.fetchImpl, "https://discord.test");
}

async function clientLane(actor: string): Promise<void> {
  const headers = await signHeaders({ privateKey: clientKey, clientId: CLIENT_ID, actor, method: "GET", pathWithQuery: "/v1/me", timestamp: peekSeconds() });
  await verifyClientRequest(db, clock, new Request("https://example.com/v1/me", { headers }), new Uint8Array(0));
}

async function event(): Promise<void> {
  await appendAdmin(db, clock, { kind: "admin.import_ticked", actor: "system:test" });
}

// Bookkeeping at the table level: moves `last_seen_at` and sets `name` to
// itself -- the trigger's WHEN guard must see no change.
async function touch(userId: string): Promise<void> {
  await db.prepare("UPDATE authors SET name = name, last_seen_at = ? WHERE user_id = ?").bind(clock(), userId).run();
}

// --- observation -----------------------------------------------------------

const ROUTES = ["/v1/meta", "/v1/authors", "/v1/authors?by=id"] as const;
type Route = (typeof ROUTES)[number];

interface Seen {
  etag: string;
  body: string;
}

async function get(route: Route, ifNoneMatch?: string): Promise<Response> {
  return SELF.fetch(`https://example.com${route}`, ifNoneMatch === undefined ? {} : { headers: { "If-None-Match": ifNoneMatch } });
}

async function observe(route: Route): Promise<Seen> {
  const res = await get(route); // no If-None-Match: may be answered from `caches.default`
  expect(res.status, route).toBe(200);
  return { etag: res.headers.get("ETag")!, body: canonical(await res.json()) };
}

interface Oracle {
  seq: number;
  rows: string; // the stored (user_id, name) set, canonical
  byId: Record<string, string>;
  count: number;
  version: number;
}

async function oracle(): Promise<Oracle> {
  const seqRow = await db.prepare("SELECT MAX(seq) AS seq FROM events").first<{ seq: number | null }>();
  const { results } = await db.prepare("SELECT user_id, name FROM authors ORDER BY user_id").all<{ user_id: string; name: string }>();
  const head = await db.prepare("SELECT version FROM authors_head WHERE id = 1").first<{ version: number }>();
  const byId = Object.fromEntries(results.map((r) => [r.user_id, r.name]));
  return { seq: seqRow?.seq ?? 0, rows: canonical(results), byId, count: results.length, version: head!.version };
}

// --- LDB-R9 / R10 / R11: property over generated write sequences ----------

const IDS = ["100000000000000001", "100000000000000002", "100000000000000003", "100000000000000004"];
const NAMES = ["alice", "bob", "carol", "Alice", "dave"]; // "alice"/"Alice" and shared names collide across ids on purpose

type Op =
  | { kind: "event" }
  | { kind: "import"; upstream: Record<string, string> }
  | { kind: "signIn"; id: string; name: string }
  | { kind: "client"; id: string }
  | { kind: "touch"; id: string };

const opArb: fc.Arbitrary<Op> = fc.oneof(
  fc.constant<Op>({ kind: "event" }),
  fc
    .array(fc.tuple(fc.constantFrom(...NAMES), fc.constantFrom(...IDS)), { minLength: 1, maxLength: 5 })
    .map((pairs): Op => ({ kind: "import", upstream: Object.fromEntries(pairs) })),
  fc.record({ id: fc.constantFrom(...IDS), name: fc.constantFrom(...NAMES) }).map((r): Op => ({ kind: "signIn", ...r })),
  fc.constantFrom(...IDS).map((id): Op => ({ kind: "client", id })),
  fc.constantFrom(...IDS).map((id): Op => ({ kind: "touch", id })),
);

async function apply(op: Op): Promise<void> {
  if (op.kind === "event") await event();
  else if (op.kind === "import") await importPass(op.upstream);
  else if (op.kind === "signIn") await signIn(op.id, op.name);
  else if (op.kind === "client") await clientLane(op.id);
  else await touch(op.id);
}

// Alternates the strong tag and the `W/` form Cloudflare rewrites it to
// (LDB-R1's weak comparison) across steps.
function asSent(etag: string, step: number): string {
  return step % 2 === 0 ? etag : `W/${etag}`;
}

describe("[LDB-R9] [LDB-R10] [LDB-R11] property: events, import passes, sign-ins, client-lane requests and bookkeeping", () => {
  it(
    "[LDB-R9] [LDB-R10] [LDB-R11] each step moves a route's ETag iff it moved that route's body; a conditional GET is 304 iff nothing it shows changed; equal tags mean equal bodies",
    async () => {
      await fc.assert(
        fc.asyncProperty(fc.array(opArb, { minLength: 1, maxLength: 10 }), async (ops) => {
          const history: Record<Route, Seen[]> = { "/v1/meta": [], "/v1/authors": [], "/v1/authors?by=id": [] };
          let before = await oracle();
          let seen = new Map<Route, Seen>();
          for (const r of ROUTES) {
            const s = await observe(r);
            seen.set(r, s);
            history[r].push(s);
          }

          for (let step = 0; step < ops.length; step++) {
            await apply(ops[step]!);
            const after = await oracle();
            const authorsChanged = after.rows !== before.rows;
            const eventAppended = after.seq !== before.seq;

            // LDB-R9's mechanism: the version moves iff the stored set does.
            expect(after.version !== before.version, `authors_head.version vs the (user_id, name) set after ${JSON.stringify(ops[step])}`).toBe(authorsChanged);

            for (const r of ROUTES) {
              const prev = seen.get(r)!;
              const cond = await get(r, asSent(prev.etag, step));
              const now = await observe(r);
              const bodyMoved = now.body !== prev.body;
              const tagMoved = now.etag !== prev.etag;
              const label = `${r} after ${JSON.stringify(ops[step])}`;

              if (r === "/v1/authors") {
                // Name-keyed: a projection that collapses shared names, so
                // its tag tracks the stored set, and a moved body always
                // moved the tag.
                expect(tagMoved, label).toBe(authorsChanged);
                if (bodyMoved) expect(tagMoved, label).toBe(true);
              } else {
                expect(tagMoved, label).toBe(bodyMoved);
              }

              // What each route shows moved (or not) -> the conditional GET.
              const shownMoved = r === "/v1/meta" ? authorsChanged || eventAppended : authorsChanged;
              expect(cond.status, `conditional ${label}`).toBe(shownMoved ? 200 : 304); // LDB-R10 / LDB-R11
              if (cond.status === 200) expect(canonical(await cond.json()), `conditional body ${label}`).toBe(now.body);
              else expect(cond.headers.get("ETag"), label).toBe(prev.etag);

              seen.set(r, now);
              history[r].push(now);
            }

            // LDB-R10: a plain GET (edge cache allowed) shows the current table.
            const byId = JSON.parse(seen.get("/v1/authors?by=id")!.body) as Record<string, string>;
            expect(byId).toEqual(after.byId);
            const meta = JSON.parse(seen.get("/v1/meta")!.body) as { author_count: number; authors_version: number; seq: number };
            expect(meta.author_count).toBe(after.count);
            expect(meta.authors_version).toBe(after.version);
            expect(meta.seq).toBe(after.seq);

            before = after;
          }

          // Across every pair of observations: equal tags -> equal bodies
          // (all three), and for `/v1/meta` the converse too.
          for (const r of ROUTES) {
            const h = history[r];
            for (let i = 0; i < h.length; i++) {
              for (let j = i + 1; j < h.length; j++) {
                if (h[i]!.etag === h[j]!.etag) expect(h[j]!.body, `${r} #${i} vs #${j}`).toBe(h[i]!.body);
                if (r === "/v1/meta" && h[i]!.body === h[j]!.body) expect(h[j]!.etag, `${r} #${i} vs #${j}`).toBe(h[i]!.etag);
              }
            }
          }
        }),
        { numRuns: 25 },
      );
    },
    180_000,
  );
});

// --- LDB-R10: the author-only changes, enumerated -------------------------

// Each case: `setup` puts the table in the "before" state; `change` is the
// author-only write; `expectAfter` is the id -> name it must leave.
interface ChangeCase {
  kind: string;
  id: string;
  setup: () => Promise<void>;
  change: () => Promise<void>;
  expectName: string;
}

let caseIdCounter = 200000000000000000n;
const freshId = (): string => String(caseIdCounter++);

function authorOnlyChanges(): ChangeCase[] {
  const a = freshId();
  const b = freshId();
  const c = freshId();
  const d = freshId();
  const e = freshId();
  return [
    { kind: "the import adds a new id", id: a, setup: async () => {}, change: () => importPass({ "new-author": a }), expectName: "new-author" },
    {
      kind: "the import renames an id whose stored name upstream no longer lists",
      id: b,
      setup: () => importPass({ "old-name": b }),
      change: () => importPass({ "new-name": b }),
      expectName: "new-name",
    },
    { kind: "a sign-in renames a user", id: c, setup: () => signIn(c, "before-signin"), change: () => signIn(c, "after-signin"), expectName: "after-signin" },
    { kind: "the import replaces a client-lane placeholder", id: d, setup: () => clientLane(d), change: () => importPass({ "real-name": d }), expectName: "real-name" },
    { kind: "the client lane first sees an id", id: e, setup: async () => {}, change: () => clientLane(e), expectName: e },
  ];
}

describe("[LDB-R10] a conditional GET after an author-only change is never 304; the edge cache never serves the old body", () => {
  for (const route of ROUTES) {
    for (const form of ["strong", "weak"] as const) {
      for (const kase of authorOnlyChanges()) {
        it(`[LDB-R10] ${route}, ${form} If-None-Match: ${kase.kind}`, async () => {
          await kase.setup();
          const seqBefore = (await oracle()).seq;
          const prior = await observe(route); // primes caches.default with the pre-change body
          await kase.change();
          expect((await oracle()).seq, "the change must append no event -- else this isn't an author-only change").toBe(seqBefore);

          const cond = await get(route, form === "strong" ? prior.etag : `W/${prior.etag}`);
          expect(cond.status).toBe(200);
          expect(cond.headers.get("ETag")).not.toBe(prior.etag);

          const plain = await observe(route);
          expect(plain.body).not.toBe(prior.body);
          if (route === "/v1/authors?by=id") expect((JSON.parse(plain.body) as Record<string, string>)[kase.id]).toBe(kase.expectName);
          if (route === "/v1/authors") expect((JSON.parse(plain.body) as Record<string, string>)[kase.expectName]).toBe(kase.id);
        });
      }
    }
  }
});

// --- LDB-R11: bookkeeping, enumerated --------------------------------------

interface KeepCase {
  kind: string;
  setup: () => Promise<void>;
  keep: () => Promise<void>;
}

function bookkeeping(): KeepCase[] {
  const a = freshId();
  const b = freshId();
  const c = freshId();
  const d = freshId();
  const e = freshId();
  return [
    { kind: "a sign-in that keeps its name (last_seen_at only)", setup: () => signIn(a, "steady"), keep: () => signIn(a, "steady") },
    { kind: "a sign-in whose name equals the import's (name_source import -> user only)", setup: () => importPass({ shared: b }), keep: () => signIn(b, "shared") },
    { kind: "a repeat client-lane request", setup: () => clientLane(c), keep: () => clientLane(c) },
    { kind: "an import pass that writes nothing", setup: () => importPass({ same: d, alias: d }), keep: () => importPass({ alias: d, same: d }) },
    { kind: "a direct last_seen_at update and a name set to itself", setup: () => importPass({ touched: e }), keep: () => touch(e) },
  ];
}

describe("[LDB-R11] bookkeeping never moves either validator", () => {
  for (const route of ROUTES) {
    for (const kase of bookkeeping()) {
      it(`[LDB-R11] ${route}: ${kase.kind}`, async () => {
        await kase.setup();
        const prior = await observe(route);
        const versionBefore = (await oracle()).version;
        await kase.keep();
        expect((await oracle()).version).toBe(versionBefore);
        const cond = await get(route, prior.etag);
        expect(cond.status).toBe(304);
        expect(cond.headers.get("ETag")).toBe(prior.etag);
      });
    }
  }
});

// The trigger itself, enumerated at the SQL level: which statements move
// `authors_head.version` (by exactly one) and which never do.
describe("[LDB-R9] [LDB-R11] authors_head's triggers: +1 on insert, delete and rename, 0 on everything else", () => {
  const ID = "300000000000000001";
  const rows: { stmt: string; binds: unknown[]; delta: number }[] = [
    { stmt: "INSERT INTO authors (user_id, name, first_seen_at, last_seen_at, name_source) VALUES (?, 'n0', ?, ?, 'import')", binds: [ID, "t", "t"], delta: 1 },
    { stmt: "INSERT INTO authors (user_id, name, first_seen_at, last_seen_at, name_source) VALUES (?, 'x', ?, ?, 'import') ON CONFLICT(user_id) DO NOTHING", binds: [ID, "t", "t"], delta: 0 },
    { stmt: "INSERT INTO authors (user_id, name, first_seen_at, last_seen_at, name_source) VALUES (?, 'n0', ?, ?, 'user') ON CONFLICT(user_id) DO UPDATE SET name = excluded.name, name_source = 'user', last_seen_at = excluded.last_seen_at", binds: [ID, "t", "t2"], delta: 0 },
    { stmt: "INSERT INTO authors (user_id, name, first_seen_at, last_seen_at, name_source) VALUES (?, 'n1', ?, ?, 'user') ON CONFLICT(user_id) DO UPDATE SET name = excluded.name, name_source = 'user', last_seen_at = excluded.last_seen_at", binds: [ID, "t", "t3"], delta: 1 },
    { stmt: "UPDATE authors SET last_seen_at = ? WHERE user_id = ?", binds: ["t4", ID], delta: 0 },
    { stmt: "UPDATE authors SET name_source = 'import' WHERE user_id = ?", binds: [ID], delta: 0 },
    { stmt: "UPDATE authors SET name = name WHERE user_id = ?", binds: [ID], delta: 0 },
    { stmt: "UPDATE authors SET name = 'n2' WHERE user_id = ?", binds: [ID], delta: 1 },
    { stmt: "UPDATE authors SET name = 'n3' WHERE user_id = 'no-such-id'", binds: [], delta: 0 },
    { stmt: "DELETE FROM authors WHERE user_id = ?", binds: [ID], delta: 1 },
    { stmt: "DELETE FROM authors WHERE user_id = ?", binds: [ID], delta: 0 },
  ];
  it("[LDB-R9] [LDB-R11] each statement moves the version by exactly its delta", async () => {
    for (const row of rows) {
      const before = (await oracle()).version;
      await db.prepare(row.stmt).bind(...row.binds).run();
      expect((await oracle()).version - before, row.stmt).toBe(row.delta);
    }
  });
});

// --- LDB-R9: the cost ------------------------------------------------------

// Counts every statement a request prepares, by calling the real app with
// a proxied D1 binding.
async function preparesFor(path: string, headers: Record<string, string> = {}): Promise<{ status: number; prepares: number }> {
  let prepares = 0;
  const counted = new Proxy(db, {
    get(target, prop) {
      if (prop === "prepare") prepares++;
      const v = Reflect.get(target, prop) as unknown;
      return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  });
  const res = await app.fetch(new Request(`https://example.com${path}`, { headers }), { ...bindings, DB: counted }, createExecutionContext());
  await res.text();
  return { status: res.status, prepares };
}

describe("[LDB-R9] a conditional request costs one D1 query", () => {
  it("[LDB-R9] /v1/meta: a 304 prepares exactly one statement (seq + authors_head + last_diff in one query); a 200 at most four", async () => {
    const first = await preparesFor("/v1/meta");
    expect(first.status).toBe(200);
    expect(first.prepares).toBeLessThanOrEqual(4);
    const etag = (await get("/v1/meta")).headers.get("ETag")!;
    const again = await preparesFor("/v1/meta", { "If-None-Match": etag });
    expect(again).toEqual({ status: 304, prepares: 1 });
  });

  it("[LDB-R9] /v1/authors (both shapes): a 304 prepares exactly one statement", async () => {
    for (const path of ["/v1/authors", "/v1/authors?by=id"]) {
      const etag = (await get(path as Route)).headers.get("ETag")!;
      expect(await preparesFor(path, { "If-None-Match": etag }), path).toEqual({ status: 304, prepares: 1 });
    }
  });
});

// --- LDB-D1 amended: dump/restore carries the validator -------------------

describe("[LDB-D1] [LDB-R9] the dump carries authors_head and a restore sets it exactly", () => {
  it("[LDB-D1] [LDB-R9] dump meta's author fields equal /v1/meta's; restoring sets authors_head to them despite the triggers; a pre-0007 dump restores as version 0", async () => {
    await importPass({ "dump-author": freshId() });
    const live = (await (await get("/v1/meta")).json()) as { authors_version: number; authors_modified_at: string | null; author_count: number };
    const dump = await buildDump(bindings, clock);
    expect(dump.meta.authors_version).toBe(live.authors_version);
    expect(dump.meta.authors_modified_at).toBe(live.authors_modified_at);
    expect(dump.meta.author_count).toBe(live.author_count);

    await restoreInto(db, dump); // its authors deletes + inserts fire the triggers
    const head = await db.prepare("SELECT version, modified_at FROM authors_head WHERE id = 1").first<{ version: number; modified_at: string | null }>();
    expect(head).toEqual({ version: dump.meta.authors_version, modified_at: dump.meta.authors_modified_at });

    const old = { ...dump, meta: { ...dump.meta } };
    delete old.meta.authors_version;
    await restoreInto(db, old);
    const oldHead = await db.prepare("SELECT version, modified_at FROM authors_head WHERE id = 1").first<{ version: number; modified_at: string | null }>();
    expect(oldHead).toEqual({ version: 0, modified_at: dump.meta.authors_modified_at });
  });
});
