// The in-process fake Discord of the shadow stage (LDB-PV1; ported from lane P's loopback server,
// scripts/lab/fake-discord/server.mjs on aws-port-rebase-1029). Shadow's DISCORD_API_URL names a host nobody can resolve
// (FAKE_DISCORD_ORIGIN); the egress guard (shadow-egress.ts) answers every request to that host with `handle()`, in this
// process, so nothing leaves the Lambda. It answers like Discord for the calls akldb makes (the bearer check, user and DM
// channel lookups, message create/edit/delete, interaction callbacks, webhooks) and records every call (the credential is
// never recorded, only its kind) in a bounded ring, so a human or a test can see what shadow would have sent.
import { createHash } from "node:crypto";

/** The host shadow's DISCORD_API_URL uses. `.invalid` never resolves (RFC 2606), so a leak of the URL cannot reach anything. */
export const FAKE_DISCORD_HOST = "fake-discord.akldb.invalid";
/** What shadow's DISCORD_API_URL is (infra/stages/shadow.json). */
export const FAKE_DISCORD_BASE = `http://${FAKE_DISCORD_HOST}/api`;

export interface FakeDiscordCall {
  seq: number;
  at: string;
  method: string;
  path: string;
  /** What kind of credential the call carried; the credential itself is never kept. */
  authKind: "bearer" | "bot" | null;
  headers: Record<string, string>;
  body: unknown;
  status: number;
}

export interface FakeDiscordOptions {
  now?: () => string;
  /** Ring size: the oldest call is dropped past it. */
  maxCalls?: number;
}

export interface FakeDiscord {
  /** Answer one request the way Discord would. Never throws, never touches the network. */
  handle(request: Request): Promise<Response>;
  /** The recorded calls, oldest first. */
  calls(): FakeDiscordCall[];
  /** How many calls were ever made (the ring may hold fewer). */
  total(): number;
  reset(): void;
}

const snowflake = (text: string): string => String(100000000000000000n + (createHash("sha256").update(text).digest().readBigUInt64BE(0) % 900000000000000000n));

const DROPPED_HEADERS = new Set(["authorization", "cookie", "host", "connection", "content-length", "accept-encoding"]);

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}
const empty = (status: number): Response => new Response(null, { status });
const notFound = (code = 10003): Response => json(404, { message: "Unknown", code });

export function createFakeDiscord(opts: FakeDiscordOptions = {}): FakeDiscord {
  const now = opts.now ?? (() => new Date().toISOString());
  const maxCalls = opts.maxCalls ?? 1000;
  const applicationId = snowflake("application:shadow");
  let ring: FakeDiscordCall[] = [];
  let seq = 0;
  let nextId = 1100000000000000000n;
  let messages = new Map<string, Record<string, unknown>>();
  let webhookMessages = new Map<string, Record<string, unknown>>();
  let nonces = new Map<string, Record<string, unknown>>();
  let dmChannels = new Map<string, string>();
  const newId = (): string => String(nextId++);

  function messageBody(j: Record<string, unknown> | null, channelId: string, authorId: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      id: newId(), channel_id: channelId, type: 0, content: "", timestamp: now(), edited_timestamp: null,
      author: { id: authorId, username: "akldb", bot: true },
      attachments: [], embeds: [], mentions: [], pinned: false, tts: false, flags: 0,
      ...(j ?? {}), ...extra,
    };
  }

  async function parseBody(request: Request): Promise<{ value: unknown; json: Record<string, unknown> | null }> {
    const type = request.headers.get("content-type") ?? "";
    const text = await request.text();
    if (text === "") return { value: null, json: null };
    if (/^application\/json/i.test(type)) {
      try {
        const v = JSON.parse(text) as unknown;
        return { value: v, json: v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null };
      } catch {
        return { value: text, json: null };
      }
    }
    // multipart and anything else: keep the text (bounded); the payload_json part is what akldb's calls carry
    if (/^multipart\/form-data/i.test(type)) {
      const m = /name="payload_json"[^\r\n]*\r\n(?:[^\r\n]+\r\n)*\r\n([\s\S]*?)\r\n--/i.exec(text);
      if (m?.[1] !== undefined) {
        try {
          const v = JSON.parse(m[1]) as Record<string, unknown>;
          return { value: { payload_json: v }, json: v };
        } catch {
          /* fall through */
        }
      }
    }
    return { value: text.slice(0, 2000), json: null };
  }

  async function answer(request: Request, url: URL, parsed: { json: Record<string, unknown> | null }, authKind: "bearer" | "bot" | null): Promise<Response> {
    if (!url.pathname.startsWith("/api/")) return notFound(0);
    const p = url.pathname.slice("/api".length).replace(/^\/v\d+(?=\/)/, "");
    const method = request.method;
    let m: RegExpExecArray | null;

    if (method === "GET" && p === "/oauth2/@me") {
      const token = /^Bearer\s+(.+)$/i.exec(request.headers.get("authorization") ?? "")?.[1];
      const lab = token === undefined ? null : /^lab-(.+)$/.exec(token);
      if (lab === null || lab[1] === undefined) return json(401, { message: "401: Unauthorized", code: 0 });
      const id = /^\d{17,20}$/.test(lab[1]) ? lab[1] : snowflake(`user:${lab[1]}`);
      return json(200, { application: { id: applicationId }, user: { id, username: `lab-user-${lab[1]}` }, scopes: ["identify"], expires: "2099-01-01T00:00:00.000000+00:00" });
    }

    if (authKind === "bot" || /^\/(?:channels|users)\//.test(p)) {
      if (authKind !== "bot") return json(401, { message: "401: Unauthorized", code: 0 });
      if (method === "POST" && p === "/users/@me/channels") {
        const recipient = parsed.json?.recipient_id;
        if (typeof recipient !== "string" || !/^\d{17,20}$/.test(recipient)) return json(400, { message: "Invalid Form Body", code: 50035 });
        if (!dmChannels.has(recipient)) dmChannels.set(recipient, snowflake(`dm:${recipient}`));
        return json(200, { id: dmChannels.get(recipient), type: 1, recipients: [{ id: recipient }] });
      }
      if (method === "GET" && (m = /^\/users\/(\d{17,20})$/.exec(p))) return json(200, { id: m[1], username: `lab-user-${m[1]}`, global_name: null, discriminator: "0" });
      if ((m = /^\/channels\/([^/]+)\/messages(?:\/([^/]+))?$/.exec(p))) {
        const channel = m[1]!;
        const id = m[2];
        if (id === undefined && method === "GET") {
          const limit = Math.min(100, Number(url.searchParams.get("limit") ?? 50));
          return json(200, [...messages.values()].filter((x) => x.channel_id === channel).reverse().slice(0, limit));
        }
        if (id === undefined && method === "POST") {
          const j = parsed.json ?? {};
          const nonceKey = typeof j.nonce === "string" || typeof j.nonce === "number" ? `${channel}/${String(j.nonce)}` : null;
          if (nonceKey !== null && j.enforce_nonce === true && nonces.has(nonceKey)) return json(200, nonces.get(nonceKey));
          const { nonce: _n, enforce_nonce: _e, ...rest } = j;
          const msg = messageBody(rest, channel, applicationId);
          messages.set(`${channel}/${String(msg.id)}`, msg);
          if (nonceKey !== null) nonces.set(nonceKey, msg);
          return json(200, msg);
        }
        const msg = messages.get(`${channel}/${id}`);
        if (msg === undefined) return notFound(10008);
        if (method === "GET") return json(200, msg);
        if (method === "PATCH") {
          const next = { ...msg, ...(parsed.json ?? {}), id: msg.id, channel_id: msg.channel_id, edited_timestamp: now() };
          messages.set(`${channel}/${id}`, next);
          return json(200, next);
        }
        if (method === "DELETE") {
          messages.delete(`${channel}/${id}`);
          return empty(204);
        }
      }
      return notFound();
    }

    // no credential: interaction callbacks and webhooks (the token in the path is the credential)
    if (method === "POST" && /^\/interactions\/(\d+)\/([^/]+)\/callback$/.test(p)) return empty(204);
    if ((m = /^\/webhooks\/([^/]+)\/([^/]+)(?:\/messages\/([^/]+))?$/.exec(p))) {
      const hook = m[1]!;
      const token = m[2]!;
      const id = m[3];
      const prefix = `${hook}/${token}/`;
      if (id === undefined && method === "POST") {
        const msg = messageBody(parsed.json, snowflake(`webhook-channel:${hook}`), hook, { webhook_id: hook });
        webhookMessages.set(prefix + String(msg.id), msg);
        if (!webhookMessages.has(`${prefix}@original`)) webhookMessages.set(`${prefix}@original`, msg);
        return url.searchParams.get("wait") === "true" ? json(200, msg) : empty(204);
      }
      if (id !== undefined) {
        const msg = webhookMessages.get(prefix + id);
        if (msg === undefined) return notFound(10015);
        if (method === "GET") return json(200, msg);
        if (method === "PATCH") {
          const next = { ...msg, ...(parsed.json ?? {}), id: msg.id, edited_timestamp: now() };
          webhookMessages.set(prefix + id, next);
          if (id !== msg.id) webhookMessages.set(prefix + String(msg.id), next);
          return json(200, next);
        }
        if (method === "DELETE") {
          webhookMessages.delete(prefix + id);
          webhookMessages.delete(prefix + String(msg.id));
          return empty(204);
        }
      }
    }
    return notFound(0);
  }

  return {
    async handle(request) {
      let response: Response;
      let parsed: { value: unknown; json: Record<string, unknown> | null } = { value: null, json: null };
      const auth = request.headers.get("authorization") ?? "";
      const authKind = /^Bearer /i.test(auth) ? "bearer" : /^Bot /i.test(auth) ? "bot" : null;
      const url = new URL(request.url);
      try {
        parsed = await parseBody(request.clone());
        response = await answer(request, url, parsed, authKind);
      } catch (e) {
        response = json(500, { message: `fake discord: ${e instanceof Error ? e.message : String(e)}` });
      }
      const headers: Record<string, string> = {};
      request.headers.forEach((v, k) => {
        if (!DROPPED_HEADERS.has(k)) headers[k] = v;
      });
      ring.push({ seq: ++seq, at: now(), method: request.method, path: url.pathname + url.search, authKind, headers, body: parsed.value, status: response.status });
      if (ring.length > maxCalls) ring = ring.slice(ring.length - maxCalls);
      return response;
    },
    calls: () => ring.slice(),
    total: () => seq,
    reset() {
      ring = [];
      seq = 0;
      nextId = 1100000000000000000n;
      messages = new Map();
      webhookMessages = new Map();
      nonces = new Map();
      dmChannels = new Map();
    },
  };
}
