// The real ports of the cutover orchestrator (steps.mjs): Cloudflare through its HTTP API with CLOUDFLARE_DB_TOKEN, AWS through the
// `aws` CLI (sts, dynamodb and ssm only: the switch makes no control-plane call) under the narrow role `akldb-cutover-role` (assumed with the `akldb-ci` key from the `akldb-production` environment).
// Nothing else is read. Every process and request goes through the injected `exec` / `fetchImpl`, so tests/cutover drive this file with
// fakes and it never touches a network there.
//
// NOT WIRED YET (a real run refuses to start while this list is not empty, before it freezes anything): the mirror wait, the ephemeral
// copy, the row-for-row proof and the smoke need the ops/bundle of scripts/mirror and a signed client; the main session wires them
// when it schedules the rehearsals.
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

export const PROD = Object.freeze({
  region: "us-east-2",
  mainTable: "akldb-prod-main",
  ssmPrefix: "/akldb/prod",
  discordParams: ["discord/bot-token", "discord/application-id", "discord/public-key", "discord/modqueue-webhook"],
  roleName: "akldb-cutover-role",
  account: "335937358231",
});

const CRON = "*/5 * * * *";
const MODE_KEY = "cutover.mode";

export function realExec() {
  return async (cmd, args, env) => {
    const { stdout } = await execFileP(cmd, args, { env: { ...process.env, ...env }, maxBuffer: 64 * 1024 * 1024 });
    return stdout;
  };
}

/** The ports that exist today. `unwired` names the ones that do not. */
export function createRealPorts({ env, exec = realExec(), fetchImpl = fetch, clock, log, worker = "akl-db", d1Id, stage = PROD }) {
  const cf = {
    token: env.CLOUDFLARE_DB_TOKEN,
    account: env.CLOUDFLARE_ACCOUNT_ID ?? env.CLOUDFLARE_DB_ACCOUNT_ID,
  };
  async function cfApi(method, path, body) {
    const res = await fetchImpl(`https://api.cloudflare.com/client/v4/accounts/${cf.account}${path}`, {
      method,
      headers: { Authorization: `Bearer ${cf.token}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const j = await res.json();
    if (!res.ok || j.success === false) throw new Error(`cloudflare ${method} ${path}: ${res.status} ${JSON.stringify(j.errors ?? j).slice(0, 300)}`);
    return j.result;
  }
  const sql = async (statement, params = []) => (await cfApi("POST", `/d1/database/${d1Id}/query`, { sql: statement, params }))[0].results;

  let creds;
  async function awsEnv() {
    if (creds === undefined) {
      const out = await exec(
        "aws",
        ["sts", "assume-role", "--role-arn", `arn:aws:iam::${stage.account}:role/${stage.roleName}`, "--role-session-name", "akldb-cutover", "--duration-seconds", "3600", "--region", stage.region, "--output", "json"],
        { AWS_ACCESS_KEY_ID: env.AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY: env.AWS_SECRET_ACCESS_KEY, AWS_SESSION_TOKEN: "" },
      );
      const c = JSON.parse(out).Credentials;
      creds = { AWS_ACCESS_KEY_ID: c.AccessKeyId, AWS_SECRET_ACCESS_KEY: c.SecretAccessKey, AWS_SESSION_TOKEN: c.SessionToken, AWS_REGION: stage.region };
    }
    return creds;
  }
  const aws = async (...args) => exec("aws", [...args, "--region", stage.region, "--output", "json"], await awsEnv());
  const awsJson = async (...args) => JSON.parse((await aws(...args)) || "null");
  const putState = (key, value) => aws("dynamodb", "put-item", "--table-name", stage.mainTable, "--item", JSON.stringify({ pk: { S: "STATE" }, sk: { S: key }, value: { S: value } }));

  return {
    clock,
    log,
    d1: {
      async getMode() {
        const rows = await sql("SELECT value FROM import_state WHERE key = ?", [MODE_KEY]);
        const v = rows[0]?.value;
        return v === "read_only" || v === "proxy" ? v : null;
      },
      async setMode(mode) {
        if (mode === null) await sql("DELETE FROM import_state WHERE key = ?", [MODE_KEY]);
        else await sql("INSERT INTO import_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [MODE_KEY, mode]);
      },
      async maxSeq() {
        return Number((await sql("SELECT COALESCE(MAX(seq), 0) AS seq FROM events"))[0].seq);
      },
    },
    cloudflare: {
      async setCron(on) {
        await cfApi("PUT", `/workers/scripts/${worker}/schedules`, on ? [{ cron: CRON }] : []);
      },
    },
    aws: {
      async getMode() {
        const r = await awsJson("dynamodb", "get-item", "--table-name", stage.mainTable, "--consistent-read", "--key", JSON.stringify({ pk: { S: "STATE" }, sk: { S: MODE_KEY } }));
        const v = r?.Item?.value?.S;
        return v === "read_only" || v === "proxy" ? v : null;
      },
      async setMode(mode) {
        const key = JSON.stringify({ pk: { S: "STATE" }, sk: { S: MODE_KEY } });
        if (mode === null) await aws("dynamodb", "delete-item", "--table-name", stage.mainTable, "--key", key);
        else await aws("dynamodb", "put-item", "--table-name", stage.mainTable, "--item", JSON.stringify({ pk: { S: "STATE" }, sk: { S: MODE_KEY }, value: { S: mode } }));
      },
      async maxSeq() {
        const r = await awsJson("dynamodb", "get-item", "--table-name", stage.mainTable, "--consistent-read", "--key", JSON.stringify({ pk: { S: "META" }, sk: { S: "HEAD" } }));
        return Number(r?.Item?.seq?.N ?? 0);
      },
      /** The mirror mode and the jobs switch are DATA (STATE/mirror.mode, STATE/jobs.enabled), read per invocation: no control-plane call. */
      async setMirrorMode(mode) {
        await putState("mirror.mode", mode);
      },
      async setJobsEnabled(on) {
        await putState("jobs.enabled", on ? "on" : "off");
      },
      async discordReady() {
        const names = stage.discordParams.map((n) => `${stage.ssmPrefix}/${n}`);
        const r = await awsJson("ssm", "get-parameters", "--names", ...names);
        return (r.Parameters ?? []).length === names.length;
      },
    },
  };
}

/** What a real run still lacks (steps.mjs ports with no real implementation yet). */
export const UNWIRED = Object.freeze(["mirror.status", "mirror.waitApplied", "ephemeral.copy", "proof.run", "smoke.run"]);
