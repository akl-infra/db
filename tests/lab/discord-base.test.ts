// [LDB-PG12..PG14] DISCORD_API_URL is the one source of every Discord URL akldb builds (design/aws-port.md §5.1). The
// literals below are what the code built before the interaction callback took its base from the config.
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveBearer } from "../../src/auth/discord";
import { drainDiscordActions } from "../../src/core/discord-interactions";
import { updateQueueNotification } from "../../src/core/modqueue";
import { verifyDiscordProofAuthor } from "../../src/core/modqueue-proof";
import { lookupDiscordUser } from "../../src/core/discord-users";
import { dispatchRejectionDms } from "../../src/core/rejection-dm";
import { PINNED_DISCORD_API_URL, withDiscordDefault } from "../../src/platform/lab-entry";
import { stubStore } from "./stub-store";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const USER = "300000000000000001";
const CHANNEL = "700000000000000002";
const MESSAGE = "800000000000000003";
const APP = "900000000000000004";

const BOT = {
  MODQUEUE_DISCORD_BOT_TOKEN: "bot-token",
  MODQUEUE_DISCORD_ACTIONS: "true",
  MODQUEUE_DISCORD_APPLICATION_ID: APP,
  MODQUEUE_DISCORD_DMS: "true",
};

/** Every URL the six Discord call sites build, in a fixed order, with Discord answering nothing useful. */
async function urlsFor(env: Record<string, unknown>): Promise<string[]> {
  const urls: string[] = [];
  const spy = vi.fn(async (input: string | URL | Request) => {
    urls.push(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    return new Response("{}", { status: 404 });
  });
  const bindings = { ...BOT, ...env } as never;
  const now = () => "2026-10-30T12:00:00.000Z";
  // bearer check
  await resolveBearer(stubStore(), now, "tok", spy as never, (bindings as { DISCORD_API_URL: string }).DISCORD_API_URL).catch(() => {});
  // bot routes: user lookup, proof message, modqueue message read
  await lookupDiscordUser(bindings, USER, { fetchImpl: spy as never });
  await verifyDiscordProofAuthor(`https://discord.com/channels/100000000000000000/${CHANNEL}/${MESSAGE}`, USER, bindings, spy as never);
  await updateQueueNotification(
    stubStore({
      "modqueue.leaseNotification": async () => true,
      "modqueue.notification": async () => ({ message_id: MESSAGE, shown_status: "pending", shown_review_version: 0, shown_source_message_url: null, message_format: "text", transport: "bot", channel_id: CHANNEL }),
      "modqueue.sourceStatus": async () => ({ status: "approved", submitter_id: USER, decider_name: "d", review_version: 1, reason: null, source_message_url: null }),
    }),
    bindings,
    "link",
    "01HZZZZZZZZZZZZZZZZZZZZZZZ",
    spy as never,
  );
  // DM channel create
  await dispatchRejectionDms(
    stubStore({
      "outbox.due": async () => [{ decision: "rejection", delivery_key: "k", event_seq: 1, review_version: 1, nonce: "n", kind: "comment", submission_id: "s", layout_id: "l", recipient_id: USER, status: "pending", attempts: 0, next_attempt_at: "2026-10-30T12:00:00.000Z", lease_token: null, lease_until: null, ambiguous_message_attempt_at: null }],
      "outbox.lease": async () => true,
      "outbox.content": async () => ({ recipient_id: USER, layout_name: "L", reason: null, comment_body: "c", eligible: true, deleted: 0 }),
    }),
    bindings,
    now,
    spy as never,
  );
  // interaction callback (uses the global fetch)
  const real = globalThis.fetch;
  globalThis.fetch = spy as never;
  try {
    await drainDiscordActions(
      stubStore({
        "discord.pendingCallbacks": async (table: unknown) =>
          table === "discord_pending_actions" ? [{ application_id: APP, token: "itok", response_mode: "reply", result: "Not allowed.", state: "done" }] : [],
      }),
      bindings,
      now,
    );
  } finally {
    globalThis.fetch = real;
  }
  return urls;
}

const TODAY = [
  "https://discord.com/api/oauth2/@me",
  `https://discord.com/api/v10/users/${USER}`,
  `https://discord.com/api/v10/channels/${CHANNEL}/messages/${MESSAGE}`,
  "https://discord.com/api/v10/users/@me/channels",
  `https://discord.com/api/v10/webhooks/${APP}/itok/messages/@original`,
];

afterEach(() => vi.restoreAllMocks());

describe("Discord base URL", () => {
  it("[LDB-PG12] unset or set to the default, every URL akldb builds equals the literal it built before, byte for byte", async () => {
    expect(await urlsFor({ DISCORD_API_URL: "https://discord.com/api" })).toEqual(TODAY);
    expect(await urlsFor(withDiscordDefault({}) as never)).toEqual(TODAY);
  });

  it("[LDB-PG13] set to a loopback base, every URL goes there and nothing reaches discord.com", async () => {
    const base = "http://127.0.0.1:18402/api";
    const urls = await urlsFor({ DISCORD_API_URL: base });
    expect(urls).toEqual(TODAY.map((u) => u.replace("https://discord.com/api", base)));
    expect(urls.some((u) => u.includes("discord.com"))).toBe(false);
  });

  it("[LDB-PG14] the default is pinned at https://discord.com/api in wrangler.toml, the lab entry and the Lambda config", () => {
    expect(PINNED_DISCORD_API_URL).toBe("https://discord.com/api");
    expect(fs.readFileSync(path.join(ROOT, "wrangler.toml"), "utf8")).toMatch(/^DISCORD_API_URL = "https:\/\/discord\.com\/api"$/m);
    expect(fs.readFileSync(path.join(ROOT, "src/platform/lambda.ts"), "utf8")).toContain('DISCORD_API_URL: e.DISCORD_API_URL ?? "https://discord.com/api",');
    expect(fs.readFileSync(path.join(ROOT, "src/core/discord-interactions.ts"), "utf8")).not.toMatch(/https:\/\/discord\.com/);
  });
});
