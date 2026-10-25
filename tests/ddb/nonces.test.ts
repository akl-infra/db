// [LDB-DDB30] [LDB-DDB31] Nonces on DynamoDB: an ephemeral conditional Put,
// single-use under concurrency, and a nightly prune that neither reopens the
// replay window nor resurrects anything.
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { describe, expect, it } from "vitest";
import { verifyClientRequest, pruneNonces } from "../../src/auth/client";
import { fixedClock } from "../../src/core/time";
import { generateKeyPair, signHeaders } from "../auth/client-support";
import { ddbHarness } from "../harness/ddb";

const { store, doc, tables } = ddbHarness;
const BASE_ISO = "2026-08-29T10:40:00.000Z";
const NOW = fixedClock(BASE_ISO);
let n = 0;
const uid = (p: string) => `${p}-${n++}-${Math.random().toString(36).slice(2, 8)}`;

describe("nonces", () => {
  it("[LDB-DDB30] a nonce is single-use, and N concurrent inserts of one nonce admit exactly one", async () => {
    const c = uid("c");
    expect(await store.auth.insertNonce(c, "n1", BASE_ISO)).toBe(true);
    expect(await store.auth.insertNonce(c, "n1", BASE_ISO)).toBe(false);
    expect(await store.auth.insertNonce(uid("other"), "n1", BASE_ISO)).toBe(true); // scoped per client
    const results = await Promise.all(Array.from({ length: 12 }, () => store.auth.insertNonce(c, "race", BASE_ISO)));
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it("[LDB-DDB30] the nonce item is ephemeral with ttl = at + 900 s", async () => {
    const c = uid("c");
    const at = new Date().toISOString();
    await store.auth.insertNonce(c, "n1", at);
    const r = await doc.send(new GetCommand({ TableName: tables.ephemeral, Key: { pk: `N#${c}`, sk: "n1" }, ConsistentRead: true }));
    expect(r.Item?.ttl).toBe(Math.floor(Date.parse(at) / 1000) + 900);
    const main = await doc.send(new GetCommand({ TableName: tables.main, Key: { pk: `N#${c}`, sk: "n1" }, ConsistentRead: true }));
    expect(main.Item).toBeUndefined();
  });

  it("[LDB-DDB30] an expired-but-present nonce row is treated as absent, a live one is not", async () => {
    const c = uid("c");
    const at = Date.now();
    const iso = (ms: number) => new Date(ms).toISOString();
    expect(await store.auth.insertNonce(c, "n1", iso(at))).toBe(true);
    expect(await store.auth.insertNonce(c, "n1", iso(at + 800_000))).toBe(false); // inside 900 s: still a replay
    expect(await store.auth.insertNonce(c, "n1", iso(at + 1_000_000))).toBe(true); // past ttl, row not collected yet
  });

  it("[LDB-DDB30] pruneNonces drops older rows and keeps newer ones", async () => {
    const c = uid("c");
    await store.auth.insertNonce(c, "old", "2026-08-29T10:00:00.000Z");
    await store.auth.insertNonce(c, "fresh", "2026-08-29T10:39:00.000Z");
    await store.auth.pruneNonces("2026-08-29T10:25:00.000Z");
    expect(await store.auth.insertNonce(c, "fresh", "2026-08-29T10:39:00.000Z")).toBe(false);
    expect(await store.auth.insertNonce(c, "old", "2026-08-29T10:00:00.000Z")).toBe(true);
  });

  it("[LDB-DDB31] after a nightly prune an old nonce is still refused by the skew window, and a fresh one is still single-use", async () => {
    const { privateKey, pubkeyB64url } = await generateKeyPair();
    const clientId = uid("client");
    const actor = "111111111111111111";
    await store.admin.insertClient({
      id: clientId, name: "c", pubkey: pubkeyB64url, owner_user_id: actor, caps: "act-as-user", discord_app_id: null, status: "active", created_at: BASE_ISO, revoked_at: null,
    });
    const sign = async (ts: number, nonce: Uint8Array) =>
      new Request("https://example.com/v1/me", {
        method: "GET",
        headers: await signHeaders({ privateKey, clientId, actor, method: "GET", pathWithQuery: "/v1/me", timestamp: ts, nonce }),
      });
    const nowS = Math.floor(Date.parse(BASE_ISO) / 1000);
    const oldNonce = crypto.getRandomValues(new Uint8Array(16));
    const old = await sign(nowS - 250, oldNonce);
    await verifyClientRequest(store, NOW, old.clone(), new Uint8Array(0), {});
    await expect(verifyClientRequest(store, NOW, old.clone(), new Uint8Array(0), {})).rejects.toMatchObject({ body: { error: "replay" } });

    // A day later: the nightly prune ran. The same signed request is now outside the skew window.
    const later = fixedClock("2026-08-30T10:40:00.000Z");
    await pruneNonces(store, later);
    await expect(verifyClientRequest(store, later, old.clone(), new Uint8Array(0), {})).rejects.toMatchObject({ status: 401 });

    // A request inside the window is single-use again after the prune ran.
    const fresh = await sign(Math.floor(Date.parse("2026-08-30T10:40:00.000Z") / 1000), crypto.getRandomValues(new Uint8Array(16)));
    await verifyClientRequest(store, later, fresh.clone(), new Uint8Array(0), {});
    await pruneNonces(store, later);
    await expect(verifyClientRequest(store, later, fresh.clone(), new Uint8Array(0), {})).rejects.toMatchObject({ body: { error: "replay" } });
  });
});
