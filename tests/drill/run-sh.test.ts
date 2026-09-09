// [LDB-D5] db/drill/run.sh -- argument/exit-code behaviour, end to end,
// against a fake `$DB_BASE_URL` (a plain node:http server standing in for
// the deployed akl-db Worker) started and stopped via node:child_process.
// Three shapes, cheapest first:
//   1. missing required env -- fails immediately, no network attempted
//   2. a corrupted dump -- step 1 fails fast (no wrangler ever touched),
//      run.sh still POSTs a `{ok:false, ...}` report and exits non-zero
//   3. a good, empty dump -- the full pipeline (migrations, restore,
//      `wrangler dev --local`, the HTTP walk, the signed report) runs for
//      real and exits 0
// (3) pays wrangler's real boot cost (~10-20s) -- the other two are fast.
// The private key/client id/actor here are `tests/vectors/client-signing.
// json`'s own `k1`/`01ARZ3NDEKTSV4RRFFQ69G5FAV`/`184412255822020608` --
// report-drill.mjs's signing itself is proven against those same vectors
// in `tests/drill/report-drill.test.ts`, so this file only needs to prove
// run.sh reaches (or doesn't reach) the point of calling it, and reacts to
// its result correctly.
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import http from "node:http";
import path from "node:path";
import zlib from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import vectorsFixture from "../vectors/client-signing.json" with { type: "json" };

const vectors = vectorsFixture as {
  keys: { id: string; pkcs8_b64url: string }[];
  vectors: unknown[];
};
const K1_PKCS8 = vectors.keys.find((k) => k.id === "k1")!.pkcs8_b64url;
const CLIENT_ID = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const ACTOR = "184412255822020608";

const DB_ROOT = path.resolve(import.meta.dirname, "..", "..");
const RUN_SH = path.join(DB_ROOT, "drill", "run.sh");

function emptyDumpBytes(): { gz: Buffer; sha256: string } {
  const dump = {
    version: 1,
    date: "2026-01-01",
    meta: {
      layout_count: 0,
      author_count: 0,
      seq: 0,
      revision: null,
      layouts_modified_at: null,
      authors_modified_at: null,
      formats: [],
    },
    records: [],
    layout_revs: [],
    likes: [],
    authors: [],
    admins: [],
    events: [],
    import_state: [],
    import_map: [],
    auth_cache: [],
    webhooks: [],
  };
  const gz = zlib.gzipSync(Buffer.from(JSON.stringify(dump)));
  const sha256 = createHash("sha256").update(gz).digest("hex");
  return { gz, sha256 };
}

interface FakeServer {
  base: string;
  drillPosts: { headers: http.IncomingHttpHeaders; body: string }[];
  close(): Promise<void>;
}

// `latestPatch` lets a test corrupt latest.json's own claims (a wrong
// sha256, say) without touching the dump bytes themselves -- exactly the
// "transfer looked fine but the claimed checksum doesn't match" case
// `checkDumpIntegrity` exists to catch.
function startFakeDb(gz: Buffer, sha256: string, latestPatch: Record<string, unknown> = {}): Promise<FakeServer> {
  const drillPosts: FakeServer["drillPosts"] = [];
  const key = "dump-2026-01-01.json.gz";
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      if (req.method === "GET" && req.url === "/v1/dump/latest.json") {
        const latest = { date: "2026-01-01", key, url: `/v1/dump/${key}`, sha256, bytes: gz.length, layout_count: 0, seq: 0, ...latestPatch };
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(latest));
        return;
      }
      if (req.method === "GET" && req.url === `/v1/dump/${key}`) {
        res.writeHead(200, { "Content-Type": "application/gzip" });
        res.end(gz);
        return;
      }
      if (req.method === "POST" && req.url === "/v1/admin/drill") {
        drillPosts.push({ headers: req.headers, body });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ recorded: true }));
        return;
      }
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "not_found", message: `no fake route for ${req.method} ${req.url}` }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr !== null ? addr.port : 0;
      resolve({
        base: `http://127.0.0.1:${port}`,
        drillPosts,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

// ASYNC on purpose (`spawn`, never `execFileSync`/`spawnSync`): the fake
// `$DB_BASE_URL` server (`startFakeDb`) runs in THIS SAME Node process, so
// servicing its requests needs this process's event loop free while
// run.sh's child (and its own `node scripts/drill-*.mjs`/`wrangler`
// grandchildren) run. A synchronous spawn blocks the event loop for its
// entire duration -- the fake server would accept the TCP connection (the
// OS backlog handles that much without JS) but could never actually
// process the request, deadlocking run.sh's very first HTTP call against
// its own test double.
function runDrill(env: Record<string, string>, timeoutMs: number): Promise<{ status: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn("sh", [RUN_SH], {
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
      detached: true, // its own process group -- a timeout kills run.sh's `wrangler dev`/node grandchildren too, not just the shell
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    const timer = setTimeout(() => {
      if (child.pid !== undefined) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      }
    }, timeoutMs);
    child.on("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ status: signal !== null ? -1 : (code ?? -1), stdout, stderr });
    });
  });
}

describe("[LDB-D5] db/drill/run.sh", () => {
  let server: FakeServer | undefined;

  afterEach(async () => {
    if (server) await server.close();
    server = undefined;
  });

  it("[LDB-D5] exits non-zero immediately when required env is missing (no network attempted)", async () => {
    const result = await runDrill({ DB_BASE_URL: "", DRILL_CLIENT_ID: "", DRILL_PRIVATE_KEY: "", DRILL_ACTOR: "" }, 10000);
    expect(result.status).not.toBe(0);
  });

  it("[LDB-D5] a corrupted dump: step 1 fails fast, a {ok:false} report still POSTs, exit non-zero", async () => {
    const { gz, sha256 } = emptyDumpBytes();
    // latest.json claims a sha256 that doesn't match the served bytes --
    // exactly LDB-D5's "byte-for-byte" clause failing at the transfer.
    // A fixed, obviously-wrong 64-hex-digit string -- NOT a single-character
    // mutation of the real sha256 (that earlier attempt happened to pick a
    // digit whose "corrupted" value equaled the original, a no-op that made
    // this test pass for the wrong reason: verify against the real hash
    // below to be sure they never coincide).
    const badSha256 = "0".repeat(64);
    expect(badSha256).not.toBe(sha256);
    server = await startFakeDb(gz, badSha256);

    const result = await runDrill(
      { DB_BASE_URL: server.base, DRILL_CLIENT_ID: CLIENT_ID, DRILL_PRIVATE_KEY: K1_PKCS8, DRILL_ACTOR: ACTOR },
      20000,
    );

    expect(result.status).not.toBe(0);
    expect(server.drillPosts.length).toBe(1);
    const posted = JSON.parse(server.drillPosts[0]!.body);
    expect(posted.ok).toBe(false);
    expect(posted.detail.checks).toEqual({ fetch: false, restore: null, verify: null });
    // The five client-lane headers made it onto the wire.
    for (const h of ["x-akl-client", "x-akl-timestamp", "x-akl-nonce", "x-akl-actor", "x-akl-signature"]) {
      expect(server.drillPosts[0]!.headers[h], h).toBeDefined();
    }
  }, 25000);

  it(
    "[LDB-D5] a good empty dump: the full pipeline runs (migrate, restore, serve, verify), posts {ok:true}, exits 0",
    async () => {
      const { gz, sha256 } = emptyDumpBytes();
      server = await startFakeDb(gz, sha256);

      const result = await runDrill(
        { DB_BASE_URL: server.base, DRILL_CLIENT_ID: CLIENT_ID, DRILL_PRIVATE_KEY: K1_PKCS8, DRILL_ACTOR: ACTOR },
        110000,
      );

      expect(result.status, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`).toBe(0);
      expect(server.drillPosts.length).toBe(1);
      const posted = JSON.parse(server.drillPosts[0]!.body);
      expect(posted.ok).toBe(true);
      expect(posted.detail.checks).toEqual({ fetch: true, restore: true, verify: true });
      expect(posted.detail.dump).toEqual({ key: "dump-2026-01-01.json.gz", sha256, bytes: gz.length });
      expect(typeof posted.detail.duration_ms).toBe("number");
    },
    120000,
  );
});
