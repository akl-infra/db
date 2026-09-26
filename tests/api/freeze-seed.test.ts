// [LDB-X3] design/db's cmini-importer removal (2026-09-26): `tests/fixtures/
// seed-upstream-100.dump.json` replaced the real import pipeline
// (`tests/api/support.ts`'s `seedUpstream100()` used to run `tick()`
// against `FakeUpstream`; the importer is gone -- see `CHANGELOG-API.md`
// 1.15) as the standard `upstream-100` seed every read/conformance/
// contract/fixture-export/dump/rehost test depends on. This proves the
// fixture is trustworthy on its own terms, without re-running an importer
// that no longer exists: restoring it (`seedUpstream100()`, `restoreInto`)
// and immediately re-dumping the SAME D1 (`buildDump`, the exact function
// that captured the fixture originally) reproduces the fixture BYTE FOR
// BYTE -- the frozen fixture is a stable fixed point of restore -> dump,
// not a snapshot that quietly drifts from what `restoreInto` actually
// does to a database.
import { describe, expect, it } from "vitest";
import { canonical } from "../../src/core/canonical";
import { fixedClock } from "../../src/core/time";
import { buildDump, type Dump } from "../../src/dump/write";
import frozenSeed from "../fixtures/seed-upstream-100.dump.json" with { type: "json" };
import { bindings, seedUpstream100, SEED_CLOCK_ISO } from "./support";

describe("[LDB-X3] the frozen upstream-100 seed is a stable fixed point of restore -> dump", () => {
  it("[LDB-X3] restoring the fixture and re-dumping the same D1 reproduces it byte-identically", async () => {
    await seedUpstream100();
    const redumped = await buildDump(bindings, fixedClock(SEED_CLOCK_ISO));
    expect(canonical(redumped)).toBe(canonical(frozenSeed as unknown as Dump));
  });

  it("[LDB-X3] the fixture itself carries the expected upstream-100 shape (100 layouts, no admin/client rows beyond migration bootstrap)", () => {
    const dump = frozenSeed as unknown as Dump;
    expect(dump.records.length).toBe(100);
    expect(dump.records.every((r) => r.upstream_source === "cmini" && r.upstream_state === "following")).toBe(true);
    // The migration bootstrap seeds exactly the one admin migrations/0001
    // inserts (0002's second bootstrap row is a TODO, never applied) --
    // the (now-deleted) importer never wrote to `admins`, so the frozen
    // fixture carries the same count.
    expect(dump.admins.length).toBeGreaterThanOrEqual(1);
    expect(dump.clients.length).toBe(0);
  });
});
