// [LDB-PV3] [LDB-PV8] The GET replay differ (scripts/lab/shadow/replay*): what it reads, what it replays, how it judges. The
// servers are two loopback listeners (ports 18461 and 18462) over the harness app: the shim lab server against itself must
// give zero diffs, and an injected difference must be found.
import http from "node:http";
import { afterAll, describe, expect, it } from "vitest";
import { SELF } from "../harness";
import { writeDump } from "../../src/dump/write";
import { env } from "../harness";
import type { Bindings } from "../../src/env";
import { registerForTest } from "../../formats/registry.ts";
import { T1 } from "../formats/stub-lineage.ts";
import { CREDENTIAL_HEADERS, buildPlan, checkBase, classify, extractRequest, fetchTelemetry, headOfEtag, judge, normalizeQuery, parseArgs, readLogpush, renderMarkdown, runReplay, STATE_KINDS, summarize } from "./shadow-scripts";
import { KINDS } from "../../src/replica/shadow/apply";
import { scenario } from "./shadow-scenario";

const unregister = registerForTest(T1);
afterAll(unregister);
const bindings = env as unknown as Bindings;

describe("routes and the plan", () => {
  it("[LDB-PV8] only public GET routes are replayable: admin, /v1/me*, writes and unknown paths are not", () => {
    for (const p of ["/v1/meta", "/v1/formats", "/v1/formats/spark/1/schema.json", "/v1/layouts", "/v1/layouts/01ABC", "/v1/layouts/01ABC/likes", "/v1/layouts/x/history", "/v1/layouts/x/rev/3", "/v1/changes", "/v1/authors", "/v1/authors/123", "/v1/comment-counts", "/v1/comments", "/v1/layouts/x/comments", "/v1/wpm", "/v1/dump/latest.json", "/v1/dump", "/v1/dump/dump-2026-11-01.json.gz", "/v1/dump/monthly/dump-2026-11.json.gz"]) {
      expect(classify(p), p).not.toBeNull();
    }
    for (const p of ["/v1/me", "/v1/me/comments", "/v1/admin/clients", "/v1/admin/wpm-queue", "/admin/changelog", "/v1/layouts/x/link", "/v1/wpm/submissions/1", "/", "/v1/does-not-exist", "/v1/dump/../../etc"]) {
      expect(classify(p), p).toBeNull();
    }
  });

  it("[LDB-PV8] the plan drops writes and unknown routes, drops `wait`, de-duplicates, samples per class and paces at rps", () => {
    const reqs = [];
    for (let i = 0; i < 300; i++) reqs.push({ ts: i, method: "GET", path: "/v1/layouts", query: `?format=spark/1&limit=${50 + (i % 40)}`, inm: false });
    for (let i = 0; i < 5; i++) reqs.push({ ts: i, method: "GET", path: "/v1/meta", query: "", inm: i % 2 === 0 });
    reqs.push({ ts: 1, method: "GET", path: "/v1/changes", query: "?since=5&wait=25&limit=10", inm: false });
    reqs.push({ ts: 1, method: "GET", path: "/v1/changes", query: "?limit=10&since=5", inm: false });
    reqs.push({ ts: 1, method: "POST", path: "/v1/layouts", query: "", inm: false });
    reqs.push({ ts: 1, method: "GET", path: "/v1/me", query: "", inm: false });
    reqs.push({ ts: 1, method: "GET", path: "/v1/admin/clients", query: "", inm: false });
    const plan = buildPlan(reqs, { n: 60, perClass: 20, rps: 4, seed: 7 });
    expect(plan.dropped["method POST"]).toBe(1);
    expect(plan.dropped["not a public replayable route"]).toBe(2);
    expect(plan.items.filter((i: { class: string }) => i.class === "layouts-list").length).toBe(20);
    const changes = plan.items.filter((i: { class: string }) => i.class === "changes");
    expect(changes).toHaveLength(1); // the two spellings are one request once `wait` is gone and the parameters are sorted
    expect(changes[0].query).toBe("?limit=10&since=5");
    expect(plan.items.some((i: { class: string; inm: boolean }) => i.class === "meta" && i.inm)).toBe(true);
    expect(plan.items.some((i: { class: string; inm: boolean }) => i.class === "meta" && !i.inm)).toBe(true);
    expect(plan.items.map((i: { at: number }) => i.at)).toEqual(plan.items.map((_: unknown, k: number) => k * 250));
    expect(buildPlan(reqs, { n: 60, perClass: 20, rps: 4, seed: 7 })).toEqual(plan); // deterministic
    expect(normalizeQuery("?wait=25&b=2&a=1")).toBe("?a=1&b=2");
    expect(headOfEtag('"123:abcd"')).toBe(123);
    expect(headOfEtag('W/"7:x"')).toBe(7);
    expect(headOfEtag("abc")).toBeNull();
  });

  it("[LDB-PV8] state kinds the differ guards on cover every kind that changes comments, comment likes and wpm", () => {
    const all = new Set(Object.values(STATE_KINDS).flat());
    for (const [kind, rule] of Object.entries(KINDS)) {
      if (rule.state.some((t) => ["layout_comments", "comment_likes", "wpm_submissions"].includes(t))) expect(all.has(kind), kind).toBe(true);
    }
  });
});

describe("what is kept from a request", () => {
  const sample = {
    $metadata: { id: "evt1", service: "akl-db" },
    timestamp: 1_762_000_000_000,
    $workers: { event: { request: { url: "https://api.akldb.org/v1/layouts?format=spark/1", method: "get", headers: { authorization: "Bearer SECRET-TOKEN", cookie: "c=SECRET-COOKIE", "x-akl-signature": "SECRET-SIG", "if-none-match": '"5:abc"', "user-agent": "spark" } } } },
  };

  it("[LDB-PV8] only method, URL and the presence of If-None-Match survive; no header value, token or cookie reaches the record", () => {
    const r = extractRequest(sample);
    expect(r).toEqual({ ts: 1_762_000_000_000, method: "GET", path: "/v1/layouts", query: "?format=spark/1", inm: true });
    expect(JSON.stringify(r)).not.toMatch(/SECRET|Bearer|cookie|signature|spark"/i);
    expect(CREDENTIAL_HEADERS).toEqual(expect.arrayContaining(["authorization", "cookie", "x-akl-signature", "x-akl-client", "x-akldb-origin"]));
    // the flat dotted form and the Logpush form read the same
    expect(extractRequest({ "$workers.event.request.url": "https://api.akldb.org/v1/meta", "$workers.event.request.method": "GET" })).toMatchObject({ path: "/v1/meta", inm: false });
    expect(extractRequest({ EventTimestampMs: 5, Event: { Request: { URL: "https://api.akldb.org/v1/changes?since=1", Method: "GET" } } })).toMatchObject({ ts: 5, path: "/v1/changes", query: "?since=1" });
    expect(extractRequest({ message: "not a request" })).toBeNull();
  });

  it("[LDB-PV8] the telemetry query pages by time window and event-id cursor, de-duplicates, sends the token only to Cloudflare's endpoint, and is bounded", async () => {
    const calls: { url: string; auth: string | null; body: Record<string, unknown> }[] = [];
    const ev = (id: string) => ({ ...sample, $metadata: { id, service: "akl-db" } });
    const fetchImpl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      calls.push({ url: String(input), auth: new Headers(init?.headers).get("authorization"), body });
      const tf = body.timeframe as { from: number };
      const page = body.offset === undefined ? [ev(`a${tf.from}`), ev(`b${tf.from}`)] : body.offset === `b${tf.from}` ? [ev(`b${tf.from}`), ev(`c${tf.from}`)] : [];
      return new Response(JSON.stringify({ result: { events: { events: page } } }), { status: 200 });
    };
    const got = await fetchTelemetry({ token: "tok", fromMs: 1000, toMs: 1000 + 2 * 60_000, windowMs: 60_000, limit: 2, fetchImpl: fetchImpl as typeof fetch });
    expect(got.events.map((e: { $metadata: { id: string } }) => e.$metadata.id)).toEqual(["a1000", "b1000", "c1000", "a61000", "b61000", "c61000"]);
    for (const c of calls) {
      expect(c.url).toBe("https://api.cloudflare.com/client/v4/accounts/58a5eb82948e2134d8b7b242e9567ac4/workers/observability/telemetry/query");
      expect(c.auth).toBe("Bearer tok");
      expect(c.body).toMatchObject({ view: "events", dry: true, limit: 2, parameters: { filters: [{ key: "$metadata.service", operation: "eq", value: "akl-db" }] } });
    }
    expect(calls.filter((c) => c.body.offsetDirection === "next")).toHaveLength(4); // two per window
    await expect(fetchTelemetry({ token: "t", fromMs: 5, toMs: 5, fetchImpl: fetchImpl as typeof fetch })).rejects.toThrow(/fromMs/);
    const capped = await fetchTelemetry({ token: "t", fromMs: 0, toMs: 100 * 60_000, windowMs: 60_000, limit: 2, maxPages: 3, fetchImpl: fetchImpl as typeof fetch });
    expect(capped.truncated).toBe(true);
    expect(capped.pages).toBe(3);
  });

  it("[LDB-PV8] the replay sends only to the akldb hosts (loopback only with --allow-local), and a plan file has nothing but the whitelisted fields", () => {
    expect(checkBase("https://api.akldb.org", false)).toBe("https://api.akldb.org");
    expect(checkBase("https://shadow-api.akldb.org", false)).toBe("https://shadow-api.akldb.org");
    for (const bad of ["https://evil.example", "http://api.akldb.org", "https://api.akldb.org/v1", "http://127.0.0.1:18461"]) expect(() => checkBase(bad, false), bad).toThrow();
    expect(checkBase("http://127.0.0.1:18461", true)).toBe("http://127.0.0.1:18461");
    expect(() => checkBase("http://10.0.0.1:1", true)).toThrow();
    expect(() => parseArgs(["--cookie", "x"])).toThrow(/unknown argument/);
    const plan = buildPlan([extractRequest(sample)!], { n: 5 });
    expect(Object.keys(plan.items[0]).sort()).toEqual(["at", "class", "group", "inm", "method", "n", "path", "query", "weight"]);
  });
});

describe("the differ", () => {
  const ok = (body: unknown, headers: Record<string, string> = {}, status = 200) => ({ status, headers: { "content-type": "application/json", etag: '"10:h"', ...headers }, body: Buffer.from(JSON.stringify(body)) });

  it("[LDB-PV3] equal answers are equal, key order is not a difference, and the masked meta health block is the only masked thing", () => {
    const item = { class: "meta", group: "feed", path: "/v1/meta" };
    const a = ok({ seq: 10, health: { dump: { last_at: "x", age_s: 5 } }, author_count: 3, layout_count: 8 });
    const b = ok({ layout_count: 8, author_count: 3, health: { dump: { last_at: null, age_s: 99 } }, seq: 10 });
    expect(judge(item, a, b).verdict).toBe("equal");
    const c = ok({ seq: 10, layout_count: 9, author_count: 3 });
    const d = judge(item, a, c);
    expect(d.verdict).toBe("diff");
    expect(d.problems[0]?.detail).toContain("/layout_count");
    // a difference confined to the author fields is informational
    expect(judge(item, a, ok({ seq: 10, layout_count: 8, author_count: 4 })).verdict).toBe("diff-state");
    // other classes mask nothing
    expect(judge({ class: "layouts-list", group: "feed", path: "/v1/layouts" }, ok({ health: 1 }), ok({ health: 2 })).verdict).toBe("diff");
  });

  it("[LDB-PV3] answers at different head seqs are skipped, never compared; status and header differences are diffs", () => {
    const item = { class: "changes", group: "feed", path: "/v1/changes" };
    const r = judge(item, ok({ x: 1 }, { etag: '"10:h"' }), ok({ x: 2 }, { etag: '"11:h"' }));
    expect(r.verdict).toBe("skipped");
    expect(r.reason).toMatch(/different heads \(prod 10, shadow 11\)/);
    expect(judge(item, ok({ x: 1 }), ok({ x: 1 }, {}, 500)).problems.some((p) => p.kind === "status")).toBe(true);
    expect(judge(item, ok({ x: 1 }, { "cache-control": "public, max-age=10" }), ok({ x: 1 }, { "cache-control": "no-store" })).problems[0]?.detail).toMatch(/header cache-control/);
    expect(judge(item, ok({ x: 1 }, { "content-length": "7" }), ok({ x: 1 }, { "content-length": "8" })).verdict).toBe("equal"); // transport detail
  });

  it("[LDB-PV3] a state class that differs is a diff-state for authors, skipped when production moved that table, and a diff otherwise", () => {
    const authors = { class: "authors", group: "state", path: "/v1/authors" };
    const wpm = { class: "wpm", group: "state", path: "/v1/wpm" };
    expect(judge(authors, ok({ a: 1 }), ok({ a: 2 })).verdict).toBe("diff-state");
    expect(judge(wpm, ok({ a: 1 }), ok({ a: 2 })).verdict).toBe("diff");
    const moved = judge(wpm, ok({ a: 1 }), ok({ a: 2 }), { stateMoved: { wpm: true } });
    expect(moved.verdict).toBe("skipped");
    expect(judge(wpm, ok({ a: 1 }), ok({ a: 2 }), { stateMoved: { wpm: false } }).verdict).toBe("diff");
  });

  it("[LDB-PV3] dump answers: a different generation is skipped, the same dump file compares by bytes", () => {
    const latest = { class: "dump-latest", group: "blob", path: "/v1/dump/latest.json" };
    const l = (seq: number, sha = "a") => ({ status: 200, headers: { "content-type": "application/json" }, body: Buffer.from(JSON.stringify({ seq, key: "dump-2026-11-02.json.gz", sha256: sha })) });
    expect(judge(latest, l(5), l(5)).verdict).toBe("equal");
    expect(judge(latest, l(5), l(9)).verdict).toBe("skipped");
    expect(judge(latest, l(5, "a"), l(5, "b")).verdict).toBe("diff");
    const file = { class: "dump-file", group: "blob", path: "/v1/dump/dump-2026-11-02.json.gz" };
    const f = (bytes: string, etag: string) => ({ status: 200, headers: { "content-type": "application/gzip", etag }, body: Buffer.from(bytes) });
    expect(judge(file, f("zz", '"r2"'), f("zz", '"s3"')).verdict).toBe("equal"); // the ETag of a dump file is not compared, the bytes are
    expect(judge(file, f("zz", '"r2"'), f("zy", '"r2"')).verdict).toBe("diff");
  });
});

describe("the replay over two servers", () => {
  const PORT_A = 18461;
  const PORT_B = 18462;
  type Mutate = (path: string, res: { status: number; headers: Record<string, string>; body: string }) => { status: number; headers: Record<string, string>; body: string };

  function serve(port: number, mutate: Mutate = (_p, r) => r): Promise<http.Server> {
    const server = http.createServer(async (req, res) => {
      try {
        const out = await SELF.fetch(`https://api.akldb.org${req.url}`, { headers: { "user-agent": String(req.headers["user-agent"] ?? ""), ...(req.headers["if-none-match"] !== undefined ? { "if-none-match": String(req.headers["if-none-match"]) } : {}) } });
        const headers: Record<string, string> = {};
        out.headers.forEach((v, k) => (headers[k] = v));
        const m = mutate(req.url ?? "", { status: out.status, headers, body: await out.text() });
        res.writeHead(m.status, m.headers);
        res.end(m.body);
      } catch (e) {
        res.writeHead(500);
        res.end(String(e));
      }
    });
    return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve(server)));
  }
  const close = (s: http.Server): Promise<void> => new Promise((r) => s.close(() => r()));

  async function plan(seed: number) {
    const sc = await scenario(seed);
    await sc.run(40);
    await sc.stateChange(`replay-${seed}`);
    await writeDump(bindings, sc.clock);
    const layouts = (await (await SELF.fetch("https://api.akldb.org/v1/layouts?format=spark/1&limit=50")).json()) as { items?: { id: string }[] } | { id: string }[];
    const list = Array.isArray(layouts) ? layouts : (layouts.items ?? []);
    const id = list[0]!.id;
    const reqs = [
      ["/v1/meta", "", false], ["/v1/meta", "", true], ["/v1/formats", "", false], ["/v1/layouts", "?format=spark/1&limit=50", true], ["/v1/layouts", "?format=spark/1&limit=3&sort=name", false],
      [`/v1/layouts/${id}`, "?format=spark/1", true], [`/v1/layouts/${id}/likes`, "", false], [`/v1/layouts/${id}/history`, "", false],
      ["/v1/changes", "?since=0&limit=20", true], ["/v1/authors", "", false], ["/v1/dump/latest.json", "", false], ["/v1/comments", "", false], ["/v1/wpm", "", false], ["/v1/comment-counts", "", false],
    ].map(([path, query, inm], i) => ({ ts: i, method: "GET", path: path as string, query: query as string, inm: inm as boolean }));
    return buildPlan(reqs, { n: 50, rps: 1000, seed: 3 });
  }

  it("[LDB-PV3] the server against itself: zero diffs, 304 revalidations equal, the summary counts them by class", async () => {
    const p = await plan(81);
    const [a, b] = [await serve(PORT_A), await serve(PORT_B)];
    try {
      const records = await runReplay({ plan: p, prod: `http://127.0.0.1:${PORT_A}`, shadow: `http://127.0.0.1:${PORT_B}`, guard: false, sleep: async () => {} });
      const bad = records.filter((r: { verdict: string }) => r.verdict !== "equal");
      expect(bad.map((r: { path: string; verdict: string; reason?: string; problems: unknown[] }) => `${r.verdict} ${r.path} ${r.reason ?? JSON.stringify(r.problems)}`)).toEqual([]);
      expect(records.filter((r: { phase: string }) => r.phase === "304").length).toBeGreaterThanOrEqual(3);
      const s = summarize(records);
      expect(s.totals.equal).toBe(records.length);
      expect(s.byClass["layouts-list"]).toBeTruthy();
      const md = renderMarkdown(records, { from: "a", to: "b" });
      expect(md).toContain("| route class | equal | diff | diff-state | skipped | error |");
      expect(md).toContain("| **all** |");
    } finally {
      await Promise.all([close(a), close(b)]);
    }
  });

  it("[LDB-PV3] an injected difference in a body, a header, a status and a head seq is reported as such; nothing is silently equal", async () => {
    const p = await plan(82);
    const mutate: Mutate = (path, r) => {
      if (path.startsWith("/v1/layouts?") && path.includes("limit=3")) return { ...r, body: r.body.replace(/"name":"([^"]+)"/, '"name":"tampered-$1"') };
      if (path.startsWith("/v1/formats")) return { ...r, headers: { ...r.headers, "cache-control": "no-store" } };
      if (path.endsWith("/likes")) return { ...r, status: 503 };
      if (path.startsWith("/v1/changes")) return { ...r, headers: { ...r.headers, etag: r.headers.etag?.replace(/^"(\d+)/, (_m, n) => `"${Number(n) + 1}`) ?? "" } };
      return r;
    };
    const [a, b] = [await serve(PORT_A), await serve(PORT_B, mutate)];
    try {
      const records = await runReplay({ plan: p, prod: `http://127.0.0.1:${PORT_A}`, shadow: `http://127.0.0.1:${PORT_B}`, guard: false, sleep: async () => {} });
      const by = (cls: string, phase = "200") => records.find((r: { class: string; phase: string }) => r.class === cls && r.phase === phase);
      expect(by("layouts-list")?.verdict).toBeDefined();
      const tampered = records.filter((r: { class: string; verdict: string }) => r.class === "layouts-list" && r.verdict === "diff");
      expect(tampered).toHaveLength(1);
      expect(tampered[0].problems[0].detail).toContain("tampered-");
      expect(by("formats")?.verdict).toBe("diff");
      expect(by("formats")?.problems[0].detail).toMatch(/header cache-control/);
      expect(by("layout-sub")?.verdict).toBe("diff");
      expect(by("changes")?.verdict).toBe("skipped");
      expect(by("changes")?.reason).toMatch(/different heads/);
      const s = summarize(records);
      expect(s.totals.diff).toBeGreaterThanOrEqual(3);
      expect(s.skipReasons["different heads (prod N, shadow N)"]).toBeGreaterThanOrEqual(1);
    } finally {
      await Promise.all([close(a), close(b)]);
    }
  });

  it("[LDB-PV3] the state guard turns a state-class difference into a skip when production moved that table after shadow's last dump", async () => {
    const p = await plan(83);
    const mutate: Mutate = (path, r) => (path.startsWith("/v1/wpm") ? { ...r, body: JSON.stringify({ different: true }) } : path.startsWith("/v1/changes?since=") && path.includes("kinds=wpm_") ? { ...r, body: JSON.stringify({ next: 9, items: [{ seq: 9 }] }) } : r);
    // prod answers the guard's query with one wpm event; shadow answers its latest.json normally
    const [a, b] = [await serve(PORT_A, mutate), await serve(PORT_B, (path, r) => (path.startsWith("/v1/wpm") ? { ...r, body: JSON.stringify({ different: true, again: 1 }) } : r))];
    try {
      const records = await runReplay({ plan: p, prod: `http://127.0.0.1:${PORT_A}`, shadow: `http://127.0.0.1:${PORT_B}`, sleep: async () => {} });
      const wpm = records.find((r: { class: string }) => r.class === "wpm");
      expect(wpm?.verdict).toBe("skipped");
      expect(wpm?.reason).toMatch(/production changed this state/);
    } finally {
      await Promise.all([close(a), close(b)]);
    }
  });
});

describe("Logpush source", () => {
  it("[LDB-PV8] a Logpush file yields requests without any header", async () => {
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "akldb-lp-"));
    fs.writeFileSync(path.join(dir, "a.ndjson"), [JSON.stringify({ EventTimestampMs: 1, Event: { Request: { URL: "https://api.akldb.org/v1/meta", Method: "GET" }, Response: { Status: 200 } } }), "not json", JSON.stringify({ other: 1 })].join("\n"));
    expect(readLogpush(dir)).toEqual([{ ts: 1, method: "GET", path: "/v1/meta", query: "", inm: false }]);
    fs.rmSync(dir, { recursive: true });
  });
});
