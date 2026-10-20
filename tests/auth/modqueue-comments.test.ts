// [LDB-CMT8] Mod-queue Discord notify for layout comments
// (`src/core/modqueue.ts`, docs/decisions/29-layout-comments.md): announced on
// submit, best effort, never by the cron (no `notified_at` column). Same "fake the outside service, count calls" approach as
// tests/auth/modqueue.test.ts; no wall-clock assertions anywhere.
import { SELF, env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ulid } from "ulidx";
import type { Bindings } from "../../src/env";
import { commitWrite, type CommitInput } from "../../src/core/events";
import { announceComment, buildCommentMessageContent, notifyPending, updateQueueNotification } from "../../src/core/modqueue";
import { fixedClock } from "../../src/core/time";
import { actorFixture, register } from "../api/write-support";

const bindings = env as unknown as Bindings;
const db = bindings.DB;
const clock = fixedClock("2026-10-18T00:00:00.000Z");

const WEBHOOK_URL = "https://discord.test/api/webhooks/modqueue-comments-test";

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
  const { layout } = await commitWrite(db, clock, input);
  return layout.id;
}

async function insertComment(o: { layoutId: string; userId: string; body?: string; status?: string }): Promise<string> {
  const id = ulid();
  await db
    .prepare(
      `INSERT INTO layout_comments (id, layout_id, user_id, body, via, submitted_at, status, decided_by, decided_at, reason)
       VALUES (?, ?, ?, ?, 'discord', ?, ?, NULL, NULL, NULL)`,
    )
    .bind(id, o.layoutId, o.userId, o.body ?? "a comment", clock(), o.status ?? "pending")
    .run();
  return id;
}

async function insertLink(layoutId: string, submittedBy: string): Promise<string> {
  const id = ulid();
  await db
    .prepare(
      `INSERT INTO link_submissions (id, layout_id, url, submitted_by, submitted_at, status, decided_by, decided_at, reason, notified_at)
       VALUES (?, ?, ?, ?, ?, 'pending', NULL, NULL, NULL, NULL)`,
    )
    .bind(id, layoutId, "https://example.org/a-link", submittedBy, clock())
    .run();
  return id;
}

async function insertAuthor(userId: string, name: string): Promise<void> {
  await db.prepare("INSERT INTO authors (user_id, name, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?)").bind(userId, name, clock(), clock()).run();
}

async function layoutName(layoutId: string): Promise<string> {
  const row = await db.prepare("SELECT name FROM layouts WHERE id = ?").bind(layoutId).first<{ name: string }>();
  return row!.name;
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
      const id = `discord-comment-${this.requests.length}`;
      this.contents.set(id, JSON.parse(String(init.body)).content);
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

describe("[LDB-CMT8] comments are announced on submit, best effort, never by the cron", () => {
  it("[LDB-MD16] uploads complete before/after comment text as plain text when the full card exceeds Discord's limit", async () => {
    const layoutId = await freshLayout(uniqueName("modq-cmt-file"));
    const userId = "900000000000000229";
    const before = "o".repeat(2000);
    const after = "n".repeat(2000);
    await insertComment({ layoutId, userId, body: before, status: "approved" });
    const id = await insertComment({ layoutId, userId, body: after });
    let uploadedText = "";
    let payload: Record<string, unknown> = {};
    let wasFormData = false;
    let contentType: string | null = null;
    const fetchImpl: typeof fetch = async (_input, init) => {
      wasFormData = init?.body instanceof FormData;
      contentType = new Headers(init?.headers).get("Content-Type");
      const form = init!.body as FormData;
      const payloadPart = form.get("payload_json");
      const filePart = form.get("files[0]");
      if (typeof payloadPart !== "string" || !(filePart instanceof Blob)) return new Response(null, { status: 400 });
      payload = JSON.parse(payloadPart);
      uploadedText = await filePart.text();
      return Response.json({ id: "discord-comment-fulltext" });
    };
    await announceComment(db, { ...envWith(WEBHOOK_URL), MODQUEUE_DISCORD_COMPONENTS: "true" }, id, fetchImpl);
    expect(wasFormData).toBe(true);
    expect(contentType).toBeNull(); // runtime sets multipart boundary
    expect(payload.allowed_mentions).toEqual({ parse: [] });
    const parts = payload.components as { components: { id?: number; content?: string }[] }[];
    expect(parts[0]!.components.find((c) => c.id === 41004)?.content).toBe("Full comment text attached as a .txt file.");
    expect(payload.attachments).toEqual([{ id: "0", filename: `comment-${id}.txt`, description: "Complete comment text before and after the edit" }]);
    expect(uploadedText).toBe(`BEFORE\n\n${before}\n\nAFTER\n\n${after}`);
  });

  it("[LDB-MD16] uses a complete text attachment for long legacy comments and removes it after deletion", async () => {
    const layoutId = await freshLayout(uniqueName("modq-cmt-legacy-file"));
    const id = await insertComment({ layoutId, userId: "900000000000000230", body: "x".repeat(2000) });
    let payload: Record<string, unknown> = {};
    let patchBody: Record<string, unknown> = {};
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (init?.method === "POST") {
        const form = init.body as FormData;
        payload = JSON.parse(String(form.get("payload_json")));
        return Response.json({ id: "discord-comment-legacy-file" });
      }
      if (init?.method === "GET") return Response.json({ content: payload.content, attachments: payload.attachments });
      patchBody = JSON.parse(String(init?.body ?? "{}"));
      expect(url).toContain("/messages/discord-comment-legacy-file");
      return Response.json({ id: "discord-comment-legacy-file" });
    };
    await announceComment(db, envWith(WEBHOOK_URL), id, fetchImpl);
    expect(payload.content).toContain("Full comment text attached as a .txt file.");
    expect(payload.content).not.toContain("x".repeat(100));
    expect(payload.attachments).toEqual([{ id: "0", filename: `comment-${id}.txt`, description: "Complete comment text before and after the edit" }]);

    await db.prepare("UPDATE layout_comments SET status = 'deleted', body = NULL WHERE id = ?").bind(id).run();
    await updateQueueNotification(db, envWith(WEBHOOK_URL), "comment", id, fetchImpl);
    expect(patchBody.content).toBe("🗑️ DELETED");
    expect(patchBody.attachments).toEqual([]);
  });

  it("[LDB-CMT8] a pending comment is announced once: layout link, author, full text, and inbox link; it stays pending", async () => {
    const layoutId = await freshLayout(uniqueName("modq-cmt-happy"));
    await insertAuthor("900000000000000210", "Kind Commenter");
    const subId = await insertComment({ layoutId, userId: "900000000000000210", body: "Great home row, I use it daily" });

    const webhook = new FakeWebhook();
    await announceComment(db, envWith(WEBHOOK_URL), subId, webhook.fetchImpl);

    const sent = webhook.about(subId);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.url).toBe(`${WEBHOOK_URL}?wait=true`);
    expect(sent[0]!.body.allowed_mentions).toEqual({ parse: [] });
    expect(sent[0]!.body.content).toContain(`New comment on **[${await layoutName(layoutId)}](<https://akldb.org/l/${layoutId}>)** by Kind Commenter (30 chars)`);
    expect(sent[0]!.body.content).toContain("**Comment**\nGreat home row, I use it daily");
    expect(sent[0]!.body.content).toContain(`[Open the inbox](<https://akldb.org/admin?tab=inbox>) \u00b7 submission \`${subId}\``);

    const row = await db.prepare("SELECT status FROM layout_comments WHERE id = ?").bind(subId).first<{ status: string }>();
    expect(row?.status).toBe("pending");
  });

  it("[LDB-MD22] no author row: the message falls back to a Discord mention", async () => {
    const layoutId = await freshLayout(uniqueName("modq-cmt-noauthor"));
    const subId = await insertComment({ layoutId, userId: "900000000000000211" });
    const webhook = new FakeWebhook();
    await announceComment(db, envWith(WEBHOOK_URL), subId, webhook.fetchImpl);
    expect(webhook.about(subId)[0]!.body.content).toContain("by <@900000000000000211> (9 chars)");
  });

  it("[LDB-MD15] edits the original comment message for approval and rejection", async () => {
    const layoutId = await freshLayout(uniqueName("modq-cmt-status"));
    const ids = [
      await insertComment({ layoutId, userId: "900000000000000218", body: "approved body" }),
      await insertComment({ layoutId, userId: "900000000000000219", body: "rejected body" }),
    ];
    const webhook = new FakeWebhook();
    for (const [id, status, prefix] of [[ids[0]!, "approved", "✅ APPROVED"], [ids[1]!, "rejected", "❌ REJECTED"]] as const) {
      await announceComment(db, envWith(WEBHOOK_URL), id, webhook.fetchImpl);
      await db.prepare("UPDATE layout_comments SET status = ? WHERE id = ?").bind(status, id).run();
      await updateQueueNotification(db, envWith(WEBHOOK_URL), "comment", id, webhook.fetchImpl);
      const edit = webhook.requests.find((r) => r.method === "PATCH" && r.body.content.includes(id));
      expect(edit?.url).toContain(`/messages/discord-comment-`);
      expect(edit?.body.content.startsWith(`${prefix}\nNew comment on`)).toBe(true);
      expect(edit?.body.content).toContain(`submission \`${id}\``);
      expect(edit?.body.allowed_mentions).toEqual({ parse: [] });
    }
  });

  it("[LDB-MD15] erases deleted and replaced comment previews during status reconciliation", async () => {
    const layoutId = await freshLayout(uniqueName("modq-cmt-erasure"));
    const id = await insertComment({ layoutId, userId: "900000000000000220", body: "private preview to erase" });
    const webhook = new FakeWebhook();
    await announceComment(db, envWith(WEBHOOK_URL), id, webhook.fetchImpl);
    await db.prepare("UPDATE layout_comments SET status = 'deleted', body = NULL WHERE id = ?").bind(id).run();
    await updateQueueNotification(db, envWith(WEBHOOK_URL), "comment", id, webhook.fetchImpl);
    const edit = webhook.requests.find((r) => r.method === "PATCH");
    expect(edit?.body.content).toBe("🗑️ DELETED");
    expect(edit?.body.content).not.toContain("private preview to erase");
  });

  it("[LDB-MD15] serial reconciliation catches a comment deletion that races the remote approval edit", async () => {
    const layoutId = await freshLayout(uniqueName("modq-cmt-status-race"));
    const id = await insertComment({ layoutId, userId: "900000000000000231", body: "private race comment" });
    const patches: Record<string, unknown>[] = [];
    const fetchImpl: typeof fetch = async (_input, init) => {
      if (init?.method === "POST") return Response.json({ id: "discord-comment-status-race" });
      if (init?.method === "GET") return Response.json({ content: "Original full comment", attachments: [] });
      const patch = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      patches.push(patch);
      if (patches.length === 1) await db.prepare("UPDATE layout_comments SET status = 'deleted', body = NULL WHERE id = ?").bind(id).run();
      return Response.json({ id: "discord-comment-status-race" });
    };
    await announceComment(db, envWith(WEBHOOK_URL), id, fetchImpl);
    await db.prepare("UPDATE layout_comments SET status = 'approved' WHERE id = ?").bind(id).run();
    await updateQueueNotification(db, envWith(WEBHOOK_URL), "comment", id, fetchImpl);
    expect(patches).toHaveLength(2);
    expect(patches[0]!.content).toMatch(/^✅ APPROVED\n/);
    expect(patches[1]!.content).toBe("🗑️ DELETED");
  });

  it("[LDB-CMT8] a user who already has a live comment gets the full before/after edit", async () => {
    const layoutId = await freshLayout(uniqueName("modq-cmt-edit"));
    const userId = "900000000000000212";
    await insertComment({ layoutId, userId, body: "the old live text", status: "approved" });
    const subId = await insertComment({ layoutId, userId, body: "the rewritten secret text" });
    const webhook = new FakeWebhook();
    await announceComment(db, envWith(WEBHOOK_URL), subId, webhook.fetchImpl);
    const content = webhook.about(subId)[0]!.body.content;
    expect(content.startsWith("Edited comment on **[")).toBe(true);
    expect(content).toContain(` by <@${userId}> (25 chars)\n**Before**\nthe old live text\n\n**After**\nthe rewritten secret text\n[Open the inbox]`);
  });

  it("[LDB-CMT8] buildCommentMessageContent shows complete content and escapes markdown without splitting Unicode", () => {
    const base = { id: "01ARZ3NDEKTSV4RRFFQ69G5FAV", layout_id: "01BX5ZZKBKACTAV9WEVGEMMVRY", user_id: "900000000000000213", layout_name: "*bold* [masked](https://evil.example)", user_name: "*Evil* `Name`", has_live: 0, live_body: null };
    const exact = buildCommentMessageContent({ ...base, body: "x".repeat(120) });
    expect(exact).toContain(`(120 chars)\n**Comment**\n${"x".repeat(120)}\n`);
    const cut = buildCommentMessageContent({ ...base, body: "y".repeat(121) });
    expect(cut).toContain(`(121 chars)\n**Comment**\n${"y".repeat(121)}\n`);
    const emoji = buildCommentMessageContent({ ...base, body: "\u{1F600}".repeat(130) });
    expect(emoji).toContain(`${"\u{1F600}".repeat(130)}`);

    const rich = buildCommentMessageContent({ ...base, body: "*loud* [link](https://x)\n\n> quote `code` _it_ ~s~ |spoiler|" });
    expect(rich).toContain("\\*loud\\* \\[link\\](https://x)\n\n\\> quote \\`code\\` \\_it\\_ \\~s\\~ \\|spoiler\\|");
    expect(rich).toContain("\\*bold\\* \\[masked\\](https://evil.example)");
    expect(rich).toContain("\\*Evil\\* \\`Name\\`");
    expect(rich).toContain("(<https://akldb.org/l/01BX5ZZKBKACTAV9WEVGEMMVRY>)");
  });

  it("[LDB-CMT8] the cron sweep never announces a comment, and layout_comments has no notified_at column", async () => {
    const layoutId = await freshLayout(uniqueName("modq-cmt-cron"));
    const subId = await insertComment({ layoutId, userId: "900000000000000214" });
    const webhook = new FakeWebhook();
    await notifyPending(db, envWith(WEBHOOK_URL), clock, webhook.fetchImpl);
    expect(webhook.about(subId)).toHaveLength(0);
    const cols = await db.prepare("SELECT name FROM pragma_table_info('layout_comments')").all<{ name: string }>();
    expect(cols.results.map((c) => c.name)).not.toContain("notified_at");
  });

  it("[LDB-CMT8] a failed post (non-2xx, thrown, 429) is dropped: no retry, no D1 write, no throw", async () => {
    const layoutId = await freshLayout(uniqueName("modq-cmt-fail"));
    const subId = await insertComment({ layoutId, userId: "900000000000000216" });
    const before = await db.prepare("SELECT * FROM layout_comments WHERE id = ?").bind(subId).first();
    for (const outcome of [500, "throw", 429] as const) {
      const failing = new FakeWebhook(() => outcome);
      await expect(announceComment(db, envWith(WEBHOOK_URL), subId, failing.fetchImpl)).resolves.toBeUndefined();
      expect(failing.about(subId), String(outcome)).toHaveLength(1); // exactly one attempt
    }
    expect(await db.prepare("SELECT * FROM layout_comments WHERE id = ?").bind(subId).first()).toEqual(before);
    // and a later sweep of any kind does not re-send it
    const later = new FakeWebhook();
    await notifyPending(db, envWith(WEBHOOK_URL), clock, later.fetchImpl);
    expect(later.about(subId)).toHaveLength(0);
  });

  it("[LDB-CMT8] only a still-pending comment with a text is announced: superseded, approved, rejected, deleted, removed and replaced rows are not", async () => {
    const layoutId = await freshLayout(uniqueName("modq-cmt-decided"));
    const webhook = new FakeWebhook();
    for (const [i, status] of ["superseded", "approved", "rejected", "deleted", "removed", "replaced"].entries()) {
      const id = await insertComment({ layoutId, userId: `90000000000000022${i}`, status });
      await announceComment(db, envWith(WEBHOOK_URL), id, webhook.fetchImpl);
    }
    await announceComment(db, envWith(WEBHOOK_URL), "no-such-comment", webhook.fetchImpl);
    expect(webhook.requests).toHaveLength(0);
  });

  it("[LDB-CMT8] MODQUEUE_DISCORD_WEBHOOK unset (or empty) is a complete no-op for comments too: no fetch", async () => {
    const layoutId = await freshLayout(uniqueName("modq-cmt-unset"));
    const subId = await insertComment({ layoutId, userId: "900000000000000217" });
    const webhook = new FakeWebhook();
    await announceComment(db, envWith(undefined), subId, webhook.fetchImpl);
    await announceComment(db, envWith(""), subId, webhook.fetchImpl);
    expect(webhook.requests).toHaveLength(0);
  });

  it("[LDB-CMT8] PUT announces a fresh queued comment through waitUntil (webhook set), and an admin's own comment is announced too (everything is pending now)", async () => {
    const fake = actorFixture();
    const user = "900000000000000218";
    const auth = register(fake, "tok-cmt-modq-route", user);
    const layoutId = await freshLayout(uniqueName("modq-cmt-route"));
    const webhook = new FakeWebhook();
    vi.stubGlobal("fetch", (url: string, init: { headers: Record<string, string>; signal?: AbortSignal }) => (url.startsWith(WEBHOOK_URL) ? webhook.fetchImpl(url, init) : fake.fetchImpl(url, init)));
    (bindings as { MODQUEUE_DISCORD_WEBHOOK?: string }).MODQUEUE_DISCORD_WEBHOOK = WEBHOOK_URL;

    const res = await SELF.fetch(`https://example.com/v1/layouts/${layoutId}/comment`, {
      method: "PUT",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ body: "announce me please" }),
    });
    expect(res.status).toBe(202);
    const { submission } = (await res.json()) as { submission: { id: string } };

    // `waitUntil` is not awaited by SELF.fetch: poll (bounded by iterations,
    // not by an asserted duration) for the announcement to land.
    for (let i = 0; i < 500 && webhook.about(submission.id).length === 0; i++) await new Promise((r) => setTimeout(r, 10));
    expect(webhook.about(submission.id)).toHaveLength(1);
    expect(webhook.about(submission.id)[0]!.body.content).toContain("**Comment**\nannounce me please");

    // An admin's own comment is pending like everyone's, so it is announced too.
    const admin = register(fake, "tok-cmt-modq-admin", "184412255822020608");
    const own = await SELF.fetch(`https://example.com/v1/layouts/${layoutId}/comment`, {
      method: "PUT",
      headers: { ...admin, "Content-Type": "application/json" },
      body: JSON.stringify({ body: "admin speaks" }),
    });
    expect(own.status).toBe(202);
    const ownId = ((await own.json()) as { submission: { id: string } }).submission.id;
    for (let i = 0; i < 500 && webhook.about(ownId).length === 0; i++) await new Promise((r) => setTimeout(r, 10));
    expect(webhook.about(ownId)).toHaveLength(1);
    expect(webhook.about(ownId)[0]!.body.content).toContain("**Comment**\nadmin speaks");
  });
});


describe("[LDB-MD21] reopened card reconciliation", () => {
  it("[LDB-MD21] converges through approved-to-pending-to-approved during PATCH even when the status repeats", async () => {
    const layoutId = await freshLayout(uniqueName("modq-reopen-aba"));
    const id = await insertComment({ layoutId, userId: "900000000000000233", body: "normal comment" });
    const patches: Record<string, unknown>[] = [];
    let remote: Record<string, unknown> = {};
    const env = { ...envWith(undefined), MODQUEUE_DISCORD_CARDS: "true", MODQUEUE_DISCORD_COMPONENTS: "true", MODQUEUE_DISCORD_ACTIONS: "true",
      MODQUEUE_DISCORD_BOT_TOKEN: "fake", MODQUEUE_DISCORD_CHANNEL_ID: "900000000000000103" };
    const fetchImpl: typeof fetch = async (_input, init) => {
      if (init?.method === "POST") { remote = JSON.parse(String(init.body)); return Response.json({ id: "900000000000000105" }); }
      if (init?.method === "GET") return Response.json(remote);
      remote = JSON.parse(String(init?.body)); patches.push(remote);
      if (patches.length === 1) await db.prepare("UPDATE layout_comments SET status = 'pending', review_version = 1 WHERE id = ?").bind(id).run();
      if (patches.length === 2) await db.prepare("UPDATE layout_comments SET status = 'approved' WHERE id = ?").bind(id).run();
      return Response.json({ id: "900000000000000105" });
    };
    await announceComment(db, env, id, fetchImpl);
    await db.prepare("UPDATE layout_comments SET status = 'approved' WHERE id = ?").bind(id).run();
    await updateQueueNotification(db, env, "comment", id, fetchImpl);
    expect(patches).toHaveLength(3);
    expect(JSON.stringify(patches[0])).toContain(`reopen-approved|${id}|0`);
    expect(JSON.stringify(patches[1])).toContain(`approve|${id}|1`);
    expect(JSON.stringify(patches[2])).toContain(`reopen-approved|${id}|1`);
    expect(await db.prepare("SELECT shown_status, shown_review_version FROM modqueue_notifications WHERE submission_id = ?").bind(id).first())
      .toEqual({ shown_status: "approved", shown_review_version: 1 });
  });

  it("[LDB-MD21] refreshes existing decided cards and removes interactive buttons when actions are disabled", async () => {
    const layoutId = await freshLayout(uniqueName("modq-reopen-migrate"));
    const id = await insertComment({ layoutId, userId: "900000000000000234" });
    let remote: Record<string, unknown> = {};
    const env = { ...envWith(undefined), MODQUEUE_DISCORD_CARDS: "true", MODQUEUE_DISCORD_COMPONENTS: "true", MODQUEUE_DISCORD_ACTIONS: "true",
      MODQUEUE_DISCORD_BOT_TOKEN: "fake", MODQUEUE_DISCORD_CHANNEL_ID: "900000000000000103" };
    const fetchImpl: typeof fetch = async (_input, init) => {
      if (init?.method === "GET") return Response.json(remote);
      remote = JSON.parse(String(init?.body));
      return Response.json({ id: "900000000000000105" });
    };
    await announceComment(db, env, id, fetchImpl);
    await db.prepare("UPDATE layout_comments SET status = 'rejected', reason = 'off topic' WHERE id = ?").bind(id).run();
    await db.prepare("UPDATE modqueue_notifications SET shown_status = 'rejected', shown_review_version = -1 WHERE submission_id = ?").bind(id).run();
    await notifyPending(db, env, clock, fetchImpl);
    expect(JSON.stringify(remote)).toContain(`reopen-rejected|${id}|0`);
    expect(JSON.stringify(remote)).toContain("**Reason:** off topic");
    await db.prepare("UPDATE layout_comments SET status = 'pending', review_version = 1 WHERE id = ?").bind(id).run();
    await updateQueueNotification(db, { ...env, MODQUEUE_DISCORD_ACTIONS: "false" }, "comment", id, fetchImpl);
    expect(JSON.stringify(remote)).not.toContain("custom_id");
    expect(JSON.stringify(remote)).not.toContain("**Reason:**");
    expect(JSON.stringify(remote)).not.toContain("Pending review");
    expect(JSON.stringify(remote)).toContain("Open in akldb");
  });

  it("[LDB-MD21] returns legacy text cards to their original pending text without stacked decision prefixes", async () => {
    const layoutId = await freshLayout(uniqueName("modq-reopen-legacy"));
    const id = await insertComment({ layoutId, userId: "900000000000000235" });
    const webhook = new FakeWebhook();
    await announceComment(db, envWith(WEBHOOK_URL), id, webhook.fetchImpl);
    const original = webhook.requests[0]!.body.content;
    await db.prepare("UPDATE layout_comments SET status = 'rejected' WHERE id = ?").bind(id).run();
    await updateQueueNotification(db, envWith(WEBHOOK_URL), "comment", id, webhook.fetchImpl);
    await db.prepare("UPDATE layout_comments SET status = 'pending', review_version = 1 WHERE id = ?").bind(id).run();
    await updateQueueNotification(db, envWith(WEBHOOK_URL), "comment", id, webhook.fetchImpl);
    expect(webhook.requests.filter((r) => r.method === "PATCH").at(-1)?.body.content).toBe(original);
  });
});
