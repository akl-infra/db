// [LDB-MD11] [LDB-MD12] Mod-queue Discord notify (`src/core/modqueue.ts`'s
// `notifyPending`, migrations/0019): a `pending` link submission is
// announced to a Discord webhook at most once ever, across any number of
// concurrent submit-path/cron-path callers -- same "fake the outside
// service, count calls, inspect the body" pattern `tests/auth/fake-
// discord.ts` uses for Discord's own `/oauth2/@me`, here for the
// webhook's `POST` instead. No wall-clock timing assertions anywhere --
// races are proven with `Promise.all` + a call count, never a sleep.
import { env, store, testStore } from "../harness";
import { pick } from "./store-support";
import { describe, expect, it } from "vitest";
import { ulid } from "ulidx";
import type { Bindings } from "../../src/env";
import { commitWrite, type CommitInput } from "../../src/core/events";
import { buildMessageContent, notifyPending, updateQueueNotification } from "../../src/core/modqueue";
import { buildV2Payload } from "../../src/core/modqueue-message";
import { fixedClock } from "../../src/core/time";

const bindings = env as unknown as Bindings;
const clock = fixedClock("2026-09-28T00:00:00.000Z");

const WEBHOOK_URL = "https://discord.test/api/webhooks/modqueue-test";
const fakeMessages = new Map<string, string>();
let fakeMessageCounter = 0;

function envWith(webhook: string | undefined): Bindings {
  return { ...bindings, MODQUEUE_DISCORD_WEBHOOK: webhook };
}

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

async function insertSubmission(opts: { layoutId: string; url: string; submittedBy: string; status?: string }): Promise<string> {
  const id = ulid();
  await testStore.insert("link_submissions", { id, layout_id: opts.layoutId, url: opts.url, submitted_by: opts.submittedBy, submitted_at: clock(), status: opts.status ?? "pending", decided_by: null, decided_at: null, reason: null, notified_at: null });
  return id;
}

async function insertAuthor(userId: string, name: string): Promise<void> {
  await testStore.insert("authors", { user_id: userId, name, first_seen_at: clock(), last_seen_at: clock() });
}

async function readSubmission(id: string): Promise<{ status: string; notified_at: string | null }> {
  const row = pick<{ status: string; notified_at: string | null }>(await testStore.row("link_submissions", { id }), "status", "notified_at");
  if (row === null) throw new Error(`no such submission '${id}'`);
  return row;
}

interface LoggedPost {
  url: string;
  method: string | undefined;
  body: { content: string; allowed_mentions: { parse: string[] } };
}

// A fake Discord incoming webhook: logs every POST, answers with a
// scripted status (204 by default -- a real webhook's own success status)
// or throws for a "network error" case.
class FakeWebhook {
  readonly requests: LoggedPost[] = [];
  constructor(private readonly answer: (callIndex: number) => "throw" | number = () => 200) {}

  readonly fetchImpl: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const body = JSON.parse(String(init?.body ?? "{}"));
    this.requests.push({ url, method: init?.method, body });
    const outcome = this.answer(this.requests.length - 1);
    if (outcome === "throw") throw new Error("fake webhook: network error");
    if (init?.method === "POST") {
      const id = `discord-message-${++fakeMessageCounter}`;
      fakeMessages.set(id, body.content);
      return Response.json({ id }, { status: outcome });
    }
    if (init?.method === "GET") {
      const id = url.match(/\/messages\/([^?]+)/)?.[1] ?? "";
      return Response.json({ content: fakeMessages.get(id) ?? "" }, { status: outcome });
    }
    const id = url.match(/\/messages\/([^?]+)/)?.[1] ?? "";
    if (typeof body.content === "string") fakeMessages.set(id, body.content);
    return new Response(null, { status: outcome });
  };
}

describe("[LDB-MD11] [LDB-MD12] notifyPending", () => {
  it("[LDB-MD11] happy path: a pending submission is announced once, notified_at is set, and the message is correct", async () => {
    const layoutId = await freshLayout(uniqueName("modq-happy"));
    await insertAuthor("900000000000000010", "Mod Tester");
    const subId = await insertSubmission({ layoutId, url: "https://example.org/happy", submittedBy: "900000000000000010" });

    const webhook = new FakeWebhook();
    await notifyPending(store, envWith(WEBHOOK_URL), clock, webhook.fetchImpl);

    expect(webhook.requests).toHaveLength(1);
    const [req] = webhook.requests;
    expect(req!.url).toBe(`${WEBHOOK_URL}?wait=true`);
    expect(req!.method).toBe("POST");
    expect(req!.body.allowed_mentions).toEqual({ parse: [] });
    expect(req!.body.content).toContain("Mod Tester");
    expect(req!.body.content).toContain("<https://example.org/happy>");
    expect(req!.body.content).toContain(subId);
    expect(req!.body.content).toContain(layoutId);

    const after = await readSubmission(subId);
    expect(after.status).toBe("pending"); // notifying never decides the submission
    expect(after.notified_at).not.toBeNull();
  });

  it("[LDB-MD11] no author row: the message falls back to the raw submitted_by user id", async () => {
    const layoutId = await freshLayout(uniqueName("modq-noauthor"));
    const subId = await insertSubmission({ layoutId, url: "https://example.org/noauthor", submittedBy: "900000000000000011" });

    const webhook = new FakeWebhook();
    await notifyPending(store, envWith(WEBHOOK_URL), clock, webhook.fetchImpl);

    expect(webhook.requests).toHaveLength(1);
    expect(webhook.requests[0]!.body.content).toContain("900000000000000011");
    void subId;
  });

  it("[LDB-MD15] edits the original message for approval and rejection, safely preserving the announcement", async () => {
    const layoutId = await freshLayout(uniqueName("modq-status"));
    const ids = [
      await insertSubmission({ layoutId, url: "https://example.org/approved", submittedBy: "900000000000000022" }),
      await insertSubmission({ layoutId, url: "https://example.org/rejected", submittedBy: "900000000000000023" }),
    ];
    const webhook = new FakeWebhook();
    await notifyPending(store, envWith(WEBHOOK_URL), clock, webhook.fetchImpl);
    for (const [id, status, prefix] of [[ids[0]!, "approved", "✅ APPROVED"], [ids[1]!, "rejected", "❌ REJECTED"]] as const) {
      await testStore.patch("link_submissions", { id }, { status });
      await updateQueueNotification(store, envWith(WEBHOOK_URL), "link", id, webhook.fetchImpl);
      await updateQueueNotification(store, envWith(WEBHOOK_URL), "link", id, webhook.fetchImpl);
      const edit = webhook.requests.find((r) => r.method === "PATCH" && r.body.content.includes(id));
      expect(edit?.url).toContain(`/messages/discord-message-`);
      expect(edit?.body.content.startsWith(`${prefix}\nNew link submission`)).toBe(true);
      expect(edit?.body.content).toContain(`<https://example.org/${status}>`);
      expect(edit?.body.allowed_mentions).toEqual({ parse: [] });
      expect((edit?.body.content.match(/✅ APPROVED|❌ REJECTED/g) ?? [])).toHaveLength(1);
    }
  });

  it("[LDB-MD15] reconciles a decision that lands before the POST response saves its message id", async () => {
    const layoutId = await freshLayout(uniqueName("modq-post-race"));
    const id = await insertSubmission({ layoutId, url: "https://example.org/post-race", submittedBy: "900000000000000024" });
    const requests: LoggedPost[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const body = JSON.parse(String(init?.body ?? "{}"));
      requests.push({ url, method: init?.method, body });
      if (init?.method === "POST") {
        if (body.content.includes(id)) {
          await testStore.patch("link_submissions", { id }, { status: "approved" });
          return Response.json({ id: "race-message-id" });
        }
        return Response.json({ id: "other-message-id" });
      }
      if (init?.method === "GET") return Response.json({ content: requests.find((r) => r.method === "POST" && r.body.content.includes(id))?.body.content ?? "" });
      return new Response(null, { status: 200 });
    };
    await notifyPending(store, envWith(WEBHOOK_URL), clock, fetchImpl);
    const edit = requests.find((r) => r.method === "PATCH" && r.body.content.includes(id));
    expect(edit?.url).toContain("/messages/race-message-id");
    expect(edit?.body.content.startsWith("✅ APPROVED\n")).toBe(true);
  });

  it("[LDB-MD15] retries a failed status edit on the next bounded notification sweep", async () => {
    const layoutId = await freshLayout(uniqueName("modq-edit-retry"));
    const id = await insertSubmission({ layoutId, url: "https://example.org/edit-retry", submittedBy: "900000000000000025" });
    const post = new FakeWebhook();
    await notifyPending(store, envWith(WEBHOOK_URL), clock, post.fetchImpl);
    await testStore.patch("link_submissions", { id }, { status: "rejected" });
    const failedEdit = new FakeWebhook((i) => i === 1 ? 500 : 200);
    await updateQueueNotification(store, envWith(WEBHOOK_URL), "link", id, failedEdit.fetchImpl);
    expect(failedEdit.requests.some((r) => r.method === "PATCH" && r.body.content.includes(id))).toBe(true);

    const retry = new FakeWebhook();
    await notifyPending(store, envWith(WEBHOOK_URL), clock, retry.fetchImpl);
    const retried = retry.requests.find((r) => r.method === "PATCH" && r.body.content.includes(id));
    expect(retried?.body.content.startsWith("❌ REJECTED\n")).toBe(true);
  });

  it("[LDB-MD15] keeps rate-limited edits dirty and cron converges after cooldown", async () => {
    const layoutId = await freshLayout(uniqueName("modq-cooldown"));
    const id = await insertSubmission({ layoutId, url: "https://example.org/cooldown", submittedBy: "900000000000000025" });
    await notifyPending(store, envWith(WEBHOOK_URL), clock, new FakeWebhook().fetchImpl);
    await testStore.patch("link_submissions", { id }, { status: "rejected" });
    const limited = new FakeWebhook((i) => i === 1 ? 429 : 200);
    await updateQueueNotification(store, envWith(WEBHOOK_URL), "link", id, limited.fetchImpl);
    const fresh = new FakeWebhook();
    await notifyPending(store, envWith(WEBHOOK_URL), clock, fresh.fetchImpl);
    expect(fresh.requests).toHaveLength(0);
    expect(pick(await testStore.row("modqueue_notifications", { submission_id: id }), "shown_status")).toEqual({ shown_status: "pending" });
    await testStore.patch("modqueue_delivery_gate", { id: 1 }, { retry_at: 0 });
    await notifyPending(store, envWith(WEBHOOK_URL), clock, fresh.fetchImpl);
    expect(fresh.requests.some((r) => r.method === "PATCH" && r.body.content.startsWith("❌ REJECTED"))).toBe(true);
    expect(pick(await testStore.row("modqueue_notifications", { submission_id: id }), "shown_status")).toEqual({ shown_status: "rejected" });
  });

  it("[LDB-MD15] drops missing Discord messages and tracks repeated failures for fair retries", async () => {
    const layoutId = await freshLayout(uniqueName("modq-edit-abandon"));
    const missingId = await insertSubmission({ layoutId, url: "https://example.org/gone", submittedBy: "900000000000000026" });
    const post = new FakeWebhook();
    await notifyPending(store, envWith(WEBHOOK_URL), clock, post.fetchImpl);
    await testStore.patch("link_submissions", { id: missingId }, { status: "approved" });
    const missing = new FakeWebhook((i) => i === 0 ? 404 : 200);
    await updateQueueNotification(store, envWith(WEBHOOK_URL), "link", missingId, missing.fetchImpl);
    expect(await testStore.row("modqueue_notifications", { kind: "link", submission_id: missingId })).toBeNull();

    const failingId = await insertSubmission({ layoutId, url: "https://example.org/fails", submittedBy: "900000000000000027" });
    await notifyPending(store, envWith(WEBHOOK_URL), clock, post.fetchImpl);
    await testStore.patch("link_submissions", { id: failingId }, { status: "rejected" });
    for (let attempt = 0; attempt < 5; attempt++) {
      const failed = new FakeWebhook((i) => i === 1 ? 500 : 200);
      await updateQueueNotification(store, envWith(WEBHOOK_URL), "link", failingId, failed.fetchImpl);
    }
    const tracked = pick<{ failed_attempts: number }>(await testStore.row("modqueue_notifications", { kind: "link", submission_id: failingId }), "failed_attempts");
    expect(tracked?.failed_attempts).toBe(5);
  });

  it("[LDB-MD16] edits a bot-owned card using its recorded channel/message and Bot auth, not the legacy webhook", async () => {
    const layoutId = await freshLayout(uniqueName("modq-bot-owner"));
    const id = await insertSubmission({ layoutId, url: "https://example.org/bot", submittedBy: "900000000000000028", status: "approved" });
    await testStore.patch("link_submissions", { id }, { decided_by: "900000000000000028" });
    const card = buildV2Payload("link", {
      id, layout_id: layoutId, url: "https://example.org/bot", submitted_by: "900000000000000028", layout_name: "bot", submitter_name: null,
    });
    await testStore.insert("modqueue_notifications", { kind: "link", submission_id: id, message_id: "900000000000000029", shown_status: "pending", message_format: "components_v2", transport: "bot", channel_id: "900000000000000030" });
    const requests: Array<{ url: string; method: string; authorization: string | null; body: Record<string, unknown> }> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const method = init?.method ?? "GET";
      requests.push({ url, method, authorization: new Headers(init?.headers).get("Authorization"), body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> });
      return method === "GET" ? Response.json(card) : new Response(null, { status: 200 });
    };
    await updateQueueNotification(store, {
      ...bindings, MODQUEUE_DISCORD_WEBHOOK: WEBHOOK_URL, MODQUEUE_DISCORD_BOT_TOKEN: "test-bot-token",
    }, "link", id, fetchImpl);
    expect(requests.map((r) => r.method)).toEqual(["GET", "PATCH"]);
    expect(requests[0]?.url).toContain(`/v10/channels/900000000000000030/messages/900000000000000029`);
    expect(requests[0]?.authorization).toBe("Bot test-bot-token");
    expect(requests[1]?.body).not.toHaveProperty("content");
    expect(requests[1]?.body.allowed_mentions).toEqual({ parse: [] });
    const saved = pick<{ shown_status: string; transport: string }>(await testStore.row("modqueue_notifications", { kind: "link", submission_id: id }), "shown_status", "transport");
    expect(saved).toEqual({ shown_status: "approved", transport: "bot" });
  });

  it("[LDB-MD11] a webhook failure (non-2xx) releases the claim so a later sweep re-sends", async () => {
    const layoutId = await freshLayout(uniqueName("modq-fail"));
    const subId = await insertSubmission({ layoutId, url: "https://example.org/fail", submittedBy: "900000000000000012" });

    const failing = new FakeWebhook(() => 500);
    await notifyPending(store, envWith(WEBHOOK_URL), clock, failing.fetchImpl);
    expect(failing.requests.filter((r) => r.method === "POST" && r.body.content.includes(subId))).toHaveLength(1);
    const afterFail = await readSubmission(subId);
    expect(afterFail.notified_at).toBeNull();
    expect(afterFail.status).toBe("pending");

    const succeeding = new FakeWebhook();
    await notifyPending(store, envWith(WEBHOOK_URL), clock, succeeding.fetchImpl);
    expect(succeeding.requests.filter((r) => r.method === "POST" && r.body.content.includes(subId))).toHaveLength(1);
    const afterRetry = await readSubmission(subId);
    expect(afterRetry.notified_at).not.toBeNull();
  });

  it("[LDB-MD11] a thrown fetch (network error) and a Discord 429 both release the claim the same as any other failure", async () => {
    const layoutId = await freshLayout(uniqueName("modq-throw"));
    const throwing = new FakeWebhook(() => "throw");
    const subThrow = await insertSubmission({ layoutId, url: "https://example.org/throw", submittedBy: "900000000000000013" });
    await notifyPending(store, envWith(WEBHOOK_URL), clock, throwing.fetchImpl);
    expect((await readSubmission(subThrow)).notified_at).toBeNull();

    const rateLimited = new FakeWebhook(() => 429);
    const subRateLimited = await insertSubmission({ layoutId, url: "https://example.org/429", submittedBy: "900000000000000014" });
    await notifyPending(store, envWith(WEBHOOK_URL), clock, rateLimited.fetchImpl);
    expect((await readSubmission(subRateLimited)).notified_at).toBeNull();

    await testStore.patch("modqueue_delivery_gate", { id: 1 }, { retry_at: 0 });

    // Both rows are left `pending` with `notified_at` still NULL on
    // purpose (that's the whole point of the assertions above) -- D1
    // storage in this "workers" project is isolated per FILE, not per
    // `it()` (`tests/setup-workers.ts`'s own comment), so a later test in
    // THIS file would otherwise see them as fresh, unclaimed candidates
    // too. Resolved here, out of `notifyPending`'s own candidate query,
    // so this test's own retry-failure setup can never leak into another
    // test's batch.
    for (const subId of [subThrow, subRateLimited]) await testStore.patch("link_submissions", { id: subId }, { status: "rejected", decided_by: "test-cleanup", decided_at: clock() });
  });

  it("[LDB-MD11] two concurrent calls (submit-path + cron-path racing) never double-announce the same submission", async () => {
    const layoutId = await freshLayout(uniqueName("modq-race"));
    const subId = await insertSubmission({ layoutId, url: "https://example.org/race", submittedBy: "900000000000000015" });

    const webhook = new FakeWebhook();
    await Promise.all([
      notifyPending(store, envWith(WEBHOOK_URL), clock, webhook.fetchImpl),
      notifyPending(store, envWith(WEBHOOK_URL), clock, webhook.fetchImpl),
    ]);

    // Filtered by THIS submission's own id, not a bare total count -- the
    // batch either call sweeps up could in principle carry other pending
    // rows too (same-file D1 storage is not test-isolated, `tests/setup-
    // workers.ts`), so the real claim under test is "this one row was
    // never announced twice," not "nothing else was ever announced."
    expect(webhook.requests.filter((r) => r.method === "POST" && typeof r.body.content === "string" && r.body.content.includes(subId))).toHaveLength(1);
    const after = await readSubmission(subId);
    expect(after.notified_at).not.toBeNull();
  });

  it("[LDB-MD11] a superseded (or otherwise already-decided) submission is never announced", async () => {
    const layoutId = await freshLayout(uniqueName("modq-superseded"));
    const superseded = await insertSubmission({ layoutId, url: "https://example.org/superseded", submittedBy: "900000000000000016", status: "superseded" });
    const approved = await insertSubmission({ layoutId, url: "https://example.org/approved", submittedBy: "900000000000000017", status: "approved" });
    const rejected = await insertSubmission({ layoutId, url: "https://example.org/rejected", submittedBy: "900000000000000018", status: "rejected" });

    const webhook = new FakeWebhook();
    await notifyPending(store, envWith(WEBHOOK_URL), clock, webhook.fetchImpl);

    expect(webhook.requests).toHaveLength(0);
    for (const id of [superseded, approved, rejected]) {
      expect((await readSubmission(id)).notified_at).toBeNull();
    }
  });

  it("[LDB-MD12] MODQUEUE_DISCORD_WEBHOOK unset (or empty) is a complete no-op: no fetch, no notified_at write", async () => {
    const layoutId = await freshLayout(uniqueName("modq-unset"));
    const subId = await insertSubmission({ layoutId, url: "https://example.org/unset", submittedBy: "900000000000000019" });

    const webhook = new FakeWebhook();
    await notifyPending(store, envWith(undefined), clock, webhook.fetchImpl);
    expect(webhook.requests).toHaveLength(0);

    await notifyPending(store, envWith(""), clock, webhook.fetchImpl);
    expect(webhook.requests).toHaveLength(0);

    const after = await readSubmission(subId);
    expect(after.status).toBe("pending");
    expect(after.notified_at).toBeNull();
  });

  it("[LDB-MD11] buildMessageContent escapes Discord markdown in the layout name and the submitter's display name", () => {
    const content = buildMessageContent({
      id: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
      layout_id: "01BX5ZZKBKACTAV9WEVGEMMVRY",
      url: "https://example.org/x",
      submitted_by: "900000000000000020",
      layout_name: "*bold* `code` _under_ ~tilde~ |pipe| >quote [masked](https://evil.example)",
      submitter_name: "*Evil* \\Name`",
    });
    expect(content).toContain("\\*bold\\* \\`code\\` \\_under\\_ \\~tilde\\~ \\|pipe\\| \\>quote \\[masked\\](https://evil.example)");
    expect(content).toContain("\\*Evil\\* \\\\Name\\`");
    expect(content).toContain("<https://example.org/x>");
    expect(content).toContain("01ARZ3NDEKTSV4RRFFQ69G5FAV");
    expect(content).toContain("01BX5ZZKBKACTAV9WEVGEMMVRY");
  });

  it("[LDB-MD22] buildMessageContent falls back to a Discord mention when there is no author", () => {
    const content = buildMessageContent({
      id: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
      layout_id: "01BX5ZZKBKACTAV9WEVGEMMVRY",
      url: "https://example.org/x",
      submitted_by: "900000000000000021",
      layout_name: "plain-name",
      submitter_name: null,
    });
    expect(content).toContain("by <@900000000000000021>:");
  });

  it("[LDB-MD11] buildMessageContent links the layout's akldb.org page and the admin inbox tab, both embed-suppressed", () => {
    const content = buildMessageContent({
      id: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
      layout_id: "01BX5ZZKBKACTAV9WEVGEMMVRY",
      url: "https://example.org/x",
      submitted_by: "900000000000000022",
      layout_name: "plain-name",
      submitter_name: null,
    });
    expect(content).toContain("[plain-name](<https://akldb.org/l/01BX5ZZKBKACTAV9WEVGEMMVRY>)");
    expect(content).toContain("[Open the mod queue](<https://akldb.org/admin?tab=inbox>)");
    expect(content).not.toMatch(/(?<!<)https:\/\/(?!\S*>)/); // every URL sits inside <...>
  });
});
