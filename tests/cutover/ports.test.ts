// [LDB-CV11] The real ports (scripts/cutover/ports-real.mjs) against a fake `exec`/`fetch`: the exact wrangler and aws command lines, what
// is parsed out of their output, and that D1 reads are SELECT-only. Nothing is spawned and nothing is sent.
import { describe, expect, it } from "vitest";
// @ts-expect-error -- plain scripts, no .d.ts
import { createAwsPort, createD1Port, createHttpPort, parseJsonOutput } from "../../scripts/cutover/ports-real.mjs";
// @ts-expect-error -- plain scripts, no .d.ts
import { createOperator } from "../../scripts/cutover/operator.mjs";
// @ts-expect-error -- plain scripts, no .d.ts
import { main as runMain } from "../../scripts/cutover/run.mjs";

type Call = { cmd: string; args: string[]; env?: Record<string, string> };
function fakeExec(answers: Record<string, string> = {}, status = 0) {
  const calls: Call[] = [];
  const exec = (cmd: string, args: string[], opts: { env?: Record<string, string> } = {}) => {
    calls.push({ cmd, args, env: opts.env });
    const key = Object.keys(answers).find((k) => args.join(" ").includes(k));
    return { status, stdout: key ? answers[key]! : "", stderr: status === 0 ? "" : "boom" };
  };
  return { exec, calls };
}

describe("the D1 port", () => {
  it("[LDB-CV11] builds the wrangler command lines the run book prints", () => {
    const { exec, calls } = fakeExec({ "time-travel": "🚧 The current bookmark is '00000085-0000024c-00004c6d-8a1b2c3d4e5f60718293a4b5c6d7e8f9' at 2026-11-04T08:59:00.123Z", create: '{"database_id": "11111111-2222-4333-8444-555555555555"}', "d1 info": '{"uuid":"aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"}' });
    const d1 = createD1Port({ exec, env: { CLOUDFLARE_ACCOUNT_ID: "acct" } });
    expect(d1.timeTravelInfo("akl-db")).toMatchObject({ bookmark: "00000085-0000024c-00004c6d-8a1b2c3d4e5f60718293a4b5c6d7e8f9", timestamp: "2026-11-04T08:59:00.123Z" });
    d1.write("DELETE FROM import_state WHERE key = 'cutover.mode'", "akl-db");
    d1.exportTo("akl-db", "/w/export.sql");
    expect(d1.create("akl-db-rollback-2026-11-04")).toMatchObject({ id: "11111111-2222-4333-8444-555555555555" });
    expect(d1.info("x")).toMatchObject({ id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee" });
    d1.importFile("akl-db-rollback-2026-11-04", "/w/rollback-import.sql");
    const lines = calls.map((c) => `${c.cmd} ${c.args.join(" ")}`);
    expect(lines).toEqual([
      "npx wrangler d1 time-travel info akl-db",
      "npx wrangler d1 execute akl-db --remote --command DELETE FROM import_state WHERE key = 'cutover.mode'",
      "npx wrangler d1 export akl-db --remote --output /w/export.sql",
      "npx wrangler d1 create akl-db-rollback-2026-11-04",
      "npx wrangler d1 info x --json",
      "npx wrangler d1 execute akl-db-rollback-2026-11-04 --remote --file /w/rollback-import.sql --yes",
    ]);
    expect(calls[0]!.env).toEqual({ CLOUDFLARE_ACCOUNT_ID: "acct" });
  });

  it("[LDB-CV11] select is read-only: anything but a SELECT is refused before a process is spawned; the JSON result is unwrapped", () => {
    const { exec, calls } = fakeExec({ "--json": ' ⛅️ wrangler\n[{"results":[{"n":3}],"success":true,"meta":{}}]' });
    const d1 = createD1Port({ exec });
    expect(d1.select("SELECT count(*) AS n FROM events", "akl-db")).toEqual([{ n: 3 }]);
    expect(calls[0]!.args).toEqual(["wrangler", "d1", "execute", "akl-db", "--remote", "--json", "--command", "SELECT count(*) AS n FROM events"].slice(0));
    for (const bad of ["DELETE FROM events", "INSERT INTO t VALUES (1)", "PRAGMA foreign_keys = OFF", "  update t set a = 1", "DROP TABLE t"]) expect(() => d1.select(bad, "akl-db"), bad).toThrow(/read-only/);
    expect(calls).toHaveLength(1);
    expect(() => parseJsonOutput("no json here")).toThrow(/no JSON/);
    const failing = createD1Port({ exec: fakeExec({}, 1).exec });
    expect(() => failing.exportTo("akl-db", "/x")).toThrow(/wrangler d1 export akl-db failed \(1\): boom/);
  });
});

describe("the AWS port", () => {
  it("[LDB-CV11] reads the stack outputs and the live alias' environment with the profile and region, and invokes the live alias", () => {
    const { exec, calls } = fakeExec({
      "describe-stacks": JSON.stringify({ Stacks: [{ Outputs: [{ OutputKey: "FunctionName", OutputValue: "akldb-prod-api" }, { OutputKey: "LogTable", OutputValue: "akldb-prod-log" }] }] }),
      "get-function-configuration": JSON.stringify({ Environment: { Variables: { AKLDB_AWAIT_IMAGE: "1" } } }),
    });
    const aws = createAwsPort({ exec, region: "us-east-2", profile: "akldb", stack: "akldb-prod", operatorFactory: async () => ({}) });
    return Promise.all([aws.stackOutputs(), aws.lambdaEnv()]).then(([out, env]) => {
      expect(out).toEqual({ FunctionName: "akldb-prod-api", LogTable: "akldb-prod-log" });
      expect(env).toEqual({ AKLDB_AWAIT_IMAGE: "1" });
      expect(calls.map((c) => c.args.join(" "))).toEqual([
        "cloudformation describe-stacks --stack-name akldb-prod --region us-east-2 --profile akldb --output json",
        "lambda get-function-configuration --function-name akldb-prod-api --qualifier live --region us-east-2 --profile akldb --output json",
      ]);
      expect(new Set(calls.map((c) => c.cmd))).toEqual(new Set(["aws"]));
    });
  });
});

describe("the HTTP port and the operator", () => {
  it("[LDB-CV11] requests do not follow redirects, lower-case the headers, and the signed form signs the path and query", async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    const fetchImpl = async (url: string, init: RequestInit) => {
      seen.push({ url, init });
      return new Response("hi", { status: 503, headers: { "Retry-After": "5", "X-Akldb-Backend": "aws" } });
    };
    const key = (await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"])) as CryptoKeyPair;
    const pkcs8 = Buffer.from((await crypto.subtle.exportKey("pkcs8", key.privateKey)) as ArrayBuffer).toString("base64url");
    const http = createHttpPort({ fetchImpl, env: { CLIENT_ID: "cid", CLIENT_PRIVATE_KEY: pkcs8, OPS_ACTOR: "ops" } });
    const r = await http.request("https://api.akldb.org/v1/layouts", { method: "POST", body: "" });
    expect(r).toEqual({ status: 503, headers: expect.objectContaining({ "retry-after": "5", "x-akldb-backend": "aws" }), body: "hi" });
    expect(seen[0]!.init.redirect).toBe("manual");
    await http.signed("PATCH", "https://api.akldb.org/v1/layouts/1?x=1", { body: "{}", headers: { "if-match": '"a:1"' } });
    const headers = seen[1]!.init.headers as Record<string, string>;
    expect(headers).toMatchObject({ "X-Akl-Client": "cid", "X-Akl-Actor": "ops", "if-match": '"a:1"', "content-type": "application/json" });
    expect(headers["X-Akl-Signature"]).toMatch(/^[A-Za-z0-9_-]{80,}$/);
  });

  it("[LDB-CV11] the operator is a replica over the log, never the public API: appendImage, snapshot, runUnit, readFlag, capture", async () => {
    const calls: string[] = [];
    const replica = { runUnit: async () => [{ rows: [{ value: "read_only" }] }], catchUp: async () => 3, seq: 3, close: () => calls.push("close"), capture: async () => ({ seq: 3, bytes: new Uint8Array([1]) }) };
    const kit = {
      bootReplica: async () => (calls.push("boot"), replica),
      appendImage: async () => (calls.push("appendImage"), { seq: 1, outcome: "appended" }),
      writeSnapshot: async () => (calls.push("writeSnapshot"), { status: "written", ref: { seq: 3, key: "snap/slot-0.sqlite.zst", sha256: "h" } }),
    };
    const op = createOperator({ kit, log: { head: async () => 3, get: async () => null }, objects: {}, state: {} });
    expect(await op.readFlag()).toBe("read_only");
    expect(await op.snapshot()).toEqual({ seq: 3, key: "snap/slot-0.sqlite.zst", sha256: "h" });
    expect(await op.runUnit("DELETE FROM t")).toEqual({ seq: 3 });
    expect((await op.capture()).seq).toBe(3);
    expect(await op.firstEntry()).toBeNull();
    await op.appendImage({ raw: new Uint8Array(), tables: {}, source: {} });
    expect(calls.filter((c) => c === "boot").length).toBe(4);
    expect(calls.filter((c) => c === "close").length).toBe(4); // every replica it boots is closed
  });

  it("[LDB-CV11] --execute without the environment stops before anything runs", async () => {
    const out: string[] = [];
    const code = await runMain(["--execute"], { env: {}, out: (l: string) => out.push(l) });
    expect(code).toBe(2);
    expect(out.join("\n")).toContain("CLOUDFLARE_ACCOUNT_ID is not set");
  });
});
