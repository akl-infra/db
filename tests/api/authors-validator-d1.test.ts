// D1-only (design/p1-briefs.md E).
// [LDB-R9] [LDB-R11] The two parts of the authors validator that are about D1
// itself: the `authors_head` triggers (enumerated at the SQL level) and the
// number of statements a conditional request prepares. Split out of
// authors-validator.test.ts, which runs on every backend.
import { createExecutionContext, env, SELF, testStore } from "../harness";
import { describe, expect, it } from "vitest";
import { app } from "../../src/index";
import type { Bindings } from "../../src/env";

const bindings = env as unknown as Bindings;
const db = bindings.DB;

type Route = "/v1/meta" | "/v1/authors" | "/v1/authors?by=id";

async function get(route: Route, ifNoneMatch?: string): Promise<Response> {
  return SELF.fetch(`https://example.com${route}`, ifNoneMatch === undefined ? {} : { headers: { "If-None-Match": ifNoneMatch } });
}

async function authorsVersion(): Promise<number> {
  const head = await testStore.row<{ version: number }>("authors_head", { id: 1 });
  return head!.version;
}

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
      const before = (await authorsVersion());
      await db.prepare(row.stmt).bind(...row.binds).run();
      expect((await authorsVersion()) - before, row.stmt).toBe(row.delta);
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
  // [LDB-A12] rogue-trusted-client hardening (2026-09-13): a 200 gained one
  // more prepare -- `core/clients.ts`'s `clientsHealth` (`health.clients`,
  // deliberately outside the ETag same as `health.dump`/`health.diff`)
  // reads the (tiny, admin-curated) `clients` table for any currently-
  // suspended rows; a second, batched `import_state` lookup only runs when
  // that first query finds at least one (never on this fresh-DB case). Was
  // <= 4, now <= 5 -- the 304 path is completely unaffected (still exactly
  // 1: `conditional()` returns before `readMetaCore`/`clientsHealth` ever run).
  it("[LDB-R9] [LDB-A12] /v1/meta: a 304 prepares exactly one statement (seq + authors_head + last_diff in one query); a 200 at most five", async () => {
    const first = await preparesFor("/v1/meta");
    expect(first.status).toBe(200);
    expect(first.prepares).toBeLessThanOrEqual(5);
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

