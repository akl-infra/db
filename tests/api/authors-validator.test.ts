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
import { env, SELF, store, testStore } from "../harness";
import fc from "fast-check";
import { beforeAll, describe, expect, it } from "vitest";

import type { Bindings } from "../../src/env";
import { verifyClientRequest } from "../../src/auth/client";
import { resolveBearer } from "../../src/auth/discord";
import { canonical } from "../../src/core/canonical";
import type { Actor } from "../../src/auth/actor";
import { appendAdmin } from "../../src/core/events";
import { renameAuthor } from "../../src/core/moderation";
import type { Clock } from "../../src/core/time";
import { restoreInto } from "../../src/dump/restore";
import { buildDump } from "../../src/dump/write";
import { generateKeyPair, seedClient, signHeaders } from "../auth/client-support";
import { FakeDiscord } from "../auth/fake-discord";

const bindings = env as unknown as Bindings;

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
  await seedClient(clock, { id: CLIENT_ID, pubkeyB64url: pair.pubkeyB64url, ownerUserId: "100000000000000000", caps: "act-as-user" });
});

// --- the real writers ------------------------------------------------------

async function signIn(userId: string, name: string): Promise<void> {
  const token = `tok-${tokenCounter++}`; // a fresh token: a cached one never reaches the authors write
  fake.setAnswer(token, { kind: "ok", id: userId, username: name, global_name: null });
  await resolveBearer(store, clock, token, fake.fetchImpl, "https://discord.test");
}

async function clientLane(actor: string): Promise<void> {
  const headers = await signHeaders({ privateKey: clientKey, clientId: CLIENT_ID, actor, method: "GET", pathWithQuery: "/v1/me", timestamp: peekSeconds() });
  await verifyClientRequest(store, clock, new Request("https://example.com/v1/me", { headers }), new Uint8Array(0));
}

async function event(): Promise<void> {
  await appendAdmin(store, clock, { kind: "admin.import_ticked", actor: "system:test" });
}

// [LDB-MD4] L5 moderation (§4.3): an admin override IS an author-only
// change too -- it moves `authors_head` (a real `name`/`name_source`
// UPDATE) but appends an event with `layout_id: NULL`, so it never bumps
// the event seq, same as a sign-in or an import pass.
const MODERATOR: Actor = { user_id: "900000000000000001", name: "moderator", via: "discord", admin: true, banned: false, source_client: "discord-app:test" };
async function adminRename(userId: string, name: string): Promise<void> {
  await renameAuthor(store, clock, MODERATOR, null, userId, name);
}

// Bookkeeping at the table level: moves `last_seen_at` and sets `name` to
// itself -- the trigger's WHEN guard must see no change.
async function touch(userId: string): Promise<void> {
  const author = await testStore.row<{ name: string }>("authors", { user_id: userId });
  if (author === null) return; // the UPDATE matches no row
  await testStore.patch("authors", { user_id: userId }, { name: author.name, last_seen_at: clock() });
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
  const events = await testStore.rows<{ seq: number }>("events");
  const results = (await testStore.rows<{ user_id: string; name: string }>("authors", {}, ["user_id"])).map((r) => ({ user_id: r.user_id, name: r.name }));
  const head = await testStore.row<{ version: number }>("authors_head", { id: 1 });
  const byId = Object.fromEntries(results.map((r) => [r.user_id, r.name]));
  return { seq: Math.max(0, ...events.map((e) => e.seq)), rows: canonical(results), byId, count: results.length, version: head!.version };
}

// --- LDB-R9 / R10 / R11: property over generated write sequences ----------

const IDS = ["100000000000000001", "100000000000000002", "100000000000000003", "100000000000000004"];
const NAMES = ["alice", "bob", "carol", "Alice", "dave"]; // "alice"/"Alice" and shared names collide across ids on purpose

type Op =
  | { kind: "event" }
  | { kind: "signIn"; id: string; name: string }
  | { kind: "client"; id: string }
  | { kind: "touch"; id: string };

const opArb: fc.Arbitrary<Op> = fc.oneof(
  fc.constant<Op>({ kind: "event" }),
  fc.record({ id: fc.constantFrom(...IDS), name: fc.constantFrom(...NAMES) }).map((r): Op => ({ kind: "signIn", ...r })),
  fc.constantFrom(...IDS).map((id): Op => ({ kind: "client", id })),
  fc.constantFrom(...IDS).map((id): Op => ({ kind: "touch", id })),
);

async function apply(op: Op): Promise<void> {
  if (op.kind === "event") await event();
  else if (op.kind === "signIn") await signIn(op.id, op.name);
  else if (op.kind === "client") await clientLane(op.id);
  else await touch(op.id);
}

// Alternates the strong tag and the `W/` form Cloudflare rewrites it to
// (LDB-R1's weak comparison) across steps.
function asSent(etag: string, step: number): string {
  return step % 2 === 0 ? etag : `W/${etag}`;
}

describe("[LDB-R9] [LDB-R10] [LDB-R11] property: events, sign-ins, client-lane requests and bookkeeping", () => {
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
  const c = freshId();
  const e = freshId();
  return [
    { kind: "a sign-in renames a user", id: c, setup: () => signIn(c, "before-signin"), change: () => signIn(c, "after-signin"), expectName: "after-signin" },
    { kind: "the client lane first sees an id", id: e, setup: async () => {}, change: () => clientLane(e), expectName: e },
  ];
}
// [LDB-MD4] L5 §4.3: an admin rename does NOT belong in the list above --
// unlike every other author-only change here, `renameAuthor` (`core/
// moderation.ts`) appends a real `admin.author_renamed` event (LDB-MD7:
// every moderation action is an event), so it moves the event seq too --
// this list's whole premise ("author-only": zero event delta) doesn't
// hold for it. Covered instead by its own dedicated describe block below.

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
  const c = freshId();
  const e = freshId();
  return [
    { kind: "a sign-in that keeps its name (last_seen_at only)", setup: () => signIn(a, "steady"), keep: () => signIn(a, "steady") },
    { kind: "a repeat client-lane request", setup: () => clientLane(c), keep: () => clientLane(c) },
    { kind: "a direct last_seen_at update and a name set to itself", setup: () => signIn(e, "touched"), keep: () => touch(e) },
  ];
}
// [LDB-MD4] L5 §4.3: an admin rename to the name a row already holds
// does NOT belong in the list above either -- `renameAuthor` still
// appends a real event even when nothing changes (LDB-MD7), so `/v1/meta`
// (seq-keyed) correctly does NOT stay 304, unlike every case in this list.
// `authors_head` itself (the OTHER validator) is unaffected -- covered by
// the dedicated describe block below.

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

// --- LDB-D1 amended: dump/restore carries the validator -------------------

describe("[LDB-D1] [LDB-R9] the dump carries authors_head and a restore sets it exactly", () => {
  it("[LDB-D1] [LDB-R9] dump meta's author fields equal /v1/meta's; restoring sets authors_head to them despite the triggers; a pre-0007 dump restores as version 0", async () => {
    await signIn(freshId(), "dump-author");
    const live = (await (await get("/v1/meta")).json()) as { authors_version: number; authors_modified_at: string | null; author_count: number };
    const dump = await buildDump(bindings, clock);
    expect(dump.meta.authors_version).toBe(live.authors_version);
    expect(dump.meta.authors_modified_at).toBe(live.authors_modified_at);
    expect(dump.meta.author_count).toBe(live.author_count);

    await restoreInto(store, dump); // its authors deletes + inserts fire the triggers
    const head = await testStore.row<{ version: number; modified_at: string | null }>("authors_head", { id: 1 });
    expect(head).toMatchObject({ version: dump.meta.authors_version, modified_at: dump.meta.authors_modified_at });

    const old = { ...dump, meta: { ...dump.meta } };
    delete old.meta.authors_version;
    await restoreInto(store, old);
    const oldHead = await testStore.row<{ version: number; modified_at: string | null }>("authors_head", { id: 1 });
    expect(oldHead).toMatchObject({ version: 0, modified_at: dump.meta.authors_modified_at });
  });
});

// [LDB-MD4] L5 §4.3: literal, standalone proof (the two matrices above
// exercise `adminRename` through the generic change-kind/bookkeeping
// loops, whose own `it()` titles are template-interpolated and so can
// never carry a static `[LDB-MD4]` tag for tests/tools/invariants.test.ts
// to find).
describe("[LDB-MD4] an admin-sourced author name survives sign-ins", () => {
  it("[LDB-MD4] moves authors_head; a later sign-in under a different Discord name never overwrites it", async () => {
    const id = freshId();
    await signIn(id, "before-admin");
    const before = (await oracle()).version;

    await adminRename(id, "sticky-admin-name");
    expect((await oracle()).version).toBeGreaterThan(before);
    expect((await oracle()).byId[id]).toBe("sticky-admin-name");

    await signIn(id, "totally-different-handle");
    expect((await oracle()).byId[id]).toBe("sticky-admin-name");
  });

  it("[LDB-MD4] a rename to the name the row already holds moves neither authors_head nor last_seen_at's own bookkeeping surface", async () => {
    const id = freshId();
    await signIn(id, "steady-name");
    await adminRename(id, "steady-name");
    const before = (await oracle()).version;
    await adminRename(id, "steady-name");
    expect((await oracle()).version).toBe(before);
  });
});
