// The replica layer for the scripts, bundled the way scripts/lab/restore-at.mjs and deploy-aws.sh bundle it (TypeScript with
// extension-less imports): esbuild into a scratch directory, then a dynamic import. Needs `npm ci`; nothing is sent anywhere.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import url from "node:url";

const ROOT = path.join(path.dirname(url.fileURLToPath(import.meta.url)), "..", "..");

export async function loadKit() {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "akldb-cutover-kit-"));
  try {
    const entry = path.join(work, "entry.ts");
    const from = (f) => JSON.stringify(path.join(ROOT, f));
    fs.writeFileSync(
      entry,
      [
        `export { Replica } from ${from("src/replica/replica.ts")};`,
        `export { bootReplica } from ${from("src/replica/boot.ts")};`,
        `export { appendImage } from ${from("src/replica/image.ts")};`,
        `export { writeSnapshot } from ${from("src/replica/snapshot.ts")};`,
        `export { createDdbLog, createDdbSnapshotState } from ${from("src/replica/log-ddb.ts")};`,
        `export { createS3Objects } from ${from("src/replica/s3.ts")};`,
      ].join("\n"),
    );
    const out = path.join(work, "kit.mjs");
    const r = spawnSync(path.join(ROOT, "node_modules", ".bin", "esbuild"), [entry, "--bundle", "--platform=node", "--target=node24", "--format=esm", "--external:node:sqlite", `--outfile=${out}`, "--log-level=error"], { encoding: "utf8" });
    if (r.status !== 0) throw new Error(`esbuild failed: ${r.stderr || r.stdout}`);
    return await import(url.pathToFileURL(out).href);
  } finally {
    // the module is loaded; the bundle can go
    fs.rmSync(work, { recursive: true, force: true });
  }
}
