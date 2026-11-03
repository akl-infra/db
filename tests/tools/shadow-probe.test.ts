// [LDB-PV9] The probe's measurement (infra/probe/measure.mjs): latency-compare.py's statistics, ported. Two loopback servers
// (ports 18463 and 18464) stand in for prod and shadow.
import http from "node:http";
import { describe, expect, it } from "vitest";
// @ts-expect-error -- plain script, no declaration file
import * as measureMod from "../../infra/probe/measure.mjs";
// @ts-expect-error -- plain script, no declaration file
import * as indexMod from "../../infra/probe/index.mjs";

/* eslint-disable @typescript-eslint/no-explicit-any */
const { pct, probe, client, ROUTES, ALLOWED_HOSTS } = measureMod as any;
const { handler } = indexMod as any;

describe("probe statistics", () => {
  it("[LDB-PV9] pct() equals latency-compare.py's (nearest index, round half to even), vectors taken from the Python", () => {
    const vectors: [number, number, number][] = [[1, 0.5, 1], [1, 0.95, 1], [2, 0.5, 1], [2, 0.95, 2], [3, 0.5, 2], [3, 0.95, 3], [10, 0.5, 5], [10, 0.95, 10], [11, 0.5, 6], [11, 0.95, 11], [20, 0.5, 11], [20, 0.95, 19], [21, 0.5, 11], [21, 0.95, 20]];
    for (const [n, p, want] of vectors) expect(pct(Array.from({ length: n }, (_, i) => n - i), p), `n=${n} p=${p}`).toBe(want);
    expect(Number.isNaN(pct([], 0.5))).toBe(true);
    expect(ROUTES.map((r: string[]) => r[0])).toEqual(["/v1/meta", "/v1/formats", "/v1/layouts?format=spark/1&limit=50", "/v1/authors", "/v1/comment-counts", "/v1/changes?since=0&limit=50", "/v1/wpm", "/v1/dump/latest.json", "/v1/does-not-exist"]);
  });
});

describe("probe run", () => {
  function server(port: number, delayMs: number) {
    const seen = { requests: 0, connections: 0, conditional: 0, byPath: {} as Record<string, number> };
    const s = http.createServer((req, res) => {
      seen.requests++;
      seen.byPath[req.url ?? ""] = (seen.byPath[req.url ?? ""] ?? 0) + 1;
      setTimeout(() => {
        if ((req.url ?? "").startsWith("/v1/does-not-exist") || (req.url ?? "").startsWith("/v1/formats")) {
          res.writeHead(req.url === "/v1/formats" ? 200 : 404, req.url === "/v1/formats" ? {} : { "cf-cache-status": "DYNAMIC" });
          return res.end("x");
        }
        const etag = '"7:abc"';
        if (req.headers["if-none-match"] === etag) {
          seen.conditional++;
          res.writeHead(304, { etag });
          return res.end();
        }
        res.writeHead(200, { etag, "cf-cache-status": "DYNAMIC" });
        res.end("{}");
      }, delayMs);
    });
    s.on("connection", () => void seen.connections++);
    return new Promise<{ s: http.Server; seen: typeof seen }>((r) => s.listen(port, "127.0.0.1", () => r({ s, seen })));
  }

  it("[LDB-PV9] per route and host: n full responses (the warm-up dropped), n revalidations with the ETag the host gave, one keep-alive connection per host", async () => {
    const a = await server(18463, 1);
    const b = await server(18464, 12);
    try {
      const out = await probe({ targets: { prod: "http://127.0.0.1:18463", shadow: "http://127.0.0.1:18464" }, n: 5, allowLocal: true });
      expect(out.routes).toHaveLength(9);
      const meta = out.routes.find((r: any) => r.path === "/v1/meta");
      for (const l of ["prod", "shadow"]) {
        expect(meta.hosts[l].full).toHaveLength(5);
        expect(meta.hosts[l].revalid).toHaveLength(5);
        expect(meta.hosts[l].statuses).toEqual([200, 304]);
        expect(meta.hosts[l].cache).toEqual(["DYNAMIC"]);
        expect(meta.hosts[l].errors).toBe(0);
      }
      expect(meta.hosts.prod.p50).toBeLessThan(meta.hosts.shadow.p50);
      // static and 404 routes have no ETag: no revalidation samples
      expect(out.routes.find((r: any) => r.path === "/v1/does-not-exist").hosts.prod.revalid).toHaveLength(0);
      expect(out.routes.find((r: any) => r.path === "/v1/does-not-exist").hosts.prod.statuses).toEqual([404]);
      // keep-alive: every request of the whole run on one connection per host
      expect(a.seen.connections).toBe(1);
      expect(b.seen.connections).toBe(1);
      expect(a.seen.requests).toBe(b.seen.requests);
      expect(a.seen.conditional).toBeGreaterThanOrEqual(5 * 6);
      // the user agent is latency-compare's, and nothing but GET paths of the route list was requested
      expect(Object.keys(a.seen.byPath).sort()).toEqual(ROUTES.map((r: string[]) => r[0]).sort());
    } finally {
      await Promise.all([new Promise((r) => a.s.close(r)), new Promise((r) => b.s.close(r))]);
    }
  });

  it("[LDB-PV9] the probe measures only the akldb hosts over https: anything else is refused, loopback only for tests", async () => {
    expect([...ALLOWED_HOSTS].sort()).toEqual(["api.akldb.org", "shadow-api.akldb.org", "staging-api.akldb.org"]);
    for (const bad of ["https://evil.example", "http://api.akldb.org", "https://api.akldb.org.evil.example", "http://127.0.0.1:1"]) expect(() => client(bad), bad).toThrow(/measures only/);
    await expect(handler({ targets: { x: "https://evil.example" } })).rejects.toThrow(/measures only/);
  });
});
