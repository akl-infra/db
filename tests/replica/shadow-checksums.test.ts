// [LDB-PV4] The standalone checksum script compares two dump files table by table and says which table differs.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { afterAll, describe, expect, it } from "vitest";
import { env } from "../harness";
import type { Bindings } from "../../src/env";
import { buildDump } from "../../src/dump/write";
import { registerForTest } from "../../formats/registry.ts";
import { T1 } from "../formats/stub-lineage.ts";
import { scenario } from "./shadow-scenario";

const unregister = registerForTest(T1);
afterAll(unregister);
const ROOT = path.resolve(import.meta.dirname, "..", "..");
const run = (...args: string[]) => spawnSync(process.execPath, [path.join(ROOT, "scripts", "lab", "shadow", "checksums.mjs"), ...args], { encoding: "utf8" });

describe("scripts/lab/shadow/checksums.mjs", () => {
  it("[LDB-PV4] equal dumps exit 0 (plain or gzip), a changed feed table exits 1 and is named, a changed state table alone exits 0, other seqs are skipped (3)", async () => {
    const sc = await scenario(91);
    await sc.run(30);
    const d = await buildDump(env as unknown as Bindings, sc.clock);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "akldb-cks-"));
    try {
      const a = path.join(dir, "a.json");
      const b = path.join(dir, "b.json.gz");
      fs.writeFileSync(a, JSON.stringify(d));
      fs.writeFileSync(b, zlib.gzipSync(JSON.stringify(d)));
      const same = run("--a", a, "--b", b);
      expect(same.status, same.stderr).toBe(0);
      expect(same.stdout).toContain("feed tables EQUAL");

      const feed = structuredClone(d);
      feed.likes = feed.likes.length > 0 ? feed.likes.slice(1) : [{ layout_id: "x", user_id: "y", at: "z", via: "discord" }];
      const c = path.join(dir, "c.json");
      fs.writeFileSync(c, JSON.stringify(feed));
      const diff = run("--a", a, "--b", c);
      expect(diff.status).toBe(1);
      expect(diff.stdout).toMatch(/! likes\s+feed/);
      const asJson = JSON.parse(run("--a", a, "--b", c, "--json").stdout) as { feedEqual: boolean; differing: string[] };
      expect(asJson.feedEqual).toBe(false);
      expect(asJson.differing).toContain("likes(feed)");

      const state = structuredClone(d);
      state.authors = [...state.authors, { user_id: "zz", name: "zz", first_seen_at: "x", last_seen_at: "x" }];
      const e = path.join(dir, "e.json");
      fs.writeFileSync(e, JSON.stringify(state));
      const st = run("--a", a, "--b", e);
      expect(st.status).toBe(0);
      expect(st.stdout).toContain("state tables differ");

      const other = structuredClone(d);
      other.meta.seq += 1;
      const f = path.join(dir, "f.json");
      fs.writeFileSync(f, JSON.stringify(other));
      const skipped = run("--a", a, "--b", f);
      expect(skipped.status).toBe(3);
      expect(skipped.stdout).toMatch(/^skipped: the dumps are at different seqs/);
      expect(run("--a", a).status).toBe(2);
      expect(run("--a", a, "--b", "https://evil.example/x.json").stderr).toMatch(/refusing to read evil.example/);
    } finally {
      fs.rmSync(dir, { recursive: true });
    }
  });
});
