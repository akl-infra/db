import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { Bindings } from "../../src/env";
import { fixedClock } from "../../src/core/time";
import { tick } from "../../src/import/cmini";
import { FakeUpstream } from "../import/fake-upstream";

const bindings = env as unknown as Bindings;
const db = bindings.DB;

// The S1 skeleton's only route. Once formats/import land, this test is
// superseded by tests/api/conformance.test.ts (S6); the invariant id moves
// with it (see the S1 table in 07-implementation-phase1.md).
describe("GET /v1/meta", () => {
  it("answers the zero body on a fresh database", async () => {
    const res = await SELF.fetch("https://example.com/v1/meta");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("application/json");
    await expect(res.json()).resolves.toEqual({
      layout_count: 0,
      author_count: 0,
      seq: 0,
      revision: null,
      layouts_modified_at: null,
      authors_modified_at: null,
      formats: ["cmini/1", "akl/1"],
    });
  });

  it("[LDB-R2] after the fixture import, counts and seq/revision equal the tables", async () => {
    const fake = new FakeUpstream();
    const clock = fixedClock("2026-06-11T00:00:00.000Z");
    await tick(bindings, clock, fake.fetchImpl, fake.sleepImpl);

    const res = await SELF.fetch("https://example.com/v1/meta");
    const body = await res.json<{ layout_count: number; author_count: number; seq: number; revision: string | null }>();
    expect(body.layout_count).toBe(100);
    // authors.json has 48 name entries but only 32 distinct user ids (9
    // users have >=2 recorded names -- verified against the fixture); the
    // `authors` table's PRIMARY KEY is user_id (migrations/0001_init.sql,
    // not S5's to change), so 32 is the correct deduped count, not the raw
    // entry count 07 §6 S5's table names.
    expect(body.author_count).toBe(32);

    const eventRow = await db.prepare("SELECT MAX(seq) AS seq, MAX(at) AS at FROM events").first<{ seq: number; at: string }>();
    expect(body.seq).toBe(eventRow!.seq);
    expect(body.revision).toBe(eventRow!.at);
  });
});
