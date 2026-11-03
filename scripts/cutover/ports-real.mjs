// The real ports: wrangler for D1, the aws CLI for the stack, fetch for HTTP, the replica kit for the log. Used only with --execute.
// Every external command goes through `exec` (injectable), so tests assert the exact command lines against a fake. Reads of D1 are
// SELECTs only: `select` refuses anything else before a process is spawned.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createHash } from "node:crypto";
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

export function createD1Port({ exec, wrangler = ["npx", "wrangler"], env = {} }) {
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
    select(sql, db) {
      if (!SELECT.test(sql)) throw new Error(`d1.select is read-only: refused ${JSON.stringify(sql.slice(0, 80))}`);
      const parsed = parseJsonOutput(run(["d1", "execute", db, "--remote", "--json", "--command", sql]));
      const first = Array.isArray(parsed) ? parsed[0] : parsed;
      if (first?.success === false) throw new Error(`D1 SELECT failed: ${JSON.stringify(first.error ?? first).slice(0, 300)}`);
      return first?.results ?? [];
    },
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
  return {
    request,
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

/** The dump-history copy (R2 -> the stack's data bucket) with the credentials in the environment. */
export function createDumpsPort({ env = process.env, outputs, fetchImpl, region = "us-east-2" }) {
  const need = ["CLOUDFLARE_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"];
  return {
    async check() {
      return need.filter((k) => !env[k]);
    },
    async sync({ dryRun = false } = {}) {
      const missing = await this.check();
      if (missing.length > 0) throw new Error(`missing ${missing.join(", ")}`);
      const bucket = (await outputs()).DataBucket;
      const src = r2Source({ accountId: env.CLOUDFLARE_ACCOUNT_ID, accessKeyId: env.R2_ACCESS_KEY_ID, secretAccessKey: env.R2_SECRET_ACCESS_KEY, bucket: env.R2_DUMPS_BUCKET ?? "akl-db-dumps", fetchImpl });
      const dst = s3Destination({ bucket, region, credentials: { accessKeyId: env.AWS_ACCESS_KEY_ID, secretAccessKey: env.AWS_SECRET_ACCESS_KEY, ...(env.AWS_SESSION_TOKEN ? { sessionToken: env.AWS_SESSION_TOKEN } : {}) }, fetchImpl });
      return copyDumps({ src, dst, dryRun, log: (m) => console.log(`      ${m}`) });
    },
  };
}
