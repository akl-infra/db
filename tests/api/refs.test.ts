// [LDB-P4] [LDB-P8] Ref resolution (21-formats.md §2.4): every seed record
// is reachable by id, by name, and by upper-cased name; a tombstone is
// unreadable by name from the moment of deletion but stays readable by id;
// a ULID-shaped name doesn't break reachability. Every GET here names
// `?format=spark/1` (D4: no default).
import { SELF } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { commitWrite, type CommitInput } from "../../src/core/events";
import { formatsForLayout, readById } from "../../src/core/records";
import { fixedClock } from "../../src/core/time";
import { ulid } from "ulidx";
import { db, seedUpstream100 } from "./support";

beforeAll(async () => {
  await seedUpstream100();
});

interface LiveRow {
  id: string;
  name: string;
}

async function fetchRef(ref: string): Promise<Response> {
  return SELF.fetch(`https://example.com/v1/layouts/${encodeURIComponent(ref)}?format=spark/1`);
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
  it("[LDB-P8] 404s by name, 200s by id, with deleted: true and the format's payload intact", async () => {
    const seed = await db.prepare("SELECT id, name FROM layouts WHERE deleted = 0 LIMIT 1").first<LiveRow>();
    if (seed === null) throw new Error("no live record to tombstone");

    const current = (await readById(db, seed.id))!;
    const formats = await formatsForLayout(db, seed.id);

    await commitWrite(db, fixedClock("2026-06-05T00:00:00.000Z"), {
      layoutId: seed.id,
      creating: false,
      currentN: current.n,
      currentLayout: current,
      currentFormats: formats,
      layout: { kind: "upstream_deleted", name: seed.name, owner: current.owner, created_at: current.created_at, deleted: true },
      modified_at: "2026-06-05T00:00:00.000Z",
      actor: "system:cmini-import",
      via: "import:cmini",
      source: { client: "system:cmini-import", version: null },
      upstream: current.upstream,
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
  it("[LDB-P8] is reachable by its id, and (via the id-then-name fallback) by its literal name too", async () => {
    const ulidShapedName = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
    const input: CommitInput = {
      layoutId: ulid(),
      creating: true,
      currentN: 0,
      currentLayout: null,
      currentFormats: new Map(),
      layout: { kind: "created", name: ulidShapedName, owner: "1", created_at: "2026-06-06T00:00:00.000Z", deleted: false },
      format: { kind: "format_added", lineage: "spark", format: "spark/1", payload: { keys: [] }, hasMagic: false },
      modified_at: "2026-06-06T00:00:00.000Z",
      actor: "1",
      via: "discord",
      source: { client: "discord-app:test", version: null },
      upstream: null,
    };
    const { layout } = await commitWrite(db, fixedClock("2026-06-06T00:00:00.000Z"), input);
    expect(layout.id).not.toBe(ulidShapedName); // minted independently -- confirms this isn't a trivial id==name coincidence

    const byId = await fetchRef(layout.id);
    expect(byId.status).toBe(200);
    expect((await byId.json<{ id: string }>()).id).toBe(layout.id);

    const byName = await fetchRef(ulidShapedName);
    expect(byName.status).toBe(200);
    expect((await byName.json<{ id: string }>()).id).toBe(layout.id);
  });
});
