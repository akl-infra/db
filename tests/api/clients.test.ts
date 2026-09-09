// [LDB-A5] [LDB-A9] The client-lane admin routes (10 C1): register/revoke/
// list clients, each an admin-only write that emits an `admin.client_*`
// event; `detail` never carries the pubkey; a registered key signs a
// request the client lane accepts, and a revoked one is refused from the
// revocation onward (no cache in front of `clients.status`).
import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Bindings } from "../../src/env";
import { verifyClientRequest } from "../../src/auth/client";
import { type EventDbRow, rowToEvent } from "../../src/core/events";
import { fixedClock } from "../../src/core/time";
import { generateKeyPair, signHeaders } from "../auth/client-support";
import { BOOTSTRAP_ADMIN, actorFixture, pinTestClock, register, uniqueName, writeFetch } from "./write-support";

const bindings = env as unknown as Bindings;
const db = bindings.DB;
const clock = fixedClock("2026-08-01T00:00:00.000Z");
pinTestClock(env as unknown as { TEST_CLOCK?: typeof clock }, clock);

const OTHER_USER = "owner-clients-nonadmin";

afterEach(() => {
  vi.unstubAllGlobals();
});

function adminHeaders(token: string) {
  const fake = actorFixture();
  return register(fake, token, BOOTSTRAP_ADMIN);
}

function userHeaders(token: string, id = OTHER_USER) {
  const fake = actorFixture();
  return register(fake, token, id);
}

let idCounter = 0;
function testUserId(): string {
  idCounter++;
  return `40000000000000${String(idCounter).padStart(3, "0")}`;
}

async function registerClient(pubkeyB64url: string, ownerUserId: string, caps: "act-as-user" | "act-as-owner-only" = "act-as-user") {
  return writeFetch("/v1/admin/clients", "POST", adminHeaders(`tok-${uniqueName("register")}`), {
    name: uniqueName("test-client"),
    pubkey: pubkeyB64url,
    owner_user_id: ownerUserId,
    caps,
  });
}

describe("[LDB-A5] admin client routes: role matrix", () => {
  it("anonymous -> 401 unauthorized on every client route", async () => {
    const routes: { method: string; path: string; body?: unknown }[] = [
      { method: "GET", path: "/v1/admin/clients" },
      { method: "POST", path: "/v1/admin/clients", body: { name: "x", pubkey: "x", owner_user_id: testUserId(), caps: "act-as-user" } },
      { method: "DELETE", path: "/v1/admin/clients/01ARZ3NDEKTSV4RRFFQ69G5FAV" },
    ];
    for (const r of routes) {
      const res = await writeFetch(r.path, r.method, {}, r.body);
      expect(res.status, `${r.method} ${r.path}`).toBe(401);
      const body = await res.json<{ error: string }>();
      expect(body.error, `${r.method} ${r.path}`).toBe("unauthorized");
    }
  });

  it("a signed-in non-admin -> 403 not_admin on every client route", async () => {
    const routes: { method: string; path: string; body?: unknown }[] = [
      { method: "GET", path: "/v1/admin/clients" },
      { method: "POST", path: "/v1/admin/clients", body: { name: "x", pubkey: "x", owner_user_id: testUserId(), caps: "act-as-user" } },
      { method: "DELETE", path: "/v1/admin/clients/01ARZ3NDEKTSV4RRFFQ69G5FAV" },
    ];
    for (const r of routes) {
      const res = await writeFetch(r.path, r.method, userHeaders(`tok-${uniqueName("nonadmin")}`), r.body);
      expect(res.status, `${r.method} ${r.path}`).toBe(403);
      const body = await res.json<{ error: string }>();
      expect(body.error, `${r.method} ${r.path}`).toBe("not_admin");
    }
  });
});

describe("[LDB-A5] POST /v1/admin/clients", () => {
  it("[LDB-A5] registers a client -> 201, the row, one admin.client_registered event WITHOUT the pubkey in detail", async () => {
    const { pubkeyB64url } = await generateKeyPair();
    const owner = testUserId();
    const res = await registerClient(pubkeyB64url, owner);
    expect(res.status).toBe(201);
    const body = await res.json<{ id: string; name: string; pubkey: string; owner_user_id: string; caps: string; status: string }>();
    expect(body.pubkey).toBe(pubkeyB64url);
    expect(body.owner_user_id).toBe(owner);
    expect(body.caps).toBe("act-as-user");
    expect(body.status).toBe("active");

    const { results } = await db
      .prepare("SELECT * FROM events WHERE kind = 'admin.client_registered' AND detail_json LIKE ? ORDER BY seq DESC LIMIT 1")
      .bind(`%${body.id}%`)
      .all<EventDbRow>();
    expect(results).toHaveLength(1);
    const e = rowToEvent(results[0]!);
    expect(e.admin).toBe(true);
    expect(e.rev).toBeNull();
    expect(JSON.stringify(e.detail)).not.toContain(pubkeyB64url);
    expect(e.detail).toEqual({ id: body.id, name: body.name, owner_user_id: owner, caps: "act-as-user" });
  });

  it("a pubkey that doesn't decode to exactly 32 bytes -> 400 bad_request /pubkey", async () => {
    const res = await registerClient("not-32-bytes", testUserId());
    expect(res.status).toBe(400);
    const body = await res.json<{ error: string; param: string }>();
    expect(body.error).toBe("bad_request");
    expect(body.param).toBe("/pubkey");
  });

  it("caps outside the two known values -> 400 bad_request", async () => {
    const { pubkeyB64url } = await generateKeyPair();
    const res = await writeFetch("/v1/admin/clients", "POST", adminHeaders(`tok-${uniqueName("caps")}`), {
      name: "x",
      pubkey: pubkeyB64url,
      owner_user_id: testUserId(),
      caps: "act-as-god",
    });
    expect(res.status).toBe(400);
  });

  it("owner_user_id not a 17-20 digit snowflake -> 400 bad_request", async () => {
    const { pubkeyB64url } = await generateKeyPair();
    const res = await writeFetch("/v1/admin/clients", "POST", adminHeaders(`tok-${uniqueName("owner")}`), {
      name: "x",
      pubkey: pubkeyB64url,
      owner_user_id: "not-an-id",
      caps: "act-as-user",
    });
    expect(res.status).toBe(400);
  });
});

describe("[LDB-A9] DELETE /v1/admin/clients/{id}", () => {
  it("[LDB-A9] revokes -> 200, status revoked, one admin.client_revoked event", async () => {
    const { pubkeyB64url } = await generateKeyPair();
    const registerRes = await registerClient(pubkeyB64url, testUserId());
    const { id } = await registerRes.json<{ id: string }>();

    const res = await writeFetch(`/v1/admin/clients/${id}`, "DELETE", adminHeaders(`tok-${uniqueName("revoke")}`));
    expect(res.status).toBe(200);
    const body = await res.json<{ id: string; status: string; revoked_at: string }>();
    expect(body.status).toBe("revoked");
    expect(body.revoked_at).toBeTruthy();

    const { results } = await db
      .prepare("SELECT * FROM events WHERE kind = 'admin.client_revoked' AND detail_json LIKE ? ORDER BY seq DESC LIMIT 1")
      .bind(`%${id}%`)
      .all<EventDbRow>();
    expect(results).toHaveLength(1);
  });

  it("revoking twice -> 200 idempotent, no second event", async () => {
    const { pubkeyB64url } = await generateKeyPair();
    const registerRes = await registerClient(pubkeyB64url, testUserId());
    const { id } = await registerRes.json<{ id: string }>();

    const first = await writeFetch(`/v1/admin/clients/${id}`, "DELETE", adminHeaders(`tok-${uniqueName("revoke")}`));
    expect(first.status).toBe(200);
    const before = await db.prepare("SELECT COUNT(*) AS n FROM events WHERE kind = 'admin.client_revoked'").first<{ n: number }>();

    const second = await writeFetch(`/v1/admin/clients/${id}`, "DELETE", adminHeaders(`tok-${uniqueName("revoke")}`));
    expect(second.status).toBe(200);
    const after = await db.prepare("SELECT COUNT(*) AS n FROM events WHERE kind = 'admin.client_revoked'").first<{ n: number }>();
    expect(after?.n).toBe(before?.n);
  });

  it("an unknown id -> 404", async () => {
    const res = await writeFetch("/v1/admin/clients/01ARZ3NDEKTSV4RRFFQ69G5FAV", "DELETE", adminHeaders(`tok-${uniqueName("revoke")}`));
    expect(res.status).toBe(404);
  });
});

describe("GET /v1/admin/clients", () => {
  it("lists registered clients, pubkey included (public by design)", async () => {
    const { pubkeyB64url } = await generateKeyPair();
    const owner = testUserId();
    const registerRes = await registerClient(pubkeyB64url, owner);
    const { id } = await registerRes.json<{ id: string }>();

    const res = await writeFetch("/v1/admin/clients", "GET", adminHeaders(`tok-${uniqueName("list")}`));
    expect(res.status).toBe(200);
    const body = await res.json<{ id: string; pubkey: string; owner_user_id: string }[]>();
    const row = body.find((c) => c.id === id);
    expect(row?.pubkey).toBe(pubkeyB64url);
    expect(row?.owner_user_id).toBe(owner);
  });
});

describe("[LDB-A9] a registered key signs a request the client lane accepts; a revoked one is refused", () => {
  it("accepted while active, client_revoked from the revocation onward", async () => {
    const { privateKey, pubkeyB64url } = await generateKeyPair();
    const owner = testUserId();
    const registerRes = await registerClient(pubkeyB64url, owner);
    const { id } = await registerRes.json<{ id: string }>();

    const sign = () =>
      signHeaders({
        privateKey,
        clientId: id,
        actor: owner,
        method: "GET",
        pathWithQuery: "/v1/me",
        timestamp: Math.floor(new Date(clock()).getTime() / 1000), // matches verifyClientRequest's own `now` below
        nonce: crypto.getRandomValues(new Uint8Array(16)),
      });

    const beforeHeaders = await sign();
    const beforeReq = new Request("https://example.com/v1/me", { method: "GET", headers: beforeHeaders });
    const actor = await verifyClientRequest(db, clock, beforeReq, new Uint8Array(0), {});
    expect(actor.via).toBe(`client:${id}`);

    const revokeRes = await writeFetch(`/v1/admin/clients/${id}`, "DELETE", adminHeaders(`tok-${uniqueName("revoke")}`));
    expect(revokeRes.status).toBe(200);

    const afterHeaders = await sign();
    const afterReq = new Request("https://example.com/v1/me", { method: "GET", headers: afterHeaders });
    await expect(verifyClientRequest(db, clock, afterReq, new Uint8Array(0), {})).rejects.toMatchObject({
      body: { error: "client_revoked" },
    });
  });
});
