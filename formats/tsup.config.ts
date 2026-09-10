// @akl/layout-formats build (12 §3 X5 item 1). Four entries: the barrel
// plus each format's own subpath (package.json's "exports" map names all
// four dist outputs). ajv/ajv-formats stay external -- consumers (the
// Worker via db/src/formats/registry.ts, the bot via its own declared
// copies, LDB-B13) already have their own resolvable copy; bundling a
// second one in here would let the two silently diverge at runtime.
import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["index.ts", "spark/1/index.ts", "mana2/1/index.ts", "adapters/cmini/index.ts"],
  format: ["esm"],
  dts: true,
  splitting: true,
  external: ["ajv", "ajv-formats"],
  clean: true,
  outDir: "dist",
});
