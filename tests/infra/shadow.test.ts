// [LDB-PV11] The shadow stage's deploy: infra/stages/shadow.json supplies the fake Discord URL and the extra schema
// directory, `deploy-aws.sh --stage shadow` uses them, refuses any other Discord URL, and no other stage changes.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { FAKE_DISCORD_BASE } from "../../src/platform/fake-discord";
import { loadTemplate, resolveStage } from "./checks";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const stageFile = JSON.parse(fs.readFileSync(path.join(ROOT, "infra", "stages", "shadow.json"), "utf8")) as {
  stage: string;
  domain: string;
  parameters: Record<string, string>;
  ssm: { required: string[]; forbidden: string[] };
  ship: string[];
};

function dryRun(stage: string, env: Record<string, string> = {}): { lines: string[]; status: number | null; stderr: string; calls: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "akldb-shadow-deploy-"));
  try {
    const marker = path.join(dir, "aws-was-called");
    fs.writeFileSync(path.join(dir, "aws"), `#!/bin/sh\necho "$@" >> ${marker}\nexit 99\n`, { mode: 0o755 });
    const r = spawnSync("sh", [path.join(ROOT, "scripts", "deploy-aws.sh"), "--stage", stage, "--dry-run"], { env: { PATH: `${dir}:${path.dirname(process.execPath)}:/usr/bin:/bin`, HOME: dir, ...env }, encoding: "utf8", cwd: dir });
    return { lines: r.stderr.split("\n").filter((l) => l.startsWith("+ ")), status: r.status, stderr: r.stderr, calls: fs.existsSync(marker) ? fs.readFileSync(marker, "utf8") : "" };
  } finally {
    fs.rmSync(dir, { recursive: true });
  }
}

describe("the shadow stage file and its deploy", () => {
  it("[LDB-PV11] infra/stages/shadow.json points Discord at the in-process fake, wants only the origin secret, and ships the follower's schema", () => {
    expect(stageFile.stage).toBe("shadow");
    expect(stageFile.domain).toBe("shadow-api.akldb.org");
    expect(stageFile.parameters.DiscordApiUrl).toBe(FAKE_DISCORD_BASE);
    expect(stageFile.ssm.required).toEqual(["origin-secret"]);
    expect(stageFile.ssm.forbidden).toContain("discord-bot-token");
    expect(stageFile.ship).toEqual(["migrations", "migrations-shadow"]);
    // the stage file only sets parameters the template has, and the template supports the stage as it is (no template change for D)
    const t = loadTemplate(path.join(ROOT, "infra", "akldb.yaml"));
    for (const name of Object.keys(stageFile.parameters)) expect(t.Parameters, name).toHaveProperty(name);
    expect(t.Parameters.Stage.AllowedValues).toContain("shadow");
    expect(t.Parameters.DomainName.AllowedValues).toContain(stageFile.domain);
    expect(Object.keys(resolveStage(t, "shadow").resources)).not.toContain("Budget");
    // every ssm name the stage forbids is one the code reads for Discord (src/platform/lambda.ts CONFIG_PARAMS)
    const lambda = fs.readFileSync(path.join(ROOT, "src", "platform", "lambda.ts"), "utf8");
    for (const name of stageFile.ssm.forbidden) expect(lambda, name).toContain(`"${name}"`);
  });

  it("[LDB-PV11] the shadow dry run bundles migrations-shadow/, passes the fake Discord URL, makes no AWS call; staging's zip and URL are unchanged", () => {
    const shadow = dryRun("shadow", { DEPLOY_DRY_STACK_STATUS: "none" });
    expect(shadow.status).toBe(0);
    expect(shadow.calls).toBe("");
    const text = shadow.lines.join("\n");
    expect(text).toMatch(/zip -q -X -r \S+ lambda\.mjs migrations migrations-shadow/);
    expect(text).toMatch(/cp' '[^']*migrations-shadow\/0001_shadow_follower\.sql/);
    expect(text).toContain(`ParameterKey=DiscordApiUrl,ParameterValue=${FAKE_DISCORD_BASE}`);
    const staging = dryRun("staging", { DEPLOY_DRY_STACK_STATUS: "none" });
    expect(staging.lines.join("\n")).toMatch(/zip -q -X -r \S+ lambda\.mjs migrations'/);
    expect(staging.lines.join("\n")).not.toContain("migrations-shadow");
    expect(staging.lines.join("\n")).toContain("ParameterKey=DiscordApiUrl,ParameterValue=https://discord.com/api");
  });

  it("[LDB-PV11] a shadow deploy with any other DISCORD_API_URL is refused before anything is built", () => {
    const r = dryRun("shadow", { DISCORD_API_URL: "https://discord.com/api" });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("refusing: the shadow stage's DISCORD_API_URL must be");
    expect(r.lines.some((l) => l.includes("create-change-set"))).toBe(false);
    expect(dryRun("shadow", { DISCORD_API_URL: FAKE_DISCORD_BASE }).status).toBe(0);
  });
});
