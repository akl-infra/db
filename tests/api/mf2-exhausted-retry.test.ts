// [LDB-P23] Coordinator review (M2): every `commitWithRetry` attempt's own
// `build()` re-reads the layout fresh and checks ITS OWN scope's If-Match
// against that read -- a real staleness on the caller's own scope already
// throws a proper `409 stale` from inside `build()` well before retries
// are exhausted (that's `tests/api/ifmatch.test.ts`'s job). This file
// covers the OTHER path: every attempt's own If-Match matches, but the
// shared `layout_revs (layout_id, n)` PK keeps colliding anyway (extreme
// contention) -- `commitWrite` itself throws `RevConflictError` on every
// single attempt. Before this fix, exhausting `MAX_RETRIES` re-threw that
// raw `RevConflictError`, which `index.ts`'s `onError` doesn't recognize
// -> an unmapped `500`. Forces this deterministically by stubbing
// `commitWrite` itself to always throw (the coordinator's own suggested
// technique), rather than trying to win a real race MAX_RETRIES+1 times.
import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Bindings } from "../../src/env";
import * as eventsModule from "../../src/core/events";
import { commitWrite, RevConflictError, type CommitInput } from "../../src/core/events";
import { fixedClock } from "../../src/core/time";
import { ulid } from "ulidx";
import { AKL_PAYLOAD, actorFixture, register, uniqueName, writeFetch } from "./write-support";
import { registerForTest } from "../../formats/registry.ts";
import { T1 } from "../formats/stub-lineage.ts";

const db = (env as unknown as Bindings).DB;
const clock = fixedClock("2026-07-23T00:00:00.000Z");
const SOURCE = { client: "discord-app:test", version: null };

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

interface Seeded {
  id: string;
  owner: string;
  formatRev: number;
}

async function seed(owner: string): Promise<Seeded> {
  const input: CommitInput = {
    layoutId: ulid(),
    creating: true,
    currentN: 0,
    currentLayout: null,
    currentFormats: new Map(),
    layout: { kind: "created", name: uniqueName("mf2-retry"), owner, created_at: clock(), deleted: false },
    format: { kind: "format_added", lineage: "spark", format: "spark/1", payload: AKL_PAYLOAD, hasMagic: false },
    modified_at: clock(),
    actor: owner,
    via: "discord",
    source: SOURCE,
    upstream: null,
  };
  const { layout, formats } = await commitWrite(db, clock, input);
  return { id: layout.id, owner, formatRev: formats.get("spark")!.rev };
}

describe("[LDB-P23] M2: an exhausted commitWithRetry answers 409 stale, not a raw RevConflictError", () => {
  it("[LDB-P23] format-scope PUT: every attempt collides on `n` -> 409 stale with a fresh read, layout fields included", async () => {
    const OWNER = `mf2-owner-${uniqueName("u")}`;
    const seeded = await seed(OWNER);
    const fake = actorFixture();
    const headers = register(fake, `tok-${uniqueName("mf2")}`, OWNER);

    const spy = vi.spyOn(eventsModule, "commitWrite").mockImplementation(async () => {
      throw new RevConflictError(seeded.id);
    });

    const putRes = await writeFetch(
      `/v1/layouts/${seeded.id}`,
      "PUT",
      { ...headers, "If-Match": `"spark:${seeded.formatRev}"` },
      { format: "spark/1", payload: { keys: { a: { row: 0, col: 0, finger: "LP" } } } },
    );
    spy.mockRestore();

    // Every `build()` attempt's own fresh read+If-Match matched (nothing
    // about THIS write's scope was ever actually stale) -- only the
    // exhausted-retries fallback fired, and it must still answer the same
    // `409 stale` wire shape any other staleness does, never a 500.
    expect(putRes.status).toBe(409);
    const body = await putRes.json<{ error: string; scope: string; record: Record<string, unknown> }>();
    expect(body.error).toBe("stale");
    expect(body.scope).toBe("spark");
    expect(body.record).toMatchObject({
      id: seeded.id,
      name: expect.any(String),
      layout_rev: expect.any(Number),
      formats: expect.any(Object),
    });

    // Nothing was actually written -- commitWrite never really ran.
    const formatsRow = await db.prepare("SELECT rev FROM layout_formats WHERE layout_id = ? AND lineage = 'spark'").bind(seeded.id).first<{ rev: number }>();
    expect(formatsRow?.rev).toBe(seeded.formatRev);
  });

  it("[LDB-P23] layout-scope PATCH (rename): same exhausted-retry fallback, layout scope reported", async () => {
    const OWNER = `mf2b-owner-${uniqueName("u")}`;
    const seeded = await seed(OWNER);
    const fake = actorFixture();
    const headers = register(fake, `tok-${uniqueName("mf2b")}`, OWNER);

    const spy = vi.spyOn(eventsModule, "commitWrite").mockImplementation(async () => {
      throw new RevConflictError(seeded.id);
    });

    const patchRes = await writeFetch(`/v1/layouts/${seeded.id}`, "PATCH", { ...headers, "If-Match": '"layout:1"' }, { name: uniqueName("mf2b-renamed") });
    spy.mockRestore();

    expect(patchRes.status).toBe(409);
    const body = await patchRes.json<{ error: string; scope: string; record: Record<string, unknown> }>();
    expect(body.error).toBe("stale");
    expect(body.scope).toBe("layout");
    expect(body.record).toMatchObject({ id: seeded.id });
  });

  // Coordinator review (LOW, third batch): an exhausted retry on a format
  // ADD (`If-None-Match: *`) reaches `staleFromExhaustedRetry` with NO
  // existing row for that lineage at all -- `latestRevBumpingEvent` used
  // to assume one always exists and threw `internal()` (500) instead.
  it("[LDB-P23] format ADD (If-None-Match: *) on a lineage this layout never had: same fallback, last_write: null, never a 500", async () => {
    const OWNER = `mf2c-owner-${uniqueName("u")}`;
    const seeded = await seed(OWNER);
    const fake = actorFixture();
    const headers = register(fake, `tok-${uniqueName("mf2c")}`, OWNER);
    const unregisterT1 = registerForTest(T1);

    const spy = vi.spyOn(eventsModule, "commitWrite").mockImplementation(async () => {
      throw new RevConflictError(seeded.id);
    });

    const putRes = await writeFetch(`/v1/layouts/${seeded.id}`, "PUT", { ...headers, "If-None-Match": "*" }, { format: "t/1", payload: { v: 1, a: 1 } });
    spy.mockRestore();
    unregisterT1();

    // Every attempt's own build() found no `t` row (nothing to be
    // If-None-Match-stale against) -- only the exhausted-retries fallback
    // fired, and it must still answer 409 stale, `last_write: null`,
    // never a 500 from assuming a prior write that never happened.
    expect(putRes.status).toBe(409);
    const body = await putRes.json<{ error: string; scope: string; rev: number; record: Record<string, unknown>; last_write: unknown }>();
    expect(body.error).toBe("stale");
    expect(body.scope).toBe("t");
    expect(body.rev).toBe(0);
    expect(body.last_write).toBeNull();
    expect(body.record).toMatchObject({ id: seeded.id });

    const formatsRow = await db.prepare("SELECT 1 FROM layout_formats WHERE layout_id = ? AND lineage = 't'").bind(seeded.id).first();
    expect(formatsRow, "nothing was actually written").toBeNull();
  });
});
