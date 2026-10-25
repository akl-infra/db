// D1-only (design/p1-briefs.md E).
// [LDB-R16] `authors_head.count` (migrations/0035) equals
// `SELECT COUNT(*) FROM authors` after every kind of authors mutation, and
// `/v1/meta.author_count` reads it.
import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { Bindings } from "../../src/env";
import { verifyClientRequest } from "../../src/auth/client";
import { buildDump } from "../../src/dump/write";
import { restoreInto } from "../../src/dump/restore";
import { fixedClock } from "../../src/core/time";
import { generateKeyPair, seedClient, signHeaders } from "../auth/client-support";
import { actorFixture, register, uniqueName, writeFetch } from "./write-support";

const bindings = env as unknown as Bindings;
const db = bindings.DB;
const clock = fixedClock("2026-10-01T00:00:00.000Z");

async function expectExact(viaHttp = true): Promise<number> {
  const n = (await db.prepare("SELECT COUNT(*) AS n FROM authors").first<{ n: number }>())!.n;
  expect((await db.prepare("SELECT count FROM authors_head WHERE id = 1").first<{ count: number }>())!.count).toBe(n);
  if (viaHttp) {
    const body = await (await SELF.fetch("https://example.com/v1/meta")).json<{ author_count: number }>();
    expect(body.author_count).toBe(n);
  }
  return n;
}

const insert = (id: string, extra = "") =>
  db.prepare(`INSERT INTO authors (user_id, name, first_seen_at, last_seen_at) VALUES (?, ?, 't', 't') ${extra}`).bind(id, `n-${id}`).run();

describe("[LDB-R16] authors_head.count tracks the author count exactly", () => {
  it("[LDB-R16] follows the bearer lane, the client lane, renames, upserts, deletes and a restore", async () => {
    let n = await expectExact();

    // Bearer lane: first sign-in inserts, a second does not.
    const h = register(actorFixture(), `tok-${uniqueName("cnt")}`, "50000000000000001");
    expect((await writeFetch("/v1/me", "GET", h)).status).toBe(200);
    expect(await expectExact()).toBe(n + 1);
    n += 1;
    await writeFetch("/v1/me", "GET", h);
    expect(await expectExact()).toBe(n);

    // Client lane: first sight inserts the actor, a repeat does not.
    const { privateKey, pubkeyB64url } = await generateKeyPair();
    await seedClient(clock, { id: "cl-count", pubkeyB64url, ownerUserId: "50000000000000002", caps: "act-as-user" });
    for (let i = 0; i < 2; i++) {
      const headers = await signHeaders({
        privateKey,
        clientId: "cl-count",
        actor: "50000000000000002",
        method: "GET",
        pathWithQuery: "/v1/me",
        timestamp: Math.floor(new Date(clock()).getTime() / 1000),
      });
      await verifyClientRequest(db, clock, new Request("https://example.com/v1/me", { headers }), new Uint8Array(0), {});
      expect(await expectExact()).toBe(n + 1);
    }
    n += 1;

    // Raw paths: insert, conflict-ignored insert, upsert, rename, delete.
    await insert("50000000000000003");
    expect(await expectExact(false)).toBe(n + 1);
    await insert("50000000000000003", "ON CONFLICT(user_id) DO NOTHING");
    await insert("50000000000000003", "ON CONFLICT(user_id) DO UPDATE SET last_seen_at = 'u'");
    await db.prepare("UPDATE authors SET name = 'renamed', last_seen_at = 'v' WHERE user_id = '50000000000000003'").run();
    expect(await expectExact(false)).toBe(n + 1);
    await db.prepare("DELETE FROM authors WHERE user_id = '50000000000000003'").run();
    expect(await expectExact(false)).toBe(n);

    // Restore: wipe-and-reinsert from a dump lands on the dumped count, and
    // authors added after the dump are dropped again.
    const dump = await buildDump(bindings, clock);
    await insert("50000000000000004");
    await insert("50000000000000005");
    expect(await expectExact(false)).toBe(n + 2);
    await restoreInto(db, dump);
    expect(await expectExact(false)).toBe(dump.authors.length);
    expect(dump.authors.length).toBe(n);
  });
});
