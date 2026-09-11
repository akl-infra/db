// [LDB-A7] transfer (21-formats.md §2.2/§2.4, layout scope): `to` unknown
// or equal to the current owner -> 400; a non-owner -> 403; a known `to` ->
// 200, `owner` moved, event `transferred` with `before.owner`/
// `after.owner`; the new owner can PUT the format, the old owner is
// refused; an admin can transfer a stranger's record.
import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Bindings } from "../../src/env";
import { commitWrite, type CommitInput } from "../../src/core/events";
import { fixedClock } from "../../src/core/time";
import { ulid } from "ulidx";
import { AKL_PAYLOAD, BOOTSTRAP_ADMIN, actorFixture, register, uniqueName, writeFetch } from "./write-support";

const db = (env as unknown as Bindings).DB;
const clock = fixedClock("2026-07-08T00:00:00.000Z");
const OWNER = "owner-transfer-1";
const OTHER = "owner-transfer-2";
const KNOWN_TARGET = "30000000000000001"; // 17 digits; given an `authors` row below
const UNKNOWN_TARGET = "30000000000000002"; // same shape, never signed in
const SOURCE = { client: "discord-app:test", version: null };

afterEach(() => {
  vi.unstubAllGlobals();
});

function ownerHeaders(id: string, token: string) {
  const fake = actorFixture();
  return register(fake, token, id);
}

interface Seeded {
  id: string;
  layoutRev: number;
  formatRev: number;
}

async function seed(owner = OWNER): Promise<Seeded> {
  const input: CommitInput = {
    layoutId: ulid(),
    creating: true,
    currentN: 0,
    currentLayout: null,
    currentFormats: new Map(),
    layout: { kind: "created", name: uniqueName("transfer-seed"), owner, created_at: clock(), deleted: false },
    format: { kind: "format_added", lineage: "spark", format: "spark/1", payload: AKL_PAYLOAD, hasMagic: false },
    modified_at: clock(),
    actor: owner,
    via: "discord",
    source: SOURCE,
    upstream: null,
  };
  const { layout, formats } = await commitWrite(db, clock, input);
  return { id: layout.id, layoutRev: layout.layout_rev, formatRev: formats.get("spark")!.rev };
}

async function seedAuthor(userId: string) {
  await db.prepare("INSERT OR IGNORE INTO authors (user_id, name, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?)").bind(userId, `user-${userId}`, clock(), clock()).run();
}

describe("[LDB-A7] POST /v1/layouts/{ref}/transfer", () => {
  it("to an unknown user -> 400 bad_request", async () => {
    const record = await seed();
    const headers = ownerHeaders(OWNER, `tok-${uniqueName("t")}`);
    const res = await writeFetch(`/v1/layouts/${record.id}/transfer`, "POST", { ...headers, "If-Match": "*" }, { to: UNKNOWN_TARGET });
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ error: "bad_request", param: "/to" });
  });

  it("to a non-snowflake-shaped string -> 400 bad_request", async () => {
    const record = await seed();
    const headers = ownerHeaders(OWNER, `tok-${uniqueName("t")}`);
    const res = await writeFetch(`/v1/layouts/${record.id}/transfer`, "POST", { ...headers, "If-Match": "*" }, { to: "not-a-user-id" });
    expect(res.status).toBe(400);
  });

  it("to the current owner -> 400 bad_request", async () => {
    const record = await seed();
    const headers = ownerHeaders(OWNER, `tok-${uniqueName("t")}`);
    const res = await writeFetch(`/v1/layouts/${record.id}/transfer`, "POST", { ...headers, "If-Match": "*" }, { to: OWNER });
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ error: "bad_request", param: "/to" });
  });

  it("a non-owner -> 403", async () => {
    await seedAuthor(KNOWN_TARGET);
    const record = await seed();
    const headers = ownerHeaders(OTHER, `tok-${uniqueName("t")}`);
    const res = await writeFetch(`/v1/layouts/${record.id}/transfer`, "POST", { ...headers, "If-Match": "*" }, { to: KNOWN_TARGET });
    expect(res.status).toBe(403);
  });

  it("no If-Match -> 400 if_match_required, owner unchanged", async () => {
    await seedAuthor(KNOWN_TARGET);
    const record = await seed();
    const headers = ownerHeaders(OWNER, `tok-${uniqueName("t")}`);
    const res = await writeFetch(`/v1/layouts/${record.id}/transfer`, "POST", headers, { to: KNOWN_TARGET });
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ error: "if_match_required" });
  });

  it("[LDB-A7] a known target -> 200, owner moved, event transferred with before/after owner", async () => {
    await seedAuthor(KNOWN_TARGET);
    const record = await seed();
    const headers = ownerHeaders(OWNER, `tok-${uniqueName("t")}`);
    const res = await writeFetch(`/v1/layouts/${record.id}/transfer`, "POST", { ...headers, "If-Match": `"layout:${record.layoutRev}"` }, { to: KNOWN_TARGET });
    expect(res.status).toBe(200);
    const body = await res.json<{ owner: string }>();
    expect(body.owner).toBe(KNOWN_TARGET);

    const { results } = await db.prepare("SELECT kind, before_json, after_json FROM events WHERE layout_id = ? ORDER BY seq DESC LIMIT 1").bind(record.id).all<{ kind: string; before_json: string; after_json: string }>();
    expect(results[0]?.kind).toBe("transferred");
    expect((JSON.parse(results[0]!.before_json) as { owner: string }).owner).toBe(OWNER);
    expect((JSON.parse(results[0]!.after_json) as { owner: string }).owner).toBe(KNOWN_TARGET);

    // the new owner can PUT the format; the old owner is refused
    const newOwnerHeaders = ownerHeaders(KNOWN_TARGET, `tok-${uniqueName("t")}`);
    const putAsNewOwner = await writeFetch(`/v1/layouts/${record.id}`, "PUT", { ...newOwnerHeaders, "If-Match": `"spark:${record.formatRev}"` }, { format: "spark/1", payload: AKL_PAYLOAD });
    expect(putAsNewOwner.status).toBe(200);

    const oldOwnerHeaders = ownerHeaders(OWNER, `tok-${uniqueName("t")}`);
    const putAsOldOwner = await writeFetch(`/v1/layouts/${record.id}`, "PUT", { ...oldOwnerHeaders, "If-Match": "*" }, { format: "spark/1", payload: AKL_PAYLOAD });
    expect(putAsOldOwner.status).toBe(403);
  });

  it("an admin transfers a stranger's record -> 200, event admin: true", async () => {
    await seedAuthor(KNOWN_TARGET);
    const record = await seed();
    const headers = ownerHeaders(BOOTSTRAP_ADMIN, `tok-${uniqueName("t")}`);
    const res = await writeFetch(`/v1/layouts/${record.id}/transfer`, "POST", { ...headers, "If-Match": `"layout:${record.layoutRev}"` }, { to: KNOWN_TARGET });
    expect(res.status).toBe(200);

    const { results } = await db.prepare("SELECT admin FROM events WHERE layout_id = ? ORDER BY seq DESC LIMIT 1").bind(record.id).all<{ admin: number }>();
    expect(results[0]?.admin).toBe(1);
  });
});
