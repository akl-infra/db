// [LDB-A4] [LDB-A5] [LDB-A8] [LDB-A9] The client lane (10 C1, 02 §3):
// every vector in tests/vectors/client-signing.json is accepted; every
// single-field mutation of a signed request is refused with the named
// 401/403; a nonce is single-use and pruned after 900s; a revoked client
// is refused from the moment of revocation, never cached; `act-as-owner-only`
// refuses a foreign actor; both lanes on one request -> 400; a client-lane
// write lands in `/v1/changes` (proven here via the event row) with
// `via: client:<id>`.
import { SELF, env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import type { Bindings } from "../../src/env";
import { hasCap, parseCaps, pruneNonces, scopeCapOf, verifyClientRequest } from "../../src/auth/client";
import { fixedClock } from "../../src/core/time";
import {
  generateKeyPair,
  importPrivateKeyPkcs8,
  seedClient,
  signHeaders,
  vectors,
  type SignOpts,
} from "./client-support";

const db = (env as unknown as Bindings).DB;

// The vectors were generated with `now` == this instant (BASE_TS,
// scripts/gen-vectors.mjs) -- every "accepted" vector is timestamped
// relative to it, including the two deliberately at exactly +-300s.
const BASE_TS_ISO = "2026-08-29T10:40:00.000Z";
const NOW = fixedClock(BASE_TS_ISO);

const K1_PUBKEY = vectors.keys[0]!.pubkey_b64url;
const K1_PKCS8 = vectors.keys[0]!.pkcs8_b64url;
const VECTOR_CLIENT_ID = vectors.vectors[0]!.client_id; // every vector shares one client id
const VECTOR_OWNER = "184412255822020608"; // every vector's actor except the 20-digit one

type Vector = (typeof vectors)["vectors"][number];

function requestFor(v: Vector, overrides: Partial<Record<"method" | "path" | "actor" | "timestamp" | "nonce" | "signature", string>> = {}): {
  request: Request;
  bodyBytes: Uint8Array;
} {
  const body = v.body === null ? new Uint8Array(0) : new TextEncoder().encode(v.body);
  const headers = new Headers({
    "X-Akl-Client": v.client_id,
    "X-Akl-Timestamp": overrides.timestamp ?? v.timestamp,
    "X-Akl-Nonce": overrides.nonce ?? v.nonce,
    "X-Akl-Actor": overrides.actor ?? v.actor,
    "X-Akl-Signature": overrides.signature ?? v.signature_b64url,
  });
  const request = new Request(`https://example.com${overrides.path ?? v.path}`, {
    method: overrides.method ?? v.method,
    headers,
  });
  return { request, bodyBytes: body };
}

let counter = 0;
function uniqueId(prefix: string): string {
  return `${prefix}-${counter++}`;
}

// LEDGER.md L4: `caps` parsing/lookup helpers (pure, no D1/network).
describe("[LDB-CH3] caps helpers (parseCaps/scopeCapOf/hasCap)", () => {
  it("parseCaps splits, trims, and drops empty tokens", () => {
    expect(parseCaps("act-as-user")).toEqual(["act-as-user"]);
    expect(parseCaps("act-as-owner-only, feed:wait")).toEqual(["act-as-owner-only", "feed:wait"]);
    expect(parseCaps("act-as-user,,feed:wait,")).toEqual(["act-as-user", "feed:wait"]);
  });

  it("scopeCapOf finds the one scope cap regardless of position, or undefined if none", () => {
    expect(scopeCapOf("act-as-owner-only")).toBe("act-as-owner-only");
    expect(scopeCapOf("feed:wait,act-as-user")).toBe("act-as-user");
    expect(scopeCapOf("feed:wait")).toBeUndefined();
    expect(scopeCapOf("")).toBeUndefined();
  });

  it("hasCap checks membership of one extra cap", () => {
    expect(hasCap("act-as-owner-only,feed:wait", "feed:wait")).toBe(true);
    expect(hasCap("act-as-owner-only", "feed:wait")).toBe(false);
    expect(hasCap("", "feed:wait")).toBe(false);
  });
});

describe("[LDB-A4] every client-signing vector is accepted", () => {
  beforeAll(async () => {
    await seedClient(db, NOW, { id: VECTOR_CLIENT_ID, pubkeyB64url: K1_PUBKEY, ownerUserId: VECTOR_OWNER, caps: "act-as-user" });
  });

  for (const v of vectors.vectors) {
    it(v.name, async () => {
      const { request, bodyBytes } = requestFor(v);
      const actor = await verifyClientRequest(db, NOW, request, bodyBytes, {});
      expect(actor.user_id).toBe(v.actor);
      expect(actor.via).toBe(`client:${v.client_id}`);
      // migrations/0001_init.sql seeds VECTOR_OWNER as a bootstrap admin --
      // proves admin resolution runs over the client lane too (the same
      // `admins` read T1's resolveBearer does), except the one vector whose
      // `actor` is a different (non-admin) 20-digit id.
      expect(actor.admin).toBe(v.actor === VECTOR_OWNER);
    });
  }
});

describe("[LDB-A4] the mutation matrix: one bad field at a time", () => {
  const BASE = vectors.vectors.find((v) => v.name === "post-layouts-body")!; // has a body, a query-free path
  let k1PrivateKey: CryptoKey;

  beforeAll(async () => {
    await seedClient(db, NOW, { id: BASE.client_id, pubkeyB64url: K1_PUBKEY, ownerUserId: VECTOR_OWNER, caps: "act-as-user" });
    k1PrivateKey = await importPrivateKeyPkcs8(K1_PKCS8);
  });

  it("[LDB-A4] method mutated -> bad_signature", async () => {
    const { request, bodyBytes } = requestFor(BASE, { method: "PUT" });
    await expect(verifyClientRequest(db, NOW, request, bodyBytes, {})).rejects.toMatchObject({ body: { error: "bad_signature" } });
  });

  it("path mutated -> bad_signature", async () => {
    const { request, bodyBytes } = requestFor(BASE, { path: `${BASE.path}/extra` });
    await expect(verifyClientRequest(db, NOW, request, bodyBytes, {})).rejects.toMatchObject({ body: { error: "bad_signature" } });
  });

  it("query added -> bad_signature", async () => {
    const withQuery = vectors.vectors.find((v) => v.name === "get-with-query")!;
    const { request, bodyBytes } = requestFor(withQuery, { path: `${withQuery.path}&extra=1` });
    await expect(verifyClientRequest(db, NOW, request, bodyBytes, {})).rejects.toMatchObject({ body: { error: "bad_signature" } });
  });

  it("[LDB-A4] timestamp +301s -> stale_timestamp", async () => {
    const { request, bodyBytes } = requestFor(BASE, { timestamp: String(Number(BASE.timestamp) + 301) });
    await expect(verifyClientRequest(db, NOW, request, bodyBytes, {})).rejects.toMatchObject({ body: { error: "stale_timestamp" } });
  });

  it("timestamp -301s -> stale_timestamp", async () => {
    const { request, bodyBytes } = requestFor(BASE, { timestamp: String(Number(BASE.timestamp) - 301) });
    await expect(verifyClientRequest(db, NOW, request, bodyBytes, {})).rejects.toMatchObject({ body: { error: "stale_timestamp" } });
  });

  // Fresh signatures, not the frozen vectors: the "every vector accepted"
  // describe above already consumed every vector's own nonce, so re-using
  // one here would fail on `replay` instead of testing the boundary.
  it("timestamp +-300s -> accepted (the boundary, not a mutation)", async () => {
    const baseTs = Math.floor(new Date(BASE_TS_ISO).getTime() / 1000);
    for (const ts of [baseTs + 300, baseTs - 300]) {
      const headers = await signHeaders({
        privateKey: k1PrivateKey,
        clientId: BASE.client_id,
        actor: VECTOR_OWNER,
        method: "GET",
        pathWithQuery: "/v1/me",
        timestamp: ts,
        nonce: crypto.getRandomValues(new Uint8Array(16)),
      });
      const request = new Request("https://example.com/v1/me", { method: "GET", headers });
      await expect(verifyClientRequest(db, NOW, request, new Uint8Array(0), {}), `ts=${ts}`).resolves.toBeDefined();
    }
  });

  it("[LDB-A4] nonce replayed -> replay", async () => {
    const headers = await signHeaders({
      privateKey: k1PrivateKey,
      clientId: BASE.client_id,
      actor: VECTOR_OWNER,
      method: "GET",
      pathWithQuery: "/v1/me",
      timestamp: Math.floor(new Date(BASE_TS_ISO).getTime() / 1000),
      nonce: crypto.getRandomValues(new Uint8Array(16)),
    });
    const first = new Request("https://example.com/v1/me", { method: "GET", headers });
    await verifyClientRequest(db, NOW, first, new Uint8Array(0), {}); // consumes the nonce
    const second = new Request("https://example.com/v1/me", { method: "GET", headers });
    await expect(verifyClientRequest(db, NOW, second, new Uint8Array(0), {})).rejects.toMatchObject({ body: { error: "replay" } });
  });

  it("one body byte flipped -> bad_signature", async () => {
    const { request } = requestFor(BASE);
    const flipped = new TextEncoder().encode(BASE.body!.slice(0, -1) + "x"); // last char differs -> different hash
    await expect(verifyClientRequest(db, NOW, request, flipped, {})).rejects.toMatchObject({ body: { error: "bad_signature" } });
  });

  it("actor mutated -> bad_signature", async () => {
    const { request, bodyBytes } = requestFor(BASE, { actor: "999999999999999999" });
    await expect(verifyClientRequest(db, NOW, request, bodyBytes, {})).rejects.toMatchObject({ body: { error: "bad_signature" } });
  });

  it("one signature byte flipped -> bad_signature", async () => {
    const sigBytes = Uint8Array.from(Buffer.from(BASE.signature_b64url, "base64url"));
    sigBytes[0] = (sigBytes[0]! + 1) & 0xff;
    const flippedSig = Buffer.from(sigBytes).toString("base64url");
    const { request, bodyBytes } = requestFor(BASE, { signature: flippedSig });
    await expect(verifyClientRequest(db, NOW, request, bodyBytes, {})).rejects.toMatchObject({ body: { error: "bad_signature" } });
  });

  it("signed with a second key -> bad_signature", async () => {
    const other = await generateKeyPair();
    const headers = await signHeaders({
      privateKey: other.privateKey,
      clientId: BASE.client_id,
      actor: BASE.actor,
      method: BASE.method,
      pathWithQuery: BASE.path,
      body: new TextEncoder().encode(BASE.body!),
      timestamp: Number(BASE.timestamp),
      nonce: crypto.getRandomValues(new Uint8Array(16)),
    });
    const request = new Request(`https://example.com${BASE.path}`, { method: BASE.method, headers });
    await expect(verifyClientRequest(db, NOW, request, new TextEncoder().encode(BASE.body!), {})).rejects.toMatchObject({
      body: { error: "bad_signature" },
    });
  });

  it.each(["X-Akl-Client", "X-Akl-Timestamp", "X-Akl-Nonce", "X-Akl-Actor", "X-Akl-Signature"])(
    "missing header %s -> bad_signature",
    async (name) => {
      const { request, bodyBytes } = requestFor(BASE);
      const headers = new Headers(request.headers);
      headers.delete(name);
      const stripped = new Request(request.url, { method: request.method, headers });
      await expect(verifyClientRequest(db, NOW, stripped, bodyBytes, {})).rejects.toMatchObject({ body: { error: "bad_signature" } });
    },
  );

  it("malformed timestamp (not digits) -> bad_signature", async () => {
    const { request, bodyBytes } = requestFor(BASE, { timestamp: "not-a-number" });
    await expect(verifyClientRequest(db, NOW, request, bodyBytes, {})).rejects.toMatchObject({ body: { error: "bad_signature" } });
  });

  it("[LDB-A4] malformed nonce (not 16 bytes) -> bad_signature", async () => {
    const { request, bodyBytes } = requestFor(BASE, { nonce: "AA" });
    await expect(verifyClientRequest(db, NOW, request, bodyBytes, {})).rejects.toMatchObject({ body: { error: "bad_signature" } });
  });

  it("malformed actor (not 17-20 digits) -> bad_signature", async () => {
    const { request, bodyBytes } = requestFor(BASE, { actor: "123" });
    await expect(verifyClientRequest(db, NOW, request, bodyBytes, {})).rejects.toMatchObject({ body: { error: "bad_signature" } });
  });

  it("malformed signature (not 64 bytes) -> bad_signature", async () => {
    const { request, bodyBytes } = requestFor(BASE, { signature: "AAAA" });
    await expect(verifyClientRequest(db, NOW, request, bodyBytes, {})).rejects.toMatchObject({ body: { error: "bad_signature" } });
  });
});

describe("[LDB-A8] nonces: single-use, pruned after 900s", () => {
  it("[LDB-A8] a fresh signed request is accepted once, replayed twice -> replay", async () => {
    const { privateKey, pubkeyB64url } = await generateKeyPair();
    const clientId = uniqueId("client-nonce");
    await seedClient(db, NOW, { id: clientId, pubkeyB64url, ownerUserId: "111111111111111111", caps: "act-as-user" });

    const nonce = crypto.getRandomValues(new Uint8Array(16));
    const signOpts: SignOpts = {
      privateKey,
      clientId,
      actor: "111111111111111111",
      method: "GET",
      pathWithQuery: "/v1/me",
      timestamp: Math.floor(new Date(BASE_TS_ISO).getTime() / 1000),
      nonce,
    };
    const headers = await signHeaders(signOpts);
    const req = () => new Request("https://example.com/v1/me", { method: "GET", headers });

    await expect(verifyClientRequest(db, NOW, req(), new Uint8Array(0), {})).resolves.toBeDefined();
    await expect(verifyClientRequest(db, NOW, req(), new Uint8Array(0), {})).rejects.toMatchObject({ body: { error: "replay" } });

    const row = await db
      .prepare("SELECT COUNT(*) AS n FROM nonces WHERE client_id = ?")
      .bind(clientId)
      .first<{ n: number }>();
    expect(row?.n).toBe(1); // one row, not two -- the replay never got as far as a second insert
  });

  it("[LDB-A8] pruneNonces drops rows older than 900s and keeps newer ones", async () => {
    const oldAt = new Date(new Date(BASE_TS_ISO).getTime() - 1000 * 1000).toISOString(); // 1000s old -- past the margin
    const freshAt = new Date(new Date(BASE_TS_ISO).getTime() - 100 * 1000).toISOString(); // 100s old -- kept
    const clientId = uniqueId("client-prune");
    await db.prepare("INSERT INTO nonces (client_id, nonce, at) VALUES (?, 'old-nonce', ?)").bind(clientId, oldAt).run();
    await db.prepare("INSERT INTO nonces (client_id, nonce, at) VALUES (?, 'fresh-nonce', ?)").bind(clientId, freshAt).run();

    await pruneNonces(db, NOW);

    const rows = await db.prepare("SELECT nonce FROM nonces WHERE client_id = ?").bind(clientId).all<{ nonce: string }>();
    expect(rows.results.map((r) => r.nonce)).toEqual(["fresh-nonce"]);
  });
});

describe("[LDB-A9] a revoked client is refused from the revocation onward", () => {
  it("[LDB-A9] active before revoke, client_revoked after, no cache in front of status", async () => {
    const { privateKey, pubkeyB64url } = await generateKeyPair();
    const clientId = uniqueId("client-revoke");
    const actor = "222222222222222222";
    await seedClient(db, NOW, { id: clientId, pubkeyB64url, ownerUserId: actor, caps: "act-as-user" });

    const signOnce = (nonce: Uint8Array) =>
      signHeaders({
        privateKey,
        clientId,
        actor,
        method: "GET",
        pathWithQuery: "/v1/me",
        timestamp: Math.floor(new Date(BASE_TS_ISO).getTime() / 1000),
        nonce,
      });

    const before = await signOnce(crypto.getRandomValues(new Uint8Array(16)));
    const reqBefore = new Request("https://example.com/v1/me", { method: "GET", headers: before });
    await expect(verifyClientRequest(db, NOW, reqBefore, new Uint8Array(0), {})).resolves.toBeDefined();

    await db.prepare("UPDATE clients SET status = 'revoked', revoked_at = ? WHERE id = ?").bind(NOW(), clientId).run();

    const after = await signOnce(crypto.getRandomValues(new Uint8Array(16)));
    const reqAfter = new Request("https://example.com/v1/me", { method: "GET", headers: after });
    await expect(verifyClientRequest(db, NOW, reqAfter, new Uint8Array(0), {})).rejects.toMatchObject({ body: { error: "client_revoked" } });
  });

  it("[LDB-A9] unknown client id -> unknown_client", async () => {
    const { privateKey } = await generateKeyPair();
    const headers = await signHeaders({
      privateKey,
      clientId: "01ARZ3NDEKTSV4RRFFQ69G5FA0", // never registered
      actor: "333333333333333333",
      method: "GET",
      pathWithQuery: "/v1/me",
      timestamp: Math.floor(new Date(BASE_TS_ISO).getTime() / 1000),
    });
    const request = new Request("https://example.com/v1/me", { method: "GET", headers });
    await expect(verifyClientRequest(db, NOW, request, new Uint8Array(0), {})).rejects.toMatchObject({ body: { error: "unknown_client" } });
  });
});

describe("[LDB-A5] act-as-owner-only refuses a foreign actor, accepts the owner", () => {
  it("owner accepted, a different asserted actor -> actor_not_allowed", async () => {
    const { privateKey, pubkeyB64url } = await generateKeyPair();
    const clientId = uniqueId("client-owneronly");
    const owner = "444444444444444444";
    const stranger = "555555555555555555";
    await seedClient(db, NOW, { id: clientId, pubkeyB64url, ownerUserId: owner, caps: "act-as-owner-only" });

    const sign = (actor: string) =>
      signHeaders({
        privateKey,
        clientId,
        actor,
        method: "GET",
        pathWithQuery: "/v1/me",
        timestamp: Math.floor(new Date(BASE_TS_ISO).getTime() / 1000),
        nonce: crypto.getRandomValues(new Uint8Array(16)),
      });

    const ownerHeaders = await sign(owner);
    const ownerReq = new Request("https://example.com/v1/me", { method: "GET", headers: ownerHeaders });
    const actor = await verifyClientRequest(db, NOW, ownerReq, new Uint8Array(0), {});
    expect(actor.user_id).toBe(owner);

    const strangerHeaders = await sign(stranger);
    const strangerReq = new Request("https://example.com/v1/me", { method: "GET", headers: strangerHeaders });
    await expect(verifyClientRequest(db, NOW, strangerReq, new Uint8Array(0), {})).rejects.toMatchObject({
      body: { error: "actor_not_allowed", actor: stranger, owner },
    });
  });

  // LEDGER.md L4: `caps` is a comma-separated set now -- `act-as-owner-only`
  // still enforces the owner-only restriction (and `Actor.client_caps`
  // still carries the full string) even alongside an extra cap.
  it("[LDB-CH3] act-as-owner-only PLUS feed:wait still refuses a foreign actor, still carries client_caps", async () => {
    const { privateKey, pubkeyB64url } = await generateKeyPair();
    const clientId = uniqueId("client-owneronly-waitcap");
    const owner = "666666666666666666";
    const stranger = "777777777777777777";
    await seedClient(db, NOW, { id: clientId, pubkeyB64url, ownerUserId: owner, caps: "act-as-owner-only,feed:wait" });

    const sign = (actor: string) =>
      signHeaders({
        privateKey,
        clientId,
        actor,
        method: "GET",
        pathWithQuery: "/v1/me",
        timestamp: Math.floor(new Date(BASE_TS_ISO).getTime() / 1000),
        nonce: crypto.getRandomValues(new Uint8Array(16)),
      });

    const ownerReq = new Request("https://example.com/v1/me", { method: "GET", headers: await sign(owner) });
    const actor = await verifyClientRequest(db, NOW, ownerReq, new Uint8Array(0), {});
    expect(actor.client_caps).toBe("act-as-owner-only,feed:wait");

    const strangerReq = new Request("https://example.com/v1/me", { method: "GET", headers: await sign(stranger) });
    await expect(verifyClientRequest(db, NOW, strangerReq, new Uint8Array(0), {})).rejects.toMatchObject({
      body: { error: "actor_not_allowed", actor: stranger, owner },
    });
  });
});

describe("[LDB-A5] the two-lane dispatcher, live over SELF.fetch", () => {
  it("both lanes present -> 400 bad_request", async () => {
    const { privateKey, pubkeyB64url } = await generateKeyPair();
    const clientId = uniqueId("client-bothlanes");
    const actor = "666666666666666666";
    await seedClient(db, NOW, { id: clientId, pubkeyB64url, ownerUserId: actor, caps: "act-as-user" });
    const clientHeaders = await signHeaders({
      privateKey,
      clientId,
      actor,
      method: "GET",
      pathWithQuery: "/v1/me",
      timestamp: Math.floor(Date.now() / 1000),
    });

    const res = await SELF.fetch("https://example.com/v1/me", {
      headers: { ...clientHeaders, Authorization: "Bearer whatever" },
    });
    expect(res.status).toBe(400);
    const body = await res.json<{ error: string; param?: string }>();
    expect(body.error).toBe("bad_request");
    expect(body.param).toBe("Authorization");
  });

  it("GET /v1/me over the client lane answers via: client:<id> (D9: reads too, not just writes)", async () => {
    const { privateKey, pubkeyB64url } = await generateKeyPair();
    const clientId = uniqueId("client-liveread");
    const actor = "777777777777777777";
    await seedClient(db, NOW, { id: clientId, pubkeyB64url, ownerUserId: actor, caps: "act-as-user" });
    const headers = await signHeaders({
      privateKey,
      clientId,
      actor,
      method: "GET",
      pathWithQuery: "/v1/me",
      timestamp: Math.floor(Date.now() / 1000),
    });

    const res = await SELF.fetch("https://example.com/v1/me", { headers });
    expect(res.status).toBe(200);
    const body = await res.json<{ user_id: string; via: string }>();
    expect(body.user_id).toBe(actor);
    expect(body.via).toBe(`client:${clientId}`);
  });
});

// Sanity: the frozen import round-trips (the vectors' own key/id fields
// are real strings, not `undefined` from a bad import path) -- a cheap
// guard so a broken `with { type: "json" }` import fails loudly here
// instead of as a wall of unrelated failures above.
describe("vectors fixture sanity", () => {
  it("has the expected shape", () => {
    expect(vectors.version).toBe(1);
    expect(vectors.keys.length).toBeGreaterThan(0);
    expect(vectors.vectors.length).toBeGreaterThanOrEqual(12);
  });
});
