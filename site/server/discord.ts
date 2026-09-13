// Discord OAuth (design/akldb-site/01-plan.md §3): GET /auth/login, GET
// /auth/callback, POST /auth/logout, GET /auth/me. Mirrors the shape of
// functions/auth/discord/login.js + callback.js (state cookie, redirect_uri
// from the request's own origin, identify scope) -- reused as an idea, not
// as code: this site keeps no refresh token and no D1, and the DB itself
// (not this Worker) is what turns the Discord bearer into a user id/name
// (GET /v1/me, db/docs/adoption.md §1.2), so there's no separate call to
// Discord's own /users/@me here.
//
// Degrades cleanly when DISCORD_CLIENT_ID/_SECRET aren't set yet (§7: saltorbit
// hasn't created the Discord application) -- /auth/login and /auth/callback
// 404 exactly like login.js's own guard, and /auth/me answers
// `{user:null, signin:false}` so the UI can hide the sign-in button
// entirely rather than show a button that 404s.
import { Hono } from "hono";
import type { Env } from "./env.ts";
import {
  MAX_SESSION_SECONDS,
  OAUTH_STATE_COOKIE,
  SESSION_COOKIE,
  clearOauthStateCookieHeader,
  clearSessionCookieHeader,
  oauthStateCookieHeader,
  openSession,
  parseCookies,
  sealSession,
  sessionCookieHeader,
} from "./session.ts";

interface MeResponse {
  user_id: string;
  name: string;
  via: string;
  admin: boolean;
  banned?: boolean;
}

function html(body: string, status = 200, extraHeaders: Record<string, string> = {}): Response {
  return new Response(body, { status, headers: { "Content-Type": "text/html; charset=utf-8", ...extraHeaders } });
}

function failurePage(reason: string): Response {
  return html(
    `<!doctype html><meta charset="utf-8"><title>Sign-in failed</title>
<body style="font:14px/1.5 -apple-system,sans-serif;max-width:520px;margin:48px auto;padding:0 16px">
<h1>Sign-in failed</h1><p>${reason}</p><p><a href="/">Back to akldb</a> · <a href="/auth/login">try again</a></p>`,
    400,
    { "Set-Cookie": clearOauthStateCookieHeader() },
  );
}

export const discordRoutes = new Hono<{ Bindings: Env }>();

discordRoutes.get("/auth/login", (c) => {
  const { env, req } = c;
  if (!env.DISCORD_CLIENT_ID) return c.text("not found", 404);
  const origin = new URL(req.url).origin;
  const state = crypto.randomUUID();
  const authorize = new URL("https://discord.com/oauth2/authorize");
  authorize.searchParams.set("client_id", env.DISCORD_CLIENT_ID);
  authorize.searchParams.set("response_type", "code");
  authorize.searchParams.set("redirect_uri", `${origin}/auth/callback`);
  authorize.searchParams.set("scope", "identify");
  authorize.searchParams.set("state", state);
  return new Response(null, {
    status: 302,
    headers: { Location: authorize.toString(), "Set-Cookie": oauthStateCookieHeader(state) },
  });
});

discordRoutes.get("/auth/callback", async (c) => {
  const { env, req } = c;
  if (!env.DISCORD_CLIENT_ID || !env.DISCORD_CLIENT_SECRET) return c.text("not found", 404);
  if (!env.SESSION_SECRET) return failurePage("Sign-in is not fully configured yet.");

  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (url.searchParams.get("error") === "access_denied") {
    return new Response(null, { status: 302, headers: { Location: "/", "Set-Cookie": clearOauthStateCookieHeader() } });
  }
  if (!code) return failurePage("Discord sent no authorization code.");

  const cookies = parseCookies(req.header("Cookie"));
  const expected = cookies[OAUTH_STATE_COOKIE];
  if (!state || !expected || state !== expected) {
    return failurePage("State mismatch -- the sign-in flow was started elsewhere or expired.");
  }

  let tokenRes: Response;
  try {
    tokenRes = await fetch("https://discord.com/api/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: env.DISCORD_CLIENT_ID,
        client_secret: env.DISCORD_CLIENT_SECRET,
        grant_type: "authorization_code",
        code,
        redirect_uri: `${url.origin}/auth/callback`,
      }),
    });
  } catch {
    return failurePage("Could not reach Discord.");
  }
  if (!tokenRes.ok) return failurePage("Discord rejected the sign-in code.");
  const token = (await tokenRes.json().catch(() => null)) as { access_token?: string; expires_in?: number } | null;
  if (!token?.access_token) return failurePage("Discord returned no access token.");

  // The DB validates the bearer AND tells us who it belongs to (adoption.md
  // §1.2) -- one call does both jobs, no separate Discord identify call.
  let me: MeResponse | null = null;
  try {
    const meRes = await fetch(`${env.DB_BASE_URL}/v1/me`, {
      headers: { Authorization: `Bearer ${token.access_token}` },
    });
    if (meRes.ok) me = (await meRes.json()) as MeResponse;
  } catch {
    // fall through to the failure page below
  }
  if (!me) return failurePage("Could not verify the sign-in with the layout database.");

  const ttlSeconds = Math.min(token.expires_in ?? MAX_SESSION_SECONDS, MAX_SESSION_SECONDS);
  const session = await sealSession(
    {
      access_token: token.access_token,
      expires_at: Date.now() + ttlSeconds * 1000,
      user_id: me.user_id,
      name: me.name,
    },
    env.SESSION_SECRET,
  );

  return new Response(null, {
    status: 302,
    headers: [
      ["Location", "/"],
      ["Set-Cookie", sessionCookieHeader(session, ttlSeconds)],
      ["Set-Cookie", clearOauthStateCookieHeader()],
    ],
  });
});

discordRoutes.post("/auth/logout", (c) => {
  return c.json({ ok: true }, 200, { "Set-Cookie": clearSessionCookieHeader() });
});

discordRoutes.get("/auth/me", async (c) => {
  const { env, req } = c;
  if (!env.DISCORD_CLIENT_ID) return c.json({ user: null, signin: false });

  const cookies = parseCookies(req.header("Cookie"));
  const token = cookies[SESSION_COOKIE];
  const session = env.SESSION_SECRET ? await openSession(token, env.SESSION_SECRET) : null;
  if (!session) return c.json({ user: null, signin: true });

  // Always proxy fresh -- admin/banned can change any time and the cookie
  // never carries them (S2, §3: "GET /auth/me proxies GET /v1/me with the
  // bearer -- fresh, never from the cookie").
  try {
    const meRes = await fetch(`${env.DB_BASE_URL}/v1/me`, {
      headers: { Authorization: `Bearer ${session.access_token}` },
    });
    if (meRes.status === 401) {
      return c.json({ user: null, signin: true }, 200, { "Set-Cookie": clearSessionCookieHeader() });
    }
    if (!meRes.ok) return c.json({ user: null, signin: true });
    const me = (await meRes.json()) as MeResponse;
    return c.json({ user: me, signin: true });
  } catch {
    return c.json({ user: null, signin: true });
  }
});
