// [LDB-CMT8] Mod-queue Discord notify for layout comments
// (`src/core/modqueue.ts`, docs/decisions/29-layout-comments.md): announced on
// submit, best effort, never by the cron (no `notified_at` column). Same "fake the outside service, count calls" approach as
// tests/auth/modqueue.test.ts; no wall-clock assertions anywhere.
import { SELF, env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ulid } from "ulidx";
import type { Bindings } from "../../src/env";
import { commitWrite, type CommitInput } from "../../src/core/events";
import { announceComment, buildCommentMessageContent, notifyPending } from "../../src/core/modqueue";
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
  body: { content: string; allowed_mentions: { parse: string[] } };
}

class FakeWebhook {
  readonly requests: LoggedPost[] = [];
  constructor(private readonly answer: (callIndex: number) => "throw" | number = () => 204) {}

  readonly fetchImpl: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    this.requests.push({ url, body: JSON.parse(String(init?.body ?? "{}")) });
    const outcome = this.answer(this.requests.length - 1);
    if (outcome === "throw") throw new Error("fake webhook: network error");
    return new Response(null, { status: outcome });
  };

  about(id: string): LoggedPost[] {
    return this.requests.filter((r) => r.body.content.includes(id));
  }
}

describe("[LDB-CMT8] comments are announced on submit, best effort, never by the cron", () => {
  it("[LDB-CMT8] a pending comment is announced once: layout link, author, length, the text in quotes, and the inbox link; it stays pending", async () => {
    const layoutId = await freshLayout(uniqueName("modq-cmt-happy"));
    await insertAuthor("900000000000000210", "Kind Commenter");
    const subId = await insertComment({ layoutId, userId: "900000000000000210", body: "Great home row, I use it daily" });

    const webhook = new FakeWebhook();
    await announceComment(db, envWith(WEBHOOK_URL), subId, webhook.fetchImpl);

    const sent = webhook.about(subId);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.url).toBe(WEBHOOK_URL);
    expect(sent[0]!.body.allowed_mentions).toEqual({ parse: [] });
    const [first, second, ...rest] = sent[0]!.body.content.split("\n");
    expect(rest).toEqual([]);
    expect(first).toBe(`New comment on **[${await layoutName(layoutId)}](<https://akldb.org/l/${layoutId}>)** by Kind Commenter (30 chars): "Great home row, I use it daily"`);
    expect(second).toBe(`[Open the inbox](<https://akldb.org/admin?tab=inbox>) \u00b7 submission \`${subId}\``);

    const row = await db.prepare("SELECT status FROM layout_comments WHERE id = ?").bind(subId).first<{ status: string }>();
    expect(row?.status).toBe("pending");
  });

  it("[LDB-CMT8] no author row: the message falls back to the raw user id", async () => {
    const layoutId = await freshLayout(uniqueName("modq-cmt-noauthor"));
    const subId = await insertComment({ layoutId, userId: "900000000000000211" });
    const webhook = new FakeWebhook();
    await announceComment(db, envWith(WEBHOOK_URL), subId, webhook.fetchImpl);
    expect(webhook.about(subId)[0]!.body.content).toContain("by 900000000000000211 (9 chars)");
  });

  it("[LDB-CMT8] a user who already has a live comment gets the 'Edited comment' message: the length, never the text", async () => {
    const layoutId = await freshLayout(uniqueName("modq-cmt-edit"));
    const userId = "900000000000000212";
    await insertComment({ layoutId, userId, body: "the old live text", status: "approved" });
    const subId = await insertComment({ layoutId, userId, body: "the rewritten secret text" });
    const webhook = new FakeWebhook();
    await announceComment(db, envWith(WEBHOOK_URL), subId, webhook.fetchImpl);
    const content = webhook.about(subId)[0]!.body.content;
    expect(content.startsWith("Edited comment on **[")).toBe(true);
    expect(content).toContain(` by ${userId} (25 chars)\n[Open the inbox]`);
    expect(content).not.toContain("secret text");
    expect(content).not.toContain("old live text");
  });

  it("[LDB-CMT8] buildCommentMessageContent shows the first 120 code points with an ellipsis when cut, escapes markdown, and flattens line breaks", () => {
    const base = { id: "01ARZ3NDEKTSV4RRFFQ69G5FAV", layout_id: "01BX5ZZKBKACTAV9WEVGEMMVRY", user_id: "900000000000000213", layout_name: "*bold* [masked](https://evil.example)", user_name: "*Evil* `Name`", has_live: 0 };
    const exact = buildCommentMessageContent({ ...base, body: "x".repeat(120) });
    expect(exact).toContain(`(120 chars): "${"x".repeat(120)}"\n`);
    const cut = buildCommentMessageContent({ ...base, body: "y".repeat(121) });
    expect(cut).toContain(`(121 chars): "${"y".repeat(120)}\u2026"\n`);
    const emoji = buildCommentMessageContent({ ...base, body: "\u{1F600}".repeat(130) });
    expect(emoji).toContain(`(130 chars): "${"\u{1F600}".repeat(120)}\u2026"`);

    const rich = buildCommentMessageContent({ ...base, body: "*loud* [link](https://x)\n\n> quote `code` _it_ ~s~ |spoiler|" });
    expect(rich).toContain('"\\*loud\\* \\[link\\](https://x) \\> quote \\`code\\` \\_it\\_ \\~s\\~ \\|spoiler\\|"');
    expect(rich.split("\n")).toHaveLength(2); // the comment cannot add lines of its own
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
    vi.stubGlobal("fetch", (url: string, init: { headers: Record<string, string>; signal?: AbortSignal }) => (url === WEBHOOK_URL ? webhook.fetchImpl(url, init) : fake.fetchImpl(url, init)));
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
    expect(webhook.about(submission.id)[0]!.body.content).toContain('"announce me please"');

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
    expect(webhook.about(ownId)[0]!.body.content).toContain('"admin speaks"');
  });
});

