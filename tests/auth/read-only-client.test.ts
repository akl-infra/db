// [LDB-A16] [LDB-A17] The `read-only` extra cap (docs/decisions/31): a client
// carrying it may send only GET and HEAD. A refused request is answered at
// step 4b of `verifyClientRequest` (after the signature, before the nonce) and
// leaves every table unchanged; a read-only GET/HEAD answers exactly like the
// same request from an otherwise identical client without the cap and never
// creates an `authors` row. Black-box over `SELF`, rows through `testStore`.
import { SELF, testStore, type TableName } from "../harness";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { app } from "../../src/index";
import { fixedClock } from "../../src/core/time";
import { bindings } from "../api/support";
import { AKL_PAYLOAD, ensureAuthor, uniqueName } from "../api/write-support";
import { bytesToBase64Url } from "../../src/auth/client";
import { generateKeyPair, seedClient, signHeaders } from "./client-support";

const NOW = fixedClock("2026-10-25T00:00:00.000Z");
const ORIGIN = "https://example.com";

const OWNER = "800000000000004001";
const KNOWN_ACTOR = "800000000000004002";
let actorCounter = 0;
function freshActor(): string {
  actorCounter++;
  return `80000000000001${String(actorCounter).padStart(4, "0")}`;
}

const ALL_TABLES: TableName[] = [
  "layouts", "layout_formats", "layout_revs", "likes", "events", "authors", "authors_head", "layouts_head",
  "admins", "bans", "clients", "nonces", "auth_cache", "ratelimit", "idempotency", "import_state", "import_map",
  "link_submissions", "wpm_submissions", "layout_comments", "comment_likes", "moderation_review_history",
  "modqueue_notifications", "modqueue_delivery_gate", "discord_pending_actions", "discord_reopen_actions",
  "discord_deny_modals", "discord_reopen_confirmations", "discord_rejection_dm_outbox",
];
// What a read-only GET may still write: replay protection, rate-limit windows
// and the auth cache are ephemeral bookkeeping, not part of the dump.
const EPHEMERAL: TableName[] = ["nonces", "ratelimit", "auth_cache"];
const DATA_TABLES = ALL_TABLES.filter((t) => !EPHEMERAL.includes(t));

async function snapshot(tables: TableName[]): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const t of tables) out[t] = await testStore.count(t);
  return out;
}

interface Signer {
  id: string;
  privateKey: CryptoKey;
}

async function makeClient(caps: string): Promise<Signer> {
  const { privateKey, pubkeyB64url } = await generateKeyPair();
  const id = `ro-test-${crypto.randomUUID()}`;
  await seedClient(NOW, { id, pubkeyB64url, ownerUserId: OWNER, caps });
  return { id, privateKey };
}

async function send(
  who: Signer,
  actor: string,
  method: string,
  path: string,
  body?: unknown,
  tweak: (h: Record<string, string>) => Record<string, string> = (h) => h,
): Promise<Response> {
  const bytes = body === undefined ? new Uint8Array(0) : new TextEncoder().encode(JSON.stringify(body));
  const headers = tweak(await signHeaders({ privateKey: who.privateKey, clientId: who.id, actor, method, pathWithQuery: path, body: bytes }));
  return SELF.fetch(`${ORIGIN}${path}`, {
    method,
    headers: body === undefined ? headers : { "Content-Type": "application/json", ...headers },
    body: body === undefined || method === "HEAD" ? undefined : bytes,
  });
}

const READ_ONLY_BODY = (method: string) => ({
  error: "client_read_only",
  message: "this client is read-only: it may send only GET and HEAD requests",
  method,
});

// A concrete path for a Hono route pattern: `:param` (optionally `:param{re}`)
// becomes an id-shaped literal.
function concretePath(pattern: string): string {
  return pattern.replace(/:[A-Za-z_]+(\{[^}]*\})?/g, "123456789");
}

function writeRoutes(): { method: string; path: string }[] {
  const seen = new Set<string>();
  const out: { method: string; path: string }[] = [];
  for (const r of app.routes) {
    if (["GET", "HEAD", "OPTIONS", "ALL"].includes(r.method)) continue;
    if (!r.path.startsWith("/v1/")) continue;
    const key = `${r.method} ${r.path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ method: r.method, path: concretePath(r.path) });
  }
  return out;
}

afterEach(() => {
  delete (bindings as unknown as { TEST_LONGPOLL_SLEEP?: unknown }).TEST_LONGPOLL_SLEEP;
});

describe("[LDB-A16] a read-only client's writes are refused before anything is written", () => {
  let ro: Signer;
  beforeAll(async () => {
    ro = await makeClient("act-as-user,read-only");
  });

  it("[LDB-A16] the sweep covers a non-trivial set of non-GET /v1 routes derived from app.routes", () => {
    const routes = writeRoutes();
    expect(routes.length).toBeGreaterThan(10);
    expect(routes.map((r) => r.method)).toEqual(expect.arrayContaining(["POST", "PUT", "PATCH", "DELETE"]));
    // Everything non-GET outside /v1 is not on the client lane at all.
    const outside = app.routes.filter((r) => !["GET", "HEAD", "OPTIONS", "ALL"].includes(r.method) && !r.path.startsWith("/v1/"));
    expect(outside.map((r) => r.path)).toEqual(expect.arrayContaining(["/discord/interactions"]));
  });

  it("[LDB-A16] every non-GET route in app.routes answers exactly 403 client_read_only, no WWW-Authenticate, and changes no table", async () => {
    const before = await snapshot(ALL_TABLES);
    const failures: string[] = [];
    for (const { method, path } of writeRoutes()) {
      const res = await send(ro, freshActor(), method, path, { probe: true });
      const body = await res.text();
      if (res.status !== 403 || body !== JSON.stringify(READ_ONLY_BODY(method))) failures.push(`${method} ${path} -> ${res.status} ${body}`);
      if (res.headers.get("WWW-Authenticate") !== null) failures.push(`${method} ${path} carried WWW-Authenticate`);
    }
    expect(failures).toEqual([]);
    expect(await snapshot(ALL_TABLES)).toEqual(before);
  });

  it("[LDB-A16] a refusal burns no nonce: the same signed request is refused the same way twice", async () => {
    const actor = freshActor();
    const nonce = crypto.getRandomValues(new Uint8Array(16));
    const path = "/v1/layouts";
    const headers = await signHeaders({ privateKey: ro.privateKey, clientId: ro.id, actor, method: "POST", pathWithQuery: path, nonce });
    const init = { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: new Uint8Array(0) };
    const a = await SELF.fetch(`${ORIGIN}${path}`, init);
    const b = await SELF.fetch(`${ORIGIN}${path}`, init);
    expect([a.status, b.status]).toEqual([403, 403]);
    expect(await b.json()).toEqual(READ_ONLY_BODY("POST"));
    expect(await testStore.count("nonces", { client_id: ro.id, nonce: bytesToBase64Url(nonce) })).toBe(0);
  });

  it("[LDB-A16] act-as-owner-only,read-only: the owner's write is refused, and the cap is checked before the actor scope", async () => {
    const ownerOnly = await makeClient("act-as-owner-only,read-only");
    const own = await send(ownerOnly, OWNER, "POST", "/v1/layouts", { name: uniqueName("ro-own"), format: "spark/1", payload: AKL_PAYLOAD });
    expect(own.status).toBe(403);
    expect(await own.json()).toEqual(READ_ONLY_BODY("POST"));
    const foreign = await send(ownerOnly, freshActor(), "DELETE", "/v1/layouts/123456789");
    expect(foreign.status).toBe(403);
    expect(await foreign.json()).toEqual(READ_ONLY_BODY("DELETE"));
  });

  it("[LDB-A16] step order: only a verified request reaches 4b", async () => {
    const actor = freshActor();
    const path = "/v1/layouts";
    const body = { name: uniqueName("ro-order"), format: "spark/1", payload: AKL_PAYLOAD };

    // A bad signature is a 401, not a probe of the client's caps.
    const forged = await send(ro, actor, "POST", path, body, (h) => ({ ...h, "X-Akl-Signature": bytesToBase64Url(new Uint8Array(64)) }));
    expect(forged.status).toBe(401);
    expect((await forged.json<{ error: string }>()).error).toBe("bad_signature");

    // An unknown client likewise.
    const unknown = await send({ ...ro, id: "ro-test-no-such-client" }, actor, "POST", path, body);
    expect(unknown.status).toBe(401);
    expect((await unknown.json<{ error: string }>()).error).toBe("unknown_client");

    // A stale timestamp.
    const staleSigned = await signHeaders({
      privateKey: ro.privateKey, clientId: ro.id, actor, method: "POST", pathWithQuery: path,
      body: new TextEncoder().encode(JSON.stringify(body)), timestamp: Math.floor(Date.now() / 1000) - 3600,
    });
    const staleRes = await SELF.fetch(`${ORIGIN}${path}`, { method: "POST", headers: { "Content-Type": "application/json", ...staleSigned }, body: JSON.stringify(body) });
    expect(staleRes.status).toBe(401);
    expect((await staleRes.json<{ error: string }>()).error).toBe("stale_timestamp");

    // Revoked and suspended are decided before the cap.
    const revoked = await makeClient("act-as-user,read-only");
    await testStore.patch("clients", { id: revoked.id }, { status: "revoked", revoked_at: NOW() });
    const revokedRes = await send(revoked, actor, "POST", path, body);
    expect(revokedRes.status).toBe(401);
    expect((await revokedRes.json<{ error: string }>()).error).toBe("client_revoked");

    const suspended = await makeClient("act-as-user,read-only");
    await testStore.patch("clients", { id: suspended.id }, { status: "suspended" });
    const suspendedRes = await send(suspended, actor, "POST", path, body);
    expect(suspendedRes.status).toBe(403);
    expect((await suspendedRes.json<{ error: string }>()).error).toBe("client_suspended");
  });
});

// Status, headers and body of two answers, with the two client ids (which
// `via` and `source_client` legitimately carry) normalised, and the headers
// that are per-request by nature left out.
async function shape(res: Response, ids: string[]): Promise<{ status: number; headers: [string, string][]; body: string }> {
  const norm = (s: string) => ids.reduce((acc, id) => acc.split(id).join("<client>"), s);
  const headers = [...res.headers.entries()]
    .filter(([k]) => !["date", "x-request-id", "cf-ray"].includes(k.toLowerCase()))
    .map(([k, v]) => [k, norm(v)] as [string, string])
    .sort(([a], [b]) => a.localeCompare(b));
  return { status: res.status, headers, body: norm(await res.text()) };
}

describe("[LDB-A17] a read-only client's GET and HEAD answer exactly like a client without the cap", () => {
  let ro: Signer;
  let rw: Signer;
  let layoutId: string;
  beforeAll(async () => {
    ro = await makeClient("act-as-user,read-only");
    rw = await makeClient("act-as-user");
    await ensureAuthor(KNOWN_ACTOR, "Known Author", "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");
    const created = await send(rw, KNOWN_ACTOR, "POST", "/v1/layouts", { name: uniqueName("ro-parity"), format: "spark/1", payload: AKL_PAYLOAD });
    expect(created.status).toBe(201);
    layoutId = (await created.json<{ id: string }>()).id;
  });

  async function pair(actor: string, method: string, path: string, status = 200): Promise<void> {
    const a = await shape(await send(ro, actor, method, path), [ro.id, rw.id]);
    const b = await shape(await send(rw, actor, method, path), [ro.id, rw.id]);
    expect(a.status, `${method} ${path} as ${actor}`).toBe(status);
    expect(a, `${method} ${path} as ${actor}`).toEqual(b);
  }

  it("[LDB-A17] /v1/me, a known actor: same answer, and the author row is untouched", async () => {
    const row = await testStore.row("authors", { user_id: KNOWN_ACTOR });
    await pair(KNOWN_ACTOR, "GET", "/v1/me");
    const ownRes = await send(ro, KNOWN_ACTOR, "GET", "/v1/me");
    expect((await ownRes.json<{ name: string }>()).name).toBe("Known Author");
    expect(await testStore.row("authors", { user_id: KNOWN_ACTOR })).toEqual(row);
  });

  it("[LDB-A17] /v1/me, an unknown actor: the name is the id, no authors row, no ETag moves; the control then stores the same placeholder", async () => {
    const actor = freshActor();
    const metaBefore = await SELF.fetch(`${ORIGIN}/v1/meta`);
    const authorsBefore = await SELF.fetch(`${ORIGIN}/v1/authors`);
    const dataBefore = await snapshot(DATA_TABLES);

    const roRes = await send(ro, actor, "GET", "/v1/me");
    expect(roRes.status).toBe(200);
    const roBody = await roRes.json<{ user_id: string; name: string; via: string }>();
    expect(roBody.name).toBe(actor);
    expect(roBody.via).toBe(`client:${ro.id}`);

    expect(await testStore.count("authors", { user_id: actor })).toBe(0);
    expect(await snapshot(DATA_TABLES)).toEqual(dataBefore);
    const metaAfter = await SELF.fetch(`${ORIGIN}/v1/meta`);
    const authorsAfter = await SELF.fetch(`${ORIGIN}/v1/authors`);
    expect(metaAfter.headers.get("ETag")).toBe(metaBefore.headers.get("ETag"));
    expect(authorsAfter.headers.get("ETag")).toBe(authorsBefore.headers.get("ETag"));

    // The control (no cap) answers the same body modulo the client id, and
    // stores exactly the placeholder the read-only answer already showed.
    const rwRes = await send(rw, actor, "GET", "/v1/me");
    const rwBody = await rwRes.json<{ user_id: string; name: string; via: string }>();
    expect({ ...rwBody, via: "" }).toEqual({ ...roBody, via: "" });
    expect((await testStore.row<{ name: string }>("authors", { user_id: actor }))?.name).toBe(actor);
  });

  it("[LDB-A17] /v1/me/comments, a known and an unknown actor", async () => {
    await pair(KNOWN_ACTOR, "GET", "/v1/me/comments");
    const actor = freshActor();
    await pair(actor, "GET", "/v1/me/comments");
  });

  it("[LDB-A17] /v1/wpm/submissions/:id (an id nobody has) answers the same private 404", async () => {
    await pair(KNOWN_ACTOR, "GET", "/v1/wpm/submissions/01ARZ3NDEKTSV4RRFFQ69G5FAV", 404);
  });

  it("[LDB-A17] /v1/changes?wait=1 is honoured the same way", async () => {
    (bindings as unknown as { TEST_LONGPOLL_SLEEP: (ms: number) => Promise<void> }).TEST_LONGPOLL_SLEEP = async () => {};
    await pair(KNOWN_ACTOR, "GET", "/v1/changes?wait=1");
  });

  it("[LDB-A17] /v1/layouts/:ref, GET and HEAD", async () => {
    await pair(KNOWN_ACTOR, "GET", `/v1/layouts/${layoutId}?format=spark%2F1`);
    await pair(KNOWN_ACTOR, "HEAD", `/v1/layouts/${layoutId}?format=spark%2F1`);
  });

  it("[LDB-A17] a run of reads writes no data table", async () => {
    const before = await snapshot(DATA_TABLES);
    const actor = freshActor();
    for (const path of ["/v1/me", "/v1/me/comments", `/v1/layouts/${layoutId}?format=spark%2F1`, "/v1/meta", "/v1/authors"]) {
      expect((await send(ro, actor, "GET", path)).status, path).toBe(200);
    }
    expect((await send(ro, actor, "HEAD", `/v1/layouts/${layoutId}?format=spark%2F1`)).status).toBe(200);
    expect(await snapshot(DATA_TABLES)).toEqual(before);
  });
});
