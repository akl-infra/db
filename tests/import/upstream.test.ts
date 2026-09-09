// [LDB-I8] Every upstream request carries the UA; 404 is never retried;
// other failures are retried 3x; the ?full=1 join drops duplicate names to
// the per-id path.
import { describe, expect, it } from "vitest";
import { UpstreamClient } from "../../src/import/upstream";
import { FakeUpstream } from "./fake-upstream";

const UA = "akl-db-import-test/1.0";

describe("UpstreamClient", () => {
  it("[LDB-I8] sends the User-Agent header on every request", async () => {
    const fake = new FakeUpstream();
    const client = new UpstreamClient(fake.baseUrl, UA, fake.fetchImpl, fake.sleepImpl);

    await client.meta();
    await client.list();
    await client.full();
    await client.detail("graphite");
    await client.authors();

    expect(fake.requestLog.length).toBeGreaterThanOrEqual(5);
    for (const req of fake.requestLog) expect(req.ua).toBe(UA);
  });

  it("[LDB-I8] the fake 403s a request missing the required UA", async () => {
    const fake = new FakeUpstream({ requireUA: UA });
    // A client using the WRONG UA gets 403'd by the fake -- and since 403
    // isn't 404, the client retries it 3x before giving up.
    const client = new UpstreamClient(fake.baseUrl, "some-other-ua/1.0", fake.fetchImpl, fake.sleepImpl);
    await expect(client.meta()).rejects.toThrow();
    expect(fake.requestLog.every((r) => r.ua === "some-other-ua/1.0")).toBe(true);
    expect(fake.requestLog.length).toBe(3); // 3 attempts, not retried further, not fewer
  });

  it("[LDB-I8] a 404 on detail() is not retried", async () => {
    const fake = new FakeUpstream();
    fake.set404("graphite");
    const client = new UpstreamClient(fake.baseUrl, UA, fake.fetchImpl, fake.sleepImpl);

    const result = await client.detail("graphite");
    expect(result).toEqual({ ok: false, notFound: true });
    expect(fake.requestLog.filter((r) => r.url.includes("/layouts/graphite")).length).toBe(1);
  });

  it("[LDB-I8] a persistent 500 is retried exactly 3 times, then throws", async () => {
    const fake = new FakeUpstream();
    fake.setServerError("graphite");
    const client = new UpstreamClient(fake.baseUrl, UA, fake.fetchImpl, fake.sleepImpl);

    await expect(client.detail("graphite")).rejects.toThrow();
    expect(fake.requestLog.filter((r) => r.url.includes("/layouts/graphite")).length).toBe(3);
  });

  it("[LDB-I8] a transient 500 recovers within the 3 retries", async () => {
    const fake = new FakeUpstream();
    fake.failNextRequestsMatching("/layouts/graphite", 2); // fails twice, succeeds on the 3rd
    const client = new UpstreamClient(fake.baseUrl, UA, fake.fetchImpl, fake.sleepImpl);

    const result = await client.detail("graphite");
    expect(result.ok).toBe(true);
    expect(fake.requestLog.filter((r) => r.url.includes("/layouts/graphite")).length).toBe(3);
  });

  it("[LDB-I8] ?full=1 drops duplicate names into dupNames, not byName", async () => {
    const fake = new FakeUpstream();
    fake.duplicateName("graphite");
    const client = new UpstreamClient(fake.baseUrl, UA, fake.fetchImpl, fake.sleepImpl);

    const { byName, dupNames } = await client.full();
    expect(dupNames.has("graphite")).toBe(true);
    expect(byName.has("graphite")).toBe(false);
    // an unaffected name is unaffected
    expect(byName.has("opal")).toBe(true);
    expect(dupNames.has("opal")).toBe(false);
  });

  it("[LDB-I8] list() dedupes ids and requires a string id on every entry", async () => {
    const fake = new FakeUpstream();
    const client = new UpstreamClient(fake.baseUrl, UA, fake.fetchImpl, fake.sleepImpl);
    const entries = await client.list();
    const ids = entries.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(entries.every((e) => typeof e.id === "string")).toBe(true);
  });

  // LDB-I9: proves the wiring, not just the rewrite -- `UpstreamClient`
  // (this file's own subject) parses every response through
  // `parseUpstreamJson` (src/import/upstream.ts's `fetchJson`), so a
  // Go-style `<`/`>`/`&` escape reaching `detail()` from the
  // real upstream must come out the other side as the literal character,
  // not the escape sequence -- `tests/core/safejson.test.ts` proves the
  // rewrite itself is correct in isolation; this proves it's actually in
  // the request path a real import tick uses.
  it("[LDB-I9] a Go-style \\u003c/\\u003e/\\u0026 escape in the raw upstream body survives detail() intact", async () => {
    const fake = new FakeUpstream();
    const base = fake.detailByName("graphite");
    const raw = JSON.stringify(base).replace('"graphite"', '"a\\u003cb\\u003e\\u0026c"');
    fake.setRawDetailBody("graphite", raw);
    const client = new UpstreamClient(fake.baseUrl, UA, fake.fetchImpl, fake.sleepImpl);

    const result = await client.detail("graphite");

    expect(result.ok).toBe(true);
    if (result.ok) expect((result.detail as { name: string }).name).toBe("a<b>&c");
  });
});
