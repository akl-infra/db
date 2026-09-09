// [LDB-P4] A name is released only by delete or rename: a write whose name
// equals a LIVE record's name (case-insensitively) fails with name_taken;
// a tombstone keeps its literal name (01 §1) but only LIVE records occupy
// the uniqueness space (migrations/0001_init.sql's `layouts_name_live`
// partial index), so a new record -- or a restore -- may take a name a
// tombstone still carries; `renamed` frees the old name in the same batch.
import { env } from "cloudflare:test";
import type { Bindings } from "../../src/env";
import { describe, expect, it } from "vitest";
import { appendWrite } from "../../src/core/events";
import { readById } from "../../src/core/records";
import { fixedClock } from "../../src/core/time";

const db = (env as unknown as Bindings).DB;
const clock = fixedClock("2026-05-01T00:00:00.000Z");

function create(name: string, owner = "owner-a") {
  return appendWrite(db, clock, {
    kind: "created",
    name,
    owner,
    modified_at: clock(),
    format: "cmini/1",
    payload: { v: 1 },
    actor: owner,
    via: "discord",
  });
}

function tombstone(record: { id: string; name: string; owner: string; format: string; payload: unknown }) {
  return appendWrite(db, clock, {
    kind: "deleted",
    layoutId: record.id,
    name: record.name,
    owner: record.owner,
    modified_at: clock(),
    format: record.format,
    payload: record.payload,
    actor: record.owner,
    via: "discord",
    deleted: true,
  });
}

describe("name uniqueness", () => {
  it("[LDB-P4] a write whose name matches a live record's (case-insensitively) fails with name_taken", async () => {
    await create("Foo-1");
    await expect(create("foo-1")).rejects.toMatchObject({
      status: 409,
      body: { error: "name_taken", name: "foo-1" },
    });
  });

  it("[LDB-P4] a tombstone keeps its literal name (readable by id) and frees it for a new record", async () => {
    const { record: a } = await create("Bar-1");
    await tombstone(a);

    const readBack = await readById(db, a.id);
    expect(readBack).not.toBeNull();
    expect(readBack!.deleted).toBe(true);
    expect(readBack!.name).toBe("Bar-1"); // the tombstone's own name column, unchanged

    const { record: b } = await create("Bar-1"); // same name, exact case, now claimable live
    expect(b.name).toBe("Bar-1");
    expect(b.id).not.toBe(a.id);
  });

  it("[LDB-P4] restoring a tombstone while another live record holds its name fails with name_taken", async () => {
    const { record: a } = await create("Restore-1");
    await tombstone(a);
    await create("Restore-1"); // a new live record takes the freed name

    await expect(
      appendWrite(db, clock, {
        kind: "restored",
        layoutId: a.id,
        name: "Restore-1",
        owner: a.owner,
        modified_at: clock(),
        format: a.format,
        payload: a.payload,
        actor: a.owner,
        via: "discord",
        deleted: false,
      }),
    ).rejects.toMatchObject({ status: 409, body: { error: "name_taken", name: "Restore-1" } });
  });

  it("[LDB-P4] renamed frees the old name in the same batch", async () => {
    const { record: a } = await create("Baz-1");
    await appendWrite(db, clock, {
      kind: "renamed",
      layoutId: a.id,
      name: "Baz-2",
      owner: a.owner,
      modified_at: clock(),
      format: a.format,
      payload: a.payload,
      actor: a.owner,
      via: "discord",
    });

    const { record: b } = await create("Baz-1"); // the name "renamed" vacated
    expect(b.name).toBe("Baz-1");
    expect(b.id).not.toBe(a.id);
  });

  it("[LDB-P4] a record keeps its own name across an update (no self-collision)", async () => {
    const { record: a } = await create("Qux-1");
    const { record: updated } = await appendWrite(db, clock, {
      kind: "updated",
      layoutId: a.id,
      name: a.name,
      owner: a.owner,
      modified_at: clock(),
      format: a.format,
      payload: { v: 2 },
      actor: a.owner,
      via: "discord",
    });
    expect(updated.name).toBe("Qux-1");
    expect(updated.rev).toBe(a.rev + 1);
  });
});
