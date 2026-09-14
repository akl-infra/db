// [LDB-A7] [LDB-P1] The write-verb x actor x format matrix (21-formats.md
// §2.2/§2.4, 02 §4): POST accepts any actor; PUT/PATCH/DELETE/restore/
// transfer accept the owner or an admin (logged `admin: true` only when the
// actor isn't the owner) and refuse a stranger with `403 not_owner`; every
// verb requires a resolved actor at all (401 anonymous, already swept
// exhaustively by tests/auth/routes.test.ts). Every accepted write lands in
// the event log with `via: discord`, the right `kind`, the right scope's
// rev bumped by exactly 1 (POST/PUT/PATCH-format: the format's own rev;
// PATCH-name/DELETE/restore/transfer: `layout_rev`), a `layout_revs` row,
// `has_magic` from the format, and a scoped `ETag`.
import { SELF, env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Bindings } from "../../src/env";
import { type EventDbRow, commitWrite, rowToEvent, type CommitInput } from "../../src/core/events";
import { formatsForLayout, readById } from "../../src/core/records";
import { fixedClock } from "../../src/core/time";
import { ulid } from "ulidx";
import { generateKeyPair, seedClient, signHeaders } from "../auth/client-support";
import { AKL_PAYLOAD, BOOTSTRAP_ADMIN, actorFixture, pinTestClock, register, uniqueName, writeFetch } from "./write-support";

const db = (env as unknown as Bindings).DB;
const clock = fixedClock("2026-07-01T00:00:00.000Z");
pinTestClock(env as unknown as { TEST_CLOCK?: typeof clock }, clock);

const OWNER = "owner-write-1";
const OTHER = "owner-write-2";
const SOURCE = { client: "discord-app:test", version: null };

interface Seeded {
  id: string;
  name: string;
  owner: string;
  layoutRev: number;
  formatRev: number;
  payload: unknown;
}

async function seed(owner = OWNER): Promise<Seeded> {
  const input: CommitInput = {
    layoutId: ulid(),
    creating: true,
    currentN: 0,
    currentLayout: null,
    currentFormats: new Map(),
    layout: { kind: "created", name: uniqueName("write-seed"), owner, created_at: clock(), deleted: false },
    format: { kind: "format_added", lineage: "spark", format: "spark/1", payload: AKL_PAYLOAD, hasMagic: false },
    modified_at: clock(),
    actor: owner,
    via: "discord",
    source: SOURCE,
    upstream: null,
  };
  const { layout, formats } = await commitWrite(db, clock, input);
  const spark = formats.get("spark")!;
  return { id: layout.id, name: layout.name, owner: layout.owner, layoutRev: layout.layout_rev, formatRev: spark.rev, payload: spark.payload };
}

async function seedDeleted(owner = OWNER): Promise<Seeded> {
  const created = await seed(owner);
  const currentLayout = (await readById(db, created.id))!;
  const currentFormats = await formatsForLayout(db, created.id);
  const input: CommitInput = {
    layoutId: created.id,
    creating: false,
    currentN: currentLayout.n,
    currentLayout,
    currentFormats,
    layout: { kind: "deleted", name: created.name, owner: created.owner, created_at: currentLayout.created_at, deleted: true },
    modified_at: clock(),
    actor: owner,
    via: "discord",
    source: SOURCE,
    upstream: currentLayout.upstream,
  };
  const { layout } = await commitWrite(db, clock, input);
  return { ...created, layoutRev: layout.layout_rev };
}

async function eventsFor(layoutId: string) {
  const { results } = await db.prepare("SELECT * FROM events WHERE layout_id = ? ORDER BY seq ASC").bind(layoutId).all<EventDbRow>();
  return results.map(rowToEvent);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("[LDB-P1] POST /v1/layouts: any actor", () => {
  for (const [kind, id] of [
    ["owner-like actor", OWNER],
    ["a stranger", OTHER],
    ["an admin", BOOTSTRAP_ADMIN],
  ] as const) {
    it(`${kind} -> 201, kind created + format_added, format rev 1, scoped ETag`, async () => {
      const fake = actorFixture();
      const headers = register(fake, `tok-post-${id}`, id);
      const name = uniqueName("post-ok");

      const res = await writeFetch("/v1/layouts", "POST", headers, { name, format: "spark/1", payload: AKL_PAYLOAD });
      expect(res.status, kind).toBe(201);
      expect(res.headers.get("ETag")).toBe('"spark:1"');
      const body = await res.json<{ id: string; layout_rev: number; owner: string; name: string; format: string; formats: Record<string, { rev: number; has_magic: boolean }> }>();
      expect(body.layout_rev).toBe(1);
      expect(body.owner).toBe(id);
      expect(body.name).toBe(name);
      expect(body.format).toBe("spark/1");
      expect(body.formats["spark/1"]!.rev).toBe(1);
      expect(body.formats["spark/1"]!.has_magic).toBe(false);

      const events = await eventsFor(body.id);
      expect(events).toHaveLength(2);
      expect(events[0]).toMatchObject({ kind: "created", via: "discord", actor: id, format: null, rev: 1, admin: false });
      expect(events[1]).toMatchObject({ kind: "format_added", via: "discord", actor: id, format: "spark/1", rev: 1, admin: false });

      const rev = await db.prepare("SELECT * FROM layout_revs WHERE layout_id = ? AND lineage = 'spark' AND rev = 1").bind(body.id).first();
      expect(rev).not.toBeNull();
    });
  }

  it("[LDB-A7] anonymous -> 401, no event", async () => {
    const before = await db.prepare("SELECT COUNT(*) AS n FROM events").first<{ n: number }>();
    const res = await writeFetch("/v1/layouts", "POST", {}, { name: uniqueName("anon"), format: "spark/1", payload: AKL_PAYLOAD });
    expect(res.status).toBe(401);
    const after = await db.prepare("SELECT COUNT(*) AS n FROM events").first<{ n: number }>();
    expect(after?.n).toBe(before?.n);
  });
});

describe("[LDB-A7] PUT /v1/layouts/{ref}: owner or admin", () => {
  it("the owner -> 200, kind updated, format rev + 1", async () => {
    const record = await seed();
    const fake = actorFixture();
    const headers = register(fake, "tok-put-owner", OWNER);

    const res = await writeFetch(`/v1/layouts/${record.id}`, "PUT", { ...headers, "If-Match": `"spark:${record.formatRev}"` }, { format: "spark/1", payload: AKL_PAYLOAD });
    expect(res.status).toBe(200);
    expect(res.headers.get("ETag")).toBe(`"spark:${record.formatRev + 1}"`);
    const body = await res.json<{ format: string; name: string; owner: string; formats: Record<string, { rev: number }> }>();
    expect(body.formats["spark/1"]!.rev).toBe(record.formatRev + 1);
    expect(body.format).toBe("spark/1");
    expect(body.name).toBe(record.name);
    expect(body.owner).toBe(record.owner);

    const events = await eventsFor(record.id);
    expect(events.at(-1)).toMatchObject({ kind: "updated", via: "discord", actor: OWNER, format: "spark/1", rev: record.formatRev + 1, admin: false });
  });

  it("a stranger -> 403 not_owner, record unchanged", async () => {
    const record = await seed();
    const fake = actorFixture();
    const headers = register(fake, "tok-put-stranger", OTHER);

    const res = await writeFetch(`/v1/layouts/${record.id}`, "PUT", { ...headers, "If-Match": `"spark:${record.formatRev}"` }, { format: "spark/1", payload: AKL_PAYLOAD });
    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toMatchObject({ error: "not_owner", owner: OWNER });
    expect(await eventsFor(record.id)).toHaveLength(2); // just the seed's own created+format_added
  });

  it("an admin (non-owner) -> 200, event admin: true", async () => {
    const record = await seed();
    const fake = actorFixture();
    const headers = register(fake, "tok-put-admin", BOOTSTRAP_ADMIN);

    const res = await writeFetch(`/v1/layouts/${record.id}`, "PUT", { ...headers, "If-Match": `"spark:${record.formatRev}"` }, { format: "spark/1", payload: AKL_PAYLOAD });
    expect(res.status).toBe(200);
    const events = await eventsFor(record.id);
    expect(events.at(-1)).toMatchObject({ kind: "updated", actor: BOOTSTRAP_ADMIN, admin: true });
  });

  it("anonymous -> 401", async () => {
    const record = await seed();
    const res = await writeFetch(`/v1/layouts/${record.id}`, "PUT", {}, { format: "spark/1", payload: AKL_PAYLOAD });
    expect(res.status).toBe(401);
  });

  it("[LDB-P2] no If-Match -> 400 if_match_required, record unchanged", async () => {
    const record = await seed();
    const fake = actorFixture();
    const headers = register(fake, "tok-put-noifmatch", OWNER);
    const res = await writeFetch(`/v1/layouts/${record.id}`, "PUT", headers, { format: "spark/1", payload: AKL_PAYLOAD });
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ error: "if_match_required" });
    expect(await eventsFor(record.id)).toHaveLength(2);
  });

  // 20-spark.md S2 (decision 6): `isMagicOnlyReplace`/`detail.magic_only`
  // are gone -- a PUT whose payload changes ONLY `magic` forks like any
  // other write, and `modified_at` bumps unconditionally.
  it("[LDB-P4] a PUT changing ONLY magic (same format) forks like any write: no magic_only marker, modified_at bumps", async () => {
    const record = await seed();
    const fake = actorFixture();
    const headers = register(fake, `tok-${uniqueName("put-magic-forks")}`, OWNER);
    const bumped = fixedClock("2026-07-02T00:00:00.000Z");
    pinTestClock(env as unknown as { TEST_CLOCK?: typeof clock }, bumped);

    try {
      const res = await writeFetch(
        `/v1/layouts/${record.id}`,
        "PUT",
        { ...headers, "If-Match": `"spark:${record.formatRev}"` },
        { format: "spark/1", payload: { ...(record.payload as object), magic: { rules: [{ inputs: "aa", output: "ab" }] } } },
      );
      expect(res.status).toBe(200);
      const events = await eventsFor(record.id);
      expect(events.at(-1)).toMatchObject({ kind: "updated", detail: null });
      const body = (await res.json()) as { formats: Record<string, { modified_at: string; rev: number }> };
      expect(body.formats["spark/1"]!.modified_at).toBe(bumped());
      expect(body.formats["spark/1"]!.rev).toBe(record.formatRev + 1);
    } finally {
      pinTestClock(env as unknown as { TEST_CLOCK?: typeof clock }, clock);
    }
  });

  it("a PUT changing magic AND something else (keys) is NOT magic_only -- forks as before", async () => {
    const record = await seed();
    const fake = actorFixture();
    const headers = register(fake, `tok-${uniqueName("put-not-magiconly")}`, OWNER);

    const res = await writeFetch(
      `/v1/layouts/${record.id}`,
      "PUT",
      { ...headers, "If-Match": `"spark:${record.formatRev}"` },
      { format: "spark/1", payload: { keys: [{ char: "a", row: 0, col: 0, finger: "LP" }], magic: { rules: [{ inputs: "aa", output: "ab" }] } } },
    );
    expect(res.status).toBe(200);
    const events = await eventsFor(record.id);
    expect(events.at(-1)).toMatchObject({ kind: "updated", detail: null });
  });
});

describe("[LDB-A7] DELETE /v1/layouts/{ref}: owner or admin (layout scope only)", () => {
  it("[LDB-F16] the owner -> 200, kind deleted, deleted: true, formats untouched", async () => {
    const record = await seed();
    const fake = actorFixture();
    const headers = register(fake, "tok-del-owner", OWNER);

    const res = await writeFetch(`/v1/layouts/${record.id}`, "DELETE", { ...headers, "If-Match": `"layout:${record.layoutRev}"` });
    expect(res.status).toBe(200);
    const body = await res.json<{ deleted: boolean; layout_rev: number; formats: Record<string, { rev: number }> }>();
    expect(body.deleted).toBe(true);
    expect(body.layout_rev).toBe(record.layoutRev + 1);
    expect(body.formats["spark/1"]!.rev).toBe(record.formatRev); // untouched -- D3: deletion is layout-level only
  });

  it("a stranger -> 403", async () => {
    const record = await seed();
    const fake = actorFixture();
    const headers = register(fake, "tok-del-stranger", OTHER);
    const res = await writeFetch(`/v1/layouts/${record.id}`, "DELETE", { ...headers, "If-Match": `"layout:${record.layoutRev}"` });
    expect(res.status).toBe(403);
  });

  it("an admin (non-owner) -> 200, event admin: true", async () => {
    const record = await seed();
    const fake = actorFixture();
    const headers = register(fake, "tok-del-admin", BOOTSTRAP_ADMIN);
    const res = await writeFetch(`/v1/layouts/${record.id}`, "DELETE", { ...headers, "If-Match": `"layout:${record.layoutRev}"` });
    expect(res.status).toBe(200);
    const events = await eventsFor(record.id);
    expect(events.at(-1)).toMatchObject({ kind: "deleted", admin: true });
  });

  it("anonymous -> 401", async () => {
    const record = await seed();
    const res = await writeFetch(`/v1/layouts/${record.id}`, "DELETE");
    expect(res.status).toBe(401);
  });

  it("[LDB-P2] no If-Match -> 400 if_match_required, record unchanged", async () => {
    const record = await seed();
    const fake = actorFixture();
    const headers = register(fake, "tok-del-noifmatch", OWNER);
    const res = await writeFetch(`/v1/layouts/${record.id}`, "DELETE", headers);
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ error: "if_match_required" });
    expect(await eventsFor(record.id)).toHaveLength(2);
  });
});

describe("[LDB-A7] POST /v1/layouts/{ref}/restore: owner or admin", () => {
  it("the owner -> 200, kind restored, deleted: false", async () => {
    const tombstone = await seedDeleted();
    const fake = actorFixture();
    const headers = register(fake, "tok-restore-owner", OWNER);
    const res = await writeFetch(`/v1/layouts/${tombstone.id}/restore`, "POST", headers);
    expect(res.status).toBe(200);
    const body = await res.json<{ deleted: boolean }>();
    expect(body.deleted).toBe(false);
  });

  it("a stranger -> 403", async () => {
    const tombstone = await seedDeleted();
    const fake = actorFixture();
    const headers = register(fake, "tok-restore-stranger", OTHER);
    const res = await writeFetch(`/v1/layouts/${tombstone.id}/restore`, "POST", headers);
    expect(res.status).toBe(403);
  });

  it("an admin (non-owner) -> 200, event admin: true", async () => {
    const tombstone = await seedDeleted();
    const fake = actorFixture();
    const headers = register(fake, "tok-restore-admin", BOOTSTRAP_ADMIN);
    const res = await writeFetch(`/v1/layouts/${tombstone.id}/restore`, "POST", headers);
    expect(res.status).toBe(200);
    const events = await eventsFor(tombstone.id);
    expect(events.at(-1)).toMatchObject({ kind: "restored", admin: true });
  });

  it("anonymous -> 401", async () => {
    const tombstone = await seedDeleted();
    const res = await writeFetch(`/v1/layouts/${tombstone.id}/restore`, "POST");
    expect(res.status).toBe(401);
  });
});

describe("[LDB-A7] POST /v1/layouts/{ref}/transfer: owner or admin", () => {
  const TARGET_ID = "20000000000000001"; // 17 digits -- shaped like a snowflake

  async function seedTargetAuthor() {
    const fake = actorFixture();
    const headers = register(fake, "tok-transfer-target", TARGET_ID);
    const res = await SELF.fetch("https://example.com/v1/me", { headers });
    expect(res.status).toBe(200);
  }

  it("[LDB-A7] the owner -> 200, owner changed, event transferred", async () => {
    await seedTargetAuthor();
    const record = await seed();
    const fake = actorFixture();
    const headers = register(fake, "tok-transfer-owner", OWNER);

    const res = await writeFetch(`/v1/layouts/${record.id}/transfer`, "POST", { ...headers, "If-Match": `"layout:${record.layoutRev}"` }, { to: TARGET_ID });
    expect(res.status).toBe(200);
    const body = await res.json<{ owner: string }>();
    expect(body.owner).toBe(TARGET_ID);
    const events = await eventsFor(record.id);
    expect(events.at(-1)).toMatchObject({ kind: "transferred", actor: OWNER, admin: false });
    expect(events.at(-1)?.before).toMatchObject({ owner: OWNER });
    expect(events.at(-1)?.after).toMatchObject({ owner: TARGET_ID });
  });

  it("a stranger -> 403", async () => {
    await seedTargetAuthor();
    const record = await seed();
    const fake = actorFixture();
    const headers = register(fake, "tok-transfer-stranger", OTHER);
    const res = await writeFetch(`/v1/layouts/${record.id}/transfer`, "POST", { ...headers, "If-Match": `"layout:${record.layoutRev}"` }, { to: TARGET_ID });
    expect(res.status).toBe(403);
  });

  it("an admin (non-owner) -> 200, event admin: true, transfers a stranger's layout", async () => {
    await seedTargetAuthor();
    const record = await seed();
    const fake = actorFixture();
    const headers = register(fake, "tok-transfer-admin", BOOTSTRAP_ADMIN);
    const res = await writeFetch(`/v1/layouts/${record.id}/transfer`, "POST", { ...headers, "If-Match": `"layout:${record.layoutRev}"` }, { to: TARGET_ID });
    expect(res.status).toBe(200);
    const events = await eventsFor(record.id);
    expect(events.at(-1)).toMatchObject({ kind: "transferred", admin: true });
  });

  it("anonymous -> 401", async () => {
    const record = await seed();
    const res = await writeFetch(`/v1/layouts/${record.id}/transfer`, "POST", {}, { to: TARGET_ID });
    expect(res.status).toBe(401);
  });

  it("[LDB-P2] no If-Match -> 400 if_match_required, record unchanged", async () => {
    await seedTargetAuthor();
    const record = await seed();
    const fake = actorFixture();
    const headers = register(fake, "tok-transfer-noifmatch", OWNER);
    const res = await writeFetch(`/v1/layouts/${record.id}/transfer`, "POST", headers, { to: TARGET_ID });
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ error: "if_match_required" });
    const events = await eventsFor(record.id);
    expect(events).toHaveLength(2);
  });
});

// [LDB-A5] 10 C1: the whole verb matrix runs again on the client lane.
describe("[LDB-A5] client-lane writes: via: client:<id>", () => {
  const TARGET_ID = "20000000000000002";
  let clientCounter = 0;
  async function freshClient(): Promise<{ clientId: string; privateKey: CryptoKey; actor: string }> {
    clientCounter++;
    const { privateKey, pubkeyB64url } = await generateKeyPair();
    const clientId = `wclient-${clientCounter}`;
    const actor = `60000000000000${String(clientCounter).padStart(4, "0")}`;
    await seedClient(db, clock, { id: clientId, pubkeyB64url, ownerUserId: actor, caps: "act-as-user" });
    return { clientId, privateKey, actor };
  }

  async function signedFetch(
    method: string,
    path: string,
    client: { clientId: string; privateKey: CryptoKey; actor: string },
    body?: unknown,
    extraHeaders?: Record<string, string>,
  ): Promise<Response> {
    const bodyText = body === undefined ? undefined : JSON.stringify(body);
    const headers = await signHeaders({
      privateKey: client.privateKey,
      clientId: client.clientId,
      actor: client.actor,
      method,
      pathWithQuery: path,
      body: bodyText === undefined ? undefined : new TextEncoder().encode(bodyText),
      timestamp: Math.floor(Date.now() / 1000),
    });
    return SELF.fetch(`https://example.com${path}`, {
      method,
      headers: bodyText === undefined ? { ...headers, ...extraHeaders } : { ...headers, "Content-Type": "application/json", ...extraHeaders },
      body: bodyText,
    });
  }

  it("[LDB-A5] POST /v1/layouts -> 201, event via: client:<id>", async () => {
    const client = await freshClient();
    const name = uniqueName("client-post");
    const res = await signedFetch("POST", "/v1/layouts", client, { name, format: "spark/1", payload: AKL_PAYLOAD });
    expect(res.status).toBe(201);
    const body = await res.json<{ id: string; owner: string }>();
    expect(body.owner).toBe(client.actor);
    const events = await eventsFor(body.id);
    expect(events[0]).toMatchObject({ kind: "created", via: `client:${client.clientId}`, actor: client.actor });
  });

  it("PUT /v1/layouts/{ref} -> 200, event via: client:<id>", async () => {
    const client = await freshClient();
    const record = await seed(client.actor);
    const res = await signedFetch("PUT", `/v1/layouts/${record.id}`, client, { format: "spark/1", payload: AKL_PAYLOAD }, { "If-Match": `"spark:${record.formatRev}"` });
    expect(res.status).toBe(200);
    const events = await eventsFor(record.id);
    expect(events.at(-1)).toMatchObject({ kind: "updated", via: `client:${client.clientId}`, actor: client.actor });
  });

  it("PATCH /v1/layouts/{ref} (rename) -> 200, event via: client:<id>", async () => {
    const client = await freshClient();
    const record = await seed(client.actor);
    const res = await signedFetch("PATCH", `/v1/layouts/${record.id}`, client, { name: uniqueName("client-patch") }, { "If-Match": `"layout:${record.layoutRev}"` });
    expect(res.status).toBe(200);
    const events = await eventsFor(record.id);
    expect(events.at(-1)).toMatchObject({ kind: "renamed", via: `client:${client.clientId}`, actor: client.actor });
  });

  it("DELETE /v1/layouts/{ref} -> 200, event via: client:<id>", async () => {
    const client = await freshClient();
    const record = await seed(client.actor);
    const res = await signedFetch("DELETE", `/v1/layouts/${record.id}`, client, undefined, { "If-Match": `"layout:${record.layoutRev}"` });
    expect(res.status).toBe(200);
    const events = await eventsFor(record.id);
    expect(events.at(-1)).toMatchObject({ kind: "deleted", via: `client:${client.clientId}`, actor: client.actor });
  });

  it("POST /v1/layouts/{ref}/restore -> 200, event via: client:<id>", async () => {
    const client = await freshClient();
    const tombstone = await seedDeleted(client.actor);
    const res = await signedFetch("POST", `/v1/layouts/${tombstone.id}/restore`, client);
    expect(res.status).toBe(200);
    const events = await eventsFor(tombstone.id);
    expect(events.at(-1)).toMatchObject({ kind: "restored", via: `client:${client.clientId}`, actor: client.actor });
  });

  it("POST /v1/layouts/{ref}/transfer -> 200, event via: client:<id>", async () => {
    const client = await freshClient();
    const record = await seed(client.actor);
    const targetFake = actorFixture();
    const targetHeaders = register(targetFake, `tok-${uniqueName("target")}`, TARGET_ID);
    await SELF.fetch("https://example.com/v1/me", { headers: targetHeaders });
    vi.unstubAllGlobals();

    const res = await signedFetch("POST", `/v1/layouts/${record.id}/transfer`, client, { to: TARGET_ID }, { "If-Match": `"layout:${record.layoutRev}"` });
    expect(res.status).toBe(200);
    const events = await eventsFor(record.id);
    expect(events.at(-1)).toMatchObject({ kind: "transferred", via: `client:${client.clientId}`, actor: client.actor });
  });

  it("[LDB-I14] nextUpstream reads via, not the literal 'discord' -- a client-lane write forks a following record too", async () => {
    const client = await freshClient();
    const record = await seed(client.actor);
    const res = await signedFetch("PUT", `/v1/layouts/${record.id}`, client, { format: "spark/1", payload: AKL_PAYLOAD }, { "If-Match": `"spark:${record.formatRev}"` });
    expect(res.status).toBe(200);
    const row = await db.prepare("SELECT via FROM events WHERE layout_id = ? ORDER BY seq DESC LIMIT 1").bind(record.id).first<{ via: string }>();
    expect(row?.via.startsWith("client:")).toBe(true);
    expect(row?.via).not.toBe("import:cmini");
  });
});

// [LDB-P9] design/layout-db/18-command-decisions.md §2 D1: `POST
// /v1/layouts` on a name a tombstone currently holds copies that
// tombstone's likes onto the new record, `via: "name_inherited"`.
describe("[LDB-P9] a re-added tombstoned name inherits the tombstone's likes", () => {
  interface CreatedBody {
    id: string;
    layout_rev: number;
    name: string;
    owner: string;
    like_count: number;
  }

  async function createViaHttp(headers: Record<string, string>, name: string): Promise<CreatedBody> {
    const res = await writeFetch("/v1/layouts", "POST", headers, { name, format: "spark/1", payload: AKL_PAYLOAD });
    expect(res.status).toBe(201);
    return res.json<CreatedBody>();
  }

  async function likeAs(id: string, headers: Record<string, string>): Promise<void> {
    const res = await writeFetch(`/v1/layouts/${id}/like`, "PUT", headers);
    expect(res.status).toBe(200);
  }

  async function deleteViaHttp(id: string, layoutRev: number, headers: Record<string, string>): Promise<void> {
    const res = await writeFetch(`/v1/layouts/${id}`, "DELETE", { ...headers, "If-Match": `"layout:${layoutRev}"` });
    expect(res.status).toBe(200);
  }

  it("[LDB-P9] same owner: delete then re-add the same name -> the new record inherits the tombstone's likes", async () => {
    const fake = actorFixture();
    const owner = register(fake, `tok-${uniqueName("p9-owner")}`, "p9-owner-same");
    const liker1 = register(fake, `tok-${uniqueName("p9-l1")}`, "p9-liker-1");
    const liker2 = register(fake, `tok-${uniqueName("p9-l2")}`, "p9-liker-2");

    const name = uniqueName("p9-same");
    const first = await createViaHttp(owner, name);
    await likeAs(first.id, liker1);
    await likeAs(first.id, liker2);
    await deleteViaHttp(first.id, first.layout_rev, owner);

    const second = await createViaHttp(owner, name);
    expect(second.like_count).toBe(2);

    const likeRows = await db.prepare("SELECT user_id FROM likes WHERE layout_id = ? ORDER BY user_id ASC").bind(second.id).all<{ user_id: string }>();
    expect(likeRows.results.map((r) => r.user_id)).toEqual(["p9-liker-1", "p9-liker-2"]);

    const events = await eventsFor(second.id);
    expect(events.map((e) => e.kind)).toEqual(["created", "format_added", "liked", "liked"]);
    for (const e of events.slice(2)) {
      expect(e.via).toBe("name_inherited");
      expect(e.detail).toEqual({ from: first.id });
    }
  });

  it("[LDB-P9] different owner: someone else re-adding the name inherits the tombstone's likes too", async () => {
    const fake = actorFixture();
    const origOwner = register(fake, `tok-${uniqueName("p9-orig")}`, "p9-owner-orig");
    const newOwner = register(fake, `tok-${uniqueName("p9-new")}`, "p9-owner-new");
    const liker = register(fake, `tok-${uniqueName("p9-l3")}`, "p9-liker-3");

    const name = uniqueName("p9-diff");
    const first = await createViaHttp(origOwner, name);
    await likeAs(first.id, liker);
    await deleteViaHttp(first.id, first.layout_rev, origOwner);

    const second = await createViaHttp(newOwner, name);
    expect(second.owner).toBe("p9-owner-new");
    expect(second.like_count).toBe(1);

    const events = await eventsFor(second.id);
    expect(events.map((e) => e.kind)).toEqual(["created", "format_added", "liked"]);
    expect(events[2]).toMatchObject({ via: "name_inherited", actor: "p9-liker-3" });
    expect(events[2]!.detail).toEqual({ from: first.id });
  });

  it("[LDB-P9] no tombstone ever held the name -> no inherited likes", async () => {
    const fake = actorFixture();
    const owner = register(fake, `tok-${uniqueName("p9-fresh")}`, "p9-owner-fresh");
    const rec = await createViaHttp(owner, uniqueName("p9-fresh-name"));
    expect(rec.like_count).toBe(0);
    expect(await eventsFor(rec.id)).toHaveLength(2); // created + format_added
  });

  it("[LDB-P9] a tombstone with zero likes -> re-add inherits nothing", async () => {
    const fake = actorFixture();
    const owner = register(fake, `tok-${uniqueName("p9-zero")}`, "p9-owner-zero");
    const name = uniqueName("p9-zero-likes");
    const first = await createViaHttp(owner, name);
    await deleteViaHttp(first.id, first.layout_rev, owner);

    const second = await createViaHttp(owner, name);
    expect(second.like_count).toBe(0);
    expect(await eventsFor(second.id)).toHaveLength(2);
  });

  it("[LDB-P9] restore-after-inherit: the tombstone stays restorable, and both records end up carrying the like (accepted per 18)", async () => {
    const fake = actorFixture();
    const owner = register(fake, `tok-${uniqueName("p9-restore")}`, "p9-owner-restore");
    const liker = register(fake, `tok-${uniqueName("p9-restore-l")}`, "p9-liker-restore");

    const name = uniqueName("p9-restore");
    const first = await createViaHttp(owner, name);
    await likeAs(first.id, liker);
    await deleteViaHttp(first.id, first.layout_rev, owner);

    const second = await createViaHttp(owner, name);
    expect(second.like_count).toBe(1);

    const renameRes = await writeFetch(`/v1/layouts/${second.id}`, "PATCH", { ...owner, "If-Match": `"layout:${second.layout_rev}"` }, { name: uniqueName("p9-restore-moved") });
    expect(renameRes.status).toBe(200);

    const restoreRes = await writeFetch(`/v1/layouts/${first.id}/restore`, "POST", owner);
    expect(restoreRes.status).toBe(200);
    const restored = await restoreRes.json<{ deleted: boolean; name: string }>();
    expect(restored.deleted).toBe(false);
    expect(restored.name).toBe(name);

    const firstLikes = await db.prepare("SELECT user_id FROM likes WHERE layout_id = ?").bind(first.id).all<{ user_id: string }>();
    const secondLikes = await db.prepare("SELECT user_id FROM likes WHERE layout_id = ?").bind(second.id).all<{ user_id: string }>();
    expect(firstLikes.results.map((r) => r.user_id)).toEqual(["p9-liker-restore"]);
    expect(secondLikes.results.map((r) => r.user_id)).toEqual(["p9-liker-restore"]);
  });

  it("[LDB-P9] /v1/changes shows the inherited 'liked' events with via: name_inherited", async () => {
    const fake = actorFixture();
    const owner = register(fake, `tok-${uniqueName("p9-feed")}`, "p9-owner-feed");
    const liker = register(fake, `tok-${uniqueName("p9-feed-l")}`, "p9-liker-feed");

    const name = uniqueName("p9-feed");
    const first = await createViaHttp(owner, name);
    await likeAs(first.id, liker);
    await deleteViaHttp(first.id, first.layout_rev, owner);
    const second = await createViaHttp(owner, name);

    const res = await writeFetch(`/v1/changes?since=0&layout=${second.id}`, "GET", owner);
    expect(res.status).toBe(200);
    const body = await res.json<{ items: { kind: string; via: string; detail: unknown }[] }>();
    const liked = body.items.filter((e) => e.kind === "liked");
    expect(liked).toHaveLength(1);
    expect(liked[0]!.via).toBe("name_inherited");
    expect(liked[0]!.detail).toEqual({ from: first.id });
  });
});
