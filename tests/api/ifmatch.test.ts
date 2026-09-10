// [LDB-P2] `If-Match` (09 §2.3): matching/`*` succeed; absent is refused
// (2026-09-09, saltorbit's rule) with `400 if_match_required`, checked before
// any read or mutation, never treated as a blind overwrite; a stale rev
// (too low or too high) is `409 stale` with the current record and its
// `last_write`; a weak ETag or garbage is `400 bad_request`, never a
// mismatch. The race: two writes at the same rev, run concurrently, land
// exactly one 200 and one 409 `stale` whose `record` is the winner's.
import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Bindings } from "../../src/env";
import { appendWrite } from "../../src/core/events";
import { fixedClock } from "../../src/core/time";
import { AKL_PAYLOAD, CMINI_PAYLOAD, actorFixture, register, uniqueName, writeFetch } from "./write-support";

const db = (env as unknown as Bindings).DB;
const clock = fixedClock("2026-07-06T00:00:00.000Z");
const OWNER = "owner-ifmatch-1";

afterEach(() => {
  vi.unstubAllGlobals();
});

async function seed() {
  const { record } = await appendWrite(db, clock, {
      upstream: null,
    kind: "created",
    name: uniqueName("ifmatch-seed"),
    owner: OWNER,
    modified_at: clock(),
    format: "cmini/1",
    payload: CMINI_PAYLOAD,
    actor: OWNER,
    via: "discord",
    hasMagic: false,
  });
  return record;
}

function ownerHeaders(token: string) {
  const fake = actorFixture();
  return register(fake, token, OWNER);
}

describe("[LDB-P2] If-Match on PUT/DELETE", () => {
  const cases: { label: string; header: (rev: number) => string | undefined; status: number; code?: string }[] = [
    // 2026-09-09: absent is refused, never treated as `*` -- LDB-P2.
    { label: "absent", header: () => undefined, status: 400, code: "if_match_required" },
    { label: "*", header: () => "*", status: 200 },
    { label: '"<rev>" (quoted, matching)', header: (rev) => `"${rev}"`, status: 200 },
    { label: "<rev> (bare, matching)", header: (rev) => `${rev}`, status: 200 },
    { label: '"<rev-1>" (stale)', header: (rev) => `"${rev - 1}"`, status: 409 },
    { label: '"<rev+1>" (ahead)', header: (rev) => `"${rev + 1}"`, status: 409 },
    { label: 'W/"<rev>" (weak, refused)', header: (rev) => `W/"${rev}"`, status: 400, code: "bad_request" },
    { label: '"a" (garbage, refused)', header: () => `"a"`, status: 400, code: "bad_request" },
  ];

  for (const { label, header, status, code } of cases) {
    it(`PUT If-Match: ${label} -> ${status}`, async () => {
      const record = await seed();
      const headers = ownerHeaders(`tok-put-${uniqueName("t")}`);
      const ifMatch = header(record.rev);
      const res = await writeFetch(`/v1/layouts/${record.id}`, "PUT", {
        ...headers,
        ...(ifMatch !== undefined ? { "If-Match": ifMatch } : {}),
      }, { format: "akl/1", payload: AKL_PAYLOAD });
      expect(res.status, label).toBe(status);
      if (status === 409) {
        const body = await res.json<{ error: string; rev: number; record: { rev: number }; last_write: { kind: string } }>();
        expect(body.error).toBe("stale");
        expect(body.rev).toBe(record.rev);
        expect(body.record.rev).toBe(record.rev);
        expect(body.last_write.kind).toBe("created");
      }
      if (status === 400 && code === "bad_request") {
        await expect(res.json()).resolves.toMatchObject({ error: "bad_request", param: "If-Match" });
      }
      if (status === 400 && code === "if_match_required") {
        await expect(res.json()).resolves.toMatchObject({ error: "if_match_required" });
      }
    });

    it(`DELETE If-Match: ${label} -> ${status}`, async () => {
      const record = await seed();
      const headers = ownerHeaders(`tok-del-${uniqueName("t")}`);
      const ifMatch = header(record.rev);
      const res = await writeFetch(`/v1/layouts/${record.id}`, "DELETE", {
        ...headers,
        ...(ifMatch !== undefined ? { "If-Match": ifMatch } : {}),
      });
      expect(res.status, label).toBe(status);
      if (status === 400 && code === "if_match_required") {
        await expect(res.json()).resolves.toMatchObject({ error: "if_match_required" });
      }
    });
  }

  it("[LDB-P2] a mismatch writes nothing (record and events unchanged)", async () => {
    const record = await seed();
    const headers = ownerHeaders("tok-noop");
    const res = await writeFetch(`/v1/layouts/${record.id}`, "PUT", { ...headers, "If-Match": `"${record.rev + 5}"` }, {
      format: "akl/1",
      payload: AKL_PAYLOAD,
    });
    expect(res.status).toBe(409);
    const row = await db.prepare("SELECT rev FROM layouts WHERE id = ?").bind(record.id).first<{ rev: number }>();
    expect(row?.rev).toBe(record.rev);
    const events = await db.prepare("SELECT COUNT(*) AS n FROM events WHERE layout_id = ?").bind(record.id).first<{ n: number }>();
    expect(events?.n).toBe(1); // just the seed's own "created"
  });

  it("[LDB-P2] race: two PUTs at the same rev -> exactly one 200, one 409 stale carrying the winner's record", async () => {
    const record = await seed();
    const fake = actorFixture();
    const headers = register(fake, "tok-race", OWNER);
    const put = (v: number) =>
      writeFetch(`/v1/layouts/${record.id}`, "PUT", { ...headers, "If-Match": `"${record.rev}"` }, {
        format: "akl/1",
        payload: { ...AKL_PAYLOAD, x: { tag: `v${v}` } },
      });

    const [a, b] = await Promise.all([put(1), put(2)]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([200, 409]);

    const winner = a.status === 200 ? a : b;
    const loser = a.status === 200 ? b : a;
    const winnerBody = await winner.json<{ rev: number; payload: { tag?: string } }>();
    const loserBody = await loser.json<{ record: { rev: number; payload: { tag?: string } } }>();
    expect(winnerBody.rev).toBe(record.rev + 1);
    expect(loserBody.record.rev).toBe(winnerBody.rev);
    expect(loserBody.record.payload.tag).toBe(winnerBody.payload.tag);

    const events = await db.prepare("SELECT COUNT(*) AS n FROM events WHERE layout_id = ?").bind(record.id).first<{ n: number }>();
    expect(events?.n).toBe(2); // "created" + exactly one "updated"
  });

  // "Overwrite (`*`) still loses a race" (09 §2.3's whole point -- `*`
  // skips the pre-check, not the guard) is the SAME `layout_revs` PK path
  // this suite's own `PUT If-Match: * -> 200` case above already runs, and
  // is proven not-flakily at the pipeline level (no HTTP/JSON/ajv hops
  // between the two racing reads) by tests/events/races.test.ts's
  // "[LDB-P1] two updates racing from the same rev" -- appendWrite there is
  // called with no If-Match concept at all, i.e. always what the HTTP layer
  // would once have called "absent" (2026-09-09: absent is now refused at
  // the route, before `appendWrite` is ever reached over HTTP -- see the
  // `if_match_required` case above -- but `appendWrite` itself has no
  // If-Match concept and is exercised the same way regardless). Racing two
  // full HTTP PUTs with `*` a second time here was tried and is NOT
  // reliable: the extra hops before either request reaches `commitWrite`
  // (actor resolution, JSON parse, ajv) change how often the two interleave
  // enough to hit the same `layout_revs` row, so a real 200/200 sometimes
  // happens even though the guard itself is sound -- an HTTP-level
  // scheduling artifact, not a guarantee violation (the actual guard is
  // `appendWrite`'s, exercised
  // identically regardless of `If-Match`).
});
