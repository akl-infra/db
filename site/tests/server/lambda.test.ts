// The Lambda entry (server/lambda.ts): origin verification, the viewer host,
// Discord URLs from the environment, cookies through the Function URL event.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleEvent, type FunctionUrlEvent, type LambdaConfig } from "../../server/lambda.ts";
import { sealSession } from "../../server/session.ts";

const SECRET = "origin-secret-0123456789";
const config: LambdaConfig = {
  originVerify: SECRET,
  env: {
    DB_BASE_URL: "https://db.example.test",
    SITE_NAME: "akldb",
    DISCORD_CLIENT_ID: "client-id",
    DISCORD_CLIENT_SECRET: "client-secret",
    SESSION_SECRET: "session-secret",
  },
};

function event(path: string, over: Partial<FunctionUrlEvent> & { headers?: Record<string, string> } = {}): FunctionUrlEvent {
  const [rawPath, rawQueryString = ""] = path.split("?");
  return {
    rawPath: rawPath!,
    rawQueryString,
    requestContext: { http: { method: "GET" } },
    ...over,
    headers: {
      "x-origin-verify": SECRET,
      "x-forwarded-host": "next.akldb.org",
      host: "abc123.lambda-url.us-east-2.on.aws",
      ...over.headers,
    },
  };
}

const json = (r: { body: string }) => JSON.parse(Buffer.from(r.body, "base64").toString());

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe("[LDB-SITE1] origin verification", () => {
  it("403s without the header, with a wrong one, and when the configured secret is empty", async () => {
    const without = event("/auth/me");
    delete without.headers!["x-origin-verify"];
    expect((await handleEvent(without, config)).statusCode).toBe(403);
    expect((await handleEvent(event("/auth/me", { headers: { "x-origin-verify": "nope" } }), config)).statusCode).toBe(403);
    expect((await handleEvent(event("/auth/me", { headers: { "x-origin-verify": "" } }), { ...config, originVerify: "" })).statusCode).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("403s a verified call that names no viewer host", async () => {
    const e = event("/auth/me");
    delete e.headers!["x-forwarded-host"];
    expect((await handleEvent(e, config)).statusCode).toBe(403);
  });

  it("serves a verified call", async () => {
    const res = await handleEvent(event("/auth/me"), config);
    expect(res.statusCode).toBe(200);
    expect(json(res)).toEqual({ user: null, signin: true });
  });

  it("never forwards the secret or the viewer-host header to the upstream", async () => {
    fetchMock.mockResolvedValue(new Response("{}", { status: 200, headers: { "content-type": "application/json" } }));
    await handleEvent(event("/api/v1/layouts", { headers: { accept: "application/json" } }), config);
    const sent = new Headers((fetchMock.mock.calls[0]![1] as RequestInit).headers);
    expect([...sent.keys()].sort()).toEqual(["accept", "user-agent", "x-client-version"]);
  });
});

describe("[LDB-SITE2] the viewer's host is the request's host", () => {
  it("redirect_uri and the Discord redirect come from x-forwarded-host", async () => {
    const res = await handleEvent(event("/auth/login", { headers: { "x-forwarded-host": "akldb.org" } }), config);
    expect(res.statusCode).toBe(302);
    const loc = new URL(res.headers.location!);
    expect(loc.searchParams.get("redirect_uri")).toBe("https://akldb.org/auth/callback");
    expect(res.cookies).toHaveLength(1);
    expect(res.cookies![0]).toMatch(/^__Host-akldb_oauth_state=/);
  });
});

describe("[LDB-SITE3] Discord's OAuth URLs come from the environment", () => {
  it("defaults to Discord's own", async () => {
    const res = await handleEvent(event("/auth/login"), config);
    expect(new URL(res.headers.location!).origin + new URL(res.headers.location!).pathname).toBe("https://discord.com/oauth2/authorize");
  });

  it("uses the configured authorize and token URLs (lab's fake Discord)", async () => {
    const lab: LambdaConfig = {
      ...config,
      env: { ...config.env, DISCORD_AUTHORIZE_URL: "http://127.0.0.1:18513/oauth2/authorize", DISCORD_TOKEN_URL: "http://127.0.0.1:18513/oauth2/token" },
    };
    const login = await handleEvent(event("/auth/login"), lab);
    expect(login.headers.location!.startsWith("http://127.0.0.1:18513/oauth2/authorize?")).toBe(true);
    const state = /state=([^;]+)/.exec(login.cookies![0]!)![1]!;
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: "tok", expires_in: 3600 }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ user_id: "u1", name: "Ann", via: "discord", admin: false }), { status: 200 }));
    const cb = await handleEvent(event(`/auth/callback?code=c&state=${state}`, { headers: { cookie: `__Host-akldb_oauth_state=${state}` } }), lab);
    expect(fetchMock.mock.calls[0]![0]).toBe("http://127.0.0.1:18513/oauth2/token");
    expect(cb.statusCode).toBe(302);
  });
});

describe("[LDB-SITE6] cookies survive the Function URL event shape", () => {
  it("returns every Set-Cookie separately in `cookies`, none in headers", async () => {
    const login = await handleEvent(event("/auth/login"), config);
    const state = /state=([^;]+)/.exec(login.cookies![0]!)![1]!;
    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: "tok", expires_in: 3600 }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ user_id: "u1", name: "Ann", via: "discord", admin: false }), { status: 200 }));
    const cb = await handleEvent(event(`/auth/callback?code=c&state=${state}`, { cookies: [`__Host-akldb_oauth_state=${state}`] }), config);
    expect(cb.cookies).toHaveLength(2);
    expect(cb.cookies![0]).toMatch(/^__Host-akldb_session=/);
    expect(cb.cookies![1]).toMatch(/^__Host-akldb_oauth_state=;/);
    expect(Object.keys(cb.headers)).not.toContain("set-cookie");
  });

  it("reads a session from the event's `cookies` array", async () => {
    const sealed = await sealSession(
      { access_token: "tok", expires_at: Date.now() + 60_000, user_id: "u1", name: "Ann" },
      config.env.SESSION_SECRET!,
    );
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ user_id: "u1", name: "Ann", via: "discord", admin: false }), { status: 200 }));
    const res = await handleEvent(event("/auth/me", { cookies: ["a=b", `__Host-akldb_session=${sealed}`] }), config);
    expect(json(res).user.user_id).toBe("u1");
    expect(new Headers((fetchMock.mock.calls[0]![1] as RequestInit).headers).get("authorization")).toBe("Bearer tok");
  });

  it("passes a base64 request body through and answers binary-safe", async () => {
    fetchMock.mockResolvedValue(new Response(new Uint8Array([0, 255, 1]), { status: 201, headers: { "content-type": "application/octet-stream" } }));
    const res = await handleEvent(
      event("/api/v1/layouts", {
        requestContext: { http: { method: "POST" } },
        headers: { "x-requested-with": "akldb", "content-type": "application/json" },
        body: Buffer.from('{"a":"é"}').toString("base64"),
        isBase64Encoded: true,
      }),
      config,
    );
    expect(res.statusCode).toBe(201);
    expect(Buffer.from(res.body, "base64")).toEqual(Buffer.from([0, 255, 1]));
    expect(Buffer.from((fetchMock.mock.calls[0]![1] as RequestInit).body as Uint8Array).toString()).toBe('{"a":"é"}');
  });
});
