// vitest globalSetup for the `ddb` project (lane L): DynamoDB Local on
// AKLDB_DDB_PORT (default 18307, lane L's; other lanes pass their own with
// AKLDB_DDB_CONTAINER), reused if something already answers there, stopped on
// teardown only if this process started it. Docker first, else the jar with
// Java 21 from AKLDB_DDB_JAR_DIR (default ~/git/akl/handoff/dynamodb-local).
// Never anything but 127.0.0.1.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const PORT = Number(process.env.AKLDB_DDB_PORT ?? 18307);
const CONTAINER = process.env.AKLDB_DDB_CONTAINER ?? "akldb-ddb-l";
const IMAGE = "amazon/dynamodb-local:latest";

function listening(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.connect({ host: "127.0.0.1", port });
    s.once("connect", () => (s.destroy(), resolve(true)));
    s.once("error", () => resolve(false));
  });
}

async function waitUp(port: number, ms: number): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await listening(port)) {
      // The port opens before the server answers HTTP; wait for a real reply.
      try {
        await fetch(`http://127.0.0.1:${port}/`, { method: "POST", headers: { "content-type": "application/x-amz-json-1.0", "x-amz-target": "DynamoDB_20120810.ListTables" }, body: "{}" });
        return;
      } catch {
        // not yet
      }
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`DynamoDB Local did not come up on 127.0.0.1:${port}`);
}

function dockerUp(): boolean {
  return spawnSync("docker", ["info"], { stdio: "ignore", timeout: 15000 }).status === 0;
}

export default async function setup(): Promise<() => Promise<void>> {
  process.env.AKLDB_DDB_ENDPOINT = `http://127.0.0.1:${PORT}`;
  if (await listening(PORT)) {
    await waitUp(PORT, 10000);
    return async () => {};
  }
  let child: ChildProcess | undefined;
  let viaDocker = false;
  if (dockerUp()) {
    const r = spawnSync(
      "docker",
      ["run", "-d", "--rm", "--name", CONTAINER, "-p", `127.0.0.1:${PORT}:8000`, IMAGE, "-jar", "DynamoDBLocal.jar", "-inMemory", "-sharedDb"],
      { encoding: "utf8" },
    );
    if (r.status !== 0) throw new Error(`docker run ${CONTAINER} failed: ${r.stderr}`);
    viaDocker = true;
  } else {
    const dir = process.env.AKLDB_DDB_JAR_DIR ?? path.join(os.homedir(), "git/akl/handoff/dynamodb-local");
    if (!fs.existsSync(path.join(dir, "DynamoDBLocal.jar"))) throw new Error(`no Docker and no DynamoDBLocal.jar in ${dir}`);
    child = spawn("java", [`-Djava.library.path=${path.join(dir, "DynamoDBLocal_lib")}`, "-jar", path.join(dir, "DynamoDBLocal.jar"), "-inMemory", "-sharedDb", "-port", String(PORT)], { cwd: dir, stdio: "ignore" });
  }
  await waitUp(PORT, 60000);
  return async () => {
    if (viaDocker) spawnSync("docker", ["stop", "-t", "1", CONTAINER], { stdio: "ignore" });
    else child?.kill();
  };
}
