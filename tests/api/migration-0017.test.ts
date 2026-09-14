// [LDB-F41] migrations/0017_magic_emit.sql (design/layout-db/27-magic-emit.md):
// every stored spark/1 magic-key rule `{after, output}` becomes `{after,
// emit}` with `emit = output minus the leading after` -- the current
// `layout_formats` row AND every historical `layout_revs` payload -- and
// what is left is byte-identical to `canonical()` of the same payload (so a
// stored row still hashes/compares exactly like a freshly written one).
// The suite's own D1 already has 0017 applied by the time any test runs
// (tests/setup-workers.ts), so this re-runs the migration's own statements
// (read back from the TEST_MIGRATIONS binding, never retyped) over rows it
// inserts in the OLD shape first.
import { env } from "cloudflare:test";
import type { D1Migration } from "@cloudflare/vitest-pool-workers";
import { describe, expect, it } from "vitest";
import { canonical } from "../../src/core/canonical";
import { ulid } from "ulidx";

const e = env as unknown as { DB: D1Database; TEST_MIGRATIONS: D1Migration[] };

function migration0017(): D1Migration {
  const m = e.TEST_MIGRATIONS.find((x) => x.name.startsWith("0017_"));
  if (m === undefined) throw new Error("migrations/0017_magic_emit.sql is not in TEST_MIGRATIONS");
  return m;
}

async function rerun0017(): Promise<void> {
  for (const q of migration0017().queries) await e.DB.prepare(q).run();
}

async function insertRecord(id: string, payload: unknown, revPayloads: unknown[]): Promise<void> {
  const now = "2026-09-13T00:00:00Z";
  await e.DB.prepare("INSERT INTO layouts (id, name, owner, n, layout_rev, created_at, modified_at) VALUES (?, ?, ?, ?, 1, ?, ?)")
    .bind(id, `m0017-${id}`, "184412255822020608", revPayloads.length, now, now)
    .run();
  await e.DB.prepare("INSERT INTO layout_formats (layout_id, lineage, format, rev, created_at, modified_at, payload_json, has_magic) VALUES (?, 'spark', 'spark/1', ?, ?, ?, ?, 1)")
    .bind(id, revPayloads.length, now, now, canonical(payload))
    .run();
  for (let i = 0; i < revPayloads.length; i++) {
    await e.DB.prepare("INSERT INTO layout_revs (layout_id, n, lineage, rev, event_seq, format, payload_json) VALUES (?, ?, 'spark', ?, ?, 'spark/1', ?)")
      .bind(id, i + 1, i + 1, i + 1, canonical(revPayloads[i]))
      .run();
  }
}

describe("[LDB-F41] migration 0017 rewrites every stored magic-key rule to {after, emit}", () => {
  it("[LDB-F41] rules lose `output` and gain `emit` (context stripped), other magic fields, keys and rows without rules are untouched; the result equals canonical(); idempotent", async () => {
    const keys = [{ char: "a", row: 0, col: 0, finger: "LP" }, { char: "*", row: 0, col: 1, finger: "LR" }, { char: "@", row: 0, col: 2, finger: "LM" }];
    const oldShape = {
      keys,
      magic: {
        magic_keys: [
          { key: "*", default: { kind: "repeat" }, except: ["@"], rules: [{ after: "a", output: "ab" }, { after: "'", output: "'r" }, { after: "th", output: "the" }] },
          { key: "@", rules: [] },
        ],
        chiral_keys: [{ key: "a", same: { kind: "repeat" } }],
        adaptive_swaps: [{ trigger: "a", swap: ["*", "@"] }],
        rules: [{ inputs: "xa", output: "xy" }],
      },
    };
    const newShape = {
      keys,
      magic: {
        magic_keys: [
          { key: "*", default: { kind: "repeat" }, except: ["@"], rules: [{ after: "a", emit: "b" }, { after: "'", emit: "r" }, { after: "th", emit: "e" }] },
          { key: "@", rules: [] },
        ],
        chiral_keys: [{ key: "a", same: { kind: "repeat" } }],
        adaptive_swaps: [{ trigger: "a", swap: ["*", "@"] }],
        rules: [{ inputs: "xa", output: "xy" }],
      },
    };
    const noRules = { keys, magic: { magic_keys: [{ key: "*", default: { kind: "repeat" } }] } };
    const noMagic = { keys };

    const withRules = ulid();
    const plain = ulid();
    const bare = ulid();
    await insertRecord(withRules, oldShape, [noMagic, oldShape]);
    await insertRecord(plain, noRules, [noRules]);
    await insertRecord(bare, noMagic, [noMagic]);

    await rerun0017();

    const cur = async (id: string) => (await e.DB.prepare("SELECT payload_json, rev FROM layout_formats WHERE layout_id = ?").bind(id).first<{ payload_json: string; rev: number }>())!;
    const revs = async (id: string) => (await e.DB.prepare("SELECT payload_json FROM layout_revs WHERE layout_id = ? ORDER BY n").bind(id).all<{ payload_json: string }>()).results.map((r) => r.payload_json);

    expect((await cur(withRules)).payload_json).toBe(canonical(newShape)); // byte-identical, not just deep-equal
    expect((await cur(withRules)).rev).toBe(2); // never bumped
    expect(await revs(withRules)).toEqual([canonical(noMagic), canonical(newShape)]);
    expect((await cur(plain)).payload_json).toBe(canonical(noRules));
    expect((await cur(bare)).payload_json).toBe(canonical(noMagic));

    await rerun0017(); // idempotent
    expect((await cur(withRules)).payload_json).toBe(canonical(newShape));
  });
});
