// [LDB-PV1] The shadow stage's egress guard and fake Discord: nothing but the stack's own AWS endpoints, production's
// public GETs and the in-process fake can be reached; Discord and every write to production are refused, with one alarm line.
import { describe, expect, it } from "vitest";
import { FAKE_DISCORD_BASE, FAKE_DISCORD_HOST, createFakeDiscord } from "../../src/platform/fake-discord";
import { GUARDED, ShadowEgressError, createEgressGuard, installEgressGuard, type FetchFn } from "../../src/platform/shadow-egress";

function guard() {
  const sent: { url: string; method: string }[] = [];
  const lines: string[] = [];
  const fakeDiscord = createFakeDiscord({ now: () => "2026-11-02T00:00:00.000Z" });
  const inner: FetchFn = async (input, init) => {
    const req = input instanceof Request ? input : new Request(input, init);
    sent.push({ url: req.url, method: req.method });
    return new Response("ok", { status: 200 });
  };
  return { fetch: createEgressGuard({ inner, fakeDiscord, logLine: (l) => void lines.push(l) }), sent, lines, fakeDiscord };
}

describe("egress guard", () => {
  it("[LDB-PV1] discord.com is refused for every method, with one alarm line that names the host and nothing else", async () => {
    const g = guard();
    for (const method of ["GET", "POST", "PATCH", "PUT", "DELETE"]) {
      await expect(g.fetch("https://discord.com/api/v10/webhooks/123/SECRET-TOKEN?wait=true", { method, headers: { authorization: "Bot x" } })).rejects.toThrow(ShadowEgressError);
    }
    expect(g.sent).toEqual([]);
    expect(g.lines).toHaveLength(5);
    expect(g.lines[0]).toBe("akldb-alarm: shadow-egress: refused GET discord.com");
    expect(g.lines.join("\n")).not.toMatch(/SECRET-TOKEN|authorization|Bot x|wait=true/);
  });

  it("[LDB-PV1] api.akldb.org answers GET and HEAD only; POST, PUT, PATCH and DELETE to it are refused", async () => {
    const g = guard();
    expect((await g.fetch("https://api.akldb.org/v1/changes?since=1")).status).toBe(200);
    expect((await g.fetch(new Request("https://api.akldb.org/v1/meta", { method: "HEAD" }))).status).toBe(200);
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      await expect(g.fetch("https://api.akldb.org/v1/layouts", { method, body: "{}" }), method).rejects.toThrow(/shadow egress refused/);
    }
    await expect(g.fetch(new Request("https://api.akldb.org/v1/layouts", { method: "POST", body: "{}" }))).rejects.toThrow(ShadowEgressError);
    expect(g.sent.map((s) => s.method)).toEqual(["GET", "HEAD"]);
    expect(g.lines).toHaveLength(5);
  });

  it("[LDB-PV1] only the stack's own AWS services in us-east-2 over https are reachable; other hosts, regions, ports and plain http are not", async () => {
    const g = guard();
    for (const ok of [
      "https://dynamodb.us-east-2.amazonaws.com/",
      "https://akldb-shadow-data-335937358231.s3.us-east-2.amazonaws.com/snap/slot-0.sqlite.zst",
      "https://ssm.us-east-2.amazonaws.com/",
      "https://lambda.us-east-2.amazonaws.com/2015-03-31/functions/akldb-shadow-jobs/invocations",
    ]) expect((await g.fetch(ok, { method: "POST" })).status, ok).toBe(200);
    for (const bad of [
      "https://dynamodb.eu-west-1.amazonaws.com/",
      "https://sts.us-east-2.amazonaws.com/",
      "https://dynamodb.us-east-2.amazonaws.com.evil.example/",
      "https://evil-dynamodb.us-east-2.amazonaws.com/",
      "https://dynamodb.us-east-2.amazonaws.com:8443/",
      "http://dynamodb.us-east-2.amazonaws.com/",
      "https://shadow-api.akldb.org/v1/meta",
      "https://api.akldb.org.evil.example/v1/meta",
      "https://cmini.example/api",
      "http://127.0.0.1:9001/runtime/invocation/next",
    ]) await expect(g.fetch(bad), bad).rejects.toThrow(ShadowEgressError);
    expect(g.sent).toHaveLength(4);
  });

  it("[LDB-PV1] the fake Discord's host is answered in-process: the call is recorded, answered like Discord and never sent", async () => {
    const g = guard();
    const base = FAKE_DISCORD_BASE;
    expect(base).toBe(`http://${FAKE_DISCORD_HOST}/api`);
    const me = await g.fetch(`${base}/oauth2/@me`, { headers: { authorization: "Bearer lab-42" } });
    expect(me.status).toBe(200);
    expect(((await me.json()) as { user: { username: string } }).user.username).toBe("lab-user-42");
    expect((await g.fetch(`${base}/oauth2/@me`, { headers: { authorization: "Bearer nope" } })).status).toBe(401);
    const dm = await g.fetch(`${base}/v10/users/@me/channels`, { method: "POST", headers: { authorization: "Bot sekrit", "content-type": "application/json" }, body: JSON.stringify({ recipient_id: "123456789012345678" }) });
    expect(dm.status).toBe(200);
    const channel = ((await dm.json()) as { id: string }).id;
    const posted = await g.fetch(`${base}/v10/channels/${channel}/messages`, { method: "POST", headers: { authorization: "Bot sekrit", "content-type": "application/json" }, body: JSON.stringify({ content: "hi", nonce: "n1", enforce_nonce: true }) });
    const msg = (await posted.json()) as { id: string; content: string };
    expect(msg.content).toBe("hi");
    // nonce dedupe, edit, delete
    const again = (await (await g.fetch(`${base}/v10/channels/${channel}/messages`, { method: "POST", headers: { authorization: "Bot sekrit", "content-type": "application/json" }, body: JSON.stringify({ content: "hi", nonce: "n1", enforce_nonce: true }) })).json()) as { id: string };
    expect(again.id).toBe(msg.id);
    expect((await g.fetch(`${base}/v10/channels/${channel}/messages/${msg.id}`, { method: "PATCH", headers: { authorization: "Bot sekrit", "content-type": "application/json" }, body: JSON.stringify({ content: "edited" }) })).status).toBe(200);
    expect((await g.fetch(`${base}/v10/channels/${channel}/messages/${msg.id}`, { method: "DELETE", headers: { authorization: "Bot sekrit" } })).status).toBe(204);
    expect((await g.fetch(`${base}/v10/webhooks/1/tok?wait=true`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ content: "w" }) })).status).toBe(200);
    expect((await g.fetch(`${base}/v10/interactions/5/tok/callback`, { method: "POST", body: "{}" })).status).toBe(204);
    expect((await g.fetch(`${base}/v10/channels/${channel}/messages`, { method: "POST", body: "{}" })).status).toBe(401); // no credential
    expect(g.sent).toEqual([]);
    expect(g.lines).toEqual([]);
    const calls = g.fakeDiscord.calls();
    expect(calls.length).toBe(g.fakeDiscord.total());
    expect(calls.some((c) => c.method === "POST" && c.path.endsWith("/messages") && c.authKind === "bot")).toBe(true);
    expect(JSON.stringify(calls)).not.toMatch(/sekrit|lab-42|Bearer|Bot /); // the credential is never recorded, only its kind
  });

  it("[LDB-PV1] the fake Discord's record is a bounded ring", async () => {
    const f = createFakeDiscord({ maxCalls: 3 });
    for (let i = 0; i < 10; i++) await f.handle(new Request(`${FAKE_DISCORD_BASE}/v10/interactions/${i}/t/callback`, { method: "POST", body: "{}" }));
    expect(f.total()).toBe(10);
    expect(f.calls().map((c) => c.seq)).toEqual([8, 9, 10]);
  });

  it("[LDB-PV1] installing the guard replaces the global fetch once, and uninstalling puts the old one back", async () => {
    const before = globalThis.fetch;
    const lines: string[] = [];
    const uninstall = installEgressGuard({ fakeDiscord: createFakeDiscord(), logLine: (l) => void lines.push(l) });
    try {
      expect((globalThis.fetch as unknown as Record<symbol, unknown>)[GUARDED]).toBe(true);
      const second = installEgressGuard({ fakeDiscord: createFakeDiscord() });
      second(); // a no-op: the guard was already there
      expect((globalThis.fetch as unknown as Record<symbol, unknown>)[GUARDED]).toBe(true);
      await expect(fetch("https://discord.com/api/v10/users/@me")).rejects.toThrow(ShadowEgressError);
      expect(lines).toEqual(["akldb-alarm: shadow-egress: refused GET discord.com"]);
    } finally {
      uninstall();
    }
    expect(globalThis.fetch).toBe(before);
  });
});
