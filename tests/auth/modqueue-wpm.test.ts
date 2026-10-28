// [LDB-WPM8] Mod-queue Discord notify for WPM submissions
// (`src/core/modqueue.ts`, docs/decisions/28-wpm-records.md): the same
// at-most-once claim pattern as links (LDB-MD11/LDB-MD12), one sweep per
// queue table. Same "fake the outside service, count calls" approach as
// tests/auth/modqueue.test.ts; no wall-clock assertions anywhere.
import { SELF, env, store, testStore } from "../harness";
import { pick } from "./store-support";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ulid } from "ulidx";
import type { Bindings } from "../../src/env";
import { commitWrite, type CommitInput } from "../../src/core/events";
import { buildMessageContent, buildWpmMessageContent, notifyPending, updateQueueNotification } from "../../src/core/modqueue";
import { fixedClock } from "../../src/core/time";
import { actorFixture, register } from "../api/write-support";
import { buildV2StatusPatch } from "../../src/core/modqueue-message";

const bindings = env as unknown as Bindings;
const clock = fixedClock("2026-10-18T00:00:00.000Z");

const WEBHOOK_URL = "https://discord.test/api/webhooks/modqueue-wpm-test";

function envWith(webhook: string | undefined): Bindings {
  return { ...bindings, MODQUEUE_DISCORD_WEBHOOK: webhook };
}

afterEach(() => {
  vi.unstubAllGlobals();
  delete (bindings as { MODQUEUE_DISCORD_WEBHOOK?: string }).MODQUEUE_DISCORD_WEBHOOK;
});

let uniqueCounter = 0;
function uniqueName(prefix: string): string {
  uniqueCounter++;
  return `${prefix}-${uniqueCounter}`;
}

async function freshLayout(name: string, owner = "900000000000000001"): Promise<string> {
  const input: CommitInput = {
    layoutId: ulid(),
    creating: true,
    currentN: 0,
    currentLayout: null,
    currentFormats: new Map(),
    layout: { kind: "created", name, owner, created_at: clock(), deleted: false },
    format: { kind: "format_added", lineage: "spark", format: "spark/1", payload: { keys: {} }, hasMagic: false },
    modified_at: clock(),
    actor: owner,
    via: "discord",
    source: { client: "discord-app:test", version: null },
    upstream: null,
  };
  const { layout } = await commitWrite(store, clock, input);
  return layout.id;
}

async function insertWpm(o: { layoutId: string; userId: string; wpm?: number; proof?: string; status?: string }): Promise<string> {
  const id = ulid();
  await testStore.insert("wpm_submissions", { id, layout_id: o.layoutId, user_id: o.userId, wpm: o.wpm ?? 85, proof: o.proof ?? "https://example.org/wpm-proof", submitted_by: o.userId, via: "discord", submitted_at: clock(), status: o.status ?? "pending", decided_by: null, decided_at: null, reason: null, notified_at: null });
  return id;
}

async function insertLink(layoutId: string, submittedBy: string): Promise<string> {
  const id = ulid();
  await testStore.insert("link_submissions", { id, layout_id: layoutId, url: "https://example.org/a-link", submitted_by: submittedBy, submitted_at: clock(), status: "pending", decided_by: null, decided_at: null, reason: null, notified_at: null });
  return id;
}

async function insertAuthor(userId: string, name: string): Promise<void> {
  await testStore.insert("authors", { user_id: userId, name, first_seen_at: clock(), last_seen_at: clock() });
}

async function readWpm(id: string): Promise<{ status: string; notified_at: string | null }> {
  const row = pick<{ status: string; notified_at: string | null }>(await testStore.row("wpm_submissions", { id }), "status", "notified_at");
  if (row === null) throw new Error(`no such submission '${id}'`);
  return row;
}

interface LoggedPost {
  url: string;
  method?: string;
  body: { content: string; allowed_mentions: { parse: string[] } };
}

class FakeWebhook {
  readonly requests: LoggedPost[] = [];
  private readonly contents = new Map<string, string>();
  constructor(private readonly answer: (callIndex: number) => "throw" | number = () => 200) {}

  readonly fetchImpl: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    this.requests.push({ url, method: init?.method, body: JSON.parse(String(init?.body ?? "{}")) });
    const outcome = this.answer(this.requests.length - 1);
    if (outcome === "throw") throw new Error("fake webhook: network error");
    if (init?.method === "POST") {
      const id = `discord-wpm-${this.requests.length}`;
      this.contents.set(id, JSON.parse(String(init?.body ?? "{}")).content);
      return Response.json({ id }, { status: outcome });
    }
    if (init?.method === "GET") {
      const id = url.match(/\/messages\/([^?]+)/)?.[1] ?? "";
      return Response.json({ content: this.contents.get(id) ?? "" }, { status: outcome });
    }
    const id = url.match(/\/messages\/([^?]+)/)?.[1] ?? "";
    const body = JSON.parse(String(init?.body ?? "{}"));
    if (typeof body.content === "string") this.contents.set(id, body.content);
    return new Response(null, { status: outcome });
  };

  about(id: string): LoggedPost[] {
    return this.requests.filter((r) => typeof r.body.content === "string" && r.body.content.includes(id));
  }
}

describe("[LDB-WPM8] notifyPending covers the WPM queue", () => {
  it("[LDB-WPM8] a pending WPM submission is announced once, with layout, user, speed, proof and the inbox link; it stays pending", async () => {
    const layoutId = await freshLayout(uniqueName("modq-wpm-happy"));
    await insertAuthor("900000000000000110", "Fast Typist");
    const subId = await insertWpm({ layoutId, userId: "900000000000000110", wpm: 142, proof: "https://monkeytype.com/profile/fast" });

    const webhook = new FakeWebhook();
    await notifyPending(store, envWith(WEBHOOK_URL), clock, webhook.fetchImpl);
    await notifyPending(store, envWith(WEBHOOK_URL), clock, webhook.fetchImpl); // a second sweep never re-sends

    const sent = webhook.about(subId);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.url).toBe(`${WEBHOOK_URL}?wait=true`);
    expect(sent[0]!.body.allowed_mentions).toEqual({ parse: [] });
    const content = sent[0]!.body.content;
    expect(content).toContain(layoutId);
    expect(content).toContain("Fast Typist");
    expect(content).toContain("142 wpm");
    expect(content).toContain("<https://monkeytype.com/profile/fast>");
    expect(content).toContain("(<https://akldb.org/admin?tab=inbox>)");

    const after = await readWpm(subId);
    expect(after.status).toBe("pending");
    expect(after.notified_at).not.toBeNull();
  });

  it("[LDB-WPM8] no author row: the message falls back to the raw user id", async () => {
    const layoutId = await freshLayout(uniqueName("modq-wpm-noauthor"));
    const subId = await insertWpm({ layoutId, userId: "900000000000000111" });
    const webhook = new FakeWebhook();
    await notifyPending(store, envWith(WEBHOOK_URL), clock, webhook.fetchImpl);
    expect(webhook.about(subId)[0]!.body.content).toContain("900000000000000111");
  });

  it("[LDB-MD15] edits the original WPM message for approval and rejection", async () => {
    const layoutId = await freshLayout(uniqueName("modq-wpm-status"));
    const ids = [
      await insertWpm({ layoutId, userId: "900000000000000122" }),
      await insertWpm({ layoutId, userId: "900000000000000123" }),
    ];
    const webhook = new FakeWebhook();
    await notifyPending(store, envWith(WEBHOOK_URL), clock, webhook.fetchImpl);
    for (const [id, status, prefix] of [[ids[0]!, "approved", "✅ APPROVED"], [ids[1]!, "rejected", "❌ REJECTED"]] as const) {
      await testStore.patch("wpm_submissions", { id }, { status });
      await updateQueueNotification(store, envWith(WEBHOOK_URL), "wpm", id, webhook.fetchImpl);
      const edit = webhook.requests.find((r) => r.method === "PATCH" && r.body.content.includes(id));
      expect(edit?.url).toContain(`/messages/discord-wpm-`);
      expect(edit?.body.content.startsWith(`${prefix}\nNew WPM submission`)).toBe(true);
      expect(edit?.body.allowed_mentions).toEqual({ parse: [] });
    }
  });

  it("[LDB-WPM8] links and WPM are both announced in one sweep, each exactly once; the link message points at the inbox now", async () => {
    const layoutId = await freshLayout(uniqueName("modq-wpm-both"));
    const linkId = await insertLink(layoutId, "900000000000000112");
    const wpmId = await insertWpm({ layoutId, userId: "900000000000000112" });

    const webhook = new FakeWebhook();
    await Promise.all([notifyPending(store, envWith(WEBHOOK_URL), clock, webhook.fetchImpl), notifyPending(store, envWith(WEBHOOK_URL), clock, webhook.fetchImpl)]);

    expect(webhook.about(linkId)).toHaveLength(1);
    expect(webhook.about(wpmId)).toHaveLength(1);
    expect(webhook.about(linkId)[0]!.body.content).toContain("(<https://akldb.org/admin?tab=inbox>)");
    expect(webhook.about(linkId)[0]!.body.content).toContain("link submission");
    expect(webhook.about(wpmId)[0]!.body.content).toContain("WPM submission");
  });

  it("[LDB-WPM8] two concurrent calls (submit-path + cron-path racing) never double-announce the same WPM submission", async () => {
    const layoutId = await freshLayout(uniqueName("modq-wpm-race"));
    const subId = await insertWpm({ layoutId, userId: "900000000000000113" });
    const webhook = new FakeWebhook();
    await Promise.all([
      notifyPending(store, envWith(WEBHOOK_URL), clock, webhook.fetchImpl),
      notifyPending(store, envWith(WEBHOOK_URL), clock, webhook.fetchImpl),
      notifyPending(store, envWith(WEBHOOK_URL), clock, webhook.fetchImpl),
    ]);
    expect(webhook.about(subId)).toHaveLength(1);
  });

  it("[LDB-WPM8] a webhook failure (non-2xx, thrown, or 429) releases the claim so a later sweep re-sends", async () => {
    const layoutId = await freshLayout(uniqueName("modq-wpm-fail"));
    const subId = await insertWpm({ layoutId, userId: "900000000000000114" });

    for (const outcome of [500, "throw", 429] as const) {
      const failing = new FakeWebhook(() => outcome);
      await notifyPending(store, envWith(WEBHOOK_URL), clock, failing.fetchImpl);
      expect(failing.about(subId), String(outcome)).toHaveLength(1);
      expect((await readWpm(subId)).notified_at, String(outcome)).toBeNull();
    }
    // A fresh caller must still honor Discord's durable cooldown.
    const deferred = new FakeWebhook();
    await notifyPending(store, envWith(WEBHOOK_URL), clock, deferred.fetchImpl);
    expect(deferred.about(subId)).toHaveLength(0);
    await testStore.patch("modqueue_delivery_gate", { id: 1 }, { retry_at: 0 });
    const succeeding = new FakeWebhook();
    await notifyPending(store, envWith(WEBHOOK_URL), clock, succeeding.fetchImpl);
    expect(succeeding.about(subId)).toHaveLength(1);
    expect((await readWpm(subId)).notified_at).not.toBeNull();
  });

  it("[LDB-WPM8] a superseded, approved or rejected submission is never announced", async () => {
    const layoutId = await freshLayout(uniqueName("modq-wpm-decided"));
    const ids = [
      await insertWpm({ layoutId, userId: "900000000000000115", status: "superseded" }),
      await insertWpm({ layoutId, userId: "900000000000000116", status: "approved" }),
      await insertWpm({ layoutId, userId: "900000000000000117", status: "rejected" }),
    ];
    const webhook = new FakeWebhook();
    await notifyPending(store, envWith(WEBHOOK_URL), clock, webhook.fetchImpl);
    for (const id of ids) {
      expect(webhook.about(id)).toHaveLength(0);
      expect((await readWpm(id)).notified_at).toBeNull();
    }
  });

  it("[LDB-WPM8] MODQUEUE_DISCORD_WEBHOOK unset (or empty) is a complete no-op for WPM too: no fetch, no notified_at write", async () => {
    const layoutId = await freshLayout(uniqueName("modq-wpm-unset"));
    const subId = await insertWpm({ layoutId, userId: "900000000000000118" });
    const webhook = new FakeWebhook();
    await notifyPending(store, envWith(undefined), clock, webhook.fetchImpl);
    await notifyPending(store, envWith(""), clock, webhook.fetchImpl);
    expect(webhook.requests).toHaveLength(0);
    expect(await readWpm(subId)).toEqual({ status: "pending", notified_at: null });
  });

  it("[LDB-WPM8] buildWpmMessageContent escapes markdown in the layout and user names, and a proof URL cannot break out of its <...> wrapper", () => {
    const content = buildWpmMessageContent({
      id: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
      layout_id: "01BX5ZZKBKACTAV9WEVGEMMVRY",
      user_id: "900000000000000119",
      wpm: 99,
      proof: "https://example.org/a>b c<d",
      layout_name: "*bold* [masked](https://evil.example)",
      user_name: "*Evil* `Name`",
    });
    expect(content).toContain("\\*bold\\* \\[masked\\](https://evil.example)");
    expect(content).toContain("\\*Evil\\* \\`Name\\`");
    expect(content).toContain("<https://example.org/a%3Eb%20c%3Cd>");
    expect(content).toContain("99 wpm");
    expect(content).toContain("(<https://akldb.org/l/01BX5ZZKBKACTAV9WEVGEMMVRY>)");
    expect(buildMessageContent({ id: "x", layout_id: "y", url: "https://example.org/x", submitted_by: "1", layout_name: "n", submitter_name: null })).toContain("tab=inbox");
  });

  it("[LDB-WPM8] the submit path announces a fresh queued submission through waitUntil (webhook set), without waiting for the cron", async () => {
    const fake = actorFixture();
    const user = "900000000000000120";
    const auth = register(fake, "tok-wpm-modq-route", user);
    const layoutId = await freshLayout(uniqueName("modq-wpm-route"));
    const webhook = new FakeWebhook();
    vi.stubGlobal("fetch", (url: string, init: { headers: Record<string, string>; signal?: AbortSignal }) => (url.startsWith(WEBHOOK_URL) ? webhook.fetchImpl(url, init) : fake.fetchImpl(url, init)));
    (bindings as { MODQUEUE_DISCORD_WEBHOOK?: string }).MODQUEUE_DISCORD_WEBHOOK = WEBHOOK_URL;

    const res = await SELF.fetch("https://example.com/v1/wpm", {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ layout: layoutId, wpm: 88, proof: "https://example.org/route-proof" }),
    });
    expect(res.status).toBe(202);
    const { submission } = (await res.json()) as { submission: { id: string } };

    // `waitUntil` is not awaited by SELF.fetch: poll (bounded by iterations,
    // not by an asserted duration) for the announcement to land.
    for (let i = 0; i < 500 && webhook.about(submission.id).length === 0; i++) await new Promise((r) => setTimeout(r, 10));
    expect(webhook.about(submission.id)).toHaveLength(1);
    expect(webhook.about(submission.id)[0]!.body.content).toContain("88 wpm");
  });
});

describe("[LDB-MD21] WPM notification review versions", () => {
  for (const components of [false, true]) {
    it(`[LDB-MD22] migration refreshes an existing ${components ? "V2" : "legacy"} numeric author, retries failures and then stops`, async () => {
      const layoutId = await freshLayout(uniqueName("modq-wpm-name"));
      const userId = "900000000000000144";
      const id = await insertWpm({ layoutId, userId, wpm: 141 });
      const config = components ? { ...envWith(undefined), MODQUEUE_DISCORD_CARDS: "true", MODQUEUE_DISCORD_ACTIONS: "true",
        MODQUEUE_DISCORD_BOT_TOKEN: "fake", MODQUEUE_DISCORD_CHANNEL_ID: "900000000000000103" } : envWith(WEBHOOK_URL);
      let remote: Record<string, unknown> = {};
      let patches = 0;
      let fail = true;
      const fetchImpl: typeof fetch = async (_input, init) => {
        if (init?.method === "GET") return Response.json(remote);
        if (init?.method === "PATCH") {
          patches++;
          if (fail) return new Response("retry", { status: 503 });
        }
        remote = JSON.parse(String(init?.body));
        return Response.json({ id: "900000000000000107" });
      };
      await notifyPending(store, config, clock, fetchImpl);
      expect(JSON.stringify(remote)).toContain(`<@${userId}>`);
      remote = JSON.parse(JSON.stringify(remote).replace(`<@${userId}>`, userId));
      // Already-decided cards need the same name repair without a new review.
      await testStore.patch("wpm_submissions", { id }, { status: "approved" });
      await testStore.patch("modqueue_notifications", { submission_id: id }, { shown_status: "approved" });
      const previous = (await testStore.rows<{ kind: string; submission_id: string; shown_review_version: number }>("modqueue_notifications"))
        .filter((r) => r.submission_id !== id);
      // migrations/0031_modqueue_user_names.sql: reset every tracked card's shown_review_version.
      await testStore.patch("modqueue_notifications", {}, { shown_review_version: -1 });
      expect((await testStore.rows<{ shown_review_version: number }>("modqueue_notifications")).filter((r) => r.shown_review_version !== -1)).toHaveLength(0);
      // This file shares storage between tests. Leave earlier fixtures as
      // they were so this migration replay cannot enqueue unrelated cards.
      for (const row of previous) await testStore.patch("modqueue_notifications", { kind: row.kind, submission_id: row.submission_id }, { shown_review_version: row.shown_review_version });
      await notifyPending(store, config, clock, fetchImpl);
      expect(patches).toBe(1);
      expect(JSON.stringify(remote)).not.toContain(`<@${userId}>`);
      expect(pick(await testStore.row("modqueue_notifications", { submission_id: id }), "shown_review_version")).toEqual({ shown_review_version: -1 });
      fail = false;
      await notifyPending(store, config, clock, fetchImpl);
      expect(patches).toBe(2);
      expect(JSON.stringify(remote)).toContain(`<@${userId}>`);
      expect(JSON.stringify(remote)).toMatch(/Approved|APPROVED/);
      expect(remote.allowed_mentions).toEqual({ parse: [] });
      expect(pick(await testStore.row("modqueue_notifications", { submission_id: id }), "shown_status", "shown_review_version")).toEqual({ shown_status: "approved", shown_review_version: 0 });
      await notifyPending(store, config, clock, fetchImpl);
      expect(patches).toBe(2);
    });
  }

  it("[LDB-MD21] refreshes the WPM decision footer from stored reason and removes it after reopening", async () => {
    const layoutId = await freshLayout(uniqueName("modq-wpm-footer"));
    const id = await insertWpm({ layoutId, userId: "900000000000000142", wpm: 150 });
    const env = { ...envWith(undefined), MODQUEUE_DISCORD_CARDS: "true", MODQUEUE_DISCORD_COMPONENTS: "true", MODQUEUE_DISCORD_ACTIONS: "true",
      MODQUEUE_DISCORD_BOT_TOKEN: "fake", MODQUEUE_DISCORD_CHANNEL_ID: "900000000000000103" };
    let remote: Record<string, unknown> = {};
    const fetchImpl: typeof fetch = async (_input, init) => {
      if (init?.method === "GET") return Response.json(remote);
      remote = JSON.parse(String(init?.body));
      return Response.json({ id: "900000000000000106" });
    };
    await notifyPending(store, env, clock, fetchImpl);
    expect(JSON.stringify(remote)).toContain("**150 WPM** · [View proof]");
    expect(JSON.stringify(remote)).not.toMatch(/Pending|PENDING/);
    await testStore.patch("wpm_submissions", { id }, { status: "rejected", reason: "Wrong layout" });
    await updateQueueNotification(store, env, "wpm", id, fetchImpl);
    expect(JSON.stringify(remote)).toContain("**❌ Denied**");
    expect(JSON.stringify(remote)).toContain("**Reason:** Wrong layout");
    expect(JSON.stringify(remote)).toContain(`reopen-rejected|${id}|0`);
    await testStore.patch("wpm_submissions", { id }, { status: "pending", review_version: 1 });
    await updateQueueNotification(store, env, "wpm", id, fetchImpl);
    expect(JSON.stringify(remote)).not.toMatch(/Pending|PENDING|Reason:|Denied/);
    expect(JSON.stringify(remote)).toContain(`approve|${id}|1`);
    expect(JSON.stringify(remote)).toContain("**150 WPM** · [View proof]");
  });

  it("[LDB-MD21] first announcement after reopening uses the current version, including a reopen racing POST", async () => {
    const layoutId = await freshLayout(uniqueName("modq-wpm-reopened-post"));
    const id = await insertWpm({ layoutId, userId: "900000000000000141" });
    await testStore.patch("wpm_submissions", { id }, { review_version: 1 });
    const env = { ...envWith(undefined), MODQUEUE_DISCORD_CARDS: "true", MODQUEUE_DISCORD_ACTIONS: "true",
      MODQUEUE_DISCORD_BOT_TOKEN: "fake", MODQUEUE_DISCORD_CHANNEL_ID: "900000000000000103" };
    let posted: Record<string, unknown> = {};
    let patched: Record<string, unknown> = {};
    const fetchImpl: typeof fetch = async (_input, init) => {
      if (init?.method === "POST") {
        posted = JSON.parse(String(init.body));
        // The original pending card can still be in flight when its review
        // is decided and reopened, returning the status to the same string.
        await testStore.patch("wpm_submissions", { id }, { review_version: 2 });
        return Response.json({ id: "900000000000000105" });
      }
      if (init?.method === "GET") return Response.json(posted);
      patched = JSON.parse(String(init?.body));
      return Response.json({ id: "900000000000000105" });
    };
    await notifyPending(store, env, clock, fetchImpl);
    expect(JSON.stringify(posted)).toContain(`aklmod2|wpm|approve|${id}|1`);
    expect(JSON.stringify(patched)).toContain(`aklmod2|wpm|approve|${id}|2`);
    expect(pick(await testStore.row("modqueue_notifications", { submission_id: id }), "shown_status", "shown_review_version"))
      .toEqual({ shown_status: "pending", shown_review_version: 2 });
  });
});

describe("WPM inline proofs", () => {
  const sourceChannel = "900000000000000701";
  const sourceMessage = "900000000000000702";
  const proof = `https://discord.com/channels/900000000000000700/${sourceChannel}/${sourceMessage}`;
  const cdn = `https://cdn.discordapp.com/attachments/${sourceChannel}/900000000000000703/proof.png?ex=123&hm=456`;
  const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);
  const config = (): Bindings => ({ ...bindings, MODQUEUE_DISCORD_WEBHOOK: undefined, MODQUEUE_DISCORD_CARDS: "true",
    MODQUEUE_DISCORD_ACTIONS: "true", MODQUEUE_DISCORD_BOT_TOKEN: "test-bot", MODQUEUE_DISCORD_CHANNEL_ID: "900000000000000704" });

  it("[LDB-WPM13] uploads a cross-server image once after claiming, and every review transition preserves the same snapshot", async () => {
    const layoutId = await freshLayout(uniqueName("proof-snapshot"));
    const id = await insertWpm({ layoutId, userId: "900000000000000705", proof });
    let remote: Record<string, unknown> = {};
    let reads = 0, downloads = 0, posts = 0;
    let uploaded: Uint8Array | undefined;
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.endsWith(`/channels/${sourceChannel}/messages/${sourceMessage}`)) {
        reads++;
        return Response.json({ id: sourceMessage, channel_id: sourceChannel, attachments: [{ url: cdn, filename: "proof.png", content_type: "image/png", size: png.length }] });
      }
      if (url === cdn) { downloads++; return new Response(png, { headers: { "content-type": "image/png" } }); }
      if (init?.method === "POST") {
        posts++;
        expect(init.body).toBeInstanceOf(FormData);
        const form = init.body as FormData;
        remote = JSON.parse(String(form.get("payload_json")));
        expect(remote).not.toHaveProperty("__files");
        const file = form.get("files[0]") as File;
        expect(file.name).toBe("wpm-proof-1.png");
        expect(file.type).toBe("image/png");
        uploaded = new Uint8Array(await file.arrayBuffer());
        remote.attachments = [{ id: "900000000000000706", filename: file.name }];
        return Response.json({ id: "900000000000000707" });
      }
      if (init?.method === "GET") return Response.json(remote);
      const patch = JSON.parse(String(init?.body));
      remote = { ...remote, ...patch };
      return Response.json(remote);
    };
    await Promise.all([notifyPending(store, config(), clock, fetchImpl), notifyPending(store, config(), clock, fetchImpl)]);
    expect(uploaded).toEqual(png);
    expect(JSON.stringify(remote)).toContain("attachment://wpm-proof-1.png");
    expect(JSON.stringify(remote)).toContain(proof);
    expect(pick(await testStore.row("wpm_submissions", { id }), "proof")).toEqual({ proof });
    for (const [status, version] of [["approved", 0], ["pending", 1], ["rejected", 1], ["superseded", 1]] as const) {
      await testStore.patch("wpm_submissions", { id }, { status, review_version: version });
      await updateQueueNotification(store, config(), "wpm", id, fetchImpl);
      expect(remote.attachments).toEqual([{ id: "900000000000000706", filename: "wpm-proof-1.png" }]);
      expect(JSON.stringify(remote)).toContain("attachment://wpm-proof-1.png");
    }
    await notifyPending(store, config(), clock, fetchImpl);
    expect({ reads, downloads, posts }).toEqual({ reads: 1, downloads: 1, posts: 1 });

    // Real Discord lists a V2 card's uploads only inside its media items (top-level
    // `attachments: []`, no attachment id on the item). An explicit list would make
    // Discord delete the proof, so the status edit sends none (observed 2026-10-28).
    const mediaOnly = { ...remote, attachments: [], components: [{ type: 17, id: 41000, components: [
      { type: 12, id: 41010, items: [{ media: { id: "900000000000000708", url: cdn, loading_state: 2 } }] },
    ] }] };
    const patch = buildV2StatusPatch(mediaOnly, "wpm", id, { status: "approved", decider_name: null });
    expect(patch).not.toHaveProperty("attachments");
  });

  it("[LDB-WPM13] preview lookup and rejected upload failures still post a useful link-only card", async () => {
    const layoutId = await freshLayout(uniqueName("proof-fallback"));
    for (const failure of ["read", 400, 403, 413] as const) {
      const id = await insertWpm({ layoutId, userId: failure === "read" ? "900000000000000710" : `900000000000000${failure}`, proof });
      let posted: Record<string, unknown> = {};
      let posts = 0;
      const fetchImpl: typeof fetch = async (input, init) => {
        if (String(input).endsWith(`/messages/${sourceMessage}`)) {
          return failure === "read" ? new Response(null, { status: 403 })
            : Response.json({ id: sourceMessage, channel_id: sourceChannel, attachments: [{ url: cdn, content_type: "image/png" }] });
        }
        if (String(input) === cdn) return new Response(png, { headers: { "content-type": "image/png" } });
        if (init?.method === "POST") {
          posts++;
          if (init.body instanceof FormData) return new Response(null, { status: failure === "read" ? 500 : failure });
          posted = JSON.parse(String(init.body));
          return Response.json({ id: failure === "read" ? "900000000000000712" : `900000000000001${failure}` });
        }
        throw new Error("Unexpected request");
      };
      await notifyPending(store, config(), clock, fetchImpl);
      expect(JSON.stringify(posted)).toContain(proof);
      expect(JSON.stringify(posted)).toContain("Image preview unavailable");
      expect(JSON.stringify(posted)).toContain(`approve|${id}|0`);
      expect(posts).toBe(failure === "read" ? 1 : 2);
      expect((await readWpm(id)).notified_at).not.toBeNull();
    }
  });

  it("[LDB-WPM14] a refused YouTube thumbnail falls back to the Watch link without losing the submission", async () => {
    const layoutId = await freshLayout(uniqueName("youtube-fallback"));
    const proof = "https://youtu.be/aBcD_123-45?t=80";
    const id = await insertWpm({ layoutId, userId: "900000000000000725", proof });
    const posts: Record<string, unknown>[] = [];
    const fetchImpl: typeof fetch = async (_input, init) => {
      expect(init?.method).toBe("POST");
      const body = JSON.parse(String(init?.body));
      posts.push(body);
      return posts.length === 1 ? new Response(null, { status: 400 }) : Response.json({ id: "900000000000000726" });
    };
    await notifyPending(store, config(), clock, fetchImpl);
    expect(posts).toHaveLength(2);
    expect(JSON.stringify(posts[0])).toContain("hqdefault.jpg");
    expect(JSON.stringify(posts[1])).not.toContain("hqdefault.jpg");
    expect(JSON.stringify(posts[1])).toContain("Watch on YouTube");
    expect(JSON.stringify(posts[1])).toContain(proof);
    expect((await readWpm(id)).notified_at).not.toBeNull();
  });

  it("[LDB-WPM14] YouTube stays one V2 card with a thumbnail and Watch link through decisions and reopening", async () => {
    const layoutId = await freshLayout(uniqueName("proof-youtube"));
    const proof = "https://youtu.be/aBcD_123-45?t=80&si=tracking";
    const id = await insertWpm({ layoutId, userId: "900000000000000720", proof });
    let remote: Record<string, unknown> = {};
    let posts = 0;
    const fetchImpl: typeof fetch = async (input, init) => {
      expect(String(input)).toContain(`/channels/${config().MODQUEUE_DISCORD_CHANNEL_ID}/messages`);
      if (init?.method === "GET") return Response.json(remote);
      const body = JSON.parse(String(init?.body));
      expect(body).not.toHaveProperty("embeds");
      expect(body).not.toHaveProperty("content");
      expect(body.flags).toBe(32768);
      if (init?.method === "POST") posts++;
      remote = { ...remote, ...body };
      return Response.json({ id: "900000000000000721" });
    };
    await notifyPending(store, config(), clock, fetchImpl);
    const checkPreview = () => {
      expect(JSON.stringify(remote)).toContain("https://i.ytimg.com/vi/aBcD_123-45/hqdefault.jpg");
      expect(JSON.stringify(remote)).toContain("[Watch on YouTube](<https://www.youtube.com/watch?v=aBcD_123-45&t=80>)");
      expect(JSON.stringify(remote)).toContain(proof);
      expect(remote.allowed_mentions).toEqual({ parse: [] });
    };
    checkPreview();
    expect(pick(await testStore.row("modqueue_notifications", { submission_id: id }), "message_format", "transport"))
      .toEqual({ message_format: "components_v2", transport: "bot" });
    for (const [status, version] of [["rejected", 0], ["pending", 1], ["approved", 1]] as const) {
      await testStore.patch("wpm_submissions", { id }, { status, review_version: version, reason: "Wrong layout" });
      await updateQueueNotification(store, config(), "wpm", id, fetchImpl);
      checkPreview();
      const controls = JSON.stringify(remote.components);
      expect(controls).toContain(`${status === "pending" ? "approve" : `reopen-${status}`}|${id}|${version}`);
      if (status === "rejected") expect(controls).toContain("**Reason:** Wrong layout");
      else expect(controls).not.toContain("Wrong layout");
    }
    await notifyPending(store, config(), clock, fetchImpl);
    expect(posts).toBe(1);
  });
});

describe("original receipt reconciliation", () => {
  const source = "https://discord.com/channels/900000000000000001/900000000000000002/900000000000000003";
  const bind = (id: string) => testStore.patch("wpm_submissions", { id }, { source_message_url: source });
  const shown = async (id: string) => pick<{ shown_source_message_url: string | null }>(await testStore.row("modqueue_notifications", { kind: "wpm", submission_id: id }), "shown_source_message_url");
  const cardEnv = () => ({ ...bindings, MODQUEUE_DISCORD_CARDS: "true", MODQUEUE_DISCORD_ACTIONS: "true", MODQUEUE_DISCORD_BOT_TOKEN: "fake-token", MODQUEUE_DISCORD_CHANNEL_ID: "900000000000000004" });

  it("[LDB-WPM17] a binding during the initial Discord POST reconciles using the URL actually rendered", async () => {
    const layoutId = await freshLayout(uniqueName("source-post"));
    const id = await insertWpm({ layoutId, userId: "900000000000000801", proof: "https://example.org/proof" });
    let message: Record<string, unknown> = {};
    const patches: Record<string, unknown>[] = [];
    const fetchImpl: typeof fetch = async (_input, init) => {
      if (init?.method === "POST") {
        message = JSON.parse(String(init.body));
        expect(JSON.stringify(message)).not.toContain(source);
        await bind(id);
        return Response.json({ id: "900000000000000005" });
      }
      if (init?.method === "GET") return Response.json(message);
      if (init?.method === "PATCH") {
        message = JSON.parse(String(init.body));
        patches.push(message);
        return Response.json({ id: "900000000000000005" });
      }
      return new Response(null, { status: 404 });
    };
    await notifyPending(store, cardEnv(), clock, fetchImpl);
    expect(patches).toHaveLength(1);
    expect(JSON.stringify(patches[0])).toContain(source);
    expect(await shown(id)).toEqual({ shown_source_message_url: source });
    await notifyPending(store, cardEnv(), clock, fetchImpl);
    expect(patches).toHaveLength(1);
  });

  it("[LDB-WPM17] binding during a status PATCH converges before releasing the lease", async () => {
    const layoutId = await freshLayout(uniqueName("source-patch"));
    const id = await insertWpm({ layoutId, userId: "900000000000000802" });
    let message: Record<string, unknown> = {};
    const patches: Record<string, unknown>[] = [];
    const fetchImpl: typeof fetch = async (_input, init) => {
      if (init?.method === "POST") { message = JSON.parse(String(init.body)); return Response.json({ id: "900000000000000006" }); }
      if (init?.method === "GET") return Response.json(message);
      if (init?.method === "PATCH") {
        message = JSON.parse(String(init.body)); patches.push(message);
        if (patches.length === 1) {
          expect(JSON.stringify(message)).not.toContain(source);
          await bind(id);
        }
        return Response.json({ id: "900000000000000006" });
      }
      return new Response(null, { status: 404 });
    };
    await notifyPending(store, cardEnv(), clock, fetchImpl);
    await testStore.patch("wpm_submissions", { id }, { status: "approved" });
    await updateQueueNotification(store, cardEnv(), "wpm", id, fetchImpl);
    expect(patches).toHaveLength(2);
    expect(JSON.stringify(patches[1])).toContain(source);
    expect(await shown(id)).toEqual({ shown_source_message_url: source });
  });

  it("[LDB-WPM17] late binding retries unchanged status after a failed edit and legacy links remain bounded and unique", async () => {
    const layoutId = await freshLayout(uniqueName("source-late"));
    const id = await insertWpm({ layoutId, userId: "900000000000000803" });
    const webhook = new FakeWebhook();
    await notifyPending(store, envWith(WEBHOOK_URL), clock, webhook.fetchImpl);
    await bind(id);
    let failures = 0;
    const failPatch: typeof fetch = async (input, init) => {
      if (init?.method === "PATCH") { failures++; return new Response(null, { status: 503 }); }
      return webhook.fetchImpl(input, init);
    };
    await updateQueueNotification(store, envWith(WEBHOOK_URL), "wpm", id, failPatch);
    expect(failures).toBe(1);
    expect(await shown(id)).toEqual({ shown_source_message_url: null });
    await notifyPending(store, envWith(WEBHOOK_URL), clock, webhook.fetchImpl);
    expect(await shown(id)).toEqual({ shown_source_message_url: source });
    for (const status of ["approved", "pending", "rejected", "superseded"]) {
      const current = await testStore.row<{ review_version: number }>("wpm_submissions", { id });
      await testStore.patch("wpm_submissions", { id }, { status, review_version: current!.review_version + 1 });
      await updateQueueNotification(store, envWith(WEBHOOK_URL), "wpm", id, webhook.fetchImpl);
    }
    const patches = webhook.requests.filter((r) => r.method === "PATCH");
    expect(patches.length).toBe(5);
    for (const patch of patches) {
      expect(patch.body.content.split(source)).toHaveLength(2);
      expect(patch.body.content.length).toBeLessThanOrEqual(2000);
      expect(patch.body.allowed_mentions).toEqual({ parse: [] });
    }
    const oversized = buildWpmMessageContent({ id, layout_id: layoutId, user_id: "900000000000000803", user_name: "😀".repeat(2000), layout_name: "Dvorak", wpm: 184, proof: "https://example.org/proof", source_message_url: source });
    expect(oversized.length).toBeLessThanOrEqual(2000);
    expect(oversized.endsWith(`[Original message](<${source}>)`)).toBe(true);
  });
});
