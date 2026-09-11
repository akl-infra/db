// [LDB-P8] Restore (21-formats.md §2.2/§2.4; 20-spark.md §1 decisions 8 and
// 9): owner or admin restores a tombstone AT ANY TIME; a live record
// holding the name meanwhile is `409 name_taken`; by name is always `404`
// (a tombstone has no live name); by id on a live record is `400`;
// restoring an `upstream_deleted` tombstone as the owner stops it following
// upstream. The body is optional -- absent, `{}`, or `{name}` (a different
// name goes through `check_name`, recorded as `detail: {renamed_from}`) --
// any other key is `400 bad_request`. Restore is LAYOUT scope only (D3):
// the tombstone's formats are untouched, never touched by this write at
// all -- the response carries no `format`/`payload`.
import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Bindings } from "../../src/env";
import { commitWrite, type CommitInput } from "../../src/core/events";
import { formatsForLayout, readById } from "../../src/core/records";
import { fixedClock } from "../../src/core/time";
import type { Clock } from "../../src/core/time";
import { ulid } from "ulidx";
import { AKL_PAYLOAD, actorFixture, pinTestClock, register, uniqueName, writeFetch } from "./write-support";

const bindings = env as unknown as Bindings;
const db = bindings.DB;
const OWNER = "owner-restore-1";
const OTHER = "owner-restore-2";
const DELETED_AT = "2026-08-01T00:00:00.000Z";
const SOURCE = { client: "discord-app:test", version: null };
const IMPORT_SOURCE = { client: "system:cmini-import", version: null };

afterEach(() => {
  vi.unstubAllGlobals();
});

function setNow(iso: string) {
  pinTestClock(env as unknown as { TEST_CLOCK?: Clock }, fixedClock(iso));
}

function ownerHeaders(id: string, token: string) {
  const fake = actorFixture();
  return register(fake, token, id);
}

interface Created {
  id: string;
  name: string;
  owner: string;
  layoutRev: number;
  formatRev: number;
  payload: unknown;
}

async function createLayout(name: string, owner: string, via: "discord" | "import:cmini"): Promise<Created> {
  const isImport = via === "import:cmini";
  const input: CommitInput = {
    layoutId: ulid(),
    creating: true,
    currentN: 0,
    currentLayout: null,
    currentFormats: new Map(),
    layout: { kind: isImport ? "imported" : "created", name, owner, created_at: DELETED_AT, deleted: false },
    format: { kind: isImport ? "imported" : "format_added", lineage: "spark", format: "spark/1", payload: AKL_PAYLOAD, hasMagic: false },
    modified_at: DELETED_AT,
    actor: isImport ? "system:cmini-import" : owner,
    via,
    source: isImport ? IMPORT_SOURCE : SOURCE,
    upstream: isImport ? { source: "cmini", id: `up-${uniqueName("restore")}`, state: "following" } : null,
  };
  const { layout, formats } = await commitWrite(db, fixedClock(DELETED_AT), input);
  const spark = formats.get("spark")!;
  return { id: layout.id, name: layout.name, owner: layout.owner, layoutRev: layout.layout_rev, formatRev: spark.rev, payload: spark.payload };
}

async function seedTombstone(name = uniqueName("restore-seed"), owner = OWNER, via: "discord" | "import:cmini" = "discord"): Promise<Created> {
  const created = await createLayout(name, owner, via);
  const current = (await readById(db, created.id))!;
  const formats = await formatsForLayout(db, created.id);
  const isImport = via === "import:cmini";
  const input: CommitInput = {
    layoutId: created.id,
    creating: false,
    currentN: current.n,
    currentLayout: current,
    currentFormats: formats,
    layout: { kind: isImport ? "upstream_deleted" : "deleted", name, owner, created_at: current.created_at, deleted: true },
    modified_at: DELETED_AT,
    actor: isImport ? "system:cmini-import" : owner,
    via,
    source: isImport ? IMPORT_SOURCE : SOURCE,
    upstream: current.upstream,
  };
  const { layout } = await commitWrite(db, fixedClock(DELETED_AT), input);
  return { ...created, layoutRev: layout.layout_rev };
}

function addDays(iso: string, days: number): string {
  return new Date(new Date(iso).getTime() + days * 24 * 60 * 60 * 1000).toISOString();
}

async function restore(id: string, headers: Record<string, string>, body?: unknown): Promise<Response> {
  return writeFetch(`/v1/layouts/${id}/restore`, "POST", body === undefined ? headers : { ...headers, "Content-Type": "application/json" }, body);
}

describe("[LDB-P8] restore has no time limit", () => {
  it("[LDB-P8] [LDB-F16] shortly after deletion -> 200, layout_rev + 1, formats untouched, live by name", async () => {
    const tombstone = await seedTombstone();
    setNow(addDays(DELETED_AT, 1));

    const headers = ownerHeaders(OWNER, `tok-${uniqueName("t")}`);
    const res = await restore(tombstone.id, headers);
    expect(res.status).toBe(200);
    const body = await res.json<{ deleted: boolean; name: string; layout_rev: number; formats: Record<string, { rev: number }> }>();
    expect(body.deleted).toBe(false);
    expect(body.name).toBe(tombstone.name);
    expect(body.formats["spark/1"]!.rev).toBe(tombstone.formatRev); // untouched -- D3
    expect(body.layout_rev).toBe(tombstone.layoutRev + 1);

    const byName = await writeFetch(`/v1/layouts/${encodeURIComponent(tombstone.name)}?format=spark/1`, "GET");
    expect(byName.status).toBe(200);
  });

  it("[LDB-P8] 90 days after deletion -> still 200 for the owner (no window)", async () => {
    const tombstone = await seedTombstone();
    setNow(addDays(DELETED_AT, 90));

    const headers = ownerHeaders(OWNER, `tok-${uniqueName("t")}`);
    const res = await restore(tombstone.id, headers);
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ deleted: false });
  });

  it("[LDB-P8] 90 days after deletion -> 200 for an admin too", async () => {
    const tombstone = await seedTombstone();
    setNow(addDays(DELETED_AT, 90));

    const headers = ownerHeaders("184412255822020608", `tok-${uniqueName("t")}`);
    const res = await restore(tombstone.id, headers);
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ deleted: false });
  });
});

describe("[LDB-P8] restore edge cases", () => {
  it("restore of a live record -> 400", async () => {
    const record = await createLayout(uniqueName("live-not-deleted"), OWNER, "discord");
    setNow(DELETED_AT);
    const headers = ownerHeaders(OWNER, `tok-${uniqueName("t")}`);
    const res = await restore(record.id, headers);
    expect(res.status).toBe(400);
  });

  it("a live holder of the name meanwhile, no {name} in the body -> 409 name_taken with holder", async () => {
    const tombstone = await seedTombstone();
    const holder = await createLayout(tombstone.name, OTHER, "discord");
    setNow(DELETED_AT);
    const headers = ownerHeaders(OWNER, `tok-${uniqueName("t")}`);
    const res = await restore(tombstone.id, headers);
    expect(res.status).toBe(409);
    const body = await res.json<{ error: string; holder: { id: string; owner: string } }>();
    expect(body.error).toBe("name_taken");
    expect(body.holder).toEqual({ id: holder.id, owner: holder.owner });
  });

  it("by name -> 404 (a tombstone has no live name)", async () => {
    const tombstone = await seedTombstone();
    setNow(DELETED_AT);
    const headers = ownerHeaders(OWNER, `tok-${uniqueName("t")}`);
    const res = await writeFetch(`/v1/layouts/${encodeURIComponent(tombstone.name)}/restore`, "POST", headers);
    expect(res.status).toBe(404);
  });

  it("[LDB-I14] owner restores an upstream_deleted tombstone -> 200, no longer follows upstream", async () => {
    const tombstone = await seedTombstone(uniqueName("was-following"), OWNER, "import:cmini");
    setNow(DELETED_AT);
    const headers = ownerHeaders(OWNER, `tok-${uniqueName("t")}`);
    const res = await restore(tombstone.id, headers);
    expect(res.status).toBe(200);

    const { results } = await db
      .prepare("SELECT kind, via, rev FROM events WHERE layout_id = ? AND rev IS NOT NULL AND format IS NULL ORDER BY seq DESC LIMIT 1")
      .bind(tombstone.id)
      .all<{ kind: string; via: string; rev: number }>();
    expect(results[0]).toMatchObject({ kind: "restored", via: "discord" }); // LDB-I14: a user write (via !== import:cmini) always forks
  });
});

describe("[LDB-P8] [LDB-N1] restore body: optional, {name} renames under check_name", () => {
  it("no body at all -> 200, restores under the tombstone's own name (the deployed site/bot send no body)", async () => {
    const tombstone = await seedTombstone();
    setNow(DELETED_AT);
    const headers = ownerHeaders(OWNER, `tok-${uniqueName("t")}`);
    const res = await writeFetch(`/v1/layouts/${tombstone.id}/restore`, "POST", headers);
    expect(res.status).toBe(200);
    const body = await res.json<{ name: string }>();
    expect(body.name).toBe(tombstone.name);
  });

  it("{} -> 200, same as no body", async () => {
    const tombstone = await seedTombstone();
    setNow(DELETED_AT);
    const headers = ownerHeaders(OWNER, `tok-${uniqueName("t")}`);
    const res = await restore(tombstone.id, headers, {});
    expect(res.status).toBe(200);
    const body = await res.json<{ name: string }>();
    expect(body.name).toBe(tombstone.name);
  });

  it("[LDB-N1] {name} naming a DIFFERENT free name -> 200, restores under it, detail.renamed_from", async () => {
    const tombstone = await seedTombstone();
    setNow(DELETED_AT);
    const headers = ownerHeaders(OWNER, `tok-${uniqueName("t")}`);
    const newName = uniqueName("restore-renamed");
    const res = await restore(tombstone.id, headers, { name: newName });
    expect(res.status).toBe(200);
    const body = await res.json<{ name: string }>();
    expect(body.name).toBe(newName);

    const { results } = await db
      .prepare("SELECT kind, name, detail_json FROM events WHERE layout_id = ? ORDER BY seq DESC LIMIT 1")
      .bind(tombstone.id)
      .all<{ kind: string; name: string; detail_json: string | null }>();
    expect(results[0]).toMatchObject({ kind: "restored", name: newName });
    expect(JSON.parse(results[0]!.detail_json!)).toEqual({ renamed_from: tombstone.name });
  });

  it("[LDB-N1] {name} naming the SAME name as the tombstone -> 200, no renamed_from (not a rename)", async () => {
    const tombstone = await seedTombstone();
    setNow(DELETED_AT);
    const headers = ownerHeaders(OWNER, `tok-${uniqueName("t")}`);
    const res = await restore(tombstone.id, headers, { name: tombstone.name });
    expect(res.status).toBe(200);

    const { results } = await db.prepare("SELECT detail_json FROM events WHERE layout_id = ? ORDER BY seq DESC LIMIT 1").bind(tombstone.id).all<{ detail_json: string | null }>();
    expect(results[0]?.detail_json).toBeNull();
  });

  it("[LDB-N1] {name} that fails check_name -> 400 invalid_name", async () => {
    const tombstone = await seedTombstone();
    setNow(DELETED_AT);
    const headers = ownerHeaders(OWNER, `tok-${uniqueName("t")}`);
    const res = await restore(tombstone.id, headers, { name: "_bad" });
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ error: "invalid_name" });
  });

  it("[LDB-N1] {name} naming a name a LIVE record already holds -> 409 name_taken with holder", async () => {
    const tombstone = await seedTombstone();
    const holder = await createLayout(uniqueName("restore-name-taken"), OTHER, "discord");
    setNow(DELETED_AT);
    const headers = ownerHeaders(OWNER, `tok-${uniqueName("t")}`);
    const res = await restore(tombstone.id, headers, { name: holder.name });
    expect(res.status).toBe(409);
    const body = await res.json<{ error: string; holder: { id: string; owner: string } }>();
    expect(body.error).toBe("name_taken");
    expect(body.holder).toEqual({ id: holder.id, owner: holder.owner });
  });

  it("[LDB-A7] a body with an unknown key -> 400 bad_request", async () => {
    const tombstone = await seedTombstone();
    setNow(DELETED_AT);
    const headers = ownerHeaders(OWNER, `tok-${uniqueName("t")}`);
    const res = await restore(tombstone.id, headers, { color: "blue" });
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ error: "bad_request", param: "/color" });
  });
});
