// [LDB-WPM8] Mod-queue Discord notify for WPM submissions
// (`src/core/modqueue.ts`, docs/decisions/28-wpm-records.md): the same
// at-most-once claim pattern as links (LDB-MD11/LDB-MD12), one sweep per
// queue table. Same "fake the outside service, count calls" approach as
// tests/auth/modqueue.test.ts; no wall-clock assertions anywhere.
import { SELF, env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ulid } from "ulidx";
import type { Bindings } from "../../src/env";
import { commitWrite, type CommitInput } from "../../src/core/events";
import { buildMessageContent, buildWpmMessageContent, notifyPending, updateQueueNotification } from "../../src/core/modqueue";
import { fixedClock } from "../../src/core/time";
import { actorFixture, register } from "../api/write-support";

const bindings = env as unknown as Bindings;
const db = bindings.DB;
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
  const { layout } = await commitWrite(db, clock, input);
  return layout.id;
}

async function insertWpm(o: { layoutId: string; userId: string; wpm?: number; proof?: string; status?: string }): Promise<string> {
  const id = ulid();
  await db
    .prepare(
      `INSERT INTO wpm_submissions (id, layout_id, user_id, wpm, proof, submitted_by, via, submitted_at, status, decided_by, decided_at, reason, notified_at)
       VALUES (?, ?, ?, ?, ?, ?, 'discord', ?, ?, NULL, NULL, NULL, NULL)`,
    )
    .bind(id, o.layoutId, o.userId, o.wpm ?? 85, o.proof ?? "https://example.org/wpm-proof", o.userId, clock(), o.status ?? "pending")
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

async function readWpm(id: string): Promise<{ status: string; notified_at: string | null }> {
  const row = await db.prepare("SELECT status, notified_at FROM wpm_submissions WHERE id = ?").bind(id).first<{ status: string; notified_at: string | null }>();
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
    await notifyPending(db, envWith(WEBHOOK_URL), clock, webhook.fetchImpl);
    await notifyPending(db, envWith(WEBHOOK_URL), clock, webhook.fetchImpl); // a second sweep never re-sends

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
    await notifyPending(db, envWith(WEBHOOK_URL), clock, webhook.fetchImpl);
    expect(webhook.about(subId)[0]!.body.content).toContain("900000000000000111");
  });

  it("[LDB-MD15] edits the original WPM message for approval and rejection", async () => {
    const layoutId = await freshLayout(uniqueName("modq-wpm-status"));
    const ids = [
      await insertWpm({ layoutId, userId: "900000000000000122" }),
      await insertWpm({ layoutId, userId: "900000000000000123" }),
    ];
    const webhook = new FakeWebhook();
    await notifyPending(db, envWith(WEBHOOK_URL), clock, webhook.fetchImpl);
    for (const [id, status, prefix] of [[ids[0]!, "approved", "✅ APPROVED"], [ids[1]!, "rejected", "❌ REJECTED"]] as const) {
      await db.prepare("UPDATE wpm_submissions SET status = ? WHERE id = ?").bind(status, id).run();
      await updateQueueNotification(db, envWith(WEBHOOK_URL), "wpm", id, webhook.fetchImpl);
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
    await Promise.all([notifyPending(db, envWith(WEBHOOK_URL), clock, webhook.fetchImpl), notifyPending(db, envWith(WEBHOOK_URL), clock, webhook.fetchImpl)]);

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
      notifyPending(db, envWith(WEBHOOK_URL), clock, webhook.fetchImpl),
      notifyPending(db, envWith(WEBHOOK_URL), clock, webhook.fetchImpl),
      notifyPending(db, envWith(WEBHOOK_URL), clock, webhook.fetchImpl),
    ]);
    expect(webhook.about(subId)).toHaveLength(1);
  });

  it("[LDB-WPM8] a webhook failure (non-2xx, thrown, or 429) releases the claim so a later sweep re-sends", async () => {
    const layoutId = await freshLayout(uniqueName("modq-wpm-fail"));
    const subId = await insertWpm({ layoutId, userId: "900000000000000114" });

    for (const outcome of [500, "throw", 429] as const) {
      const failing = new FakeWebhook(() => outcome);
      await notifyPending(db, envWith(WEBHOOK_URL), clock, failing.fetchImpl);
      expect(failing.about(subId), String(outcome)).toHaveLength(1);
      expect((await readWpm(subId)).notified_at, String(outcome)).toBeNull();
    }
    const succeeding = new FakeWebhook();
    await notifyPending(db, envWith(WEBHOOK_URL), clock, succeeding.fetchImpl);
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
    await notifyPending(db, envWith(WEBHOOK_URL), clock, webhook.fetchImpl);
    for (const id of ids) {
      expect(webhook.about(id)).toHaveLength(0);
      expect((await readWpm(id)).notified_at).toBeNull();
    }
  });

  it("[LDB-WPM8] MODQUEUE_DISCORD_WEBHOOK unset (or empty) is a complete no-op for WPM too: no fetch, no notified_at write", async () => {
    const layoutId = await freshLayout(uniqueName("modq-wpm-unset"));
    const subId = await insertWpm({ layoutId, userId: "900000000000000118" });
    const webhook = new FakeWebhook();
    await notifyPending(db, envWith(undefined), clock, webhook.fetchImpl);
    await notifyPending(db, envWith(""), clock, webhook.fetchImpl);
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
  it("[LDB-MD21] first announcement after reopening uses the current version, including a reopen racing POST", async () => {
    const layoutId = await freshLayout(uniqueName("modq-wpm-reopened-post"));
    const id = await insertWpm({ layoutId, userId: "900000000000000141" });
    await db.prepare("UPDATE wpm_submissions SET review_version = 1 WHERE id = ?").bind(id).run();
    const env = { ...envWith(undefined), MODQUEUE_DISCORD_CARDS: "true", MODQUEUE_DISCORD_ACTIONS: "true",
      MODQUEUE_DISCORD_BOT_TOKEN: "fake", MODQUEUE_DISCORD_CHANNEL_ID: "900000000000000103" };
    let posted: Record<string, unknown> = {};
    let patched: Record<string, unknown> = {};
    const fetchImpl: typeof fetch = async (_input, init) => {
      if (init?.method === "POST") {
        posted = JSON.parse(String(init.body));
        // The original pending card can still be in flight when its review
        // is decided and reopened, returning the status to the same string.
        await db.prepare("UPDATE wpm_submissions SET review_version = 2 WHERE id = ?").bind(id).run();
        return Response.json({ id: "900000000000000105" });
      }
      if (init?.method === "GET") return Response.json(posted);
      patched = JSON.parse(String(init?.body));
      return Response.json({ id: "900000000000000105" });
    };
    await notifyPending(db, env, clock, fetchImpl);
    expect(JSON.stringify(posted)).toContain(`aklmod2|wpm|approve|${id}|1`);
    expect(JSON.stringify(patched)).toContain(`aklmod2|wpm|approve|${id}|2`);
    expect(await db.prepare("SELECT shown_status, shown_review_version FROM modqueue_notifications WHERE submission_id = ?").bind(id).first())
      .toEqual({ shown_status: "pending", shown_review_version: 2 });
  });
});
