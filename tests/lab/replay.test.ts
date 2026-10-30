// Lane R: the Logpush replay (scripts/lab/replay/, design/aws-port.md §5.1). Pure and local: the fixtures under
// tests/lab/fixtures/replay/ are hand-shaped Logpush NDJSON plus before/after exports produced by the repo's own
// `exportRows` from a seeded lab store (scripts/lab/replay/gen-fixtures.mjs). The sides are in-process fakes.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { describe, expect, it } from "vitest";

/* eslint-disable @typescript-eslint/no-explicit-any */
const R = path.join(process.cwd(), "scripts/lab/replay");
const load = async (f: string): Promise<any> => import(/* @vite-ignore */ path.join(R, f));
const FIX = path.join(process.cwd(), "tests/lab/fixtures/replay");

async function fixturePlan(opts: any = {}) {
  const { readLogs } = await load("parse.mjs");
  const { loadExport } = await load("exports.mjs");
  const { buildPlan } = await load("plan.mjs");
  const logs = readLogs(path.join(FIX, "logs"));
  const before = loadExport(path.join(FIX, "before.json.gz"));
  const after = loadExport(path.join(FIX, "after.json.gz"));
  return { logs, before, after, plan: buildPlan(logs.requests, { before, after }, opts) };
}

const item = (plan: any, method: string, re: RegExp, nth = 0) => plan.items.filter((i: any) => i.method === method && re.test(i.path))[nth];
const body = (i: any) => JSON.parse(i.body.toString("utf8"));

/** A fake side: records wires, answers with an ETag per path and a minted id for POSTs. */
function fakeSide(name: string, mint = (n: number) => `${name}-id-${n}`) {
  const wires: any[] = [];
  let n = 0;
  let version = 0;
  return {
    name,
    wires,
    bump: () => version++,
    async send(w: any) {
      wires.push(w);
      if (w.method !== "GET") {
        version++;
        return { status: 201, headers: {}, body: Buffer.from(JSON.stringify({ id: mint(++n) })) };
      }
      const inm = w.headers["If-None-Match"];
      const etag = `"${w.pathWithQuery}@${version}"`;
      if (inm === etag) return { status: 304, headers: { etag }, body: Buffer.alloc(0) };
      return { status: 200, headers: { etag }, body: Buffer.from("{}") };
    },
  };
}
const noClock = () => {
  let t = 0;
  const sleeps: number[] = [];
  return { sleeps, now: () => t, sleep: async (ms: number) => { sleeps.push(ms); t += ms; } };
};
const mkItem = (i: number, ts: number, o: any = {}) => ({ i, kind: "read", method: "GET", path: `/v1/x/${i}`, query: "", body: null, headers: {}, actor: null, mint: null, notes: [], logged: { ts, status: 200, wallMs: 0 }, ...o });

describe("parser", () => {
  it("[LDB-PG35] reads a Logpush tree of gzip NDJSON, nested or dotted keys, counts bad lines, sorts by EventTimestampMs", async () => {
    const { readLogs, parseLine, parseBuffer } = await load("parse.mjs");
    const { logs } = await fixturePlan();
    expect(logs.files).toBe(2);
    expect(logs.errors).toEqual({ json: 1 }); // the one garbage line is counted, not dropped silently
    expect(logs.requests).toHaveLength(518);
    expect(logs.requests.every((r: any, i: number) => i === 0 || logs.requests[i - 1].ts <= r.ts)).toBe(true);
    const r = logs.requests.find((x: any) => x.path === "/v1/changes");
    expect(r).toMatchObject({ method: "GET", query: "?since=0&limit=50&wait=20", status: 200, outcome: "ok", script: "akldb", wallMs: 20000 });
    // the flattened form and plain (non-gzip) input parse the same
    const flat = JSON.stringify({ EventTimestampMs: 5, "Event.Request.URL": "https://api.akldb.org/v1/meta?x=1", "Event.Request.Method": "get", "Event.Response.Status": 304, Outcome: "ok" });
    expect(parseLine(flat)).toMatchObject({ ts: 5, method: "GET", path: "/v1/meta", query: "?x=1", status: 304 });
    expect(parseLine('{"nope":1}')).toEqual({ error: "not-a-request" });
    expect(parseBuffer(Buffer.from(`${flat}\n\n`)).requests).toHaveLength(1);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "replay-logs-"));
    fs.mkdirSync(path.join(dir, "20261030", "20261030"), { recursive: true });
    fs.writeFileSync(path.join(dir, "20261030", "20261030", "a_b_c.log.gz"), zlib.gzipSync(`${flat}\n`));
    expect(readLogs(dir).requests).toHaveLength(1);
    expect(readLogs(dir, { script: "other" }).requests).toHaveLength(0);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("ordering", () => {
  it("[LDB-PG36] dispatches in EventTimestampMs order at (ts - ts0) / speed, 1x and 10x, with the lab clock always the original time", async () => {
    const { schedule, runPlan } = await load("run.mjs");
    const { createSigner } = await load("sign.mjs");
    const { diffPair } = await load("diff-shim.mjs");
    const items = [mkItem(0, 1_000_000), mkItem(1, 1_002_000), mkItem(2, 1_010_000)];
    expect(schedule(items, 1).map((s: any) => s.dueMs)).toEqual([0, 2000, 10000]);
    expect(schedule(items, 10).map((s: any) => s.dueMs)).toEqual([0, 200, 1000]);
    for (const speed of [1, 10]) {
      const a = fakeSide("a");
      const b = fakeSide("b");
      const clock = noClock();
      const res = await runPlan({ items }, { sides: [a, b], diffPair, signer: createSigner(), speed, clock });
      expect(a.wires.map((w: any) => w.pathWithQuery)).toEqual(["/v1/x/0", "/v1/x/1", "/v1/x/2"]);
      expect(a.wires.map((w: any) => w.headers["x-lab-now"])).toEqual(items.map((x) => new Date(x.logged.ts).toISOString()));
      expect(a.wires.map((w: any) => w.headers["x-lab-seed"])).toEqual(b.wires.map((w: any) => w.headers["x-lab-seed"]));
      expect(clock.sleeps.reduce((s, x) => s + x, 0)).toBe(10000 / speed);
      expect(res.diffs).toEqual([]);
    }
    // A slow side makes a request late, never early, and the lag is reported.
    const slowClock = { t: 0, now() { return this.t; }, async sleep(ms: number) { this.t += ms; } };
    const slow = { name: "slow", async send() { slowClock.t += 5000; return { status: 200, headers: {}, body: Buffer.alloc(0) }; } };
    const res = await runPlan({ items }, { sides: [slow, slow], diffPair, signer: createSigner(), speed: 1, clock: slowClock, concurrency: 1 });
    expect(res.lagMaxMs).toBeGreaterThan(0);
  });

  it("[LDB-PG37] a write is a barrier (earlier requests finish first, later ones wait), a long-poll is not", async () => {
    const { runPlan } = await load("run.mjs");
    const { createSigner } = await load("sign.mjs");
    const { diffPair } = await load("diff-shim.mjs");
    const log: string[] = [];
    let releaseHold: () => void = () => {};
    const hold = new Promise<void>((r) => (releaseHold = r));
    const delays: Record<string, number> = { "/v1/x/0": 15, "/v1/x/1": 5 };
    const side = (name: string) => ({
      name,
      async send(w: any) {
        const p = w.pathWithQuery;
        if (name === "b") return { status: 200, headers: {}, body: Buffer.alloc(0) };
        log.push(`start ${p}`);
        if (p.startsWith("/v1/changes")) await hold;
        else if (w.method === "PUT") releaseHold(); // the write wakes the long-poll
        await new Promise((r) => setTimeout(r, delays[p] ?? 1));
        log.push(`end ${p}`);
        return { status: 200, headers: {}, body: Buffer.alloc(0) };
      },
    });
    const items = [
      mkItem(0, 0), // slow read
      mkItem(1, 1), // quick read
      mkItem(2, 2, { kind: "longpoll", path: "/v1/changes", query: "?wait=20", actor: "1" }),
      mkItem(3, 3, { kind: "write", method: "PUT", path: "/v1/w" }),
      mkItem(4, 4), // after the write
    ];
    const clock = { now: () => 0, sleep: async () => {} };
    await runPlan({ items }, { sides: [side("a"), side("b")], diffPair, signer: createSigner(), speed: 1, clock, concurrency: 4 });
    const at = (s: string) => log.indexOf(s);
    expect(at("start /v1/changes?wait=20")).toBeLessThan(at("start /v1/w")); // held while the write is dispatched
    expect(at("end /v1/x/0")).toBeLessThan(at("start /v1/w")); // the barrier waited for the earlier reads
    expect(at("end /v1/x/1")).toBeLessThan(at("start /v1/w"));
    expect(at("end /v1/w")).toBeLessThan(at("start /v1/x/4")); // nothing starts while the write runs
    expect(at("end /v1/changes?wait=20")).toBeGreaterThan(at("start /v1/w")); // the long-poll did not hold the write back
  });

  it("[LDB-PG38] a long-poll never holds real time at 10x: wait is kept at 1x and scaled to ceil(wait / N), at least 1 s, above it", async () => {
    const { scaleWait } = await load("run.mjs");
    expect(scaleWait("?since=0&wait=20", 1)).toBe("?since=0&wait=20");
    expect(scaleWait("?since=0&wait=20", 10)).toBe("?since=0&wait=2");
    expect(scaleWait("?wait=25&limit=5", 10)).toBe("?wait=3&limit=5");
    expect(scaleWait("?wait=3", 10)).toBe("?wait=1");
    expect(scaleWait("?wait=0", 10)).toBe("?wait=0");
    expect(scaleWait("?wait=abc", 10)).toBe("?wait=abc");
    const { plan } = await fixturePlan();
    const lp = plan.items.filter((i: any) => i.kind === "longpoll");
    expect(lp).toHaveLength(1);
    expect(lp[0].actor).not.toBeNull(); // the wait gate needs a registered client
    // end to end: the scaled query is what reaches the sides
    const { runPlan } = await load("run.mjs");
    const { createSigner } = await load("sign.mjs");
    const { diffPair } = await load("diff-shim.mjs");
    const a = fakeSide("a");
    const b = fakeSide("b");
    await runPlan({ items: [lp[0]] }, { sides: [a, b], diffPair, signer: createSigner(), speed: 10, clock: noClock() });
    expect(a.wires[0].pathWithQuery).toBe("/v1/changes?since=0&limit=50&wait=2");
  });
});

describe("304 and ids", () => {
  it("[LDB-PG39] a logged 304 is replayed with each side's then-current ETag (re-primed after a write)", async () => {
    const { runPlan } = await load("run.mjs");
    const { createSigner } = await load("sign.mjs");
    const { diffPair } = await load("diff-shim.mjs");
    const items = [
      mkItem(0, 0, { path: "/v1/meta", conditional304: true, logged: { ts: 0, status: 304, wallMs: 0 } }),
      mkItem(1, 1, { kind: "write", method: "POST", path: "/v1/w" }),
      mkItem(2, 2, { path: "/v1/meta", conditional304: true, logged: { ts: 2, status: 304, wallMs: 0 } }),
    ];
    const a = fakeSide("a", (n) => `id-${n}`);
    const b = fakeSide("b", (n) => `id-${n}`);
    const res = await runPlan({ items }, { sides: [a, b], diffPair, signer: createSigner(), speed: 1, clock: noClock() });
    const metas = a.wires.filter((w: any) => w.pathWithQuery === "/v1/meta");
    expect(metas.map((w: any) => w.headers["If-None-Match"])).toEqual([undefined, '"/v1/meta@0"', undefined, '"/v1/meta@1"']); // prime, conditional, prime, conditional
    expect(res.primes).toBe(2);
    expect(res.results.filter((r: any) => !r.prime).map((r: any) => r.status)).toEqual([[304, 304], [201, 201], [304, 304]]);
    expect(res.diffs).toEqual([]);
    // and the fixture marks exactly the logged 304
    const { plan } = await fixturePlan();
    expect(plan.items.filter((i: any) => i.conditional304)).toHaveLength(1);
  });

  it("[LDB-PG45] ids the lab mints replace the logged ones in later paths and bodies, per side", async () => {
    const { runPlan } = await load("run.mjs");
    const { createSigner } = await load("sign.mjs");
    const { diffPair } = await load("diff-shim.mjs");
    const orig = "01ORIGINALORIGINALORIGINAL";
    const items = [
      mkItem(0, 0, { kind: "write", method: "POST", path: "/v1/layouts", mint: { kind: "layout", orig }, body: Buffer.from('{"name":"n"}') }),
      mkItem(1, 1, { path: `/v1/layouts/${orig}` }),
      mkItem(2, 2, { kind: "write", method: "POST", path: `/v1/layouts/${orig}/transfer`, body: Buffer.from(`{"ref":"${orig}"}`) }),
    ];
    const a = fakeSide("a", (n) => `A${n}`);
    const b = fakeSide("b", (n) => `B${n}`);
    await runPlan({ items }, { sides: [a, b], diffPair, signer: createSigner(), clock: noClock() });
    expect(a.wires.map((w: any) => w.pathWithQuery)).toEqual(["/v1/layouts", "/v1/layouts/A1", "/v1/layouts/A1/transfer"]);
    expect(b.wires.map((w: any) => w.pathWithQuery)).toEqual(["/v1/layouts", "/v1/layouts/B1", "/v1/layouts/B1/transfer"]);
    expect(a.wires[2].body.toString()).toBe('{"ref":"A1"}');
  });
});

describe("actors and rebuilt bodies", () => {
  it("[LDB-PG40] actor inference: the submitter for receipts, an admin for queues, the event's actor for writes, else a lab actor", async () => {
    const { plan, after } = await fixturePlan();
    const ids = JSON.parse(fs.readFileSync(path.join(FIX, "ids.json"), "utf8"));
    const { LAB_USER } = await load("sign.mjs");
    expect(item(plan, "GET", /\/v1\/wpm\/submissions\//).actor).toBe(ids.A); // A submitted it
    expect(item(plan, "GET", /\/v1\/admin\/link-queue/).actor).toBe(ids.admin);
    expect(item(plan, "GET", /\/v1\/admin\/bans/).actor).toBe(ids.admin);
    expect(item(plan, "GET", /^\/v1\/me$/).actor).toBe(LAB_USER);
    expect(item(plan, "POST", /^\/v1\/layouts$/).actor).toBe(ids.A);
    expect(item(plan, "POST", /transfer$/).actor).toBe(ids.B);
    expect(item(plan, "DELETE", /^\/v1\/layouts\/[^/]+$/).actor).toBe(ids.C);
    expect(item(plan, "PUT", /\/like$/, 0).actor).toBe(ids.B);
    // the repeat like logged no event: the most recent liker stands in, so the repeat stays a no-op
    expect(item(plan, "PUT", /\/like$/, 1).actor).toBe(ids.B);
    // plain public reads carry no signature
    expect(item(plan, "GET", /^\/v1\/meta$/).actor).toBeNull();
    expect(after.events.length).toBe(28);
  });

  it("[LDB-PG41] layout writes are rebuilt from the window's events and revs, with the If-Match of the rev before the event", async () => {
    const { plan, after } = await fixturePlan();
    const create = item(plan, "POST", /^\/v1\/layouts$/);
    const createdEv = after.events.find((e: any) => e.kind === "created" && e.name === "gamma");
    const rev = after.revsByEventSeq.get(createdEv.seq + 1) ?? after.revsByEventSeq.get(createdEv.seq);
    expect(body(create)).toEqual({ name: "gamma", format: "spark/1", payload: JSON.parse(rev.payload_json) });
    expect(create.mint).toEqual({ kind: "layout", orig: createdEv.layout_id });
    const put = item(plan, "PUT", /^\/v1\/layouts\/[^/]+$/);
    expect(put.headers).toEqual({ "If-Match": '"spark:1"' });
    expect(Object.keys(body(put)).sort()).toEqual(["format", "payload"]);
    const patch = item(plan, "PATCH", /^\/v1\/layouts\//);
    expect(body(patch)).toEqual({ name: "beta2" });
    expect(patch.headers).toEqual({ "If-Match": '"layout:1"' });
    expect(body(item(plan, "POST", /transfer$/))).toEqual({ to: "100000000000000004" });
    expect(item(plan, "POST", /transfer$/).headers).toEqual({ "If-Match": '"layout:2"' });
    expect(item(plan, "DELETE", /^\/v1\/layouts\/[^/]+$/).headers).toEqual({ "If-Match": '"layout:3"' });
    expect(body(item(plan, "POST", /restore$/))).toEqual({});
    // a layout named in the URL (not by id) resolves through the window's renames
    expect(plan.skipped.some((s: any) => s.reason === "unresolved-ref")).toBe(false);
    expect(item(plan, "PUT", /\/layouts\/beta2\/like$/)).toBeDefined();
  });

  it("[LDB-PG42] moderation decisions rebuild from events and the review history: review_version, the reopened status, the reason", async () => {
    const { plan } = await fixturePlan();
    const q = (re: RegExp) => item(plan, "POST", re);
    expect(body(q(/wpm-queue\/[^/]+\/approve$/))).toEqual({ review_version: 0 });
    expect(body(q(/wpm-queue\/[^/]+\/reopen$/))).toEqual({ status: "approved", review_version: 0 });
    expect(body(q(/wpm-queue\/[^/]+\/reject$/))).toEqual({ reason: "fixture", review_version: 1 }); // after one reopen
    expect(body(q(/link-queue\/[^/]+\/approve$/))).toEqual({});
    expect(body(q(/comment-queue\/[^/]+\/approve$/))).toEqual({ review_version: 0 });
    expect(q(/wpm-queue\/[^/]+\/reject$/).actor).toBe("100000000000000001");
    expect(body(item(plan, "PUT", /\/admin\/bans\//))).toEqual({ reason: "fixture" });
    expect(item(plan, "DELETE", /\/admin\/bans\//).body).toBeNull();
  });

  it("[LDB-PG43] submit bodies come from the after export by submission id; an erased comment gets a generated body of the same length", async () => {
    const { plan, after } = await fixturePlan();
    expect(body(item(plan, "PUT", /\/link$/))).toEqual({ url: "https://example.com/replay-fixture" });
    expect(body(item(plan, "POST", /^\/v1\/wpm$/))).toMatchObject({ wpm: 120, proof: "https://www.youtube.com/watch?v=replayfx1" });
    expect(body(item(plan, "POST", /^\/v1\/admin\/wpm$/))).toMatchObject({ user_id: "100000000000000003", wpm: 95 });
    expect(body(item(plan, "PUT", /discord-message$/))).toEqual({ guild_id: "300000000000000001", channel_id: "300000000000000002", message_id: "300000000000000003" });
    const kept = item(plan, "PUT", /\/comment$/, 0);
    expect(body(kept)).toEqual({ body: "a kept comment on alpha" });
    const erased = item(plan, "PUT", /\/comment$/, 1);
    const row = [...after.comments.values()].find((c: any) => c.user_id === "100000000000000003");
    expect(row.body).toBeNull(); // the text really is gone from the export
    expect(erased.notes).toContain("body:generated-default-length"); // Logpush carries no request size here
    const { Planner, generatedBody, parseMessageUrl } = await load("plan.mjs");
    expect(generatedBody("sid", 37)).toHaveLength(37);
    expect(generatedBody("sid", 37)).toBe(generatedBody("sid", 37));
    expect(generatedBody("sid", 37)).not.toBe(generatedBody("other", 37));
    for (const n of [1, 2, 5, 300]) expect(generatedBody("s", n)).toMatch(/^[a-z]([a-z ]*[a-z])?$|^[a-z]$/);
    expect(parseMessageUrl("https://discord.com/channels/@me/300000000000000002/300000000000000003")).toEqual({ guild_id: null, channel_id: "300000000000000002", message_id: "300000000000000003" });
    expect(parseMessageUrl("nope")).toBeNull();
    // when Logpush does carry a request size, the generated body has that length (minus the {"body":""} envelope)
    const { readLogs } = await load("parse.mjs");
    const { loadExport } = await load("exports.mjs");
    const p = new Planner({ before: loadExport(path.join(FIX, "before.json.gz")), after });
    const reqs = readLogs(path.join(FIX, "logs")).requests.filter((r: any) => r.method === "PUT" && r.path.endsWith("/comment"));
    const spec = p.plan({ ...reqs[1], bytes: 11 + 29 });
    expect(JSON.parse(spec.body.toString()).body).toHaveLength(29);
    expect(spec.notes).toContain("body:generated");
  });
});

describe("re-signing", () => {
  it("[LDB-PG44] requests are signed with the lab client key over the akl-v1 message, body hash included, a fresh nonce each", async () => {
    const { createSigner, labKey, labClientRow, LAB_CLIENT } = await load("sign.mjs");
    const signer = createSigner();
    const args = { method: "PUT", pathWithQuery: "/v1/layouts/x/like?a=1", body: Buffer.from('{"a":1}'), actor: "100000000000000002", nowMs: 1_761_825_600_000, nonceSeed: 7 };
    const h = signer.sign(args);
    expect(h["X-Akl-Client"]).toBe(LAB_CLIENT);
    expect(h["X-Akl-Timestamp"]).toBe("1761825600");
    const msg = (bodyHash: string) => `akl-v1\nPUT\n/v1/layouts/x/like?a=1\n1761825600\n${h["X-Akl-Nonce"]}\n100000000000000002\n${bodyHash}`;
    const bodyHash = crypto.createHash("sha256").update(args.body).digest("base64url");
    const pub = labKey().pub;
    const verify = (m: string) => crypto.verify(null, Buffer.from(m), pub, Buffer.from(h["X-Akl-Signature"], "base64url"));
    expect(verify(msg(bodyHash))).toBe(true);
    expect(verify(msg(crypto.createHash("sha256").update("{}").digest("base64url")))).toBe(false); // a different body does not verify
    expect(signer.sign({ ...args, nonceSeed: 8 })["X-Akl-Nonce"]).not.toBe(h["X-Akl-Nonce"]);
    expect(signer.sign(args)).toEqual(h); // deterministic, so both sides get the same bytes
    expect(labClientRow().pubkey).toBe(labKey().pubRaw);
    expect(labClientRow()).toMatchObject({ id: LAB_CLIENT, status: "active", caps: "act-as-user,feed:wait" });
    // run.mjs signs the final (id-remapped) path and body per side, and only the requests that carry an actor
    const { runPlan } = await load("run.mjs");
    const { diffPair } = await load("diff-shim.mjs");
    const a = fakeSide("a");
    const b = fakeSide("b");
    await runPlan({ items: [mkItem(0, 0, { actor: "100000000000000002" }), mkItem(1, 1)] }, { sides: [a, b], diffPair, signer, clock: noClock() });
    expect(a.wires[0].headers["X-Akl-Signature"]).toBeDefined();
    expect(a.wires[1].headers["X-Akl-Signature"]).toBeUndefined();
    expect(a.wires[0].headers["X-Akl-Signature"]).toBe(b.wires[0].headers["X-Akl-Signature"]);
  });
});

describe("skipped-request report", () => {
  it("[LDB-PG46] every request is replayed, skipped with a reason, or ignored as non-API; the gate is <= 1% skipped; the differ has lane S's signature", async () => {
    const { skipReport, renderSkipReport, MAX_SKIP_FRACTION } = await load("report.mjs");
    const { logs, plan } = await fixturePlan();
    const r = skipReport(plan);
    expect(r.replayed + r.skipped + r.ignored).toBe(logs.requests.length); // conservation: nothing vanishes
    expect(r.byReason).toMatchObject({ "write-infra-error": { count: 1 }, "discord-interaction": { count: 1 }, "failed-write-unrebuildable": { count: 1 } });
    expect(r.skipped).toBe(3);
    expect(r.ignored).toBe(1);
    expect(MAX_SKIP_FRACTION).toBe(0.01);
    expect(r.ok).toBe(true);
    expect(renderSkipReport(r)).toContain("PASS");
    // the gate trips above 1%
    const worse = skipReport({ ...plan, skipped: [...plan.skipped, ...plan.skipped, ...plan.skipped, ...plan.skipped, ...plan.skipped] });
    expect(worse.fraction).toBeGreaterThan(0.01);
    expect(worse.ok).toBe(false);
    expect(renderSkipReport(worse)).toContain("FAIL");
    expect(skipReport(plan, { maxFraction: 0.001 }).ok).toBe(false);
    // the driver exits nonzero for a failed gate and zero for a passing dry run
    const { spawnSync } = await import("node:child_process");
    const run = (extra: string[]) => spawnSync(process.execPath, [path.join(R, "replay.mjs"), "--logs", path.join(FIX, "logs"), "--before", path.join(FIX, "before.json.gz"), "--after", path.join(FIX, "after.json.gz"), "--dry-run", ...extra], { encoding: "utf8" });
    expect(run([]).status).toBe(0);
    expect(run(["--max-skip", "0.001"]).status).toBe(1);
    expect(run([]).stdout).toContain("skipped 3 (0.580%");
    // diffPair(a, b, ctx) => Problem[], the shim S replaces
    const { diffPair, loadDiffPair } = await load("diff-shim.mjs");
    const res = (status: number, etag: string, text: string) => ({ status, headers: { etag }, body: Buffer.from(text) });
    expect(diffPair(res(200, '"1"', "{}"), res(200, '"1"', "{}"), {})).toEqual([]);
    expect(diffPair(res(200, '"1"', "{}"), res(404, '"2"', "{x}"), {}).map((p: any) => p.kind)).toEqual(["status", "header", "body"]);
    expect(typeof (await loadDiffPair()).diffPair).toBe("function");
    // loopback only: no cloud, ever
    const { httpSide } = await import(/* @vite-ignore */ path.join(R, "replay.mjs"));
    expect(() => httpSide("x", "https://api.akldb.org")).toThrow(/loopback/);
    expect(() => httpSide("x", "http://127.0.0.1:18422")).not.toThrow();
  });
});
