// [LDB-I2a] "Follows upstream" ⇔ the record's latest rev-bumping event has
// via = 'import:cmini'. The exact matrix from 07 §6 S4.
import { env } from "cloudflare:test";
import type { Bindings } from "../../src/env";
import { describe, expect, it } from "vitest";
import { appendInfo, appendLike, appendWrite, type WriteKind } from "../../src/core/events";
import { legacyFollows } from "../../src/core/follows";
import { fixedClock } from "../../src/core/time";

const db = (env as unknown as Bindings).DB;
const clock = fixedClock("2026-04-01T00:00:00.000Z");

async function create(name: string): Promise<string> {
  const { record } = await appendWrite(db, clock, {
      upstream: null,
    kind: "imported",
    name,
    owner: "owner-a",
    modified_at: clock(),
    format: "cmini/1",
    payload: { v: 1 },
    actor: "system:cmini-import",
    via: "import:cmini",
  });
  return record.id;
}

async function createByHumanOwner(name: string): Promise<string> {
  const { record } = await appendWrite(db, clock, {
      upstream: null,
    kind: "created",
    name,
    owner: "owner-a",
    modified_at: clock(),
    format: "cmini/1",
    payload: { v: 1 },
    actor: "owner-a",
    via: "discord",
  });
  return record.id;
}

describe("legacyFollows matrix", () => {
  it("[LDB-I2a] {imported} -> T", async () => {
    const id = await create("follows-1");
    expect(await legacyFollows(db, id)).toBe(true);
  });

  it("[LDB-I2a] {imported, updated} -> F", async () => {
    const id = await create("follows-2");
    await appendWrite(db, clock, {
      upstream: null,
      kind: "updated",
      layoutId: id,
      name: "follows-2",
      owner: "owner-a",
      modified_at: clock(),
      format: "cmini/1",
      payload: { v: 2 },
      actor: "owner-a",
      via: "discord",
    });
    expect(await legacyFollows(db, id)).toBe(false);
  });

  it("[LDB-I2a] {imported, liked} -> T", async () => {
    const id = await create("follows-3");
    await appendLike(db, clock, { kind: "liked", layoutId: id, userId: "u1", via: "discord" });
    expect(await legacyFollows(db, id)).toBe(true);
  });

  it("[LDB-I2a] {imported, upstream_changed} -> T", async () => {
    const id = await create("follows-4");
    await appendInfo(db, clock, {
      kind: "upstream_changed",
      layoutId: id,
      actor: "system:cmini-import",
      via: "import:cmini",
      detail: { note: "x" },
    });
    expect(await legacyFollows(db, id)).toBe(true);
  });

  it("[LDB-I2a] {created} -> F", async () => {
    const id = await createByHumanOwner("follows-5");
    expect(await legacyFollows(db, id)).toBe(false);
  });

  it("[LDB-I2a] {imported, upstream_deleted} -> T", async () => {
    const id = await create("follows-6");
    await appendWrite(db, clock, {
      upstream: null,
      kind: "upstream_deleted",
      layoutId: id,
      name: "follows-6",
      owner: "owner-a",
      modified_at: clock(),
      format: "cmini/1",
      payload: { v: 1 },
      actor: "system:cmini-import",
      via: "import:cmini",
      deleted: true,
    });
    expect(await legacyFollows(db, id)).toBe(true);
  });

  it("[LDB-I2a] {imported, deleted (by owner)} -> F", async () => {
    const id = await create("follows-7");
    await appendWrite(db, clock, {
      upstream: null,
      kind: "deleted",
      layoutId: id,
      name: "follows-7",
      owner: "owner-a",
      modified_at: clock(),
      format: "cmini/1",
      payload: { v: 1 },
      actor: "owner-a",
      via: "discord",
      deleted: true,
    });
    expect(await legacyFollows(db, id)).toBe(false);
  });

  it("[LDB-I2a] {imported, restored (by owner)} -> F", async () => {
    // The matrix's exact sequence: imported, then restored -- no
    // intervening delete. legacyFollows only looks at the LATEST
    // rev-bumping event's `via`, so this exercises the derivation the same
    // way a real delete-then-restore would.
    const id = await create("follows-8");
    await appendWrite(db, clock, {
      upstream: null,
      kind: "restored",
      layoutId: id,
      name: "follows-8-restored",
      owner: "owner-a",
      modified_at: clock(),
      format: "cmini/1",
      payload: { v: 1 },
      actor: "owner-a",
      via: "discord",
      deleted: false,
    });
    expect(await legacyFollows(db, id)).toBe(false);
  });
});

// LDB-I12 (design/layout-db/18-command-decisions.md §2 item 1;
// 17-magic-ownership.md's M2 prerequisite): a magic-only `updated` event
// (`detail: {fields: ["magic"], magic_only: true}` -- what `core/write.ts`'s
// `patchLayout` appends for a PATCH whose body is only `{magic}`) is
// skipped when finding "the latest write" -- constructed directly here via
// `appendWrite` rather than through `patchLayout`/HTTP so this stays a pure
// events -> boolean unit test, same style as the LDB-I2a matrix above.
async function appendMagicOnlyUpdate(id: string, name: string): Promise<void> {
  await appendWrite(db, clock, {
      upstream: null,
    kind: "updated",
    layoutId: id,
    name,
    owner: "owner-a",
    modified_at: clock(),
    format: "akl/1",
    payload: { keys: {}, magic: { rules: [{ inputs: "aa", output: "ab" }] } },
    actor: "owner-a",
    via: "discord",
    detail: { fields: ["magic"], magic_only: true },
  });
}

describe("[LDB-I12] legacyFollows skips magic-only rev-bumping events", () => {
  it("[LDB-I12] {imported, magic-only updated} -> T (a magic-only PATCH never forks a following record)", async () => {
    const id = await create("follows-i12-1");
    await appendMagicOnlyUpdate(id, "follows-i12-1");
    expect(await legacyFollows(db, id)).toBe(true);
  });

  it("[LDB-I12] {imported, magic-only updated x2} -> T (any number of magic-only writes stack)", async () => {
    const id = await create("follows-i12-2");
    await appendMagicOnlyUpdate(id, "follows-i12-2");
    await appendMagicOnlyUpdate(id, "follows-i12-2");
    expect(await legacyFollows(db, id)).toBe(true);
  });

  it("[LDB-I12] {imported, magic-only updated, updated (real fork)} -> F (a later real write still forks)", async () => {
    const id = await create("follows-i12-3");
    await appendMagicOnlyUpdate(id, "follows-i12-3");
    await appendWrite(db, clock, {
      upstream: null,
      kind: "updated",
      layoutId: id,
      name: "follows-i12-3",
      owner: "owner-a",
      modified_at: clock(),
      format: "akl/1",
      payload: { keys: { a: { row: 0, col: 0, finger: "LP" } }, magic: { rules: [{ inputs: "aa", output: "ab" }] } },
      actor: "owner-a",
      via: "discord",
      detail: { fields: ["fingermap", "magic"] }, // NOT magic-only: magic_only is only ever set when fields === ["magic"]
    });
    expect(await legacyFollows(db, id)).toBe(false);
  });

  it("[LDB-I12] {created (human), magic-only updated} -> F (a magic-only PATCH never REVIVES a follow that wasn't there)", async () => {
    const id = await createByHumanOwner("follows-i12-4");
    await appendMagicOnlyUpdate(id, "follows-i12-4");
    expect(await legacyFollows(db, id)).toBe(false);
  });
});

// 20-spark.md S3a: `legacyFollows` (this file's S2 rename target) also
// skips `migrated` events (S4's own writes) when finding "the latest
// write" -- otherwise a migration's OWN write would become the record's
// latest rev-bumping event, and `legacyFollows` (the S4/`upstreamOf`
// fallback's own rule) would then read the migration's `via`
// ("system:migration", never "import:cmini") instead of walking back to
// what the record actually was following before its migration.
describe("[LDB-I12] legacyFollows skips migrated rev-bumping events", () => {
  it("[LDB-I12] {imported, migrated} -> T (a migration alone never changes the legacy answer)", async () => {
    const id = await create("follows-i12-5");
    await appendWrite(db, clock, {
      upstream: null,
      kind: "migrated" as WriteKind, // S4 adds this to WriteKind; cast here since S3a lands first
      layoutId: id,
      name: "follows-i12-5",
      owner: "owner-a",
      modified_at: clock(),
      format: "spark/1",
      payload: { v: 1 },
      actor: "system:migration",
      via: "migration",
      detail: { from: "cmini/1", to: "spark/1" },
    });
    expect(await legacyFollows(db, id)).toBe(true);
  });

  it("[LDB-I12] {created (human), migrated} -> F (a migration never REVIVES a follow that wasn't there)", async () => {
    const id = await createByHumanOwner("follows-i12-6");
    await appendWrite(db, clock, {
      upstream: null,
      kind: "migrated" as WriteKind, // S4 adds this to WriteKind; cast here since S3a lands first
      layoutId: id,
      name: "follows-i12-6",
      owner: "owner-a",
      modified_at: clock(),
      format: "spark/1",
      payload: { v: 1 },
      actor: "system:migration",
      via: "migration",
      detail: { from: "cmini/1", to: "spark/1" },
    });
    expect(await legacyFollows(db, id)).toBe(false);
  });

  it("[LDB-I12] {imported, migrated, updated (real fork)} -> F (a later real write still forks, past any number of migrated events)", async () => {
    const id = await create("follows-i12-7");
    await appendWrite(db, clock, {
      upstream: null,
      kind: "migrated" as WriteKind, // S4 adds this to WriteKind; cast here since S3a lands first
      layoutId: id,
      name: "follows-i12-7",
      owner: "owner-a",
      modified_at: clock(),
      format: "spark/1",
      payload: { v: 1 },
      actor: "system:migration",
      via: "migration",
      detail: { from: "cmini/1", to: "spark/1" },
    });
    await appendWrite(db, clock, {
      upstream: null,
      kind: "updated",
      layoutId: id,
      name: "follows-i12-7",
      owner: "owner-a",
      modified_at: clock(),
      format: "spark/1",
      payload: { v: 2 },
      actor: "owner-a",
      via: "discord",
    });
    expect(await legacyFollows(db, id)).toBe(false);
  });
});
