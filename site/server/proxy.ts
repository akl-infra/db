// The proxy: ANY /api/v1/* -> `${DB_BASE_URL}/v1/*` (design/akldb-site/
// 01-plan.md §3). The browser never talks to akl-db directly (S3) -- this
// is the one place that attaches a bearer token, and the one place that has
// to get header hygiene right so a browser can never smuggle a client-lane
// header (`X-Akl-*`) or read a `Set-Cookie`/`WWW-Authenticate` meant for a
// server, never a tab.
import type { Context } from "hono";
import { Hono } from "hono";
import type { Env } from "./env.ts";
import { CLIENT_VERSION_HEADER } from "./env.ts";
import { SESSION_COOKIE, clearSessionCookieHeader, openSession, parseCookies } from "./session.ts";

export const UPSTREAM_TIMEOUT_MS = 10_000;
export const MAX_BODY_BYTES = 4 * 1024 * 1024;

// Request headers a browser may send through -- everything else (Cookie,
// every X-Akl-*, every X-Forwarded-*, ...) is dropped on the floor.
const FORWARD_REQUEST_HEADERS = ["content-type", "if-match", "if-none-match", "idempotency-key", "accept"];

// Response headers the browser may see back -- WWW-Authenticate and
// Set-Cookie are never in this list (allowlist, not a copy-everything-but).
const FORWARD_RESPONSE_HEADERS = ["content-type", "etag", "cache-control", "retry-after", "x-wait-ignored"];

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

function json(obj: unknown, status: number, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", ...headers } });
}

// Exported: `/auth/logout` (discord.ts) applies the same gate -- a cross-site
// form POST must not be able to log a user out.
export function csrfOk(req: Request): boolean {
  if (req.headers.get("X-Requested-With") !== "akldb") return false;
  const secFetchSite = req.headers.get("Sec-Fetch-Site");
  // Absent (older browser / non-fetch client) is allowed through -- the
  // custom-header check above is the real guard (a cross-site page can't
  // set arbitrary headers on a simple/no-CORS request); Sec-Fetch-Site is a
  // second, browser-verified signal when present.
  if (secFetchSite && secFetchSite !== "same-origin" && secFetchSite !== "none") return false;
  return true;
}

async function readErrorCode(res: Response): Promise<string | null> {
  try {
    const body = (await res.clone().json()) as { error?: string };
    return body?.error ?? null;
  } catch {
    return null;
  }
}

export const proxyRoutes = new Hono<{ Bindings: Env }>();

proxyRoutes.all("/api/v1/*", async (c: Context<{ Bindings: Env }>) => {
  const { req, env } = c;
  const method = req.method.toUpperCase();
  const url = new URL(req.url);

  // Strip the /api prefix -> the /v1/... path on the DB. Anything that
  // doesn't start with /v1/ never reaches this handler at all (the route
  // pattern itself is /api/v1/*), so SITE-4 is enforced by the router, not
  // by a runtime check here.
  const dbPath = url.pathname.replace(/^\/api/, "");
  const params = new URLSearchParams(url.search);
  params.delete("wait"); // the site never long-polls (§3); the DB would ignore it anyway
  const qs = params.toString();

  if (!SAFE_METHODS.has(method) && !csrfOk(req.raw)) {
    return json({ error: "csrf", message: "missing or invalid CSRF headers" }, 403);
  }

  let body: ArrayBuffer | undefined;
  if (method !== "GET" && method !== "HEAD") {
    const buf = await req.raw.arrayBuffer();
    if (buf.byteLength > MAX_BODY_BYTES) {
      return json({ error: "payload_too_large", message: "request body exceeds the 4 MiB limit" }, 413);
    }
    if (buf.byteLength > 0) body = buf;
  }

  const outHeaders = new Headers();
  for (const name of FORWARD_REQUEST_HEADERS) {
    const v = req.header(name);
    if (v !== undefined) outHeaders.set(name, v);
  }
  outHeaders.set("X-Client-Version", CLIENT_VERSION_HEADER);
  outHeaders.set("User-Agent", CLIENT_VERSION_HEADER);

  const cookies = parseCookies(req.header("Cookie"));
  const sessionToken = cookies[SESSION_COOKIE];
  const session = env.SESSION_SECRET ? await openSession(sessionToken, env.SESSION_SECRET) : null;
  const authenticated = !!session;
  if (session) outHeaders.set("Authorization", `Bearer ${session.access_token}`);

  const upstreamUrl = `${env.DB_BASE_URL}${dbPath}${qs ? `?${qs}` : ""}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
  let upstream: Response;
  try {
    upstream = await fetch(upstreamUrl, {
      method,
      headers: outHeaders,
      body,
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    if (err instanceof Error && err.name === "AbortError") {
      return json({ error: "upstream_timeout", message: "the layout service took too long to respond" }, 504);
    }
    return json({ error: "identity_unavailable", message: "could not reach the layout service" }, 503);
  }
  clearTimeout(timer);

  // A `401 token_invalid` on an AUTHENTICATED request means the sealed
  // access token Discord issued no longer works -- clear the cookie and
  // tell the browser to re-auth. There is no refresh token to retry with
  // (S2); an anonymous 401 (no session at all) just passes through as-is.
  if (authenticated && upstream.status === 401 && (await readErrorCode(upstream)) === "token_invalid") {
    return json(
      { error: "reauth", message: "sign in again" },
      401,
      { "Set-Cookie": clearSessionCookieHeader() },
    );
  }

  const headers = new Headers();
  for (const name of FORWARD_RESPONSE_HEADERS) {
    const v = upstream.headers.get(name);
    if (v !== null) headers.set(name, v);
  }
  if (authenticated) headers.set("Cache-Control", "private, no-store");

  return new Response(upstream.body, { status: upstream.status, headers });
});

export const __test_only = { csrfOk };
