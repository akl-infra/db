// [LDB-P4] A name is released only by delete or rename: a write whose name
// equals a LIVE layout's name (case-insensitively) fails with name_taken; a
// tombstone keeps its literal name (LDB-P8) but only LIVE layouts occupy the
// uniqueness space (`layouts_name_live`), so a new layout -- or a restore --
// may take a name a tombstone still carries; `renamed` frees the old name in
// the same batch.
import { env } from "cloudflare:test";
import type { Bindings } from "../../src/env";
import { describe, expect, it } from "vitest";
import { commitWrite, type CommitInput } from "../../src/core/events";
import { formatsForLayout, readById, type LayoutRow } from "../../src/core/records";
import { fixedClock } from "../../src/core/time";
import { ulid } from "ulidx";

const db = (env as unknown as Bindings).DB;
const clock = fixedClock("2026-05-01T00:00:00.000Z");
const SOURCE = { client: "discord-app:test", version: null };

function create(name: string, owner = "owner-a") {
  const input: CommitInput = {
    layoutId: ulid(),
    creating: true,
    currentN: 0,
    currentLayout: null,
    currentFormats: new Map(),
    layout: { kind: "created", name, owner, created_at: clock(), deleted: false },
    format: { kind: "format_added", lineage: "spark", format: "spark/1", payload: { v: 1 }, hasMagic: false },
    modified_at: clock(),
    actor: owner,
    via: "discord",
    source: SOURCE,
    upstream: null,
  };
  return commitWrite(db, clock, input);
}

async function layoutScope(layout: LayoutRow, kind: "deleted" | "restored" | "renamed" | "updated-name", name: string, deleted: boolean) {
  const currentFormats = await formatsForLayout(db, layout.id);
  const input: CommitInput = {
    layoutId: layout.id,
    creating: false,
    currentN: layout.n,
    currentLayout: layout,
    currentFormats,
    layout: { kind: kind === "updated-name" ? "renamed" : kind, name, owner: layout.owner, created_at: layout.created_at, deleted },
    modified_at: clock(),
    actor: layout.owner,
    via: "discord",
    source: SOURCE,
    upstream: layout.upstream,
  };
  return commitWrite(db, clock, input);
}

describe("name uniqueness", () => {
  it("[LDB-P4] a write whose name matches a live layout's (case-insensitively) fails with name_taken", async () => {
    await create("Foo-1");
    await expect(create("foo-1")).rejects.toMatchObject({
      status: 409,
      body: { error: "name_taken", name: "foo-1" },
    });
  });

  it("[LDB-P4] a tombstone keeps its literal name (readable by id) and frees it for a new layout", async () => {
    const { layout: a } = await create("Bar-1");
    await layoutScope(a, "deleted", a.name, true);

    const readBack = await readById(db, a.id);
    expect(readBack).not.toBeNull();
    expect(readBack!.deleted).toBe(true);
    expect(readBack!.name).toBe("Bar-1"); // the tombstone's own name column, unchanged

    const { layout: b } = await create("Bar-1"); // same name, exact case, now claimable live
    expect(b.name).toBe("Bar-1");
    expect(b.id).not.toBe(a.id);
  });

  it("[LDB-P4] restoring a tombstone while another live layout holds its name fails with name_taken", async () => {
    const { layout: a } = await create("Restore-1");
    await layoutScope(a, "deleted", a.name, true);
    await create("Restore-1"); // a new live layout takes the freed name

    const tombstoned = (await readById(db, a.id))!;
    await expect(layoutScope(tombstoned, "restored", "Restore-1", false)).rejects.toMatchObject({ status: 409, body: { error: "name_taken", name: "Restore-1" } });
  });

  it("[LDB-P4] renamed frees the old name in the same batch", async () => {
    const { layout: a } = await create("Baz-1");
    await layoutScope(a, "renamed", "Baz-2", false);

    const { layout: b } = await create("Baz-1"); // the name vacated
    expect(b.name).toBe("Baz-1");
    expect(b.id).not.toBe(a.id);
  });

  it("[LDB-P4] a layout keeps its own name across an update (no self-collision)", async () => {
    const { layout: a } = await create("Qux-1");
    const { layout: updated } = await layoutScope(a, "renamed", a.name, false);
    expect(updated.name).toBe("Qux-1");
    expect(updated.layout_rev).toBe(a.layout_rev + 1);
  });
});
