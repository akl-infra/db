// [LDB-P15] 20-spark.md S3s (decision 14): every write's `source.client`
// is PROVEN, never declared -- a lane x verb x `X-Client-Version` header
// matrix, plus a spoof matrix proving no header, query param or body
// field can set `source.client` on either lane. `source.version` is the
// validated header (or `null`); an invalid header is `400
// invalid_client_version` and writes nothing.
import { env } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Bindings } from "../../src/env";
import { commitWrite, type CommitInput } from "../../src/core/events";
import { fixedClock } from "../../src/core/time";
import { ulid } from "ulidx";
import { generateKeyPair, seedClient, signHeaders } from "../auth/client-support";
import { AKL_PAYLOAD, actorFixture, pinTestClock, register, uniqueName, writeFetch } from "./write-support";

const bindings = env as unknown as Bindings;
const db = bindings.DB;
const clock = fixedClock("2026-09-10T00:00:00.000Z");
pinTestClock(bindings as unknown as { TEST_CLOCK?: typeof clock }, clock);

const DISCORD_OWNER = "800000000000000501";
const CLIENT_OWNER = "800000000000000502";
const TRANSFER_TARGET = "800000000000000503";
const CLIENT_ID = "source-matrix-client-1";
const VALID_VERSION = "spark-bot/1.2.3";
// >64 chars and (separately) a disallowed character -- either alone is
// enough to refuse, tested together here since both hit the same 400.
const INVALID_VERSION_TOO_LONG = "v".repeat(65);
const INVALID_VERSION_BAD_CHAR = "has a space";

afterEach(() => {
  vi.unstubAllGlobals();
});

async function seedAuthor(userId: string): Promise<void> {
  await db
    .prepare("INSERT OR IGNORE INTO authors (user_id, name, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?)")
    .bind(userId, `user-${userId}`, clock(), clock())
    .run();
}

beforeAll(async () => {
  await seedAuthor(TRANSFER_TARGET);
});

function headersForDiscordUser(userId: string): Record<string, string> {
  return register(actorFixture(), `tok-${uniqueName("srcm")}`, userId);
}

function discordHeaders(): Record<string, string> {
  return headersForDiscordUser(DISCORD_OWNER);
}

let clientKeyPromise: Promise<{ privateKey: CryptoKey; pubkeyB64url: string }> | null = null;
function clientKey(): Promise<{ privateKey: CryptoKey; pubkeyB64url: string }> {
  clientKeyPromise ??= generateKeyPair();
  return clientKeyPromise;
}

let clientRegistered = false;
async function ensureClientRegistered(): Promise<void> {
  const { pubkeyB64url } = await clientKey();
  if (!clientRegistered) {
    await seedClient(db, clock, { id: CLIENT_ID, pubkeyB64url, ownerUserId: CLIENT_OWNER, caps: "act-as-owner-only" });
    clientRegistered = true;
  }
}

// Signs the exact request `writeFetch` is about to send -- body bytes and
// path/query must match byte-for-byte with what's actually sent (10 C1
// §4's signature covers both).
async function clientHeaders(method: string, pathWithQuery: string, body?: unknown, versionHeader?: string): Promise<Record<string, string>> {
  await ensureClientRegistered();
  const { privateKey } = await clientKey();
  const bodyBytes = body === undefined ? undefined : new TextEncoder().encode(JSON.stringify(body));
  const signed = await signHeaders({ privateKey, clientId: CLIENT_ID, actor: CLIENT_OWNER, method, pathWithQuery, body: bodyBytes });
  return versionHeader === undefined ? signed : { ...signed, "X-Client-Version": versionHeader };
}

// `n` (the internal write counter, shared across BOTH scopes) is what this
// file checks moved-or-not on: a write refused for an invalid client
// version 400s before `commitWrite` ever runs, whatever scope it would
// have targeted, so `n` unchanged is the one check that works for every
// verb uniformly.
async function nOf(layoutId: string): Promise<number | null> {
  const row = await db.prepare("SELECT n FROM layouts WHERE id = ?").bind(layoutId).first<{ n: number }>();
  return row?.n ?? null;
}

async function seedRecord(owner: string): Promise<{ id: string; n: number; name: string }> {
  const input: CommitInput = {
    layoutId: ulid(),
    creating: true,
    currentN: 0,
    currentLayout: null,
    currentFormats: new Map(),
    layout: { kind: "created", name: uniqueName("srcm-seed"), owner, created_at: clock(), deleted: false },
    format: { kind: "format_added", lineage: "spark", format: "spark/1", payload: AKL_PAYLOAD, hasMagic: false },
    modified_at: clock(),
    actor: owner,
    via: "discord",
    source: { client: "discord-app:test", version: null },
    upstream: null,
  };
  const { layout } = await commitWrite(db, clock, input);
  return { id: layout.id, n: layout.n, name: layout.name };
}

interface EventSourceRow {
  source_client: string | null;
  source_version: string | null;
}

async function latestEventSource(layoutId: string): Promise<{ client: string; version: string | null } | null> {
  const row = await db
    .prepare("SELECT source_client, source_version FROM events WHERE layout_id = ? ORDER BY seq DESC LIMIT 1")
    .bind(layoutId)
    .first<EventSourceRow>();
  if (row === null || row.source_client === null) return null;
  return { client: row.source_client, version: row.source_version };
}

type Lane = "discord" | "client";
type Verb = "create" | "replace" | "patch" | "delete" | "restore" | "transfer";

// One entry per (lane, verb): builds and fires the request, returning the
// resulting layoutId (so the caller can read back the event it wrote) and
// the raw Response. `owner` differs by lane -- the client lane is
// registered `act-as-owner-only` for CLIENT_OWNER, so every client-lane
// write must act as that user.
async function fire(lane: Lane, verb: Verb, versionHeader: string | undefined): Promise<{ res: Response; layoutId: string; nBefore: number | null }> {
  const owner = lane === "discord" ? DISCORD_OWNER : CLIENT_OWNER;
  // Lazy: each `actorFixture()` call replaces the global `fetch` stub with
  // a FRESH FakeDiscord, orphaning any earlier one's registered token --
  // "restore" needs a SEPARATE discord actor for its own tombstone step
  // first, so the headers used for the request actually under test must
  // be minted AFTER that (never cached from before it).
  const baseHeaders = () => discordHeaders();
  const withVersion = (h: Record<string, string>) => (versionHeader === undefined ? h : { ...h, "X-Client-Version": versionHeader });

  switch (verb) {
    case "create": {
      const body = { name: uniqueName(`srcm-${lane}-create`), format: "spark/1", payload: AKL_PAYLOAD };
      const headers =
        lane === "discord" ? withVersion(baseHeaders()) : await clientHeaders("POST", "/v1/layouts", body, versionHeader);
      const res = await writeFetch("/v1/layouts", "POST", headers, body);
      const layoutId = res.status === 201 ? (await res.clone().json<{ id: string }>()).id : "";
      return { res, layoutId, nBefore: null }; // no prior rev -- "nothing written" is checked via the global event count instead
    }
    case "replace": {
      const seed = await seedRecord(owner);
      const body = { format: "spark/1", payload: { keys: [{ char: "a", row: 0, col: 0, finger: "LP" }], board: "ansi" } };
      const path = `/v1/layouts/${seed.id}`;
      const headers =
        lane === "discord"
          ? { ...withVersion(baseHeaders()), "If-Match": "*" }
          : { ...(await clientHeaders("PUT", path, body, versionHeader)), "If-Match": "*" };
      const res = await writeFetch(path, "PUT", headers, body);
      return { res, layoutId: seed.id, nBefore: seed.n };
    }
    case "patch": {
      const seed = await seedRecord(owner);
      const body = { name: uniqueName(`srcm-${lane}-patch`) };
      const path = `/v1/layouts/${seed.id}`;
      const headers =
        lane === "discord"
          ? { ...withVersion(baseHeaders()), "If-Match": "*" }
          : { ...(await clientHeaders("PATCH", path, body, versionHeader)), "If-Match": "*" };
      const res = await writeFetch(path, "PATCH", headers, body);
      return { res, layoutId: seed.id, nBefore: seed.n };
    }
    case "delete": {
      const seed = await seedRecord(owner);
      const path = `/v1/layouts/${seed.id}`;
      const headers =
        lane === "discord"
          ? { ...withVersion(baseHeaders()), "If-Match": "*" }
          : { ...(await clientHeaders("DELETE", path, undefined, versionHeader)), "If-Match": "*" };
      const res = await writeFetch(path, "DELETE", headers);
      return { res, layoutId: seed.id, nBefore: seed.n };
    }
    case "restore": {
      const seed = await seedRecord(owner);
      // Tombstone it first, AS ITS OWNER (whichever lane this attempt is
      // for -- the discord lane can authenticate as any FakeDiscord id,
      // so this reaches the same ownership check either way without
      // needing a signed delete too).
      await writeFetch(`/v1/layouts/${seed.id}`, "DELETE", { ...headersForDiscordUser(owner), "If-Match": "*" });
      const nBefore = await nOf(seed.id);
      const path = `/v1/layouts/${seed.id}/restore`;
      const headers = lane === "discord" ? withVersion(baseHeaders()) : await clientHeaders("POST", path, {}, versionHeader);
      const res = await writeFetch(path, "POST", headers, lane === "discord" ? undefined : {});
      return { res, layoutId: seed.id, nBefore };
    }
    case "transfer": {
      const seed = await seedRecord(owner);
      const body = { to: TRANSFER_TARGET };
      const path = `/v1/layouts/${seed.id}/transfer`;
      const headers =
        lane === "discord"
          ? { ...withVersion(baseHeaders()), "If-Match": "*" }
          : { ...(await clientHeaders("POST", path, body, versionHeader)), "If-Match": "*" };
      const res = await writeFetch(path, "POST", headers, body);
      return { res, layoutId: seed.id, nBefore: seed.n };
    }
  }
}

const LANES: Lane[] = ["discord", "client"];
const VERBS: Verb[] = ["create", "replace", "patch", "delete", "restore", "transfer"];

function expectedClient(lane: Lane): string {
  return lane === "discord" ? "discord-app:app-default" : `client:${CLIENT_ID}`;
}

describe("[LDB-P15] source.client x source.version: lane x verb x version-header matrix", () => {
  for (const lane of LANES) {
    for (const verb of VERBS) {
      it(`[LDB-P15] ${lane} lane, ${verb}: absent header -> version null, client proven`, async () => {
        const { res, layoutId } = await fire(lane, verb, undefined);
        expect(res.status, await res.clone().text()).toBeLessThan(300);
        expect(await latestEventSource(layoutId)).toEqual({ client: expectedClient(lane), version: null });
      });

      it(`[LDB-P15] ${lane} lane, ${verb}: valid header -> stored verbatim`, async () => {
        const { res, layoutId } = await fire(lane, verb, VALID_VERSION);
        expect(res.status, await res.clone().text()).toBeLessThan(300);
        expect(await latestEventSource(layoutId)).toEqual({ client: expectedClient(lane), version: VALID_VERSION });
      });

      it.each([
        ["too long (65 chars)", INVALID_VERSION_TOO_LONG],
        ["disallowed character (space)", INVALID_VERSION_BAD_CHAR],
      ])(`[LDB-P15] ${lane} lane, ${verb}: invalid header (%s) -> 400 invalid_client_version, writes nothing`, async (_label, bad) => {
        const globalBefore = await db.prepare("SELECT COUNT(*) AS n FROM events").first<{ n: number }>();
        const { res, layoutId, nBefore } = await fire(lane, verb, bad);
        expect(res.status).toBe(400);
        await expect(res.clone().json()).resolves.toMatchObject({ error: "invalid_client_version" });
        if (verb === "create") {
          // No prior record to check a rev on -- the global event count
          // (this attempt's only possible side effect) must be unchanged.
          const globalAfter = await db.prepare("SELECT COUNT(*) AS n FROM events").first<{ n: number }>();
          expect(globalAfter?.n).toBe(globalBefore?.n);
        } else {
          // Every other verb seeded a real record (+ restore's own
          // tombstone) before this attempt -- those writes already
          // happened, so the precise check is that THIS record's rev
          // didn't move past what seeding itself left it at.
          expect(await nOf(layoutId)).toBe(nBefore);
        }
      });
    }
  }
});

describe("[LDB-P15] spoof matrix: nothing but the resolved identity can set source.client", () => {
  it("[LDB-P15] a body field named 'source' is refused outright (LDB-A7: unknown field), never silently accepted", async () => {
    const headers = discordHeaders();
    const res = await writeFetch("/v1/layouts", "POST", headers, {
      name: uniqueName("srcm-spoof-body"),
      format: "spark/1",
      payload: AKL_PAYLOAD,
      source: { client: "evil:spoofed", version: "9.9.9" },
    });
    expect(res.status).toBe(400);
    await expect(res.clone().json()).resolves.toMatchObject({ error: "bad_request" });
  });

  it("[LDB-P15] a spoofed X-Akl-Client-alike / unrecognized header never reaches source.client", async () => {
    const headers = { ...discordHeaders(), "X-Source-Client": "evil:spoofed", "X-Actor": "evil-actor" };
    const body = { name: uniqueName("srcm-spoof-header"), format: "spark/1", payload: AKL_PAYLOAD };
    const res = await writeFetch("/v1/layouts", "POST", headers, body);
    expect(res.status).toBe(201);
    const created = await res.json<{ id: string }>();
    expect(await latestEventSource(created.id)).toEqual({ client: "discord-app:app-default", version: null });
  });

  it("[LDB-P15] a query-string spoof (?source_client=, ?client=) never reaches source.client", async () => {
    const headers = discordHeaders();
    const body = { name: uniqueName("srcm-spoof-query"), format: "spark/1", payload: AKL_PAYLOAD };
    const res = await writeFetch("/v1/layouts?source_client=evil&client=evil2", "POST", headers, body);
    expect(res.status).toBe(201);
    const created = await res.json<{ id: string }>();
    expect(await latestEventSource(created.id)).toEqual({ client: "discord-app:app-default", version: null });
  });

  it("[LDB-P15] the client lane's source.client is the SIGNED client id, never the (spoofable) X-Akl-Actor value alone", async () => {
    // The actor a client lane write is FOR (X-Akl-Actor, LDB-A4) and the
    // client that made the write (source.client) are two different
    // identities on purpose -- proving the latter never collapses into
    // (or is overridable by) the former.
    const path = "/v1/layouts";
    const body = { name: uniqueName("srcm-client-actor"), format: "spark/1", payload: AKL_PAYLOAD };
    const headers = await clientHeaders("POST", path, body);
    const res = await writeFetch(path, "POST", headers, body);
    expect(res.status).toBe(201);
    const created = await res.json<{ id: string }>();
    const source = await latestEventSource(created.id);
    expect(source?.client).toBe(`client:${CLIENT_ID}`);
    expect(source?.client).not.toBe(CLIENT_OWNER); // never the bare actor id
  });
});
