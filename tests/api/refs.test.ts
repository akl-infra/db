// [LDB-P4] [LDB-P8] Ref resolution (03 §1): every seed record is reachable
// by id, by name, and by upper-cased name; a tombstone is unreadable by
// name from the moment of deletion but stays readable by id; a
// ULID-shaped name (which `check_name`, phase 2, would refuse to ever
// freshly assign -- 07 §10) doesn't break reachability.
import { SELF } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { appendWrite } from "../../src/core/events";
import { fixedClock } from "../../src/core/time";
import { db, seedUpstream100 } from "./support";

beforeAll(async () => {
  await seedUpstream100();
});

interface LiveRow {
  id: string;
  name: string;
}

async function fetchRef(ref: string): Promise<Response> {
  return SELF.fetch(`https://example.com/v1/layouts/${encodeURIComponent(ref)}`);
}

describe("[LDB-P4] every seed record is reachable by id, name, and upper-cased name", () => {
  it("[LDB-P4] holds for all 100 live records", async () => {
    const { results } = await db.prepare("SELECT id, name FROM layouts WHERE deleted = 0").all<LiveRow>();
    expect(results.length).toBe(100);

    for (const { id, name } of results) {
      const byId = await fetchRef(id);
      expect(byId.status, `by id '${id}'`).toBe(200);
      const idBody = await byId.json<{ id: string }>();
      expect(idBody.id).toBe(id);

      const byName = await fetchRef(name);
      expect(byName.status, `by name '${name}'`).toBe(200);
      const nameBody = await byName.json<{ id: string }>();
      expect(nameBody.id).toBe(id);

      const byUpper = await fetchRef(name.toUpperCase());
      expect(byUpper.status, `by upper-cased name '${name.toUpperCase()}'`).toBe(200);
      const upperBody = await byUpper.json<{ id: string }>();
      expect(upperBody.id).toBe(id);
    }
  });
});

describe("[LDB-P8] a tombstone is unreadable by name, readable by id", () => {
  it("[LDB-P8] 404s by name, 200s by id, with deleted: true and the payload intact", async () => {
    const seed = await db.prepare("SELECT id, name FROM layouts WHERE deleted = 0 LIMIT 1").first<LiveRow>();
    if (seed === null) throw new Error("no live record to tombstone");

    const current = await db
      .prepare("SELECT owner, rev, format, payload_json FROM layouts WHERE id = ?")
      .bind(seed.id)
      .first<{ owner: string; rev: number; format: string; payload_json: string }>();
    if (current === null) throw new Error("record vanished");

    await appendWrite(db, fixedClock("2026-06-05T00:00:00.000Z"), {
      upstream: null,
      kind: "upstream_deleted",
      layoutId: seed.id,
      name: seed.name,
      owner: current.owner,
      modified_at: "2026-06-05T00:00:00.000Z",
      format: current.format,
      payload: JSON.parse(current.payload_json) as unknown,
      actor: "system:cmini-import",
      via: "import:cmini",
      source: { client: "system:cmini-import", version: null },
      deleted: true,
    });

    const byName = await fetchRef(seed.name);
    expect(byName.status).toBe(404);

    const byId = await fetchRef(seed.id);
    expect(byId.status).toBe(200);
    const body = await byId.json<{ deleted: boolean; payload: unknown }>();
    expect(body.deleted).toBe(true);
    expect(body.payload).not.toBeNull();
  });
});

describe("[LDB-P8] a ULID-shaped name doesn't break reachability", () => {
  // `check_name` (phase 2, 03 §3) refuses a freshly-assigned ULID-shaped
  // name, so the only way one exists at all in phase 1 is a raw internal
  // op (an import, or here, a direct `appendWrite`) -- 07 §0.1 confirms
  // none exist in the real corpus. This record's real `id` is a DIFFERENT
  // ulid than its `name`; the record is reachable by its `id` regardless
  // (id lookup never depends on what the name happens to look like). Its
  // `name` string ALSO happens to resolve it, via `byRef`'s own documented
  // fallback (03 §1: a ULID-shaped ref is tried as an id first, then as a
  // name) -- that fallback finding the SAME record is not an ambiguity
  // (nothing else could match), so it's asserted here too rather than
  // treated as a violation.
  it("[LDB-P8] is reachable by its id, and (via the id-then-name fallback) by its literal name too", async () => {
    const ulidShapedName = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
    const { record } = await appendWrite(db, fixedClock("2026-06-06T00:00:00.000Z"), {
      upstream: null,
      kind: "created",
      name: ulidShapedName,
      owner: "1",
      modified_at: "2026-06-06T00:00:00.000Z",
      format: "spark/1",
      payload: { keys: {} },
      actor: "1",
      via: "discord",
      source: { client: "discord-app:test", version: null },
    });
    expect(record.id).not.toBe(ulidShapedName); // minted independently -- confirms this isn't a trivial id==name coincidence

    const byId = await fetchRef(record.id);
    expect(byId.status).toBe(200);
    expect((await byId.json<{ id: string }>()).id).toBe(record.id);

    const byName = await fetchRef(ulidShapedName);
    expect(byName.status).toBe(200);
    expect((await byName.json<{ id: string }>()).id).toBe(record.id);
  });
});
