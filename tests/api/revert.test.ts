// [LDB-A13] rogue-trusted-client hardening (saltorbit 2026-09-13): bulk revert
// (`POST /v1/admin/clients/:id/revert`, `core/revert.ts`'s
// `revertClientWrites`) -- walks a client's own destructive events newest
// -> oldest and reverts each from its own history. Exercised directly
// against `core/revert.ts` (not through HTTP/Ed25519 signing) by building
// the same `CommitInput`/`appendLinkChange` shapes the real client-lane
// write pipeline produces (`source.client: "client:<id>"`, `via` the
// same), the same technique tests/api/l8-roundtrips.test.ts uses to drive
// `core/write.ts`'s own verbs directly.
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { Bindings } from "../../src/env";
import { appendLinkChange, commitWrite, type CommitInput } from "../../src/core/events";
import { revertClientWrites } from "../../src/core/revert";
import { formatsForLayout, readById, readFormat, type Source } from "../../src/core/records";
import { fixedClock } from "../../src/core/time";
import { ulid } from "ulidx";

const bindings = env as unknown as Bindings;
const db = bindings.DB;
const clock = fixedClock("2026-09-13T00:00:00.000Z");
const SINCE = "2026-01-01T00:00:00.000Z";
const DISCORD_SOURCE: Source = { client: "discord-app:test", version: null };
const SPARK_PAYLOAD = (n: number) => ({ keys: [{ char: String.fromCharCode(97 + n), row: 0, col: n, finger: "LP" as const }], board: "ansi" as const });

let uniqueCounter = 0;
function uniqueName(prefix: string): string {
  uniqueCounter += 1;
  return `${prefix}-${uniqueCounter}`;
}

async function createLive(owner: string, name: string): Promise<string> {
  const input: CommitInput = {
    layoutId: ulid(),
    creating: true,
    currentN: 0,
    currentLayout: null,
    currentFormats: new Map(),
    layout: { kind: "created", name, owner, created_at: clock(), deleted: false },
    format: { kind: "format_added", lineage: "spark", format: "spark/1", payload: SPARK_PAYLOAD(0), hasMagic: false },
    modified_at: clock(),
    actor: owner,
    via: "discord",
    source: DISCORD_SOURCE,
    upstream: null,
  };
  const { layout } = await commitWrite(db, clock, input);
  return layout.id;
}

// Simulates a client-lane rogue write of the given layout-scope `kind`
// (deleted/renamed/transferred) -- same CommitInput shape core/write.ts's
// own verbs build, `source.client`/`via` set to the client lane directly.
async function rogueLayoutWrite(layoutId: string, clientId: string, mutate: (current: Awaited<ReturnType<typeof readById>>) => { name: string; owner: string; deleted: boolean; kind: "deleted" | "renamed" | "transferred" }): Promise<number> {
  const current = await readById(db, layoutId);
  if (current === null) throw new Error("layout vanished");
  const { name, owner, deleted, kind } = mutate(current);
  const formats = await formatsForLayout(db, layoutId);
  const input: CommitInput = {
    layoutId,
    creating: false,
    currentN: current.n,
    currentLayout: current,
    currentFormats: formats,
    layout: { kind, name, owner, created_at: current.created_at, deleted },
    modified_at: clock(),
    actor: "900000000000000900",
    via: `client:${clientId}`,
    source: { client: `client:${clientId}`, version: null },
    upstream: null,
  };
  const { seqs } = await commitWrite(db, clock, input);
  return seqs[0]!;
}

async function otherActorRename(layoutId: string, newName: string): Promise<void> {
  const current = await readById(db, layoutId);
  if (current === null) throw new Error("layout vanished");
  const formats = await formatsForLayout(db, layoutId);
  const input: CommitInput = {
    layoutId,
    creating: false,
    currentN: current.n,
    currentLayout: current,
    currentFormats: formats,
    layout: { kind: "renamed", name: newName, owner: current.owner, created_at: current.created_at, deleted: false },
    modified_at: clock(),
    actor: "900000000000000901",
    via: "discord",
    source: DISCORD_SOURCE,
    upstream: null,
  };
  await commitWrite(db, clock, input);
}

async function eventCount(): Promise<number> {
  const row = await db.prepare("SELECT COUNT(*) AS n FROM events").first<{ n: number }>();
  return row?.n ?? 0;
}

describe("[LDB-A13] core/revert.ts: revertClientWrites", () => {
  it("[LDB-A13] a tombstone is restored, and never touched again (idempotent)", async () => {
    const owner = "900000000000000910";
    const layoutId = await createLive(owner, uniqueName("revert-delete"));
    await rogueLayoutWrite(layoutId, "R-DEL-1", () => ({ name: uniqueName("irrelevant"), owner, deleted: true, kind: "deleted" }));

    const before = await readById(db, layoutId);
    expect(before?.deleted).toBe(true);

    const first = await revertClientWrites(db, clock, "admin-1", "R-DEL-1", SINCE, { dryRun: false });
    expect(first.items.some((i) => i.outcome === "reverted" && i.scope === "layout")).toBe(true);
    const after = await readById(db, layoutId);
    expect(after?.deleted).toBe(false);

    const countAfterFirst = await eventCount();
    const second = await revertClientWrites(db, clock, "admin-1", "R-DEL-1", SINCE, { dryRun: false });
    expect(second.items.every((i) => i.outcome === "skipped_no_op")).toBe(true);
    expect(await eventCount()).toBe(countAfterFirst); // [LDB-A13] idempotent: nothing new written
  });

  it("[LDB-A13] a rename is undone; a LATER rename by another actor on the same layout blocks it (skipped_newer_write_by_other)", async () => {
    const owner = "900000000000000911";
    const original = uniqueName("revert-rename-orig");
    const layoutId = await createLive(owner, original);
    await rogueLayoutWrite(layoutId, "R-REN-1", () => ({ name: uniqueName("revert-rename-rogue"), owner, deleted: false, kind: "renamed" }));

    const result = await revertClientWrites(db, clock, "admin-1", "R-REN-1", SINCE, { dryRun: false });
    expect(result.items[0]?.outcome).toBe("reverted");
    const restored = await readById(db, layoutId);
    expect(restored?.name).toBe(original);

    // Now: rogue renames again, then a DIFFERENT (non-client, non-revert)
    // actor renames it once more -- the rogue's rename must NOT be
    // reverted out from under the other actor's later, legitimate write.
    await rogueLayoutWrite(layoutId, "R-REN-1", () => ({ name: uniqueName("revert-rename-rogue2"), owner, deleted: false, kind: "renamed" }));
    const otherName = uniqueName("revert-rename-other");
    await otherActorRename(layoutId, otherName);

    const blocked = await revertClientWrites(db, clock, "admin-1", "R-REN-1", SINCE, { dryRun: false });
    const renameItem = blocked.items.find((i) => i.scope === "layout" && i.outcome !== "skipped_no_op");
    expect(renameItem?.outcome).toBe("skipped_newer_write_by_other");
    const stillOther = await readById(db, layoutId);
    expect(stillOther?.name).toBe(otherName); // untouched
  });

  it("[LDB-A13] a transfer is undone back to the original owner", async () => {
    const ownerA = "900000000000000912";
    const ownerB = "900000000000000913";
    const layoutId = await createLive(ownerA, uniqueName("revert-transfer"));
    await rogueLayoutWrite(layoutId, "R-XFER-1", (current) => ({ name: current!.name, owner: ownerB, deleted: false, kind: "transferred" }));
    expect((await readById(db, layoutId))?.owner).toBe(ownerB);

    const result = await revertClientWrites(db, clock, "admin-1", "R-XFER-1", SINCE, { dryRun: false });
    expect(result.items[0]?.outcome).toBe("reverted");
    expect((await readById(db, layoutId))?.owner).toBe(ownerA);
  });

  it("[LDB-A13] a format replacement is rolled back to the prior layout_revs payload (a NEW rev, history never rewritten)", async () => {
    const owner = "900000000000000914";
    const layoutId = await createLive(owner, uniqueName("revert-format"));
    const before = await readFormat(db, layoutId, "spark");
    expect(before?.rev).toBe(1);

    const current = await readById(db, layoutId);
    const formats = await formatsForLayout(db, layoutId);
    const input: CommitInput = {
      layoutId,
      creating: false,
      currentN: current!.n,
      currentLayout: current,
      currentFormats: formats,
      format: { kind: "updated", lineage: "spark", format: "spark/1", payload: SPARK_PAYLOAD(1), hasMagic: false },
      modified_at: clock(),
      actor: "900000000000000900",
      via: "client:R-FMT-1",
      source: { client: "client:R-FMT-1", version: null },
      upstream: null,
    };
    await commitWrite(db, clock, input);
    const replaced = await readFormat(db, layoutId, "spark");
    expect(replaced?.rev).toBe(2);
    expect(replaced?.payload).toEqual(SPARK_PAYLOAD(1));

    const result = await revertClientWrites(db, clock, "admin-1", "R-FMT-1", SINCE, { dryRun: false });
    expect(result.items[0]?.outcome).toBe("reverted");
    const rolledBack = await readFormat(db, layoutId, "spark");
    expect(rolledBack?.rev).toBe(3); // a NEW rev, never rewriting rev 1 or 2
    expect(rolledBack?.payload).toEqual(SPARK_PAYLOAD(0));

    // Idempotent.
    const countAfterFirst = await eventCount();
    const second = await revertClientWrites(db, clock, "admin-1", "R-FMT-1", SINCE, { dryRun: false });
    expect(second.items[0]?.outcome).toBe("skipped_no_op");
    expect(await eventCount()).toBe(countAfterFirst);
  });

  it("[LDB-A13] a cleared link is restored to what it was before the clear", async () => {
    const owner = "900000000000000915";
    const layoutId = await createLive(owner, uniqueName("revert-link"));
    await appendLinkChange(db, clock, {
      layoutId,
      kind: "link_approved",
      link: "https://example.com/original",
      actor: "admin-1",
      via: "discord",
      admin: true,
      source: DISCORD_SOURCE,
    });
    await appendLinkChange(db, clock, {
      layoutId,
      kind: "link_cleared",
      link: null,
      actor: "900000000000000900",
      via: "client:R-LINK-1",
      admin: false,
      source: { client: "client:R-LINK-1", version: null },
    });
    expect((await readById(db, layoutId))?.link).toBeNull();

    const result = await revertClientWrites(db, clock, "admin-1", "R-LINK-1", SINCE, { dryRun: false });
    expect(result.items[0]?.outcome).toBe("reverted");
    expect((await readById(db, layoutId))?.link).toBe("https://example.com/original");
  });

  it("[LDB-A13] dry_run: true reports the plan and writes NOTHING (event count unchanged)", async () => {
    const owner = "900000000000000916";
    const layoutId = await createLive(owner, uniqueName("revert-dryrun"));
    await rogueLayoutWrite(layoutId, "R-DRY-1", () => ({ name: uniqueName("irrelevant"), owner, deleted: true, kind: "deleted" }));

    const countBefore = await eventCount();
    const dry = await revertClientWrites(db, clock, "admin-1", "R-DRY-1", SINCE, { dryRun: true });
    expect(dry.items[0]?.outcome).toBe("would_revert");
    expect(await eventCount()).toBe(countBefore);
    expect((await readById(db, layoutId))?.deleted).toBe(true); // untouched

    // A REAL run afterward still works normally.
    const real = await revertClientWrites(db, clock, "admin-1", "R-DRY-1", SINCE, { dryRun: false });
    expect(real.items[0]?.outcome).toBe("reverted");
    expect((await readById(db, layoutId))?.deleted).toBe(false);
  });

  it("[LDB-A13] never touches a record the client didn't write -- a client with no destructive writes reverts nothing", async () => {
    const result = await revertClientWrites(db, clock, "admin-1", "R-NEVER-WROTE-ANYTHING", SINCE, { dryRun: false });
    expect(result.items).toEqual([]);
    expect(result.scanned).toBe(0);
  });

  it("[LDB-A13] bounded per call: `next` cursor lets a second call continue below it", async () => {
    const owner = "900000000000000917";
    const layoutA = await createLive(owner, uniqueName("revert-page-a"));
    const layoutB = await createLive(owner, uniqueName("revert-page-b"));
    await rogueLayoutWrite(layoutA, "R-PAGE-1", () => ({ name: uniqueName("irrelevant-a"), owner, deleted: true, kind: "deleted" }));
    await rogueLayoutWrite(layoutB, "R-PAGE-1", () => ({ name: uniqueName("irrelevant-b"), owner, deleted: true, kind: "deleted" }));

    const firstPage = await revertClientWrites(db, clock, "admin-1", "R-PAGE-1", SINCE, { dryRun: true, limit: 1 });
    expect(firstPage.items).toHaveLength(1);
    expect(firstPage.next).not.toBeNull();

    const secondPage = await revertClientWrites(db, clock, "admin-1", "R-PAGE-1", SINCE, { dryRun: true, limit: 1, cursor: firstPage.next! });
    expect(secondPage.items).toHaveLength(1);
    expect(secondPage.items[0]!.layout_id).not.toBe(firstPage.items[0]!.layout_id);

    const thirdPage = await revertClientWrites(db, clock, "admin-1", "R-PAGE-1", SINCE, { dryRun: true, limit: 1, cursor: secondPage.next! });
    expect(thirdPage.items).toHaveLength(0);
    expect(thirdPage.next).toBeNull();
  });
});
