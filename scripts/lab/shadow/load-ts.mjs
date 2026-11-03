// Load a TypeScript module of src/ from a plain-Node script. The sources import each other without extensions (bundler
// resolution), which Node cannot follow, so the module is bundled with esbuild (a devDependency) into a temporary ESM file.
// Used for the code the scripts must share with the service (the dump comparison, the applier's kind table).
import { build } from "esbuild";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import url from "node:url";

const ROOT = path.join(path.dirname(url.fileURLToPath(import.meta.url)), "..", "..", "..");

/** `await loadTs("src/replica/shadow/checksum.ts")` -> the module's exports. */
export async function loadTs(relPath) {
  const out = await build({ entryPoints: [path.join(ROOT, relPath)], bundle: true, write: false, format: "esm", platform: "node", target: "node24", logLevel: "silent", external: ["node:*"] });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "akldb-shadow-ts-"));
  const file = path.join(dir, `${path.basename(relPath, ".ts")}.mjs`);
  fs.writeFileSync(file, out.outputFiles[0].text);
  try {
    return await import(url.pathToFileURL(file).href);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
