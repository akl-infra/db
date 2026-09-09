// [LDB-H3] GET /admin/changelog (12 §3 X3): a rendering of the feed, never
// a second source -- every property below is checked AGAINST `/v1/changes`'
// own JSON for the same params, never against a hand-typed expectation of
// what the feed "should" contain.
import { SELF } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { appendWrite } from "../../src/core/events";
import { fixedClock } from "../../src/core/time";
import { db, seedUpstream100 } from "./support";

const CMINI_PAYLOAD = { board: "ortho" as const, keys: {} };

function extractSeqs(html: string): number[] {
  return [...html.matchAll(/data-seq="(\d+)"/g)].map((m) => Number(m[1]!));
}

function extractHref(html: string, label: "newer" | "older"): string {
  const m = new RegExp(`<a href="([^"]+)">${label}</a>`).exec(html);
  if (m === null) throw new Error(`no '${label}' link found in:\n${html}`);
  return m[1]!.replace(/&amp;/g, "&"); // renderPage escapes hrefs like any other interpolated string
}

async function fetchChanges(query: string): Promise<{ next: number; items: { seq: number }[] }> {
  const res = await SELF.fetch(`https://example.com/v1/changes${query}`);
  expect(res.status).toBe(200);
  return res.json();
}

async function fetchChangelog(query: string): Promise<{ status: number; html: string }> {
  const res = await SELF.fetch(`https://example.com/admin/changelog${query}`);
  return { status: res.status, html: await res.text() };
}

beforeAll(async () => {
  await seedUpstream100();
});

describe("GET /admin/changelog", () => {
  // Every combo here is compared against `/v1/changes`' own JSON for the
  // IDENTICAL params (`limit=100` matching the page's fixed page size) --
  // the page is required to agree with the API, not with a value this file
  // invents.
  const MATRIX = ["?since=0", "?since=0&kinds=imported", "?since=0&layout=40kwh", "?since=0&actor=system:cmini-import", "?since=20"];

  it.each(MATRIX)("[LDB-H3] the rendered data-seq set for '%s' equals /v1/changes' items", async (query) => {
    const { html } = await fetchChangelog(query);
    const changes = await fetchChanges(`${query}&limit=100`);
    expect(new Set(extractSeqs(html))).toEqual(new Set(changes.items.map((i) => i.seq)));
  });

  it("[LDB-H3] rows render newest-first", async () => {
    const { html } = await fetchChangelog("?since=0");
    const seqs = extractSeqs(html);
    expect(seqs.length).toBeGreaterThan(0);
    expect(seqs).toEqual([...seqs].sort((a, b) => b - a));
  });

  it("[LDB-H3] a name with '<'/'>' is escaped, never rendered as a literal tag", async () => {
    const clock = fixedClock("2026-06-15T00:00:00.000Z");
    const { record } = await appendWrite(db, clock, {
      kind: "created",
      name: "<b>x",
      owner: "700000000000000001",
      modified_at: "2026-06-15T00:00:00.000Z",
      format: "cmini/1",
      payload: CMINI_PAYLOAD,
      actor: "700000000000000001",
      via: "discord",
      hasMagic: false,
    });

    const { html } = await fetchChangelog(`?layout=${record.id}`);
    expect(html).toContain("&lt;b&gt;x");
    expect(html).not.toContain("<b>x");
    // No literal <b> opening tag anywhere on the page (the escaped name is
    // the only place "b>" could appear from user data).
    expect(html.includes("<b>")).toBe(false);
  });

  it("[LDB-H3] the 'newer'/'older' links chain to the same sets /v1/changes paging gives", async () => {
    const { html } = await fetchChangelog("?since=0");
    const newerQuery = extractHref(html, "newer").replace("/admin/changelog", "");
    const olderQuery = extractHref(html, "older").replace("/admin/changelog", "");

    const { html: newerHtml } = await fetchChangelog(newerQuery);
    const { html: olderHtml } = await fetchChangelog(olderQuery);

    const newerChanges = await fetchChanges(`${newerQuery}&limit=100`);
    const olderChanges = await fetchChanges(`${olderQuery}&limit=100`);

    expect(new Set(extractSeqs(newerHtml))).toEqual(new Set(newerChanges.items.map((i) => i.seq)));
    expect(new Set(extractSeqs(olderHtml))).toEqual(new Set(olderChanges.items.map((i) => i.seq)));
  });

  it("[LDB-H3] 304 on a matching If-None-Match", async () => {
    const first = await SELF.fetch("https://example.com/admin/changelog");
    expect(first.status).toBe(200);
    const etag = first.headers.get("ETag");
    expect(etag).toBeTruthy();

    const second = await SELF.fetch("https://example.com/admin/changelog", { headers: { "If-None-Match": etag! } });
    expect(second.status).toBe(304);
    expect(await second.text()).toBe("");
    expect(second.headers.get("ETag")).toBe(etag);
  });

  it("[LDB-H3] layout= by name and by id agree", async () => {
    const detailRes = await SELF.fetch("https://example.com/v1/layouts/40kwh");
    expect(detailRes.status).toBe(200);
    const detail = await detailRes.json<{ id: string }>();

    const byName = await fetchChangelog("?layout=40kwh&since=0");
    const byId = await fetchChangelog(`?layout=${detail.id}&since=0`);
    const seqs = extractSeqs(byName.html);
    expect(seqs.length).toBeGreaterThan(0);
    expect(new Set(seqs)).toEqual(new Set(extractSeqs(byId.html)));
  });

  it("[LDB-H3] an unknown layout= 404s, same as /v1/changes", async () => {
    const res = await SELF.fetch("https://example.com/admin/changelog?layout=does-not-exist-xyz");
    expect(res.status).toBe(404);
    const body = await res.json<{ error: string }>();
    expect(body.error).toBe("not_found");
  });
});
