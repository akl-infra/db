// The AWS entry: the same Hono app as the Worker (index.ts), behind a
// CloudFront distribution and a Lambda Function URL (design/aws-port.md §3a).
//
// Three things differ from the Worker, all in this file and none in the app:
//  - Origin verification. The Function URL is `AuthType NONE`; CloudFront adds
//    the `x-origin-verify` header and nothing else may call it (LDB-SITE1).
//  - The origin. CloudFront replaces `Host` with the Function URL's host, so a
//    viewer-request CloudFront Function copies the viewer's host into
//    `x-forwarded-host`; it is the request's host only once the origin secret
//    has been verified, and the app derives `redirect_uri` from that (LDB-SITE2).
//  - Secrets. They live in SSM Parameter Store (not in the Lambda's
//    environment, where a console reader could see them) and are read once per
//    cold start.
import type { Env } from "./env.ts";
import app from "./index.ts";

export interface FunctionUrlEvent {
  rawPath: string;
  rawQueryString?: string;
  cookies?: string[];
  headers?: Record<string, string | undefined>;
  body?: string;
  isBase64Encoded?: boolean;
  requestContext: { http: { method: string } };
}

export interface FunctionUrlResult {
  statusCode: number;
  headers: Record<string, string>;
  cookies?: string[];
  body: string;
  isBase64Encoded: true;
}

export interface LambdaConfig {
  /** The value CloudFront sends as `x-origin-verify`. */
  originVerify: string;
  /** The Worker's bindings: vars and secrets, same names as wrangler.toml. */
  env: Env;
}

export const ORIGIN_VERIFY_HEADER = "x-origin-verify";
export const FORWARDED_HOST_HEADER = "x-forwarded-host";

function timingSafeEqual(a: string, b: string): boolean {
  const ea = new TextEncoder().encode(a);
  const eb = new TextEncoder().encode(b);
  let diff = ea.length ^ eb.length;
  for (let i = 0; i < Math.max(ea.length, eb.length); i++) diff |= (ea[i] ?? 0) ^ (eb[i] ?? 0);
  return diff === 0;
}

function denied(): FunctionUrlResult {
  return {
    statusCode: 403,
    headers: { "content-type": "application/json" },
    body: Buffer.from(JSON.stringify({ error: "forbidden" })).toString("base64"),
    isBase64Encoded: true,
  };
}

export async function handleEvent(event: FunctionUrlEvent, config: LambdaConfig): Promise<FunctionUrlResult> {
  const headers = new Headers();
  for (const [k, v] of Object.entries(event.headers ?? {})) if (v !== undefined) headers.set(k, v);

  // Before anything else: no secret, no service. An empty configured secret
  // never matches (a missing parameter must fail closed).
  const presented = headers.get(ORIGIN_VERIFY_HEADER);
  if (!config.originVerify || presented === null || !timingSafeEqual(presented, config.originVerify)) return denied();
  headers.delete(ORIGIN_VERIFY_HEADER);

  const host = headers.get(FORWARDED_HOST_HEADER);
  if (!host) return denied(); // CloudFront's function always sets it; its absence is a misrouted call
  headers.delete(FORWARDED_HOST_HEADER);
  headers.set("host", host);
  if (event.cookies?.length) headers.set("cookie", event.cookies.join("; "));

  const method = event.requestContext.http.method.toUpperCase();
  const query = event.rawQueryString ? `?${event.rawQueryString}` : "";
  let body: Uint8Array | undefined;
  if (method !== "GET" && method !== "HEAD" && event.body) {
    body = event.isBase64Encoded ? Buffer.from(event.body, "base64") : new TextEncoder().encode(event.body);
  }
  const request = new Request(`https://${host}${event.rawPath}${query}`, { method, headers, body: body as BodyInit | undefined });

  const res = await app.fetch(request, config.env);

  const out: Record<string, string> = {};
  res.headers.forEach((value, name) => {
    if (name !== "set-cookie") out[name] = value;
  });
  const cookies = res.headers.getSetCookie();
  return {
    statusCode: res.status,
    headers: out,
    ...(cookies.length ? { cookies } : {}),
    body: Buffer.from(await res.arrayBuffer()).toString("base64"),
    isBase64Encoded: true,
  };
}

// --- cold-start configuration ------------------------------------------------

// Lambda environment: plain vars, and the SSM parameter *names* of the secrets.
//   DB_BASE_URL, SITE_NAME, DISCORD_AUTHORIZE_URL?, DISCORD_TOKEN_URL?
//   SSM_ORIGIN_VERIFY, SSM_SESSION_SECRET, SSM_DISCORD_CLIENT_ID, SSM_DISCORD_CLIENT_SECRET
async function loadConfig(): Promise<LambdaConfig> {
  const e = process.env;
  const names = {
    originVerify: e.SSM_ORIGIN_VERIFY,
    SESSION_SECRET: e.SSM_SESSION_SECRET,
    DISCORD_CLIENT_ID: e.SSM_DISCORD_CLIENT_ID,
    DISCORD_CLIENT_SECRET: e.SSM_DISCORD_CLIENT_SECRET,
  };
  const wanted = Object.values(names).filter((n): n is string => !!n);
  // The AWS SDK v3 ships in the Node 24 Lambda runtime; it is not bundled.
  const sdk = "@aws-sdk/client-ssm";
  const { SSMClient, GetParametersCommand } = await import(/* @vite-ignore */ sdk);
  const out = await new SSMClient({}).send(new GetParametersCommand({ Names: wanted, WithDecryption: true }));
  const values = new Map<string, string>(out.Parameters?.map((p: { Name: string; Value: string }) => [p.Name, p.Value]));
  const get = (n: string | undefined) => (n ? values.get(n) : undefined);
  const env: Env = {
    DB_BASE_URL: e.DB_BASE_URL ?? "",
    SITE_NAME: e.SITE_NAME ?? "akldb",
    DISCORD_AUTHORIZE_URL: e.DISCORD_AUTHORIZE_URL || undefined,
    DISCORD_TOKEN_URL: e.DISCORD_TOKEN_URL || undefined,
    SESSION_SECRET: get(names.SESSION_SECRET),
    DISCORD_CLIENT_ID: get(names.DISCORD_CLIENT_ID),
    DISCORD_CLIENT_SECRET: get(names.DISCORD_CLIENT_SECRET),
  };
  return { originVerify: get(names.originVerify) ?? "", env };
}

let config: Promise<LambdaConfig> | undefined;

export async function handler(event: FunctionUrlEvent): Promise<FunctionUrlResult> {
  config ??= loadConfig().catch((err) => {
    config = undefined; // a failed cold start is retried, not cached
    throw err;
  });
  return handleEvent(event, await config);
}
