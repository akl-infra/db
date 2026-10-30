// [LDB-PG6..PG11] the proving ground's fake Discord (scripts/lab/fake-discord/server.mjs), on a free loopback port.
import crypto from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
// @ts-expect-error plain .mjs, no declarations
import { startFakeDiscord } from "../../scripts/lab/fake-discord/server.mjs";
import { handleDiscordInteraction } from "../../src/core/discord-interactions";
import { resolveBearer } from "../../src/auth/discord";
import { stubStore } from "./stub-store";

let fake: Awaited<ReturnType<typeof startFakeDiscord>>;
beforeAll(async () => {
  fake = await startFakeDiscord({ port: 0, seed: "test" });
});
afterAll(async () => {
  await fake.close();
});
beforeEach(async () => {
  await fetch(`${fake.url}/__fake/reset`, { method: "POST" });
});

const bot = { authorization: "Bot lab-bot-token", "content-type": "application/json" };
const control = (path: string, body?: unknown, method = "POST") => fetch(`${fake.url}/__fake/${path}`, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: { "content-type": "application/json" } });
const records = async () => ((await (await control("log", undefined, "GET")).text()).split("\n").filter(Boolean).map((l) => JSON.parse(l))) as any[];

describe("fake Discord", () => {
  it("[LDB-PG6] meets the bearer-check contract: 200 shape for lab-<id> and registered tokens, 401 for unknown or revoked", async () => {
    const ok = await fetch(`${fake.base}/oauth2/@me`, { headers: { authorization: "Bearer lab-1234" } });
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as any;
    expect(body.application.id).toBe(fake.applicationId);
    expect(body.user.id).toMatch(/^\d{17,20}$/);
    expect(typeof body.user.username).toBe("string");
    expect(body.scopes).toEqual(["identify"]);
    // a numeric id is the user id as is
    const num = (await (await fetch(`${fake.base}/oauth2/@me`, { headers: { authorization: "Bearer lab-300000000000000001" } })).json()) as any;
    expect(num.user.id).toBe("300000000000000001");
    expect((await fetch(`${fake.base}/oauth2/@me`, { headers: { authorization: "Bearer nope" } })).status).toBe(401);
    expect((await fetch(`${fake.base}/oauth2/@me`)).status).toBe(401);
    await control("tokens", { token: "akl-gg-token", user: { id: "400000000000000002", username: "sam" } });
    expect(((await (await fetch(`${fake.base}/oauth2/@me`, { headers: { authorization: "Bearer akl-gg-token" } })).json()) as any).user).toEqual({ id: "400000000000000002", username: "sam" });
    await control("revoke", { token: "akl-gg-token" });
    await control("revoke", { token: "lab-1234" });
    for (const t of ["akl-gg-token", "lab-1234"]) expect((await fetch(`${fake.base}/oauth2/@me`, { headers: { authorization: `Bearer ${t}` } })).status).toBe(401);
    // and akldb's own bearer check, unmodified, resolves a good token against it and says token_invalid for a revoked one
    const store = stubStore();
    const actor = await resolveBearer(store, () => new Date().toISOString(), "lab-77", fetch, fake.base);
    expect(actor).toMatchObject({ via: "discord", name: "lab-user-77", source_client: `discord-app:${fake.applicationId}` });
    await expect(resolveBearer(store, () => new Date().toISOString(), "lab-1234", fetch, fake.base)).rejects.toMatchObject({ status: 401 });
  });

  it("[LDB-PG7] serves the bot routes akldb calls: messages, DM channels, nonce dedupe, user lookup", async () => {
    expect((await fetch(`${fake.base}/v10/channels/9/messages`)).status).toBe(401);
    const dm = (await (await fetch(`${fake.base}/v10/users/@me/channels`, { method: "POST", headers: bot, body: JSON.stringify({ recipient_id: "300000000000000001" }) })).json()) as any;
    expect(dm.id).toMatch(/^\d{17,20}$/);
    const again = (await (await fetch(`${fake.base}/v10/users/@me/channels`, { method: "POST", headers: bot, body: JSON.stringify({ recipient_id: "300000000000000001" }) })).json()) as any;
    expect(again.id).toBe(dm.id);
    const post = (n: string) => fetch(`${fake.base}/v10/channels/${dm.id}/messages`, { method: "POST", headers: bot, body: JSON.stringify({ content: "hi", nonce: n, enforce_nonce: true }) });
    const first = (await (await post("n1")).json()) as any;
    expect((await (await post("n1")).json() as any).id).toBe(first.id);
    expect((await (await post("n2")).json() as any).id).not.toBe(first.id);
    expect(first.nonce).toBeUndefined();
    const got = (await (await fetch(`${fake.base}/v10/channels/${dm.id}/messages/${first.id}`, { headers: bot })).json()) as any;
    expect(got.content).toBe("hi");
    const patched = (await (await fetch(`${fake.base}/v10/channels/${dm.id}/messages/${first.id}`, { method: "PATCH", headers: bot, body: JSON.stringify({ content: "edited" }) })).json()) as any;
    expect(patched).toMatchObject({ id: first.id, content: "edited" });
    expect(patched.edited_timestamp).not.toBeNull();
    expect(((await (await fetch(`${fake.base}/v10/channels/${dm.id}/messages?limit=1`, { headers: bot })).json()) as any[]).length).toBe(1);
    expect((await fetch(`${fake.base}/v10/channels/${dm.id}/messages/${first.id}`, { method: "DELETE", headers: bot })).status).toBe(204);
    expect((await fetch(`${fake.base}/v10/channels/${dm.id}/messages/${first.id}`, { headers: bot })).status).toBe(404);
    expect(((await (await fetch(`${fake.base}/v10/users/300000000000000001`, { headers: bot })).json()) as any).username).toBe("lab-user-300000000000000001");
    // multipart creates keep payload_json
    const form = new FormData();
    form.append("payload_json", JSON.stringify({ content: "with file" }));
    form.append("files[0]", new Blob(["abc"]), "a.txt");
    const multi = (await (await fetch(`${fake.base}/v10/channels/${dm.id}/messages`, { method: "POST", headers: { authorization: bot.authorization }, body: form })).json()) as any;
    expect(multi.content).toBe("with file");
  });

  it("[LDB-PG8] serves interaction callbacks, followups, the original-message routes and incoming webhooks without auth", async () => {
    expect((await fetch(`${fake.base}/v10/interactions/500000000000000001/tok/callback`, { method: "POST", body: JSON.stringify({ type: 6 }), headers: { "content-type": "application/json" } })).status).toBe(204);
    const hook = `${fake.base}/v10/webhooks/${fake.applicationId}/tok`;
    const json = { "content-type": "application/json" };
    expect((await fetch(`${hook}/messages/@original`, { method: "PATCH", headers: json, body: "{}" })).status).toBe(404);
    const follow = (await (await fetch(`${hook}?wait=true`, { method: "POST", headers: json, body: JSON.stringify({ content: "followup", flags: 64 }) })).json()) as any;
    expect(follow).toMatchObject({ content: "followup", flags: 64 });
    const original = (await (await fetch(`${hook}/messages/@original`, { method: "PATCH", headers: json, body: JSON.stringify({ content: "edited" }) })).json()) as any;
    expect(original).toMatchObject({ id: follow.id, content: "edited" });
    expect(((await (await fetch(`${hook}/messages/${follow.id}`)).json()) as any).content).toBe("edited");
    expect((await fetch(`${hook}/messages/@original`, { method: "DELETE" })).status).toBe(204);
    expect((await fetch(`${hook}/messages/${follow.id}`)).status).toBe(404);
    // an incoming (legacy) webhook post answers 204 without ?wait
    expect((await fetch(`${fake.base}/v10/webhooks/600000000000000001/secret`, { method: "POST", headers: json, body: JSON.stringify({ content: "queue" }) })).status).toBe(204);
  });

  it("[LDB-PG9] records every call as NDJSON with method, path, body and headers, never the credential", async () => {
    await fetch(`${fake.base}/oauth2/@me`, { headers: { authorization: "Bearer lab-secret-token" } });
    await fetch(`${fake.base}/v10/channels/1/messages`, { method: "POST", headers: { ...bot, cookie: "c=1" }, body: JSON.stringify({ content: "x" }) });
    const log = await records();
    expect(log.map((l) => [l.seq, l.method, l.path, l.authKind, l.status])).toEqual([
      [1, "GET", "/api/oauth2/@me", "bearer", 200],
      [2, "POST", "/api/v10/channels/1/messages", "bot", 200],
    ]);
    expect(log[1].body).toEqual({ content: "x" });
    const text = JSON.stringify(log);
    expect(text).not.toContain("lab-secret-token");
    expect(text).not.toContain("lab-bot-token");
    expect(log[1].headers.cookie).toBeUndefined();
    expect(log[1].headers.authorization).toBeUndefined();
    // control routes are not part of the record
    expect(log.some((l) => l.path.startsWith("/__fake"))).toBe(false);
    await control("reset");
    expect(await records()).toEqual([]);
  });

  it("[LDB-PG10] injects a 429 with Retry-After or a 5xx on command, counted, matched and flagged in the record", async () => {
    await control("inject", { status: 429, retryAfter: 7, path: "oauth2", count: 2 });
    const hit = await fetch(`${fake.base}/oauth2/@me`, { headers: { authorization: "Bearer lab-1" } });
    expect(hit.status).toBe(429);
    expect(hit.headers.get("retry-after")).toBe("7");
    expect(((await hit.json()) as any).retry_after).toBe(7);
    // the real bearer check turns it into identity_unavailable and passes Retry-After through
    await expect(resolveBearer(stubStore(), () => new Date().toISOString(), "lab-1", fetch, fake.base)).rejects.toMatchObject({ status: 503 });
    expect((await fetch(`${fake.base}/oauth2/@me`, { headers: { authorization: "Bearer lab-1" } })).status).toBe(200); // count spent
    await control("inject", { status: 503, method: "POST", after: 1, count: 1 });
    const post = () => fetch(`${fake.base}/v10/users/@me/channels`, { method: "POST", headers: bot, body: JSON.stringify({ recipient_id: "300000000000000001" }) });
    expect((await post()).status).toBe(200);
    expect((await post()).status).toBe(503);
    expect((await post()).status).toBe(200);
    expect((await control("inject", { status: 400 })).status).toBe(400);
    const log = await records();
    expect(log.filter((l) => l.injected).map((l) => l.status)).toEqual([429, 429, 503]);
  });

  it("[LDB-PG11] holds the lab application's Ed25519 key: signed interactions pass akldb's own verification, tampered ones do not", async () => {
    const signer = (await (await control("signer", undefined, "GET")).json()) as any;
    expect(signer).toEqual({ application_id: fake.applicationId, public_key: fake.publicKeyHex });
    expect(fake.publicKeyHex).toMatch(/^[0-9a-f]{64}$/);
    expect((await startFakeDiscord({ port: 0, seed: "test" }).then(async (f: any) => { const k = f.publicKeyHex; await f.close(); return k; }))).toBe(fake.publicKeyHex); // seed -> same key
    const body = JSON.stringify({ type: 1, application_id: fake.applicationId });
    const signed = fake.sign(body);
    const env = { MODQUEUE_DISCORD_APPLICATION_ID: fake.applicationId, MODQUEUE_DISCORD_PUBLIC_KEY: fake.publicKeyHex, DB: stubStore() } as never;
    const send = (b: string, h: Record<string, string>) => handleDiscordInteraction(new Request("http://127.0.0.1/discord/interactions", { method: "POST", body: b, headers: h }), env, () => new Date().toISOString());
    const pong = await send(signed.body, signed.headers);
    expect(pong.status).toBe(200);
    expect(await pong.json()).toEqual({ type: 1 });
    expect((await send(body + " ", signed.headers)).status).toBe(401);
    // the /__fake/sign route gives the same kind of signature, verifiable with the public key alone
    const viaHttp = (await (await control("sign", { body, timestamp: "1790000000" })).json()) as any;
    const pub = crypto.createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(fake.publicKeyHex, "hex")]), format: "der", type: "spki" });
    expect(crypto.verify(null, Buffer.from("1790000000" + body), pub, Buffer.from(viaHttp.headers["X-Signature-Ed25519"], "hex"))).toBe(true);
  });
});
