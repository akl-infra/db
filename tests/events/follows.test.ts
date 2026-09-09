// [LDB-I2a] "Follows upstream" ⇔ the record's latest rev-bumping event has
// via = 'import:cmini'. The exact matrix from 07 §6 S4.
import { env } from "cloudflare:test";
import type { Bindings } from "../../src/env";
import { describe, expect, it } from "vitest";
import { appendInfo, appendLike, appendWrite } from "../../src/core/events";
import { followsUpstream } from "../../src/core/follows";
import { fixedClock } from "../../src/core/time";

const db = (env as unknown as Bindings).DB;
const clock = fixedClock("2026-04-01T00:00:00.000Z");

async function create(name: string): Promise<string> {
  const { record } = await appendWrite(db, clock, {
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

describe("followsUpstream matrix", () => {
  it("[LDB-I2a] {imported} -> T", async () => {
    const id = await create("follows-1");
    expect(await followsUpstream(db, id)).toBe(true);
  });

  it("[LDB-I2a] {imported, updated} -> F", async () => {
    const id = await create("follows-2");
    await appendWrite(db, clock, {
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
    expect(await followsUpstream(db, id)).toBe(false);
  });

  it("[LDB-I2a] {imported, liked} -> T", async () => {
    const id = await create("follows-3");
    await appendLike(db, clock, { kind: "liked", layoutId: id, userId: "u1", via: "discord" });
    expect(await followsUpstream(db, id)).toBe(true);
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
    expect(await followsUpstream(db, id)).toBe(true);
  });

  it("[LDB-I2a] {created} -> F", async () => {
    const id = await createByHumanOwner("follows-5");
    expect(await followsUpstream(db, id)).toBe(false);
  });

  it("[LDB-I2a] {imported, upstream_deleted} -> T", async () => {
    const id = await create("follows-6");
    await appendWrite(db, clock, {
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
    expect(await followsUpstream(db, id)).toBe(true);
  });

  it("[LDB-I2a] {imported, deleted (by owner)} -> F", async () => {
    const id = await create("follows-7");
    await appendWrite(db, clock, {
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
    expect(await followsUpstream(db, id)).toBe(false);
  });

  it("[LDB-I2a] {imported, restored (by owner)} -> F", async () => {
    // The matrix's exact sequence: imported, then restored -- no
    // intervening delete. followsUpstream only looks at the LATEST
    // rev-bumping event's `via`, so this exercises the derivation the same
    // way a real delete-then-restore would.
    const id = await create("follows-8");
    await appendWrite(db, clock, {
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
    expect(await followsUpstream(db, id)).toBe(false);
  });
});
