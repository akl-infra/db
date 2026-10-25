// [LDB-WPM1..LDB-WPM9] WPM records (docs/decisions/28-wpm-records.md):
// submit / queue / approve / public read, black-box via SELF.fetch, same
// pattern tests/api/links.test.ts uses for the link queue.
import { env, store, testStore } from "../harness";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ulid } from "ulidx";
import type { Bindings } from "../../src/env";
import { commitWrite, type CommitInput } from "../../src/core/events";
import { steppingClock } from "../../src/core/time";
import { generateKeyPair, seedClient, signHeaders } from "../auth/client-support";
import { AKL_PAYLOAD, BOOTSTRAP_ADMIN, actorFixture, pinTestClock, register, uniqueName, writeFetch } from "./write-support";

const bindings = env as unknown as Bindings;
const originalProofBotToken = bindings.MODQUEUE_DISCORD_BOT_TOKEN;
// Every call to the clock is a fresh instant, so `submitted_at`/`decided_at`
// order strictly by the order the test made its requests.
const clock = steppingClock("2026-10-01T00:00:00.000Z", 1000);
pinTestClock(env as unknown as { TEST_CLOCK?: typeof clock }, clock);

afterEach(() => {
  vi.unstubAllGlobals();
  bindings.MODQUEUE_DISCORD_BOT_TOKEN = originalProofBotToken;
});

let idCounter = 0;
function testUserId(): string {
  idCounter++;
  return `33000000000000${String(idCounter).padStart(4, "0")}`;
}

let tokenCounter = 0;
function token(label: string): string {
  tokenCounter++;
  return `tok-wpm-${label}-${tokenCounter}`;
}

async function createLayout(owner: string, name = uniqueName("wpm-layout")): Promise<{ id: string; name: string }> {
  const input: CommitInput = {
    layoutId: ulid(),
    creating: true,
    currentN: 0,
    currentLayout: null,
    currentFormats: new Map(),
    layout: { kind: "created", name, owner, created_at: clock(), deleted: false },
    format: { kind: "format_added", lineage: "spark", format: "spark/1", payload: AKL_PAYLOAD, hasMagic: false },
    modified_at: clock(),
    actor: owner,
    via: "discord",
    source: { client: "discord-app:test", version: null },
    upstream: null,
  };
  const { layout } = await commitWrite(store, clock, input);
  return { id: layout.id, name: layout.name };
}

interface Submission {
  id: string;
  layout_id: string;
  user_id: string;
  wpm: number;
  proof: string;
  submitted_by: string;
  via: string;
  submitted_at: string;
  status: string;
  decided_by: string | null;
  decided_at: string | null;
  reason: string | null;
}
interface WpmRecord {
  layout_id: string;
  layout_name: string;
  user_id: string;
  user_name: string | null;
  wpm: number;
  proof: string;
  approved_at: string;
  submission_id: string;
}

async function records(query: string): Promise<WpmRecord[]> {
  const res = await writeFetch(`/v1/wpm${query}`, "GET");
  expect(res.status).toBe(200);
  return ((await res.json()) as { records: WpmRecord[] }).records;
}

interface FeedEvent {
  seq: number;
  kind: string;
  layout_id: string | null;
  actor: string;
  admin: boolean;
  detail: Record<string, unknown> | null;
}
async function feedFor(layoutId: string): Promise<FeedEvent[]> {
  const res = await writeFetch(`/v1/changes?since=0&limit=1000&layout=${layoutId}`, "GET");
  return ((await res.json()) as { items: FeedEvent[] }).items;
}

// Inserts an approved row directly, so a test controls `wpm`/`decided_at`
// exactly (the best-row tie-break and sort cases).
async function insertRow(o: { layoutId: string; userId: string; wpm: number; status?: string; decidedAt?: string; id?: string; proof?: string }): Promise<string> {
  const id = o.id ?? ulid();
  await testStore.insert("wpm_submissions", {
    id,
    layout_id: o.layoutId,
    user_id: o.userId,
    wpm: o.wpm,
    proof: o.proof ?? `https://example.org/proof/${id}`,
    submitted_by: o.userId,
    via: "discord",
    submitted_at: "2026-09-01T00:00:00.000Z",
    status: o.status ?? "approved",
    decided_by: "mod",
    decided_at: o.decidedAt ?? null,
    reason: null,
  });
  return id;
}

async function pendingFor(admin: Record<string, string>, layoutId: string): Promise<Submission[]> {
  const res = await writeFetch("/v1/admin/wpm-queue?status=pending", "GET", admin);
  expect(res.status).toBe(200);
  return ((await res.json()) as { submissions: Submission[] }).submissions.filter((s) => s.layout_id === layoutId);
}

const PROOF = "https://www.youtube.com/watch?v=wpm-proof";

describe("private WPM submission status", () => {
  it("[LDB-WPM16] only the typist, submitter and admins can read every status, with no extra private fields or shared caching", async () => {
    const user = testUserId();
    const submitter = testUserId();
    const { id: layoutId } = await createLayout(user);
    const fake = actorFixture();
    const authorized = [
      register(fake, token("status-typist"), user),
      register(fake, token("status-submitter"), submitter),
      register(fake, token("status-admin"), BOOTSTRAP_ADMIN),
    ];
    const unrelated = register(fake, token("status-unrelated"), testUserId());
    for (const [status, reason] of [
      ["pending", null], ["approved", null], ["rejected", "Proof does not show the result."],
      ["rejected", null], ["superseded", null],
    ] as const) {
      const id = await insertRow({ layoutId, userId: user, wpm: 120, status });
      await testStore.patch("wpm_submissions", { id }, { submitted_by: submitter, reason });
      const path = `/v1/wpm/submissions/${id}`;
      for (const auth of authorized) {
        const response = await writeFetch(path, "GET", auth);
        expect(response.status).toBe(200);
        expect(response.headers.get("Cache-Control")).toBe("private, no-store");
        expect(response.headers.get("ETag")).toBeNull();
        expect(await response.json()).toEqual({ submission: { id, status, reason, review_version: 0 } });
      }
      const denied = await writeFetch(path, "GET", unrelated);
      expect(denied.status).toBe(404);
      expect(denied.headers.get("Cache-Control")).toBe("private, no-store");
      expect(await denied.json()).toEqual({ error: "not_found", message: `no wpm submission '${id}'`, ref: id });
      const anonymous = await writeFetch(path, "GET");
      expect(anonymous.status).toBe(401);
      expect(anonymous.headers.get("Cache-Control")).toBe("private, no-store");
    }
    const missing = await writeFetch("/v1/wpm/submissions/missing", "GET", authorized[0]);
    expect(missing.status).toBe(404);
    expect(missing.headers.get("Cache-Control")).toBe("private, no-store");
    expect(await missing.json()).toEqual({ error: "not_found", message: "no wpm submission 'missing'", ref: "missing" });
    const invalid = await writeFetch("/v1/wpm/submissions/missing", "GET", { Authorization: "Bearer invalid-status-token" });
    expect(invalid.status).toBe(401);
    expect(invalid.headers.get("Cache-Control")).toBe("private, no-store");
  });

  it("[LDB-WPM16] follows rejection, reopen and approval without leaking reasons into the public feed", async () => {
    const user = testUserId();
    const { id: layoutId } = await createLayout(user);
    const fake = actorFixture();
    const auth = register(fake, token("status-cycle-user"), user);
    const admin = register(fake, token("status-cycle-admin"), BOOTSTRAP_ADMIN);
    const created = await writeFetch("/v1/wpm", "POST", auth, { layout: layoutId, wpm: 100, proof: PROOF });
    const { submission: { id } } = await created.json() as { submission: Submission };
    const read = async () => {
      const response = await writeFetch(`/v1/wpm/submissions/${id}`, "GET", auth);
      expect(response.status).toBe(200);
      return response.json();
    };
    const reason = "Please include the complete result.";
    expect((await writeFetch(`/v1/admin/wpm-queue/${id}/reject`, "POST", admin, { reason })).status).toBe(200);
    expect(await read()).toEqual({ submission: { id, status: "rejected", reason, review_version: 0 } });
    expect((await writeFetch(`/v1/admin/wpm-queue/${id}/reopen`, "POST", admin, { status: "rejected", review_version: 0 })).status).toBe(200);
    expect(await read()).toEqual({ submission: { id, status: "pending", reason: null, review_version: 1 } });
    expect((await writeFetch(`/v1/admin/wpm-queue/${id}/approve`, "POST", admin, { review_version: 1 })).status).toBe(200);
    expect(await read()).toEqual({ submission: { id, status: "approved", reason: null, review_version: 1 } });
    expect(JSON.stringify(await feedFor(layoutId))).not.toContain(reason);
  });

  it("[LDB-WPM16] signed client reads authorize the acting user, not the client owner", async () => {
    const user = testUserId();
    const { id: layoutId } = await createLayout(user);
    const id = await insertRow({ layoutId, userId: user, wpm: 120, status: "pending" });
    const { privateKey, pubkeyB64url } = await generateKeyPair();
    const owner = testUserId();
    const clientId = "wpm-status-client";
    await seedClient(clock, { id: clientId, pubkeyB64url, ownerUserId: owner, caps: "act-as-user" });
    const path = `/v1/wpm/submissions/${id}`;
    for (const [actor, expectedStatus] of [[user, 200], [owner, 404]] as const) {
      const headers = await signHeaders({ privateKey, clientId, actor, method: "GET", pathWithQuery: path });
      const response = await writeFetch(path, "GET", headers);
      expect(response.status).toBe(expectedStatus);
      expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    }
  });
});

describe("Discord proof authorship at submission", () => {
  const channel = "900000000000000801";
  const message = "900000000000000802";
  const proof = `https://discord.com/channels/900000000000000800/${channel}/${message}`;

  it("[LDB-WPM15] rejects another author's message before superseding a pending proof or appending WPM history/events", async () => {
    const user = testUserId();
    const other = testUserId();
    const { id } = await createLayout(user);
    const fake = actorFixture();
    const auth = register(fake, token("proof-author"), user);
    let author = other;
    let lookups = 0;
    vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith(`/v10/channels/${channel}/messages/${message}`)) {
        lookups++;
        return Promise.resolve(Response.json({ id: message, channel_id: channel, author: { id: author }, attachments: [] }));
      }
      return fake.fetchImpl(String(input), { headers: { Authorization: new Headers(init?.headers).get("Authorization") ?? "" } });
    });
    bindings.MODQUEUE_DISCORD_BOT_TOKEN = "test-proof-bot";
    const before = await writeFetch("/v1/wpm", "POST", auth, { layout: id, wpm: 80, proof: PROOF });
    const previous = (await before.json()) as { submission: Submission };
    const events = await feedFor(id);
    const refused = await writeFetch("/v1/wpm", "POST", auth, { layout: id, wpm: 90, proof });
    expect(refused.status).toBe(400);
    expect(await refused.json()).toMatchObject({ error: "invalid_proof", message: expect.stringContaining("must be written by") });
    expect(await testStore.rows("wpm_submissions", { layout_id: id }))
      .toMatchObject([{ id: previous.submission.id, status: "pending" }]);
    expect(await feedFor(id)).toEqual(events);
    expect((await testStore.rows("moderation_review_history", { submission_id: previous.submission.id }))).toHaveLength(0);
    author = user;
    const accepted = await writeFetch("/v1/wpm", "POST", auth, { layout: id, wpm: 90, proof });
    expect(accepted.status).toBe(202);
    expect(await accepted.json()).toMatchObject({ submission: { user_id: user, proof, status: "pending" } });
    expect(await testStore.row("wpm_submissions", { id: previous.submission.id })).toMatchObject({ status: "superseded" });
    expect(lookups).toBe(2);
  });

  it("[LDB-WPM15] admin on-behalf checks the typist, not the submitting moderator; admin self-submission has no bypass", async () => {
    const user = testUserId();
    const { id } = await createLayout(user);
    const fake = actorFixture();
    const admin = register(fake, token("proof-admin-author"), BOOTSTRAP_ADMIN);
    let author = BOOTSTRAP_ADMIN;
    vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => String(input).endsWith(`/messages/${message}`)
      ? Promise.resolve(Response.json({ id: message, channel_id: channel, author: { id: author } })) : fake.fetchImpl(String(input), { headers: { Authorization: new Headers(init?.headers).get("Authorization") ?? "" } }));
    bindings.MODQUEUE_DISCORD_BOT_TOKEN = "test-proof-bot";
    const body = { user_id: user, layout: id, wpm: 90, proof };
    expect((await writeFetch("/v1/admin/wpm", "POST", admin, body)).status).toBe(400);
    expect((await testStore.rows("wpm_submissions", { layout_id: id }))).toHaveLength(0);
    expect((await feedFor(id)).some((e) => e.kind.startsWith("wpm_"))).toBe(false);
    author = user;
    expect((await writeFetch("/v1/wpm", "POST", admin, { layout: id, wpm: 90, proof })).status).toBe(400);
    const accepted = await writeFetch("/v1/admin/wpm", "POST", admin, body);
    expect(accepted.status).toBe(201);
    expect(await accepted.json()).toMatchObject({ submission: { user_id: user, submitted_by: BOOTSTRAP_ADMIN, status: "approved" } });
  });

  it("[LDB-WPM15] a proof the bot cannot verify (no credentials, or a direct Discord image link) is queued unverified, not refused", async () => {
    const user = testUserId();
    const auth = register(actorFixture(), token("proof-unreadable"), user);
    bindings.MODQUEUE_DISCORD_BOT_TOKEN = undefined;
    for (const value of [proof, `https://cdn.discordapp.com/attachments/${channel}/${message}/proof.png`]) {
      const { id } = await createLayout(user);
      const res = await writeFetch("/v1/wpm", "POST", auth, { layout: id, wpm: 90, proof: value });
      expect(res.status, value).toBeLessThan(300);
      expect((await testStore.rows("wpm_submissions", { layout_id: id }))).toHaveLength(1);
    }
  });
});

describe("[LDB-WPM1] validation is shared by every route", () => {
  it("[LDB-WPM1] POST /v1/wpm refuses a bad wpm with 400 invalid_wpm, and accepts the 1 and 1000 boundaries", async () => {
    const user = testUserId();
    const { id } = await createLayout(user);
    const auth = register(actorFixture(), token("wpm-bounds"), user);

    for (const wpm of [0, -1, 1001, 85.5, "85", null, true]) {
      const res = await writeFetch("/v1/wpm", "POST", auth, { layout: id, wpm, proof: PROOF });
      expect(res.status, JSON.stringify(wpm)).toBe(400);
      await expect(res.json()).resolves.toMatchObject({ error: "invalid_wpm" });
    }
    for (const wpm of [1, 1000]) {
      const res = await writeFetch("/v1/wpm", "POST", auth, { layout: id, wpm, proof: PROOF });
      expect(res.status, String(wpm)).toBe(202);
    }
  });

  it("[LDB-WPM1] POST /v1/wpm refuses a bad proof with 400 invalid_proof; any http(s) host is fine and the stored value is trimmed", async () => {
    const user = testUserId();
    const { id } = await createLayout(user);
    const auth = register(actorFixture(), token("wpm-proof"), user);

    for (const proof of ["ftp://example.org/x", "javascript:alert(1)", "not a url", "", "   ", "https://", "http:example.org", `https://example.org/${"a".repeat(512)}`, 5, null]) {
      const res = await writeFetch("/v1/wpm", "POST", auth, { layout: id, wpm: 90, proof });
      expect(res.status, JSON.stringify(proof)).toBe(400);
      await expect(res.json()).resolves.toMatchObject({ error: "invalid_proof" });
    }
    for (const [sent, stored] of [
      ["http://example.org/a", "http://example.org/a"],
      ["https://monkeytype.com/profile/someone", "https://monkeytype.com/profile/someone"],
      ["  https://example.org/trimmed  ", "https://example.org/trimmed"],
    ] as const) {
      const res = await writeFetch("/v1/wpm", "POST", auth, { layout: id, wpm: 90, proof: sent });
      expect(res.status, sent).toBe(202);
      const body = (await res.json()) as { submission: Submission };
      expect(body.submission.proof).toBe(stored);
    }
  });

  it("[LDB-WPM1] the admin on-behalf route uses the same refusals", async () => {
    const { id } = await createLayout(testUserId());
    const admin = register(actorFixture(), token("wpm-admin-validate"), BOOTSTRAP_ADMIN);
    const target = testUserId();
    const wpm = await writeFetch("/v1/admin/wpm", "POST", admin, { user_id: target, layout: id, wpm: 1001, proof: PROOF });
    expect(wpm.status).toBe(400);
    await expect(wpm.json()).resolves.toMatchObject({ error: "invalid_wpm" });
    const proof = await writeFetch("/v1/admin/wpm", "POST", admin, { user_id: target, layout: id, wpm: 90, proof: "ftp://x" });
    expect(proof.status).toBe(400);
    await expect(proof.json()).resolves.toMatchObject({ error: "invalid_proof" });
  });

  it("[LDB-WPM1] a missing or extra body field is 400 bad_request; the layout ref resolves by id or name; an unknown or deleted layout is 404", async () => {
    const user = testUserId();
    const { id, name } = await createLayout(user);
    const auth = register(actorFixture(), token("wpm-body"), user);

    expect((await writeFetch("/v1/wpm", "POST", auth, { wpm: 90, proof: PROOF })).status).toBe(400);
    expect((await writeFetch("/v1/wpm", "POST", auth, { layout: id, proof: PROOF })).status).toBe(400);
    expect((await writeFetch("/v1/wpm", "POST", auth, { layout: id, wpm: 90 })).status).toBe(400);
    expect((await writeFetch("/v1/wpm", "POST", auth, { layout: id, wpm: 90, proof: PROOF, user_id: user })).status).toBe(400);

    expect((await writeFetch("/v1/wpm", "POST", auth, { layout: id, wpm: 90, proof: PROOF })).status).toBe(202);
    expect((await writeFetch("/v1/wpm", "POST", auth, { layout: name, wpm: 91, proof: PROOF })).status).toBe(202);

    const unknown = await writeFetch("/v1/wpm", "POST", auth, { layout: "no-such-layout-wpm", wpm: 90, proof: PROOF });
    expect(unknown.status).toBe(404);
    await expect(unknown.json()).resolves.toMatchObject({ error: "not_found" });

    await testStore.patch("layouts", { id }, { deleted: 1 });
    expect((await writeFetch("/v1/wpm", "POST", auth, { layout: id, wpm: 92, proof: PROOF })).status).toBe(404);
  });
});

describe("[LDB-WPM2] a fresh pending submission supersedes the user's older one; rows are never deleted", () => {
  it("[LDB-WPM2] same user + same layout: the older pending row becomes superseded, with no event; other users and layouts are untouched", async () => {
    const userA = testUserId();
    const userB = testUserId();
    const layout1 = await createLayout(userA);
    const layout2 = await createLayout(userA);
    const fake = actorFixture();
    const a = register(fake, token("wpm-sup-a"), userA);
    const b = register(fake, token("wpm-sup-b"), userB);
    const admin = register(fake, token("wpm-sup-admin"), BOOTSTRAP_ADMIN);

    await writeFetch("/v1/wpm", "POST", a, { layout: layout1.id, wpm: 70, proof: "https://example.org/a1" });
    await writeFetch("/v1/wpm", "POST", b, { layout: layout1.id, wpm: 60, proof: "https://example.org/b1" });
    await writeFetch("/v1/wpm", "POST", a, { layout: layout2.id, wpm: 75, proof: "https://example.org/a-other" });
    const eventsBefore = (await feedFor(layout1.id)).length;
    const second = await writeFetch("/v1/wpm", "POST", a, { layout: layout1.id, wpm: 80, proof: "https://example.org/a2" });
    expect(second.status).toBe(202);

    const rows = await testStore.rows<{ user_id: string; wpm: number; status: string }>("wpm_submissions", { layout_id: layout1.id }, ["submitted_at"]);
    expect(rows.map((r) => ({ user_id: r.user_id, wpm: r.wpm, status: r.status }))).toEqual([
      { user_id: userA, wpm: 70, status: "superseded" },
      { user_id: userB, wpm: 60, status: "pending" },
      { user_id: userA, wpm: 80, status: "pending" },
    ]);
    const other = await testStore.row<{ status: string }>("wpm_submissions", { layout_id: layout2.id });
    expect(other?.status).toBe("pending");

    // Only the NEW submission's `wpm_submitted` landed; superseding is silent.
    const eventsAfter = await feedFor(layout1.id);
    expect(eventsAfter.length - eventsBefore).toBe(1);

    const queue = await pendingFor(admin, layout1.id);
    expect(queue.map((s) => [s.user_id, s.wpm])).toEqual([
      [userB, 60],
      [userA, 80],
    ]);
    const superseded = (await (await writeFetch("/v1/admin/wpm-queue?status=superseded", "GET", admin)).json()) as { submissions: Submission[] };
    expect(superseded.submissions.filter((s) => s.layout_id === layout1.id).map((s) => s.wpm)).toEqual([70]);
  });

  it("[LDB-WPM2] there is no withdraw route, and no route removes a row", async () => {
    const user = testUserId();
    const { id } = await createLayout(user);
    const auth = register(actorFixture(), token("wpm-nodelete"), user);
    const submitted = (await (await writeFetch("/v1/wpm", "POST", auth, { layout: id, wpm: 70, proof: PROOF })).json()) as { submission: Submission };
    for (const [method, path] of [
      ["DELETE", "/v1/wpm"],
      ["DELETE", `/v1/wpm/${submitted.submission.id}`],
      ["DELETE", `/v1/admin/wpm-queue/${submitted.submission.id}`],
    ] as const) {
      expect([404, 405], `${method} ${path}`).toContain((await writeFetch(path, method, auth)).status);
    }
    const count = await testStore.count("wpm_submissions", { id: submitted.submission.id });
    expect(count).toBe(1);
  });
});

describe("[LDB-WPM3] an admin's own speed goes through the queue like anyone's", () => {
  it("[LDB-WPM3] 202, status pending, not public, in the queue, one wpm_submitted and no wpm_approved; the admin approves it in the Inbox", async () => {
    const { id, name } = await createLayout(testUserId());
    const admin = register(actorFixture(), token("wpm-self"), BOOTSTRAP_ADMIN);

    const res = await writeFetch("/v1/wpm", "POST", admin, { layout: name, wpm: 130, proof: PROOF });
    expect(res.status).toBe(202);
    const { submission } = (await res.json()) as { submission: Submission };
    expect(submission).toMatchObject({ layout_id: id, user_id: BOOTSTRAP_ADMIN, submitted_by: BOOTSTRAP_ADMIN, wpm: 130, status: "pending", decided_by: null, decided_at: null });

    expect(await records(`?layout=${id}`)).toEqual([]);
    expect((await pendingFor(admin, id)).map((q) => q.id)).toEqual([submission.id]);
    expect((await feedFor(id)).map((e) => e.kind).filter((k) => k.startsWith("wpm_"))).toEqual(["wpm_submitted"]);

    expect((await writeFetch(`/v1/admin/wpm-queue/${submission.id}/approve`, "POST", admin)).status).toBe(200);
    expect(await records(`?layout=${id}`)).toMatchObject([{ user_id: BOOTSTRAP_ADMIN, wpm: 130, proof: PROOF, submission_id: submission.id }]);
    expect((await feedFor(id)).map((e) => e.kind).filter((k) => k.startsWith("wpm_"))).toEqual(["wpm_submitted", "wpm_approved"]);
  });
});


describe("[LDB-WPM4] an admin enters a speed on someone else's behalf", () => {
  it("[LDB-WPM4] 201, approved, user_id is the target and submitted_by the admin; the target needs no authors row", async () => {
    const { id } = await createLayout(testUserId());
    const admin = register(actorFixture(), token("wpm-behalf"), BOOTSTRAP_ADMIN);
    const target = testUserId();
    expect((await testStore.row("authors", { user_id: target })) === null).toBe(true);

    const res = await writeFetch("/v1/admin/wpm", "POST", admin, { user_id: target, layout: id, wpm: 101, proof: PROOF });
    expect(res.status).toBe(201);
    const { submission } = (await res.json()) as { submission: Submission };
    expect(submission).toMatchObject({ layout_id: id, user_id: target, submitted_by: BOOTSTRAP_ADMIN, via: "discord", wpm: 101, status: "approved", decided_by: BOOTSTRAP_ADMIN });

    const recs = await records(`?user=${target}`);
    expect(recs).toHaveLength(1);
    expect(recs[0]).toMatchObject({ user_id: target, user_name: null, wpm: 101, layout_id: id });
    expect((await testStore.row("authors", { user_id: target })) === null).toBe(true);

    // Once the target has an author row, the record names them.
    await testStore.insert("authors", { user_id: target, name: "Typist", first_seen_at: clock(), last_seen_at: clock() });
    expect((await records(`?user=${target}`))[0]).toMatchObject({ user_name: "Typist" });
  });

  it("[LDB-WPM4] a user_id that isn't a snowflake is 400 bad_request, and a deleted or unknown layout is 404", async () => {
    const { id } = await createLayout(testUserId());
    const admin = register(actorFixture(), token("wpm-behalf-bad"), BOOTSTRAP_ADMIN);
    for (const user_id of ["short", "1234567890123456", "123456789012345678901", "18441225582202060x", ""]) {
      const res = await writeFetch("/v1/admin/wpm", "POST", admin, { user_id, layout: id, wpm: 90, proof: PROOF });
      expect(res.status, user_id).toBe(400);
      await expect(res.json()).resolves.toMatchObject({ error: "bad_request", param: "user_id" });
    }
    expect((await writeFetch("/v1/admin/wpm", "POST", admin, { user_id: testUserId(), layout: "no-such-layout-wpm", wpm: 90, proof: PROOF })).status).toBe(404);
    await testStore.patch("layouts", { id }, { deleted: 1 });
    expect((await writeFetch("/v1/admin/wpm", "POST", admin, { user_id: testUserId(), layout: id, wpm: 90, proof: PROOF })).status).toBe(404);
  });
});

describe("[LDB-WPM5] GET /v1/wpm answers each user's top approved speed per layout", () => {
  it("[LDB-WPM5] one row per (layout, user): the highest approved wpm; a tie goes to the earliest decided_at; pending, rejected and superseded rows never count", async () => {
    const owner = testUserId();
    const { id } = await createLayout(owner);
    const user = testUserId();
    await insertRow({ layoutId: id, userId: user, wpm: 90, decidedAt: "2026-09-02T00:00:00.000Z" });
    const late = await insertRow({ layoutId: id, userId: user, wpm: 100, decidedAt: "2026-09-05T00:00:00.000Z" });
    const early = await insertRow({ layoutId: id, userId: user, wpm: 100, decidedAt: "2026-09-03T00:00:00.000Z" });
    await insertRow({ layoutId: id, userId: user, wpm: 200, status: "pending" });
    await insertRow({ layoutId: id, userId: user, wpm: 300, status: "rejected", decidedAt: "2026-09-04T00:00:00.000Z" });
    await insertRow({ layoutId: id, userId: user, wpm: 400, status: "superseded", decidedAt: "2026-09-04T00:00:00.000Z" });

    const recs = await records(`?layout=${id}&user=${user}`);
    expect(recs).toHaveLength(1);
    expect(recs[0]).toMatchObject({ wpm: 100, submission_id: early, approved_at: "2026-09-03T00:00:00.000Z" });
    expect(recs[0]!.submission_id).not.toBe(late);
  });

  it("[LDB-WPM5] a fully tied (wpm, decided_at) pair still picks one row, the lower id", async () => {
    const { id } = await createLayout(testUserId());
    const user = testUserId();
    await insertRow({ layoutId: id, userId: user, wpm: 80, decidedAt: "2026-09-02T00:00:00.000Z", id: "01ARZ3NDEKTSV4RRFFQ69G5FB2" });
    await insertRow({ layoutId: id, userId: user, wpm: 80, decidedAt: "2026-09-02T00:00:00.000Z", id: "01ARZ3NDEKTSV4RRFFQ69G5FB1" });
    const recs = await records(`?layout=${id}`);
    expect(recs.map((r) => r.submission_id)).toEqual(["01ARZ3NDEKTSV4RRFFQ69G5FB1"]);
  });

  it("[LDB-WPM5] sorted wpm desc then approved_at asc; the same user on two layouts gets two rows; the layout and user filters narrow it", async () => {
    const l1 = await createLayout(testUserId());
    const l2 = await createLayout(testUserId());
    const [u1, u2, u3] = [testUserId(), testUserId(), testUserId()] as const;
    await insertRow({ layoutId: l1.id, userId: u1, wpm: 100, decidedAt: "2026-09-02T00:00:00.000Z" });
    await insertRow({ layoutId: l1.id, userId: u2, wpm: 120, decidedAt: "2026-09-09T00:00:00.000Z" });
    await insertRow({ layoutId: l1.id, userId: u3, wpm: 100, decidedAt: "2026-09-01T00:00:00.000Z" });
    await insertRow({ layoutId: l2.id, userId: u1, wpm: 70, decidedAt: "2026-09-02T00:00:00.000Z" });

    const onL1 = await records(`?layout=${l1.name}`);
    expect(onL1.map((r) => [r.user_id, r.wpm])).toEqual([
      [u2, 120],
      [u3, 100], // ties on 100: the earlier approval first
      [u1, 100],
    ]);
    expect(onL1.every((r) => r.layout_name === l1.name && r.layout_id === l1.id)).toBe(true);

    const forU1 = await records(`?user=${u1}`);
    expect(forU1.map((r) => [r.layout_id, r.wpm])).toEqual([
      [l1.id, 100],
      [l2.id, 70],
    ]);
    expect(await records(`?layout=${l2.id}&user=${u2}`)).toEqual([]);
  });

  it("[LDB-WPM5] an unknown layout is 404; a malformed user is 400; the body carries no notified_at", async () => {
    expect((await writeFetch("/v1/wpm?layout=no-such-layout-wpm", "GET")).status).toBe(404);
    const bad = await writeFetch("/v1/wpm?user=nope", "GET");
    expect(bad.status).toBe(400);
    await expect(bad.json()).resolves.toMatchObject({ error: "bad_request", param: "user" });

    const { id } = await createLayout(testUserId());
    await insertRow({ layoutId: id, userId: testUserId(), wpm: 50, decidedAt: "2026-09-02T00:00:00.000Z" });
    const [rec] = await records(`?layout=${id}`);
    expect(Object.keys(rec!).sort()).toEqual(["approved_at", "layout_id", "layout_name", "proof", "submission_id", "user_id", "user_name", "wpm"]);
  });

  it("[LDB-WPM5] the read carries an ETag: 304 on a match, a new tag after an approval", async () => {
    const { id } = await createLayout(testUserId());
    const admin = register(actorFixture(), token("wpm-etag"), BOOTSTRAP_ADMIN);
    const first = await writeFetch(`/v1/wpm?layout=${id}`, "GET");
    const etag = first.headers.get("ETag");
    expect(etag).not.toBeNull();
    expect(first.headers.get("Cache-Control")).toBe("public, max-age=10");

    const again = await writeFetch(`/v1/wpm?layout=${id}`, "GET", { "If-None-Match": etag! });
    expect(again.status).toBe(304);

    await writeFetch("/v1/admin/wpm", "POST", admin, { user_id: testUserId(), layout: id, wpm: 99, proof: PROOF });
    const after = await writeFetch(`/v1/wpm?layout=${id}`, "GET", { "If-None-Match": etag! });
    expect(after.status).toBe(200);
    expect(after.headers.get("ETag")).not.toBe(etag);
    expect(((await after.json()) as { records: WpmRecord[] }).records).toHaveLength(1);
  });
});

describe("[LDB-WPM6] records on a deleted layout are hidden", () => {
  it("[LDB-WPM6] a real DELETE hides the public records and the queue rows; a restore brings both back", async () => {
    const owner = testUserId();
    const { id, name } = await createLayout(owner);
    const fake = actorFixture();
    const ownerAuth = register(fake, token("wpm-del-owner"), owner);
    const admin = register(fake, token("wpm-del-admin"), BOOTSTRAP_ADMIN);
    const user = testUserId();

    await writeFetch("/v1/admin/wpm", "POST", admin, { user_id: user, layout: id, wpm: 88, proof: PROOF });
    await writeFetch("/v1/wpm", "POST", ownerAuth, { layout: id, wpm: 66, proof: PROOF });
    expect(await records(`?user=${user}`)).toHaveLength(1);
    expect(await pendingFor(admin, id)).toHaveLength(1);

    const layoutRow = await testStore.row<{ layout_rev: number }>("layouts", { id });
    const del = await writeFetch(`/v1/layouts/${id}`, "DELETE", { ...ownerAuth, "If-Match": `"layout:${layoutRow!.layout_rev}"` });
    expect(del.status).toBe(200);

    expect(await records(`?user=${user}`)).toEqual([]);
    expect(await pendingFor(admin, id)).toEqual([]);
    // The tombstone has no live name, so the layout filter by name is a 404 and by id an empty list.
    expect((await writeFetch(`/v1/wpm?layout=${name}`, "GET")).status).toBe(404);
    expect(await records(`?layout=${id}`)).toEqual([]);

    const restore = await writeFetch(`/v1/layouts/${id}/restore`, "POST", ownerAuth, {});
    expect(restore.status).toBe(200);
    expect(await records(`?user=${user}`)).toHaveLength(1);
    expect(await pendingFor(admin, id)).toHaveLength(1);
  });

  it("[LDB-WPM6] approving a pending submission on a deleted layout is 404 until restored; the row is kept", async () => {
    const owner = testUserId();
    const { id } = await createLayout(owner);
    const fake = actorFixture();
    const ownerAuth = register(fake, token("wpm-del2-owner"), owner);
    const admin = register(fake, token("wpm-del2-admin"), BOOTSTRAP_ADMIN);
    const submitted = (await (await writeFetch("/v1/wpm", "POST", ownerAuth, { layout: id, wpm: 66, proof: PROOF })).json()) as { submission: Submission };

    await testStore.patch("layouts", { id }, { deleted: 1 });
    expect((await writeFetch(`/v1/admin/wpm-queue/${submitted.submission.id}/approve`, "POST", admin)).status).toBe(404);
    const row = await testStore.row<{ status: string }>("wpm_submissions", { id: submitted.submission.id });
    expect(row?.status).toBe("pending");

    await testStore.patch("layouts", { id }, { deleted: 0 });
    expect((await writeFetch(`/v1/admin/wpm-queue/${submitted.submission.id}/approve`, "POST", admin)).status).toBe(200);
  });
});

describe("[LDB-WPM7] events: one per action, nothing private in the public feed", () => {
  it("[LDB-WPM7] wpm_submitted carries only the submission id -- no wpm, no proof -- anywhere in the feed while pending", async () => {
    const user = testUserId();
    const { id } = await createLayout(user);
    const auth = register(actorFixture(), token("wpm-feed-pending"), user);
    const secretProof = "https://example.org/pending-proof-never-public-8431";
    const submitted = (await (await writeFetch("/v1/wpm", "POST", auth, { layout: id, wpm: 777, proof: secretProof })).json()) as { submission: Submission };

    const events = (await feedFor(id)).filter((e) => e.kind.startsWith("wpm_"));
    expect(events.map((e) => e.kind)).toEqual(["wpm_submitted"]);
    expect(events[0]).toMatchObject({ actor: user, admin: false, detail: { submission_id: submitted.submission.id } });
    expect(Object.keys(events[0]!.detail!)).toEqual(["submission_id"]);

    // The whole public surface that lists events: nothing of the pending row.
    for (const path of [`/v1/changes?since=0&limit=1000&layout=${id}`, `/admin/changelog?layout=${id}`, `/v1/layouts/${id}/history?format=spark/1`, `/v1/wpm?layout=${id}`]) {
      const text = await (await writeFetch(path, "GET")).text();
      expect(text.includes(secretProof), path).toBe(false);
      expect(text.includes("777"), path).toBe(false);
    }
  });

  it("[LDB-WPM7] approve appends one wpm_approved (public: layout, user_id, wpm, proof); reject appends one wpm_rejected with no wpm or proof", async () => {
    const user = testUserId();
    const { id } = await createLayout(user);
    const fake = actorFixture();
    const userAuth = register(fake, token("wpm-feed-user"), user);
    const admin = register(fake, token("wpm-feed-admin"), BOOTSTRAP_ADMIN);

    const first = (await (await writeFetch("/v1/wpm", "POST", userAuth, { layout: id, wpm: 91, proof: "https://example.org/approve-me" })).json()) as { submission: Submission };
    const approve = await writeFetch(`/v1/admin/wpm-queue/${first.submission.id}/approve`, "POST", admin);
    expect(approve.status).toBe(200);
    const approved = ((await approve.json()) as { submission: Submission }).submission;
    expect(approved).toMatchObject({ id: first.submission.id, status: "approved", decided_by: BOOTSTRAP_ADMIN, reason: null });

    const second = (await (await writeFetch("/v1/wpm", "POST", userAuth, { layout: id, wpm: 92, proof: "https://example.org/reject-me" })).json()) as { submission: Submission };
    const reject = await writeFetch(`/v1/admin/wpm-queue/${second.submission.id}/reject`, "POST", admin, { reason: "cannot see the keyboard" });
    expect(reject.status).toBe(200);
    expect(((await reject.json()) as { submission: Submission }).submission).toMatchObject({ status: "rejected", decided_by: BOOTSTRAP_ADMIN, reason: "cannot see the keyboard" });

    const events = (await feedFor(id)).filter((e) => e.kind.startsWith("wpm_"));
    expect(events.map((e) => e.kind)).toEqual(["wpm_submitted", "wpm_approved", "wpm_submitted", "wpm_rejected"]);
    expect(events[1]).toMatchObject({ actor: BOOTSTRAP_ADMIN, admin: true, layout_id: id, detail: { submission_id: first.submission.id, user_id: user, wpm: 91, proof: "https://example.org/approve-me" } });
    expect(events[3]).toMatchObject({ admin: true, detail: { submission_id: second.submission.id } });
    expect(JSON.stringify(events[3])).not.toContain("cannot see the keyboard");
    expect(JSON.stringify(events[3])).not.toContain("reject-me");
    expect(JSON.stringify(events[3])).not.toContain('"wpm"');

    // `kinds=` accepts the new names.
    for (const kind of ["wpm_submitted", "wpm_approved", "wpm_rejected"]) {
      expect((await writeFetch(`/v1/changes?kinds=${kind}&limit=1`, "GET")).status).toBe(200);
    }
  });

  it("[LDB-WPM7] a wpm_submitted / wpm_rejected row stored with speed, proof or reason in its detail is redacted on read", async () => {
    const { id, name } = await createLayout(testUserId());
    for (const [kind, detail] of [
      ["wpm_submitted", { submission_id: "01OLDWPM", wpm: 777, proof: "https://example.org/old-secret-proof" }],
      ["wpm_rejected", { submission_id: "01OLDWPM", user_id: "1", reason: "old private reason" }],
    ] as const) {
      await testStore.insert("events", {
        at: clock(),
        kind,
        layout_id: id,
        name,
        owner: "o",
        format: null,
        rev: null,
        actor: "a",
        via: "discord",
        admin: 0,
        detail_json: JSON.stringify(detail),
        before_json: null,
        after_json: null,
        source_client: null,
        source_version: null,
      });
    }
    const events = (await feedFor(id)).filter((e) => e.kind.startsWith("wpm_"));
    expect(events.map((e) => e.detail)).toEqual([{ submission_id: "01OLDWPM" }, { submission_id: "01OLDWPM" }]);
  });

  it("[LDB-WPM7] the on-behalf entry is exactly one wpm_approved event attributed to the admin", async () => {
    const { id } = await createLayout(testUserId());
    const admin = register(actorFixture(), token("wpm-feed-behalf"), BOOTSTRAP_ADMIN);
    const target = testUserId();
    await writeFetch("/v1/admin/wpm", "POST", admin, { user_id: target, layout: id, wpm: 105, proof: PROOF });
    const events = (await feedFor(id)).filter((e) => e.kind.startsWith("wpm_"));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: "wpm_approved", actor: BOOTSTRAP_ADMIN, admin: true, detail: { user_id: target, wpm: 105, proof: PROOF } });
  });
});

describe("[LDB-WPM9] the queue is admin-only; a ban stops submissions; internal bookkeeping stays off the wire", () => {
  it("[LDB-WPM9] every admin route is 403 not_admin for a user and 401 with no credentials", async () => {
    const user = testUserId();
    const { id } = await createLayout(user);
    const auth = register(actorFixture(), token("wpm-nonadmin"), user);
    const calls: [string, string, unknown][] = [
      ["POST", "/v1/admin/wpm", { user_id: testUserId(), layout: id, wpm: 90, proof: PROOF }],
      ["GET", "/v1/admin/wpm-queue", undefined],
      ["POST", "/v1/admin/wpm-queue/some-id/approve", undefined],
      ["POST", "/v1/admin/wpm-queue/some-id/reject", {}],
    ];
    for (const [method, path, body] of calls) {
      const denied = await writeFetch(path, method, auth, body);
      expect(denied.status, `${method} ${path}`).toBe(403);
      await expect(denied.json()).resolves.toMatchObject({ error: "not_admin" });
      expect((await writeFetch(path, method, {}, body)).status, `${method} ${path} anonymous`).toBe(401);
    }
    expect((await writeFetch("/v1/wpm", "POST", {}, { layout: id, wpm: 90, proof: PROOF })).status).toBe(401);
  });

  it("[LDB-WPM9] a banned user's POST /v1/wpm is 403 banned and writes nothing", async () => {
    const user = testUserId();
    const { id } = await createLayout(user);
    const fake = actorFixture();
    const admin = register(fake, token("wpm-ban-admin"), BOOTSTRAP_ADMIN);
    const banned = register(fake, token("wpm-ban-user"), user);
    await writeFetch(`/v1/admin/bans/${user}`, "PUT", admin, {});

    const res = await writeFetch("/v1/wpm", "POST", banned, { layout: id, wpm: 90, proof: PROOF });
    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toMatchObject({ error: "banned" });
    const n = await testStore.count("wpm_submissions", { user_id: user });
    expect(n).toBe(0);
  });

  it("[LDB-WPM9] a decided submission cannot be decided again (404); reject's reason is optional and stored; a bad status is 400", async () => {
    const user = testUserId();
    const { id } = await createLayout(user);
    const fake = actorFixture();
    const userAuth = register(fake, token("wpm-decide-user"), user);
    const admin = register(fake, token("wpm-decide-admin"), BOOTSTRAP_ADMIN);

    const a = (await (await writeFetch("/v1/wpm", "POST", userAuth, { layout: id, wpm: 90, proof: PROOF })).json()) as { submission: Submission };
    expect((await writeFetch(`/v1/admin/wpm-queue/${a.submission.id}/approve`, "POST", admin)).status).toBe(200);
    expect((await writeFetch(`/v1/admin/wpm-queue/${a.submission.id}/approve`, "POST", admin)).status).toBe(404);
    expect((await writeFetch(`/v1/admin/wpm-queue/${a.submission.id}/reject`, "POST", admin, {})).status).toBe(404);

    const b = (await (await writeFetch("/v1/wpm", "POST", userAuth, { layout: id, wpm: 91, proof: PROOF })).json()) as { submission: Submission };
    const rejected = await writeFetch(`/v1/admin/wpm-queue/${b.submission.id}/reject`, "POST", admin); // no body at all
    expect(rejected.status).toBe(200);
    expect(((await rejected.json()) as { submission: Submission }).submission).toMatchObject({ status: "rejected", reason: null });

    expect((await writeFetch("/v1/admin/wpm-queue?status=bogus", "GET", admin)).status).toBe(400);
    const approvedList = (await (await writeFetch("/v1/admin/wpm-queue?status=approved", "GET", admin)).json()) as { submissions: Submission[] };
    expect(approvedList.submissions.some((s) => s.id === a.submission.id)).toBe(true);
  });

  it("[LDB-WPM9] the queue rows name the layout and the user; notified_at is on no wire", async () => {
    const user = testUserId();
    const { id, name } = await createLayout(user);
    const fake = actorFixture();
    const userAuth = register(fake, token("wpm-wire-user"), user);
    const admin = register(fake, token("wpm-wire-admin"), BOOTSTRAP_ADMIN);

    const posted = await writeFetch("/v1/wpm", "POST", userAuth, { layout: id, wpm: 90, proof: PROOF });
    // The sign-in above created the author row; give it a display name to join.
    await testStore.patch("authors", { user_id: user }, { name: "Wire Typist" });
    const body = (await posted.json()) as { submission: Submission };
    expect(Object.keys(body.submission).sort()).toEqual(["decided_at", "decided_by", "id", "layout_id", "proof", "reason", "review_version", "status", "submitted_at", "submitted_by", "user_id", "via", "wpm"]);

    const queue = await pendingFor(admin, id);
    expect(queue).toHaveLength(1);
    expect(queue[0]).toMatchObject({ layout_name: name, user_name: "Wire Typist", user_id: user, wpm: 90 });
    expect(JSON.stringify(queue)).not.toContain("notified_at");

    const approved = await writeFetch(`/v1/admin/wpm-queue/${body.submission.id}/approve`, "POST", admin);
    expect(JSON.stringify(await approved.json())).not.toContain("notified_at");
  });
});

describe("private Discord receipt binding", () => {
  const body = { guild_id: "900000000000000001", channel_id: "900000000000000002", message_id: "900000000000000003" };
  const sourceUrl = `https://discord.com/channels/${body.guild_id}/${body.channel_id}/${body.message_id}`;

  it("[LDB-WPM17] binds once for the submitter/admin, hides existence from other actors and keeps metadata off existing wires", async () => {
    const user = testUserId();
    const submitter = testUserId();
    const { id: layoutId } = await createLayout(user);
    const id = await insertRow({ layoutId, userId: user, wpm: 120 });
    await testStore.patch("wpm_submissions", { id }, { submitted_by: submitter });
    const fake = actorFixture();
    const auth = register(fake, token("bind-submitter"), submitter);
    const admin = register(fake, token("bind-admin"), BOOTSTRAP_ADMIN);
    const typist = register(fake, token("bind-typist"), user);
    const stranger = register(fake, token("bind-other"), testUserId());
    const path = `/v1/wpm/submissions/${id}/discord-message`;
    for (const denied of [typist, stranger]) {
      const response = await writeFetch(path, "PUT", denied, body);
      expect(response.status).toBe(404);
      expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    }
    const anonymous = await writeFetch(path, "PUT", undefined, body);
    expect(anonymous.status).toBe(401);
    expect(anonymous.headers.get("Cache-Control")).toBe("private, no-store");
    for (const allowed of [auth, auth, admin]) {
      const response = await writeFetch(path, "PUT", allowed, body);
      expect(response.status).toBe(200);
      expect(response.headers.get("Cache-Control")).toBe("private, no-store");
      expect(await response.json()).toEqual({ source_message_url: sourceUrl });
    }
    const conflict = await writeFetch(path, "PUT", admin, { ...body, guild_id: null });
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({ error: "source_message_conflict" });
    for (const readPath of [`/v1/wpm/submissions/${id}`, "/v1/admin/wpm-queue?status=approved", `/v1/wpm?layout=${layoutId}`, `/v1/changes?since=0&layout=${layoutId}`]) {
      const response = await writeFetch(readPath, "GET", admin);
      const wire = await response.text();
      expect(wire).not.toContain("source_message_url");
      expect(wire).not.toContain(sourceUrl);
    }
    const { buildDump } = await import("../../src/dump/write");
    const dump = await buildDump(bindings, clock);
    expect(dump.wpm_submissions.some((s) => s.id === id)).toBe(true);
    expect(JSON.stringify(dump)).not.toContain("source_message_url");
    expect(JSON.stringify(dump)).not.toContain(sourceUrl);
  });

  it("[LDB-WPM17] validates strict decimal snowflakes, maps DM guild null, and applies the normal ban gate", async () => {
    const user = testUserId();
    const { id: layoutId } = await createLayout(user);
    const id = await insertRow({ layoutId, userId: user, wpm: 100 });
    const fake = actorFixture();
    const auth = register(fake, token("bind-validation"), user);
    const path = `/v1/wpm/submissions/${id}/discord-message`;
    for (const invalid of [
      {}, { ...body, extra: true }, { ...body, guild_id: "@me" }, { ...body, guild_id: 900000000000000001 },
      { ...body, channel_id: "1".repeat(16) }, { ...body, message_id: "1".repeat(21) },
      { ...body, message_id: "900000000000000003\n" }, { ...body, channel_id: "/../900000000000000002" },
      { ...body, message_id: null },
    ]) expect((await writeFetch(path, "PUT", auth, invalid)).status).toBe(400);
    const response = await writeFetch(path, "PUT", auth, { ...body, guild_id: null });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ source_message_url: `https://discord.com/channels/@me/${body.channel_id}/${body.message_id}` });
    const admin = register(fake, token("bind-ban-admin"), BOOTSTRAP_ADMIN);
    await writeFetch(`/v1/admin/bans/${user}`, "PUT", admin, {});
    const banned = await writeFetch(path, "PUT", auth, { ...body, guild_id: null });
    expect(banned.status).toBe(403);
    expect(banned.headers.get("Cache-Control")).toBe("private, no-store");
    expect(await banned.json()).toMatchObject({ error: "banned" });
  });

  it("[LDB-WPM17] competing signed binds have exactly one immutable winner and authenticate the acting user", async () => {
    const user = testUserId();
    const { id: layoutId } = await createLayout(user);
    const id = await insertRow({ layoutId, userId: user, wpm: 100 });
    const { privateKey, pubkeyB64url } = await generateKeyPair();
    const owner = testUserId();
    const clientId = "wpm-bind-client";
    await seedClient(clock, { id: clientId, pubkeyB64url, ownerUserId: owner, caps: "act-as-user" });
    const path = `/v1/wpm/submissions/${id}/discord-message`;
    const send = async (actor: string, message_id: string) => {
      const payload = { ...body, message_id };
      const headers = await signHeaders({ privateKey, clientId, actor, method: "PUT", pathWithQuery: path, body: new TextEncoder().encode(JSON.stringify(payload)) });
      return writeFetch(path, "PUT", headers, payload);
    };
    expect((await send(owner, body.message_id)).status).toBe(404);
    const results = await Promise.all([send(user, body.message_id), send(user, "900000000000000004")]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    const winner = await results.find((r) => r.status === 200)!.json() as { source_message_url: string };
    expect(await testStore.row("wpm_submissions", { id })).toMatchObject(winner);
  });
});
