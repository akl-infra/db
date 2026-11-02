// DynamoDB Local for tests/shim/log-ddb.test.ts. Reused if something already
// answers on 127.0.0.1:AKLDB_DDB_PORT (default 18407); else started from the
// pinned image with Docker (container AKLDB_DDB_CONTAINER, default
// akldb-ddb-a) and stopped afterwards only if this process started it. When
// neither works the caller skips with the reason. Never anything but 127.0.0.1.
import { spawnSync } from "node:child_process";
import net from "node:net";

export const PORT = Number(process.env.AKLDB_DDB_PORT ?? 18407);
export const ENDPOINT = `http://127.0.0.1:${PORT}`;
const CONTAINER = process.env.AKLDB_DDB_CONTAINER ?? "akldb-ddb-a";
export const IMAGE = process.env.AKLDB_DDB_IMAGE ?? "amazon/dynamodb-local:2.6.1";

function listening(): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.connect({ host: "127.0.0.1", port: PORT });
    s.once("connect", () => (s.destroy(), resolve(true)));
    s.once("error", () => resolve(false));
  });
}

async function answers(): Promise<boolean> {
  try {
    await fetch(ENDPOINT, { method: "POST", headers: { "content-type": "application/x-amz-json-1.0", "x-amz-target": "DynamoDB_20120810.ListTables" }, body: "{}" });
    return true;
  } catch {
    return false;
  }
}

export interface DdbLocal {
  available: boolean;
  /** Why not, when unavailable. */
  reason?: string;
  stop(): void;
}

export async function startDdbLocal(): Promise<DdbLocal> {
  if (await listening()) {
    for (let i = 0; i < 50 && !(await answers()); i++) await new Promise((r) => setTimeout(r, 150));
    return { available: true, stop() {} };
  }
  if (spawnSync("docker", ["info"], { stdio: "ignore", timeout: 15000 }).status !== 0) {
    return { available: false, reason: `DynamoDB Local is not running on 127.0.0.1:${PORT} and Docker is not available to start ${IMAGE}`, stop() {} };
  }
  spawnSync("docker", ["rm", "-f", CONTAINER], { stdio: "ignore" });
  const r = spawnSync("docker", ["run", "-d", "--rm", "--name", CONTAINER, "-p", `127.0.0.1:${PORT}:8000`, IMAGE, "-jar", "DynamoDBLocal.jar", "-inMemory", "-sharedDb"], { encoding: "utf8" });
  if (r.status !== 0) return { available: false, reason: `docker run ${IMAGE} failed: ${r.stderr.trim()}`, stop() {} };
  for (let i = 0; i < 200; i++) {
    if ((await listening()) && (await answers())) return { available: true, stop: () => void spawnSync("docker", ["stop", "-t", "1", CONTAINER], { stdio: "ignore" }) };
    await new Promise((res) => setTimeout(res, 150));
  }
  spawnSync("docker", ["stop", "-t", "1", CONTAINER], { stdio: "ignore" });
  return { available: false, reason: `DynamoDB Local did not come up on 127.0.0.1:${PORT}`, stop() {} };
}
