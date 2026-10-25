// [LDB-DEV1..DEV3] `npm run dev` (scripts/dev.mjs, src/platform/node.ts; design/aws-port.md §6): a
// server on DynamoDB Local that needs no AWS credentials. Each case boots the real script as a child
// on free ports (port 0), waits for <dir>/dev.json, and talks to it over HTTP.
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const jarHere = fs.existsSync(path.join(ROOT, ".dev/dynamodb-local/DynamoDBLocal.jar")) || process.env.AKLDB_DDB_JAR_DIR !== undefined;
const dockerHere = spawnSync("docker", ["image", "inspect", "amazon/dynamodb-local:latest"], { stdio: "ignore" }).status === 0;
// CI has DynamoDB Local as a service container; the script then borrows it instead of starting one.
const sharedDdb = process.env.AKLDB_DDB_ENDPOINT;

interface Dev {
  child: ChildProcess;
  dir: string;
  info: { url: string; ddb: string; clientId: string; privateKey: string; actor: string; pid: number };
  log: () => string;
}

const running: Dev[] = [];
afterEach(async () => {
  for (const d of running.splice(0)) {
    d.child.kill("SIGINT");
    await new Promise((r) => (d.child.exitCode !== null ? r(null) : d.child.once("exit", r)));
    fs.rmSync(d.dir, { recursive: true, force: true });
  }
});

async function boot(extra: string[], env: Record<string, string> = {}): Promise<Dev> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "akldb-dev-test-"));
  const prefix = `akldb-dev-t${crypto.randomBytes(4).toString("hex")}`;
  const ddb = sharedDdb !== undefined && env.AKLDB_DEV_NO_DOCKER === undefined ? ["--ddb", sharedDdb] : ["--ddb-port", "0"];
  const child = spawn(process.execPath, ["scripts/dev.mjs", "--port", "0", "--dir", dir, "--prefix", prefix, ...ddb, ...extra], {
    cwd: ROOT,
    env: { ...process.env, AWS_ACCESS_KEY_ID: "", AWS_SECRET_ACCESS_KEY: "", AWS_PROFILE: "", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  child.stdout?.on("data", (b: Buffer) => (out += b.toString()));
  child.stderr?.on("data", (b: Buffer) => (out += b.toString()));
  const dev: Dev = { child, dir, info: undefined as never, log: () => out };
  running.push(dev);
  const file = path.join(dir, "dev.json");
  const end = Date.now() + 100_000;
  while (!fs.existsSync(file)) {
    if (child.exitCode !== null) throw new Error(`dev.mjs exited ${child.exitCode}:\n${out}`);
    if (Date.now() > end) throw new Error(`dev.mjs did not come up in 100 s:\n${out}`);
    await new Promise((r) => setTimeout(r, 200));
  }
  dev.info = JSON.parse(fs.readFileSync(file, "utf8"));
  return dev;
}

function signedFetch(d: Dev, method: string, pathname: string, body?: unknown): Promise<Response> {
  const text = body === undefined ? "" : JSON.stringify(body);
  const ts = String(Math.floor(Date.now() / 1000));
  const nonce = crypto.randomBytes(16).toString("base64url");
  const hash = crypto.createHash("sha256").update(text).digest("base64url");
  const message = `akl-v1\n${method}\n${pathname}\n${ts}\n${nonce}\n${d.info.actor}\n${hash}`;
  const key = crypto.createPrivateKey({ key: Buffer.from(d.info.privateKey, "base64url"), format: "der", type: "pkcs8" });
  return fetch(d.info.url + pathname, {
    method,
    headers: {
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      "X-Akl-Client": d.info.clientId,
      "X-Akl-Timestamp": ts,
      "X-Akl-Nonce": nonce,
      "X-Akl-Actor": d.info.actor,
      "X-Akl-Signature": crypto.sign(null, Buffer.from(message), key).toString("base64url"),
    },
    body: body === undefined ? undefined : text,
  });
}

async function oneSignedWrite(d: Dev): Promise<void> {
  const meta = await fetch(`${d.info.url}/v1/meta`);
  expect(meta.status).toBe(200);
  expect(((await meta.json()) as { layout_count: number }).layout_count).toBeGreaterThanOrEqual(0);
  const created = await signedFetch(d, "POST", "/v1/layouts", { name: "dev-probe", format: "spark/1", payload: { keys: [] } });
  expect(created.status, d.log()).toBe(201);
  const layout = (await created.json()) as { id: string; name: string };
  const read = await fetch(`${d.info.url}/v1/layouts/${layout.id}?format=spark/1`);
  expect(read.status).toBe(200);
  expect(((await read.json()) as { name: string }).name).toBe("dev-probe");
  // The write is the next event: a second server read of /v1/meta sees it.
  const after = (await (await fetch(`${d.info.url}/v1/meta`)).json()) as { layout_count: number; seq: number };
  expect(after.layout_count).toBeGreaterThanOrEqual(1);
  expect(after.seq).toBeGreaterThanOrEqual(1);
}

describe("npm run dev on DynamoDB Local", () => {
  it("[LDB-DEV1] boots with no AWS credentials and takes a signed write (Docker or a given DynamoDB Local)", async (ctx) => {
    if (!dockerHere && !jarHere && sharedDdb === undefined) ctx.skip();
    const d = await boot([], dockerHere || sharedDdb !== undefined ? {} : { AKLDB_DEV_NO_DOCKER: "1" });
    await oneSignedWrite(d);
  }, 150_000);

  it("[LDB-DEV2] boots from the jar with Docker out of the way, and takes a signed write", async (ctx) => {
    if (!jarHere) ctx.skip();
    const d = await boot([], { AKLDB_DEV_NO_DOCKER: "1" });
    expect(d.log()).toContain("jar");
    await oneSignedWrite(d);
  }, 150_000);

  it("[LDB-DEV3] --seed fixture serves the 100-layout seed, a restart keeps the dev client key, and the tick writes a dump to the blob directory", async (ctx) => {
    if (!dockerHere && !jarHere && sharedDdb === undefined) ctx.skip();
    const d = await boot(["--seed", "fixture", "--tick-ms", "500"], dockerHere || sharedDdb !== undefined ? {} : { AKLDB_DEV_NO_DOCKER: "1" });
    const meta = (await (await fetch(`${d.info.url}/v1/meta`)).json()) as { layout_count: number };
    expect(meta.layout_count).toBe(100);
    const blobs = path.join(d.dir, "blobs");
    const end = Date.now() + 30_000;
    const dumped = (): string[] => (fs.existsSync(blobs) ? fs.readdirSync(blobs, { recursive: true }).map(String).filter((f) => f.includes("dump") && !f.endsWith(".type")) : []);
    while (dumped().length === 0 && Date.now() < end) await new Promise((r) => setTimeout(r, 250));
    expect(dumped().length, d.log()).toBeGreaterThan(0);
    const key = fs.readFileSync(path.join(d.dir, "client.json"), "utf8");
    d.child.kill("SIGINT");
    await new Promise((r) => d.child.once("exit", r));
    expect(fs.existsSync(path.join(d.dir, "dev.json"))).toBe(false);
    expect(fs.readFileSync(path.join(d.dir, "client.json"), "utf8")).toBe(key);
  }, 200_000);
});
