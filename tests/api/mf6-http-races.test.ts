// [MF-6 = LDB-P20] Coordinator review (H3): the earlier MF-6 coverage
// (tests/events/races.test.ts) exercised the concurrency guard by calling
// `commitWrite`/`commitWithRetry` directly. This file exercises the SAME
// guarantee over real HTTP (`SELF.fetch`), through the real router, the
// real `commitWithRetry`/`loadForWrite`, forcing a deterministic
// interleaving the same way `tests/api/mf13-dump-floor.test.ts` forces its
// own race: a spy on `byRefWithFormats` (the one read every write verb's
// `loadForWrite` starts with) runs a SECOND real HTTP write to completion
// the FIRST time it's called for a given layout, before returning control
// to the write that triggered it -- so the first write's `build()` reads
// STALE state, its commit collides with the second write's own `n`, and
// `commitWithRetry` rebuilds from a fresh read exactly once (`loadForWrite`
// re-running its owner/deletion/If-Match checks against post-race state,
// per the reviewer's own note that this is what makes case (b)/(c) work).
//
// (a) two DIFFERENT scopes (PUT spark, PATCH name) -- both land, 200/200.
// (b) PUT (format scope) by the OLD owner racing a transfer that lands
//     first -- the retry's fresh read sees the NEW owner -> 403 not_owner.
// (c) PUT racing a DELETE that lands first -- the retry's fresh read sees
//     `deleted: true` -> 404 not_found.
import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Bindings } from "../../src/env";
import { commitWrite, type CommitInput } from "../../src/core/events";
import { fixedClock } from "../../src/core/time";
import { ulid } from "ulidx";
import * as recordsModule from "../../src/core/records";
import { AKL_PAYLOAD, actorFixture, register, uniqueName, writeFetch } from "./write-support";

const db = (env as unknown as Bindings).DB;
const clock = fixedClock("2026-07-21T00:00:00.000Z");
const SOURCE = { client: "discord-app:test", version: null };

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

interface Seeded {
  id: string;
  owner: string;
  layoutRev: number;
  formatRev: number;
}

async function seed(owner: string): Promise<Seeded> {
  const input: CommitInput = {
    layoutId: ulid(),
    creating: true,
    currentN: 0,
    currentLayout: null,
    currentFormats: new Map(),
    layout: { kind: "created", name: uniqueName("mf6-http"), owner, created_at: clock(), deleted: false },
    format: { kind: "format_added", lineage: "spark", format: "spark/1", payload: AKL_PAYLOAD, hasMagic: false },
    modified_at: clock(),
    actor: owner,
    via: "discord",
    source: SOURCE,
    upstream: null,
  };
  const { layout, formats } = await commitWrite(db, clock, input);
  return { id: layout.id, owner, layoutRev: layout.layout_rev, formatRev: formats.get("spark")!.rev };
}

async function seedAuthor(userId: string) {
  await db.prepare("INSERT OR IGNORE INTO authors (user_id, name, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?)").bind(userId, `user-${userId}`, clock(), clock()).run();
}

// Runs `inject()` to completion exactly once, the first time
// `byRefWithFormats` is called for `layoutId` -- every other call (this
// one's own recursive internals, and every later retry attempt) passes
// straight through to the real function.
function injectOnce(layoutId: string, inject: () => Promise<void>) {
  const original = recordsModule.byRefWithFormats;
  let fired = false;
  return vi.spyOn(recordsModule, "byRefWithFormats").mockImplementation(async (...args) => {
    const result = await original(...args);
    if (!fired && args[1] === layoutId) {
      fired = true;
      await inject();
    }
    return result;
  });
}

describe("[MF-6] [LDB-P20] HTTP-level cross-scope races (H3)", () => {
  it("[MF-6] [LDB-P20] (a) PUT spark ∥ PATCH name interleaved -- both land, 200/200", async () => {
    const OWNER = `mf6a-owner-${uniqueName("u")}`;
    const seeded = await seed(OWNER);
    const fake = actorFixture();
    const headers = register(fake, `tok-${uniqueName("a")}`, OWNER);
    const newName = uniqueName("mf6a-renamed");

    const spy = injectOnce(seeded.id, async () => {
      const patchRes = await writeFetch(`/v1/layouts/${seeded.id}`, "PATCH", { ...headers, "If-Match": `"layout:${seeded.layoutRev}"` }, { name: newName });
      expect(patchRes.status, "the injected PATCH must itself land").toBe(200);
    });

    const putRes = await writeFetch(
      `/v1/layouts/${seeded.id}`,
      "PUT",
      { ...headers, "If-Match": `"spark:${seeded.formatRev}"` },
      { format: "spark/1", payload: { keys: { a: { row: 0, col: 0, finger: "LP" } } } },
    );
    spy.mockRestore();

    expect(putRes.status, "the PUT must ALSO land -- MF-6: different scopes never block each other").toBe(200);
    const putBody = await putRes.json<{ formats: Record<string, { rev: number }> }>();
    expect(putBody.formats["spark/1"]!.rev).toBe(seeded.formatRev + 1);

    // Both changes really landed: the rename AND the format replace.
    const finalLayout = await recordsModule.readById(db, seeded.id);
    expect(finalLayout!.name).toBe(newName);
    expect(finalLayout!.layout_rev).toBe(seeded.layoutRev + 1);
    const finalFormats = await recordsModule.formatsForLayout(db, seeded.id);
    expect(finalFormats.get("spark")!.rev).toBe(seeded.formatRev + 1);
  });

  it("[MF-6] [LDB-P20] (b) PUT by the OLD owner racing a transfer that lands first -- 403 not_owner after retry", async () => {
    const OWNER = `mf6b-owner-${uniqueName("u")}`;
    const NEW_OWNER = `30${uniqueName("").padStart(15, "0")}`.slice(0, 17); // 17-digit snowflake shape
    await seedAuthor(NEW_OWNER);
    const seeded = await seed(OWNER);
    const fake = actorFixture();
    const headers = register(fake, `tok-${uniqueName("b")}`, OWNER);

    const spy = injectOnce(seeded.id, async () => {
      const transferRes = await writeFetch(`/v1/layouts/${seeded.id}/transfer`, "POST", { ...headers, "If-Match": "*" }, { to: NEW_OWNER });
      expect(transferRes.status, "the injected transfer must itself land").toBe(200);
    });

    const putRes = await writeFetch(
      `/v1/layouts/${seeded.id}`,
      "PUT",
      { ...headers, "If-Match": `"spark:${seeded.formatRev}"` },
      { format: "spark/1", payload: { keys: { a: { row: 0, col: 0, finger: "LP" } } } },
    );
    spy.mockRestore();

    // The FIRST attempt's `loadForWrite` read predates the transfer (owner
    // still OWNER, so it passes that read's own ownership check) -- it's
    // only the RETRY's fresh read, after the transfer already landed, that
    // sees the new owner and refuses.
    expect(putRes.status).toBe(403);
    await expect(putRes.json()).resolves.toMatchObject({ error: "not_owner" });

    const finalLayout = await recordsModule.readById(db, seeded.id);
    expect(finalLayout!.owner).toBe(NEW_OWNER);
    // The refused PUT never touched the format row.
    const finalFormats = await recordsModule.formatsForLayout(db, seeded.id);
    expect(finalFormats.get("spark")!.rev).toBe(seeded.formatRev);
  });

  it("[MF-6] [LDB-P20] (c) PUT racing a DELETE that lands first -- 404 not_found after retry", async () => {
    const OWNER = `mf6c-owner-${uniqueName("u")}`;
    const seeded = await seed(OWNER);
    const fake = actorFixture();
    const headers = register(fake, `tok-${uniqueName("c")}`, OWNER);

    const spy = injectOnce(seeded.id, async () => {
      const deleteRes = await writeFetch(`/v1/layouts/${seeded.id}`, "DELETE", { ...headers, "If-Match": `"layout:${seeded.layoutRev}"` });
      expect(deleteRes.status, "the injected DELETE must itself land").toBe(200);
    });

    const putRes = await writeFetch(
      `/v1/layouts/${seeded.id}`,
      "PUT",
      { ...headers, "If-Match": `"spark:${seeded.formatRev}"` },
      { format: "spark/1", payload: { keys: { a: { row: 0, col: 0, finger: "LP" } } } },
    );
    spy.mockRestore();

    expect(putRes.status).toBe(404);
    await expect(putRes.json()).resolves.toMatchObject({ error: "not_found" });

    const finalLayout = await recordsModule.readById(db, seeded.id);
    expect(finalLayout!.deleted).toBe(true);
    const finalFormats = await recordsModule.formatsForLayout(db, seeded.id);
    expect(finalFormats.get("spark")!.rev).toBe(seeded.formatRev);
  });
});
