// The real ports: wrangler for D1, the aws CLI for the stack, fetch for HTTP, the replica kit for the log. Used only with --execute.
// Every external command goes through `exec` (injectable), so tests assert the exact command lines against a fake. Reads of D1 are
// SELECTs only: `select` refuses anything else before a process is spawned.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import dns from "node:dns/promises";
import { createHash } from "node:crypto";
import https from "node:https";
import fsSync from "node:fs";
import { signerFromEnv } from "../client-sign.mjs";
import { copyDumps } from "./dumps.mjs";
import { r2Source, s3Destination } from "./dumps-real.mjs";
import { createOperator } from "./operator.mjs";

/** Default exec: run a program, return { status, stdout, stderr }. */
export function realExec(cmd, args, { input, env } = {}) {
  const r = spawnSync(cmd, args, { encoding: "utf8", input, env: { ...process.env, ...env }, maxBuffer: 1024 * 1024 * 1024 });
  return { status: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

const SELECT = /^\s*select\b/i;

/** `wrangler d1 execute --json` prints JSON (maybe after a banner): take from the first [ or {. */
export function parseJsonOutput(text) {
  const i = text.search(/[[{]/);
  if (i < 0) throw new Error(`no JSON in wrangler's output: ${text.slice(0, 200)}`);
  return JSON.parse(text.slice(i));
}

/**
 * D1 through the Cloudflare REST API (`POST /accounts/<id>/d1/database/<db id>/query`), SELECTs only. One HTTP call is 70-150 ms against about a
 * second for a `wrangler` process, and `selectMany` runs several statements in ONE call (the API returns one result per statement). The account's
 * limit is 1,200 calls per 5 minutes per user, shared with every other agent on the token, so callers keep the count low (proveAllBatched) and a
 * 429 is waited out (Retry-After) rather than failed. The token needs D1 read; it is never printed.
 */
export function createD1RestPort({ accountId, token, resolveId, fetchImpl = globalThis.fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), retries = 6, timeoutMs = 60_000 }) {
  const ids = new Map();
  const idOf = (db) => {
    if (!ids.has(db)) ids.set(db, resolveId(db));
    return ids.get(db);
  };
  async function query(db, sql) {
    const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database/${idOf(db)}/query`;
    for (let attempt = 0; ; attempt++) {
      const res = await fetchImpl(url, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ sql }), signal: AbortSignal.timeout(timeoutMs) });
      if ((res.status === 429 || res.status >= 500) && attempt < retries) {
        const wait = Number(res.headers.get("retry-after")) * 1000 || Math.min(30_000, 500 * 2 ** attempt);
        await res.body?.cancel();
        await sleep(wait);
        continue;
      }
      const text = await res.text();
      let json;
      try {
        json = JSON.parse(text);
      } catch {
        throw new Error(`D1 REST ${res.status}: not JSON: ${text.slice(0, 200)}`);
      }
      if (!res.ok || json.success === false) throw new Error(`D1 REST ${res.status}: ${(json.errors ?? []).map((e) => `${e.code} ${e.message}`).join("; ") || text.slice(0, 200)}`);
      return json.result;
    }
  }
  const guard = (sql) => {
    if (!SELECT.test(sql)) throw new Error(`d1.select is read-only: refused ${JSON.stringify(sql.slice(0, 80))}`);
  };
  return {
    async select(sql, db) {
      guard(sql);
      const [first] = await query(db, sql);
      if (first?.success === false) throw new Error(`D1 SELECT failed: ${JSON.stringify(first.error ?? first).slice(0, 300)}`);
      return first?.results ?? [];
    },
    async selectMany(sqls, db) {
      sqls.forEach(guard);
      const result = await query(db, sqls.join(";\n"));
      if (result.length !== sqls.length) throw new Error(`D1 REST answered ${result.length} results for ${sqls.length} statements`);
      return result.map((r) => r.results ?? []);
    },
  };
}

export function createD1Port({ exec, wrangler = ["npx", "wrangler"], env = {}, rest }) {
  const run = (args, opts) => {
    const r = exec(wrangler[0], [...wrangler.slice(1), ...args], { env, ...opts });
    if (r.status !== 0) throw new Error(`wrangler ${args.slice(0, 3).join(" ")} failed (${r.status}): ${(r.stderr || r.stdout).slice(0, 600)}`);
    return r.stdout;
  };
  return {
    timeTravelInfo(db) {
      const out = run(["d1", "time-travel", "info", db]);
      // "The current bookmark is '00000085-0000024c-00004c6d-...'" (and a timestamp line)
      const m = /bookmark[^'"\n]*['"]?([0-9a-f]{8}-[0-9a-f]{8}-[0-9a-f]{8}-[0-9a-f]+)['"]?/i.exec(out) ?? /([0-9a-f]{8}-[0-9a-f]{8}-[0-9a-f]{8}-[0-9a-f]{20,})/i.exec(out);
      const t = /(\d{4}-\d{2}-\d{2}T[\d:.]+Z)/.exec(out);
      return { bookmark: m?.[1] ?? null, timestamp: t?.[1] ?? null, raw: out.trim().slice(0, 400) };
    },
    ...(rest ? { select: rest.select, selectMany: rest.selectMany } : {}),
    ...(rest ? {} : { select(sql, db) {
      if (!SELECT.test(sql)) throw new Error(`d1.select is read-only: refused ${JSON.stringify(sql.slice(0, 80))}`);
      const parsed = parseJsonOutput(run(["d1", "execute", db, "--remote", "--json", "--command", sql]));
      const first = Array.isArray(parsed) ? parsed[0] : parsed;
      if (first?.success === false) throw new Error(`D1 SELECT failed: ${JSON.stringify(first.error ?? first).slice(0, 300)}`);
      return first?.results ?? [];
    } }),
    write(sql, db) {
      run(["d1", "execute", db, "--remote", "--command", sql]);
    },
    exportTo(db, file) {
      run(["d1", "export", db, "--remote", "--output", file]);
    },
    create(name) {
      const out = run(["d1", "create", name]);
      const id = /database_id["'\s=:]+["']?([0-9a-f-]{36})/i.exec(out)?.[1] ?? /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i.exec(out)?.[1];
      if (!id) throw new Error(`wrangler d1 create ${name} printed no database id: ${out.slice(0, 300)}`);
      return { name, id, raw: out.trim().slice(0, 400) };
    },
    /** An existing database's id (`wrangler d1 info`); throws when there is none of that name. */
    info(name) {
      const out = run(["d1", "info", name, "--json"]);
      const id = /"(?:uuid|database_id|id)"\s*:\s*"([0-9a-f-]{36})"/i.exec(out)?.[1] ?? /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i.exec(out)?.[1];
      if (!id) throw new Error(`wrangler d1 info ${name} printed no database id: ${out.slice(0, 300)}`);
      return { name, id };
    },
    importFile(db, file) {
      run(["d1", "execute", db, "--remote", "--file", file, "--yes"]);
    },
  };
}

export function createHttpPort({ fetchImpl = globalThis.fetch, env = process.env, userAgent = "akldb-cutover/1" }) {
  async function request(url, init = {}) {
    const res = await fetchImpl(url, { redirect: "manual", ...init, headers: { "user-agent": userAgent, ...(init.headers ?? {}) } });
    const headers = {};
    res.headers.forEach((v, k) => (headers[k.toLowerCase()] = v));
    const bytes = new Uint8Array(await res.arrayBuffer());
    return { status: res.status, headers, body: new TextDecoder().decode(bytes), sha256: createHash("sha256").update(bytes).digest("hex") };
  }
  /** One request on a brand-new connection (no keep-alive, no pool): what the DNS poll needs, so a stale connection to the old address cannot answer. */
  function fresh(url, init = {}) {
    return new Promise((resolve, reject) => {
      const u = new URL(url);
      const req = https.request({ hostname: u.hostname, port: u.port || 443, path: `${u.pathname}${u.search}`, method: init.method ?? "GET", agent: false, headers: { "user-agent": userAgent, connection: "close", ...(init.headers ?? {}) }, timeout: 15_000 }, (res) => {
        const chunks = [];
        res.on("data", (d) => chunks.push(d));
        res.on("end", () => {
          const bytes = new Uint8Array(Buffer.concat(chunks));
          const headers = Object.fromEntries(Object.entries(res.headers).map(([k, v]) => [k.toLowerCase(), Array.isArray(v) ? v.join(", ") : String(v)]));
          resolve({ status: res.statusCode ?? 0, headers, body: new TextDecoder().decode(bytes), sha256: createHash("sha256").update(bytes).digest("hex") });
        });
      });
      req.on("timeout", () => req.destroy(new Error("timed out after 15 s")));
      req.on("error", reject);
      req.end(init.body);
    });
  }
  return {
    request,
    fresh,
    async signed(method, url, { body, headers = {} } = {}) {
      const u = new URL(url);
      const bytes = body === undefined ? new Uint8Array(0) : Buffer.from(body, "utf8");
      const sig = signerFromEnv(env)(method, `${u.pathname}${u.search}`, bytes);
      return request(url, { method, headers: { ...sig, ...(body === undefined ? {} : { "content-type": "application/json" }), ...headers }, ...(body === undefined ? {} : { body }) });
    },
  };
}

export function createAwsPort({ exec, region = "us-east-2", profile, stack, operatorFactory }) {
  const aws = (args) => {
    const r = exec("aws", [...args, "--region", region, ...(profile ? ["--profile", profile] : []), "--output", "json"]);
    if (r.status !== 0) throw new Error(`aws ${args.slice(0, 2).join(" ")} failed (${r.status}): ${(r.stderr || r.stdout).slice(0, 600)}`);
    return r.stdout.trim() === "" ? null : JSON.parse(r.stdout);
  };
  let outputs;
  let operator;
  const getOutputs = () => {
    if (outputs === undefined) {
      const d = aws(["cloudformation", "describe-stacks", "--stack-name", stack]);
      outputs = Object.fromEntries((d.Stacks?.[0]?.Outputs ?? []).map((o) => [o.OutputKey, o.OutputValue]));
    }
    return outputs;
  };
  const op = async () => (operator ??= await operatorFactory(getOutputs()));
  return {
    async stackOutputs() {
      return getOutputs();
    },
    async lambdaEnv() {
      const cfg = aws(["lambda", "get-function-configuration", "--function-name", getOutputs().FunctionName, "--qualifier", "live"]);
      return cfg?.Environment?.Variables ?? {};
    },
    async invoke(payload) {
      const out = `${process.env.TMPDIR ?? "/tmp"}/akldb-cutover-invoke-${process.pid}.json`;
      const r = exec("aws", ["lambda", "invoke", "--function-name", getOutputs().FunctionName, "--qualifier", "live", "--cli-binary-format", "raw-in-base64-out", "--payload", JSON.stringify(payload), out, "--region", region, ...(profile ? ["--profile", profile] : []), "--output", "json"]);
      if (r.status !== 0) throw new Error(`aws lambda invoke failed: ${(r.stderr || r.stdout).slice(0, 400)}`);
      const meta = JSON.parse(r.stdout);
      const text = fs.readFileSync(out, "utf8");
      fs.rmSync(out, { force: true });
      const body = JSON.parse(text || "null");
      if (meta.FunctionError) throw new Error(`the function failed (${meta.FunctionError}): ${JSON.stringify(body).slice(0, 400)}`);
      return body;
    },
    async logHead() {
      return (await op()).head();
    },
    async firstEntry() {
      return (await op()).firstEntry();
    },
    operator: {
      appendImage: async (a) => (await op()).appendImage(a),
      tail: async () => (await op()).tail(),
      snapshot: async () => (await op()).snapshot(),
      runUnit: async (sql, params) => (await op()).runUnit(sql, params),
      readFlag: async () => (await op()).readFlag(),
      capture: async () => (await op()).capture(),
    },
  };
}

/** The operator over the real DynamoDB log and S3 bucket, with the credentials in the environment (aws-vault exec akldb -- ...). */
export async function realOperatorFactory(outputs, { env = process.env, region = "us-east-2", loadKit }) {
  const kit = await loadKit();
  const credentials = () => ({ accessKeyId: env.AWS_ACCESS_KEY_ID, secretAccessKey: env.AWS_SECRET_ACCESS_KEY, ...(env.AWS_SESSION_TOKEN ? { sessionToken: env.AWS_SESSION_TOKEN } : {}) });
  if (!env.AWS_ACCESS_KEY_ID || !env.AWS_SECRET_ACCESS_KEY) throw new Error("the operator needs AWS credentials in the environment (aws-vault exec akldb -- node scripts/cutover/...)");
  const objects = kit.createS3Objects({ bucket: outputs.DataBucket, region, credentials });
  const log = kit.createDdbLog({ table: outputs.LogTable, region, credentials: credentials(), blobs: objects });
  const state = kit.createDdbSnapshotState({ table: outputs.LogTable, region, credentials: credentials() });
  return createOperator({ kit, log, objects, state, logLine: (m) => console.log(`      ${m}`) });
}

/**
 * The dump-history copy (R2 -> the stack's data bucket). The R2 read credentials are in an env file (R2_KEY_ID, R2_SECRET, and R2_ENDPOINT
 * `https://<account>.r2.cloudflarestorage.com`; bucket-scoped list and read on akl-db-dumps), the AWS ones in the environment.
 */
export function createDumpsPort({ env = process.env, r2Env, outputs, fetchImpl, region = "us-east-2" }) {
  const awsNeed = ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"];
  const r2 = () => {
    const v = readEnvFile(r2Env);
    const endpoint = v.R2_ENDPOINT ?? (v.CLOUDFLARE_ACCOUNT_ID ? `https://${v.CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com` : env.CLOUDFLARE_ACCOUNT_ID ? `https://${env.CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com` : undefined);
    return { accessKeyId: v.R2_KEY_ID, secretAccessKey: v.R2_SECRET, endpoint, bucket: v.R2_BUCKET ?? "akl-db-dumps" };
  };
  return {
    async check() {
      const missing = awsNeed.filter((k) => !env[k]);
      try {
        const c = r2();
        for (const [k, v] of Object.entries({ R2_KEY_ID: c.accessKeyId, R2_SECRET: c.secretAccessKey, "R2_ENDPOINT (or CLOUDFLARE_ACCOUNT_ID)": c.endpoint })) if (!v) missing.push(`${k} in ${r2Env}`);
      } catch (e) {
        missing.push(`${r2Env} (${e.code === "ENOENT" ? "not found" : e.message})`);
      }
      return missing;
    },
    async sync({ dryRun = false, destBucket } = {}) {
      const missing = await this.check();
      if (missing.length > 0) throw new Error(`missing ${missing.join(", ")}`);
      const bucket = destBucket ?? (await outputs()).DataBucket;
      const c = r2();
      const src = r2Source({ endpoint: c.endpoint, accessKeyId: c.accessKeyId, secretAccessKey: c.secretAccessKey, bucket: c.bucket, fetchImpl });
      const dst = s3Destination({ bucket, region, credentials: { accessKeyId: env.AWS_ACCESS_KEY_ID, secretAccessKey: env.AWS_SECRET_ACCESS_KEY, ...(env.AWS_SESSION_TOKEN ? { sessionToken: env.AWS_SESSION_TOKEN } : {}) }, fetchImpl });
      return copyDumps({ src, dst, dryRun, log: (m) => console.log(`      ${m}`) });
    },
  };
}

/** Read `KEY=value` lines (no quoting rules beyond optional surrounding quotes and `export `). The values are never printed. */
export function readEnvFile(file) {
  const out = {};
  for (const line of fsSync.readFileSync(file, "utf8").split("\n")) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (m && !line.trimStart().startsWith("#")) out[m[1]] = m[2].replace(/^(['"])(.*)\1$/, "$2");
  }
  return out;
}

/** The origin secret in an env file: the one assignment whose name mentions ORIGIN (AKLDB_ORIGIN_SECRET, X_AKLDB_ORIGIN, ...), or the only assignment there is. */
export function originSecretFrom(file) {
  const vars = readEnvFile(file);
  const named = Object.keys(vars).filter((k) => /ORIGIN/i.test(k));
  const key = named.length === 1 ? named[0] : Object.keys(vars).length === 1 ? Object.keys(vars)[0] : undefined;
  if (key === undefined || !vars[key]) throw new Error(`${file} has no single origin secret assignment`);
  return vars[key];
}

/**
 * The prod stack read DIRECTLY, bypassing Cloudflare and the DNS name: TCP to the HTTP API custom domain's regional target (ApiDomainTarget),
 * TLS SNI and Host of the public name, and the `x-akldb-origin` header from the env file (read when the request is made, never kept in the state
 * file, never printed). Equivalent to `curl --resolve <host>:443:<ip> -H 'x-akldb-origin: ...'`.
 */
export function createStackPort({ outputs, hostname, originEnv, fetchImpl }) {
  const request = fetchImpl ?? ((path, init, ctx) => direct(path, init, ctx));
  async function direct(path, init = {}, { target, secret }) {
    const [{ address }] = await dns.lookup(target, { all: true, family: 4 });
    return new Promise((resolve, reject) => {
      const req = https.request({ host: address, port: 443, servername: hostname, path, method: init.method ?? "GET", agent: false, headers: { host: hostname, "x-akldb-origin": secret, "user-agent": "akldb-cutover/1", connection: "close", ...(init.headers ?? {}) }, timeout: 20_000 }, (res) => {
        const chunks = [];
        res.on("data", (d) => chunks.push(d));
        res.on("end", () => {
          const bytes = new Uint8Array(Buffer.concat(chunks));
          const headers = Object.fromEntries(Object.entries(res.headers).map(([k, v]) => [k.toLowerCase(), Array.isArray(v) ? v.join(", ") : String(v)]));
          resolve({ status: res.statusCode ?? 0, headers, body: new TextDecoder().decode(bytes), sha256: createHash("sha256").update(bytes).digest("hex") });
        });
      });
      req.on("timeout", () => req.destroy(new Error("timed out after 20 s")));
      req.on("error", reject);
      req.end(init.body);
    });
  }
  return {
    async check() {
      try {
        originSecretFrom(originEnv);
        return [];
      } catch (e) {
        return [`the origin secret file ${originEnv} is unusable: ${e.message}`];
      }
    },
    async request(path, init) {
      return request(path, init, { target: (await outputs()).ApiDomainTarget, secret: originSecretFrom(originEnv) });
    },
  };
}
