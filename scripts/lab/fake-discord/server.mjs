#!/usr/bin/env node
// The fake Discord of akldb's proving ground (design/aws-port.md §5.1; lane P). Plain Node, loopback only, no
// dependency: `node scripts/lab/fake-discord/server.mjs --port 18402 [--log <file.ndjson>] [--seed lab]`.
// Serves, under /api (the value akldb's DISCORD_API_URL takes in a lab: http://127.0.0.1:<port>/api):
//   GET  /oauth2/@me                              the bearer check (tokens `lab-<id>`, or the token table)
//   GET  /users/<id>                              bot user lookup
//   POST /users/@me/channels                      DM channel create
//   GET  /v10/channels/<c>/messages[/<m>]         read one message, or list
//   POST /v10/channels/<c>/messages               create (JSON or multipart; `nonce` + `enforce_nonce` dedupes)
//   PATCH|DELETE /v10/channels/<c>/messages/<m>
//   POST /v10/interactions/<id>/<token>/callback  interaction callback
//   POST /v10/webhooks/<app|id>/<token>           followup / incoming webhook (?wait=true returns the message)
//   GET|PATCH|DELETE /v10/webhooks/<app|id>/<token>/messages/<@original|m>
// Control routes (never recorded, never faulted), under /__fake/:
//   GET  /__fake/log            the NDJSON record     POST /__fake/reset        clear messages, log, faults, revocations
//   POST /__fake/inject         {status, retryAfter?, method?, path?, count?, after?}   DELETE /__fake/inject clears
//   POST /__fake/tokens         {token, user:{id,username}, application_id?}            POST /__fake/revoke {token}
//   GET  /__fake/signer         {application_id, public_key}   POST /__fake/sign {body, timestamp?} -> signed headers
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import process from "node:process";
import url from "node:url";

const PKCS8_ED25519_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

function snowflakeOf(text) {
  const n = crypto.createHash("sha256").update(text).digest().readBigUInt64BE(0);
  return String(100000000000000000n + (n % 900000000000000000n));
}

/** The lab application's Ed25519 key, derived from `seed`, so a restart keeps the same public key. */
export function deriveKeys(seed) {
  const raw = crypto.createHash("sha256").update(`akldb-lab-discord-key:${seed}`).digest();
  const privateKey = crypto.createPrivateKey({ key: Buffer.concat([PKCS8_ED25519_PREFIX, raw]), format: "der", type: "pkcs8" });
  const publicRaw = Buffer.from(crypto.createPublicKey(privateKey).export({ format: "jwk" }).x, "base64url");
  return { privateKey, publicKeyHex: publicRaw.toString("hex") };
}

function json(res, status, body, headers = {}) {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text), ...headers });
  res.end(text);
}
function empty(res, status) {
  res.writeHead(status, { "content-length": 0 });
  res.end();
}
const unauthorized = (res) => json(res, 401, { message: "401: Unauthorized", code: 0 });
const notFound = (res, code = 10003) => json(res, 404, { message: "Unknown", code });

/**
 * @param {{port?: number, seed?: string, logFile?: string, applicationId?: string, now?: () => string}} [opts]
 */
export async function startFakeDiscord(opts = {}) {
  const seed = opts.seed ?? "lab";
  const keys = deriveKeys(seed);
  const applicationId = opts.applicationId ?? snowflakeOf(`application:${seed}`);
  const now = opts.now ?? (() => new Date().toISOString());
  let log = [];
  let seq = 0;
  let nextId = 1100000000000000000n;
  let messages = new Map(); // `${channel}/${id}` -> message
  let webhookMessages = new Map(); // `${webhook}/${token}/${id}` -> message ("@original" aliases the first)
  let nonces = new Map(); // `${channel}/${nonce}` -> message
  let dmChannels = new Map();
  let tokens = new Map(); // token -> {user, application_id}
  let revoked = new Set();
  let faults = [];
  const newId = () => String(nextId++);

  const record = (entry) => {
    const line = { seq: ++seq, at: now(), ...entry };
    log.push(line);
    if (opts.logFile !== undefined) fs.appendFileSync(opts.logFile, JSON.stringify(line) + "\n");
  };

  function identity(token) {
    if (revoked.has(token)) return null;
    const known = tokens.get(token);
    if (known !== undefined) return known;
    const m = /^lab-(.+)$/.exec(token);
    if (m === null) return null;
    const id = /^\d{17,20}$/.test(m[1]) ? m[1] : snowflakeOf(`user:${m[1]}`);
    return { user: { id, username: `lab-user-${m[1]}` }, application_id: applicationId };
  }

  async function readBody(req) {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    return Buffer.concat(chunks);
  }

  function parseBody(buf, contentType) {
    if (buf.length === 0) return { value: null, json: null };
    const text = buf.toString("utf8");
    if (/^application\/json/i.test(contentType)) {
      try {
        const v = JSON.parse(text);
        return { value: v, json: v };
      } catch {
        return { value: text, json: null };
      }
    }
    if (/^multipart\/form-data/i.test(contentType)) {
      const boundary = /boundary=([^;]+)/i.exec(contentType)?.[1];
      const parts = [];
      let payload = null;
      for (const raw of boundary === undefined ? [] : text.split(`--${boundary}`)) {
        const head = /content-disposition:\s*form-data;\s*name="([^"]*)"(?:;\s*filename="([^"]*)")?/i.exec(raw);
        if (head === null) continue;
        const body = raw.slice(raw.indexOf("\r\n\r\n") + 4).replace(/\r\n$/, "");
        if (head[1] === "payload_json") {
          try {
            payload = JSON.parse(body);
          } catch {}
        } else parts.push({ name: head[1], filename: head[2] ?? null, size: Buffer.byteLength(body), content: head[2] === undefined ? body : body.slice(0, 2000) });
      }
      return { value: { payload_json: payload, files: parts }, json: payload };
    }
    return { value: text, json: null };
  }

  function fault(method, path) {
    for (const f of faults) {
      if (f.method !== undefined && f.method !== method) continue;
      if (f.path !== undefined && !f.path.test(path)) continue;
      if (f.after > 0) {
        f.after--;
        continue;
      }
      if (f.count === 0) continue;
      if (f.count > 0) f.count--;
      return f;
    }
    return null;
  }

  function messageBody(json, channelId, authorId, extra = {}) {
    const b = json ?? {};
    return {
      id: newId(),
      channel_id: channelId,
      type: 0,
      content: "",
      timestamp: now(),
      edited_timestamp: null,
      author: { id: authorId, username: "akldb", bot: true },
      attachments: [],
      embeds: [],
      mentions: [],
      pinned: false,
      tts: false,
      flags: 0,
      ...b,
      ...extra,
    };
  }

  async function control(req, res, pathname) {
    const body = parseBody(await readBody(req), req.headers["content-type"] ?? "").json;
    if (pathname === "/__fake/log" && req.method === "GET") {
      res.writeHead(200, { "content-type": "application/x-ndjson" });
      return res.end(log.map((l) => JSON.stringify(l) + "\n").join(""));
    }
    if (pathname === "/__fake/reset") {
      log = [];
      seq = 0;
      nextId = 1100000000000000000n;
      messages = new Map();
      webhookMessages = new Map();
      nonces = new Map();
      dmChannels = new Map();
      tokens = new Map();
      revoked = new Set();
      faults = [];
      if (opts.logFile !== undefined) fs.writeFileSync(opts.logFile, "");
      return json(res, 200, { ok: true });
    }
    if (pathname === "/__fake/inject") {
      if (req.method === "DELETE") {
        faults = [];
        return json(res, 200, { ok: true });
      }
      if (!Number.isInteger(body?.status) || (body.status !== 429 && (body.status < 500 || body.status > 599))) return json(res, 400, { error: "status must be 429 or 5xx" });
      faults.push({
        status: body.status,
        retryAfter: body.retryAfter ?? (body.status === 429 ? 1 : undefined),
        method: body.method?.toUpperCase(),
        path: body.path === undefined ? undefined : new RegExp(body.path),
        count: body.count ?? 1, // -1 = until cleared
        after: body.after ?? 0,
      });
      return json(res, 200, { ok: true, armed: faults.length });
    }
    if (pathname === "/__fake/tokens" && req.method === "POST") {
      if (typeof body?.token !== "string" || typeof body?.user?.id !== "string" || typeof body?.user?.username !== "string") return json(res, 400, { error: "token, user.id, user.username" });
      revoked.delete(body.token);
      tokens.set(body.token, { user: { id: body.user.id, username: body.user.username }, application_id: body.application_id ?? applicationId });
      return json(res, 200, { ok: true });
    }
    if (pathname === "/__fake/revoke" && req.method === "POST") {
      revoked.add(String(body?.token));
      return json(res, 200, { ok: true });
    }
    if (pathname === "/__fake/signer" && req.method === "GET") return json(res, 200, { application_id: applicationId, public_key: keys.publicKeyHex });
    if (pathname === "/__fake/sign" && req.method === "POST") {
      const text = typeof body?.body === "string" ? body.body : JSON.stringify(body?.body);
      return json(res, 200, signInteraction(text, body?.timestamp));
    }
    return notFound(res);
  }

  function signInteraction(bodyText, timestamp = String(Math.floor(Date.now() / 1000))) {
    const ts = String(timestamp);
    const signature = crypto.sign(null, Buffer.from(ts + bodyText), keys.privateKey).toString("hex");
    return { body: bodyText, headers: { "X-Signature-Ed25519": signature, "X-Signature-Timestamp": ts, "Content-Type": "application/json" } };
  }

  async function handle(req, res) {
    const u = new URL(req.url, "http://127.0.0.1");
    if (u.pathname.startsWith("/__fake/")) return control(req, res, u.pathname);
    const raw = await readBody(req);
    const contentType = req.headers["content-type"] ?? "";
    const parsed = parseBody(raw, contentType);
    const auth = req.headers.authorization ?? "";
    const authKind = /^Bearer /i.test(auth) ? "bearer" : /^Bot /i.test(auth) ? "bot" : null;
    const headers = Object.fromEntries(Object.entries(req.headers).filter(([k]) => !["authorization", "cookie", "host", "connection", "content-length", "accept-encoding"].includes(k)));
    let status = 0;
    let injected = false;
    const done = (code) => {
      status = code;
    };
    const wrap = { writeHead: res.writeHead.bind(res), end: res.end.bind(res) };
    res.writeHead = (code, ...rest) => {
      done(code);
      return wrap.writeHead(code, ...rest);
    };
    res.end = (...a) => {
      record({ method: req.method, path: u.pathname + u.search, authKind, headers, body: parsed.value, status, ...(injected ? { injected: true } : {}) });
      return wrap.end(...a);
    };

    const f = fault(req.method, u.pathname);
    if (f !== null) {
      injected = true;
      return json(res, f.status, f.status === 429 ? { message: "You are being rate limited.", retry_after: f.retryAfter, global: false } : { message: "injected" }, f.retryAfter === undefined ? {} : { "retry-after": String(f.retryAfter) });
    }
    if (!u.pathname.startsWith("/api/")) return notFound(res, 0);
    const p = u.pathname.slice("/api".length).replace(/^\/v\d+(?=\/)/, "");
    let m;

    if (req.method === "GET" && p === "/oauth2/@me") {
      const token = /^Bearer\s+(.+)$/i.exec(auth)?.[1];
      const who = token === undefined ? null : identity(token);
      if (who === null) return unauthorized(res);
      return json(res, 200, { application: { id: who.application_id }, user: who.user, scopes: ["identify"], expires: "2099-01-01T00:00:00.000000+00:00" });
    }

    // bot routes: any `Bot <token>`
    if (authKind === "bot" || /^\/(?:channels|users)\//.test(p)) {
      if (authKind !== "bot") return unauthorized(res);
      if (req.method === "POST" && p === "/users/@me/channels") {
        const recipient = parsed.json?.recipient_id;
        if (typeof recipient !== "string" || !/^\d{17,20}$/.test(recipient)) return json(res, 400, { message: "Invalid Form Body", code: 50035 });
        if (!dmChannels.has(recipient)) dmChannels.set(recipient, snowflakeOf(`dm:${recipient}`));
        return json(res, 200, { id: dmChannels.get(recipient), type: 1, recipients: [{ id: recipient }] });
      }
      if (req.method === "GET" && (m = /^\/users\/(\d{17,20})$/.exec(p))) return json(res, 200, { id: m[1], username: `lab-user-${m[1]}`, global_name: null, discriminator: "0" });
      if ((m = /^\/channels\/([^/]+)\/messages(?:\/([^/]+))?$/.exec(p))) {
        const [, channel, id] = m;
        if (id === undefined && req.method === "GET") {
          const limit = Math.min(100, Number(u.searchParams.get("limit") ?? 50));
          return json(res, 200, [...messages.values()].filter((x) => x.channel_id === channel).reverse().slice(0, limit));
        }
        if (id === undefined && req.method === "POST") {
          const j = parsed.json ?? {};
          const nonceKey = typeof j.nonce === "string" || typeof j.nonce === "number" ? `${channel}/${j.nonce}` : null;
          if (nonceKey !== null && j.enforce_nonce === true && nonces.has(nonceKey)) return json(res, 200, nonces.get(nonceKey));
          const { nonce: _n, enforce_nonce: _e, ...rest } = j;
          const msg = messageBody(rest, channel, applicationId);
          messages.set(`${channel}/${msg.id}`, msg);
          if (nonceKey !== null) nonces.set(nonceKey, msg);
          return json(res, 200, msg);
        }
        const msg = messages.get(`${channel}/${id}`);
        if (msg === undefined) return notFound(res, 10008);
        if (req.method === "GET") return json(res, 200, msg);
        if (req.method === "PATCH") {
          const next = { ...msg, ...(parsed.json ?? {}), id: msg.id, channel_id: msg.channel_id, edited_timestamp: now() };
          messages.set(`${channel}/${id}`, next);
          return json(res, 200, next);
        }
        if (req.method === "DELETE") {
          messages.delete(`${channel}/${id}`);
          return empty(res, 204);
        }
      }
      return notFound(res);
    }

    // no auth: interaction callbacks and webhooks (the token in the path is the credential)
    if (req.method === "POST" && (m = /^\/interactions\/(\d+)\/([^/]+)\/callback$/.exec(p))) return empty(res, 204);
    if ((m = /^\/webhooks\/([^/]+)\/([^/]+)(?:\/messages\/([^/]+))?$/.exec(p))) {
      const [, hook, token, id] = m;
      const prefix = `${hook}/${token}/`;
      if (id === undefined && req.method === "POST") {
        const msg = messageBody(parsed.json ?? {}, snowflakeOf(`webhook-channel:${hook}`), hook, { webhook_id: hook });
        webhookMessages.set(prefix + msg.id, msg);
        if (!webhookMessages.has(prefix + "@original")) webhookMessages.set(prefix + "@original", msg);
        return u.searchParams.get("wait") === "true" ? json(res, 200, msg) : empty(res, 204);
      }
      if (id !== undefined) {
        const msg = webhookMessages.get(prefix + id);
        if (msg === undefined) return notFound(res, 10015);
        if (req.method === "GET") return json(res, 200, msg);
        if (req.method === "PATCH") {
          const next = { ...msg, ...(parsed.json ?? {}), id: msg.id, edited_timestamp: now() };
          webhookMessages.set(prefix + id, next);
          if (id !== msg.id) webhookMessages.set(prefix + msg.id, next);
          return json(res, 200, next);
        }
        if (req.method === "DELETE") {
          webhookMessages.delete(prefix + id);
          webhookMessages.delete(prefix + msg.id);
          return empty(res, 204);
        }
      }
    }
    return notFound(res, 0);
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((e) => {
      if (!res.headersSent) json(res, 500, { message: String(e) });
      else res.end();
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port ?? 0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  return {
    port,
    url: `http://127.0.0.1:${port}`,
    /** What akldb's DISCORD_API_URL is set to. */
    base: `http://127.0.0.1:${port}/api`,
    applicationId,
    publicKeyHex: keys.publicKeyHex,
    /** Sign an interaction body the way Discord does: Ed25519 over timestamp + body. */
    sign: signInteraction,
    log: () => log.slice(),
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

const IS_MAIN = process.argv[1] !== undefined && url.pathToFileURL(process.argv[1]).href === import.meta.url;
if (IS_MAIN) {
  const a = { port: 18402, seed: "lab", log: undefined };
  for (let i = 2; i < process.argv.length; i++) {
    const k = process.argv[i];
    if (k === "--port") a.port = Number(process.argv[++i]);
    else if (k === "--seed") a.seed = process.argv[++i];
    else if (k === "--log") a.log = process.argv[++i];
    else throw new Error(`unknown argument ${k}`);
  }
  const fake = await startFakeDiscord({ port: a.port, seed: a.seed, logFile: a.log });
  console.log(`[fake-discord] ${fake.base} application ${fake.applicationId} public key ${fake.publicKeyHex}`);
  const stop = async () => {
    await fake.close();
    process.exit(0);
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}
