// [LDB-MD25] A card status edit Discord will never accept is parked, not
// retried forever; transient failures retry with backoff up to a cap. Fake
// Discord, counted calls and an injected clock only: no wall-clock assertions.
import { env, store, testStore } from "../harness";
import { pick } from "./store-support";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ulid } from "ulidx";
import type { Bindings } from "../../src/env";
import { commitWrite, type CommitInput } from "../../src/core/events";
import { MAX_EDIT_ATTEMPTS, notifyPending } from "../../src/core/modqueue";
import { buildV2Payload } from "../../src/core/modqueue-message";
import type { Clock } from "../../src/core/time";

const WEBHOOK_URL = "https://discord.test/api/webhooks/modqueue-parking-test";
const bindings = { ...(env as unknown as Bindings), MODQUEUE_DISCORD_WEBHOOK: WEBHOOK_URL } as Bindings;
const bindingsV2 = { ...bindings, MODQUEUE_DISCORD_COMPONENTS: "true" } as Bindings;

afterEach(() => vi.restoreAllMocks());

/** A clock the test moves by hand. */
function handClock(startIso = "2026-11-23T00:00:00.000Z"): Clock & { advanceHours(h: number): void } {
  let ms = Date.parse(startIso);
  const c = (() => new Date(ms).toISOString()) as Clock & { advanceHours(h: number): void };
  c.advanceHours = (h) => { ms += h * 3_600_000; };
  return c;
}

let counter = 0;
async function freshLayout(): Promise<string> {
  const owner = "900000000000000001";
  const at = "2026-11-23T00:00:00.000Z";
  const input: CommitInput = {
    layoutId: ulid(), creating: true, currentN: 0, currentLayout: null, currentFormats: new Map(),
    layout: { kind: "created", name: `modq-park-${++counter}`, owner, created_at: at, deleted: false },
    format: { kind: "format_added", lineage: "spark", format: "spark/1", payload: { keys: {} }, hasMagic: false },
    modified_at: at, actor: owner, via: "discord", source: { client: "discord-app:test", version: null }, upstream: null,
  };
  return (await commitWrite(store, () => at, input)).layout.id;
}

const AT = "2026-11-23T00:00:00.000Z";

/** A tracked, already-announced link card whose source was then decided. */
async function decidedLink(status = "rejected"): Promise<string> {
  const id = ulid();
  await testStore.insert("link_submissions", { id, layout_id: await freshLayout(), url: "https://example.org/x", submitted_by: "900000000000000010", submitted_at: AT, status, decided_by: null, decided_at: null, reason: null, notified_at: AT });
  await testStore.insert("modqueue_notifications", { kind: "link", submission_id: id, message_id: `m-${id}`, shown_status: "pending", message_format: "text", transport: "legacy_webhook" });
  return id;
}

interface Fake { fetchImpl: typeof fetch; gets: number; patches: number }
/** Discord stand-in: GET always shows the card; PATCH answers `patch(callIndex)`. */
function fakeDiscord(patch: (n: number) => number | "throw", card: unknown = { content: "New link submission" }, body: unknown = null): Fake {
  const f: Fake = { gets: 0, patches: 0, fetchImpl: async (_input, init) => {
    if (init?.method === "GET") { f.gets++; return Response.json(card); }
    const outcome = patch(f.patches++);
    if (outcome === "throw") throw new Error("fake discord: network error");
    return outcome >= 400 ? Response.json(body ?? { message: "fake", code: 50035 }, { status: outcome }) : new Response(null, { status: outcome });
  } };
  return f;
}

function notification(id: string, kind = "link") {
  return testStore.row("modqueue_notifications", { kind, submission_id: id }).then((r) => pick<{ failed_attempts: number; parked_at: string | null; parked_key: string | null; parked_error: string | null; shown_status: string }>(r, "failed_attempts", "parked_at", "parked_key", "parked_error", "shown_status"));
}

describe("[LDB-MD25] permanent Discord refusals park the card", () => {
  for (const status of [400, 403]) {
    it(`[LDB-MD25] a ${status} on the edit parks after one attempt, logs the Discord body once, and nothing is sent again`, async () => {
      const id = await decidedLink();
      const log = vi.spyOn(console, "error").mockImplementation(() => {});
      const clock = handClock();
      const fake = fakeDiscord(() => status, undefined, { message: "Invalid Form Body", code: 50035 });
      await notifyPending(store, bindings, clock, fake.fetchImpl);
      expect(fake.patches).toBe(1);
      const row = await notification(id);
      expect(row?.parked_at).not.toBeNull();
      expect(row?.parked_key).toBe("rejected:0:");
      expect(row?.parked_error).toContain("Invalid Form Body");
      const lines = log.mock.calls.map((c) => String(c[0])).filter((l) => l.includes(id));
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain("parked");
      expect(lines[0]).toContain("Invalid Form Body");
      // Any number of later sweeps, a day apart each, touch nothing.
      const gets = fake.gets;
      for (let i = 0; i < 5; i++) { clock.advanceHours(24); await notifyPending(store, bindings, clock, fake.fetchImpl); }
      expect(fake.patches).toBe(1);
      expect(fake.gets).toBe(gets);
      expect(log.mock.calls.map((c) => String(c[0])).filter((l) => l.includes(id))).toHaveLength(1);
    });
  }

  it("[LDB-MD25] a parked card is retried afresh, with a fresh budget, once its source state changes", async () => {
    const id = await decidedLink("rejected");
    vi.spyOn(console, "error").mockImplementation(() => {});
    const clock = handClock();
    const refuse = fakeDiscord(() => 400);
    await notifyPending(store, bindings, clock, refuse.fetchImpl);
    expect((await notification(id))?.parked_at).not.toBeNull();
    await testStore.patch("link_submissions", { id }, { status: "approved" });
    const ok = fakeDiscord(() => 204);
    await notifyPending(store, bindings, clock, ok.fetchImpl);
    expect(ok.patches).toBe(1);
    const row = await notification(id);
    expect(row).toMatchObject({ shown_status: "approved", parked_at: null, parked_key: null, failed_attempts: 0 });
  });
});

describe("[LDB-MD25] transient failures retry with backoff, bounded, then park", () => {
  for (const [name, answer] of [["5xx", () => 503], ["network errors", () => "throw" as const]] as const) {
    it(`[LDB-MD25] ${name}: backoff holds the card between sweeps and the ${MAX_EDIT_ATTEMPTS}th failure parks it`, async () => {
      const id = await decidedLink();
      const log = vi.spyOn(console, "error").mockImplementation(() => {});
      const clock = handClock();
      const fake = fakeDiscord(answer);
      await notifyPending(store, bindings, clock, fake.fetchImpl);
      expect(fake.patches).toBe(1);
      expect((await notification(id))?.failed_attempts).toBe(1);
      // Same instant: still in backoff, nothing is sent.
      await notifyPending(store, bindings, clock, fake.fetchImpl);
      expect(fake.patches).toBe(1);
      // Each later sweep is made well past any backoff (7 h > the 6 h cap).
      for (let i = 2; i <= MAX_EDIT_ATTEMPTS + 3; i++) { clock.advanceHours(7); await notifyPending(store, bindings, clock, fake.fetchImpl); }
      expect(fake.patches).toBe(MAX_EDIT_ATTEMPTS);
      const row = await notification(id);
      expect(row?.parked_at).not.toBeNull();
      expect(row?.failed_attempts).toBe(MAX_EDIT_ATTEMPTS);
      expect(log.mock.calls.map((c) => String(c[0])).filter((l) => l.includes("parked") && l.includes(id))).toHaveLength(1);
    });
  }

  it("[LDB-MD25] a transient failure followed by success clears the count and nothing is parked", async () => {
    const id = await decidedLink();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const clock = handClock();
    const fake = fakeDiscord((n) => n < 2 ? 502 : 204);
    for (let i = 0; i < 3; i++) { await notifyPending(store, bindings, clock, fake.fetchImpl); clock.advanceHours(7); }
    expect(fake.patches).toBe(3);
    expect(await notification(id)).toMatchObject({ shown_status: "rejected", failed_attempts: 0, parked_at: null });
  });

  it("[LDB-MD25] a 429 is the shared gate's to defer: it neither counts as a failure nor parks", async () => {
    const id = await decidedLink();
    vi.spyOn(console, "error").mockImplementation(() => {});
    const fake: Fake = { gets: 0, patches: 0, fetchImpl: async (_i, init) => {
      if (init?.method === "GET") { fake.gets++; return Response.json({ content: "x" }); }
      fake.patches++;
      return Response.json({ retry_after: 1 }, { status: 429, headers: { "Retry-After": "1" } });
    } };
    try {
      await notifyPending(store, bindings, handClock(), fake.fetchImpl);
      expect(fake.patches).toBe(1);
      expect(await notification(id)).toMatchObject({ failed_attempts: 0, parked_at: null });
    } finally {
      await testStore.patch("modqueue_delivery_gate", { id: 1 }, { retry_at: 0 }); // the cooldown is real-time state; do not leak it
    }
  });
});

describe("[LDB-MD25] the stuck production card drains", () => {
  // The prod item: a comment card whose decision edit Discord answered 400
  // every five minutes. A Components V2 message may carry 4000 characters of
  // text; an older card has its preview filling that and no room for the
  // status line a decision adds.
  async function stuckComment(bodyLength: number): Promise<{ id: string; card: unknown }> {
    const id = ulid();
    const layoutId = await freshLayout();
    await testStore.insert("layout_comments", { id, layout_id: layoutId, user_id: "900000000000000020", body: "b".repeat(50), via: "discord", submitted_at: AT, status: "rejected", decided_by: null, decided_at: AT, reason: "r".repeat(480) });
    await testStore.insert("modqueue_notifications", { kind: "comment", submission_id: id, message_id: `m-${id}`, shown_status: "pending", message_format: "components_v2", transport: "legacy_webhook" });
    const card = buildV2Payload("comment", { id, layout_id: layoutId, user_id: "900000000000000020", body: "b".repeat(50), layout_name: "x", layout_owner: "900000000000000001", user_name: "Someone", live_body: null }) as { components: { components: { id?: number; content?: string }[] }[] };
    card.components[0]!.components.find((c) => c.id === 41004)!.content = "b".repeat(bodyLength);
    return { id, card };
  }
  const textTotal = (body: unknown): number => {
    let n = 0;
    const walk = (c: unknown): void => {
      if (Array.isArray(c)) c.forEach(walk);
      else if (c !== null && typeof c === "object") { const r = c as Record<string, unknown>; if (r.type === 10 && typeof r.content === "string") n += r.content.length; walk(r.components); }
    };
    walk((body as { components: unknown }).components);
    return n;
  };

  it("[LDB-MD25] the edit is trimmed to Discord's 4000-character text limit, so it succeeds and the card converges", async () => {
    const { id, card } = await stuckComment(3900);
    vi.spyOn(console, "error").mockImplementation(() => {});
    const seen: unknown[] = [];
    // Discord's rule: 400 when the text displays total more than 4000.
    const fetchImpl: typeof fetch = async (_i, init) => {
      if (init?.method === "GET") return Response.json(card);
      const body = JSON.parse(String(init?.body));
      seen.push(body);
      return textTotal(body) > 4000 ? Response.json({ code: 50035, message: "components text too long" }, { status: 400 }) : new Response(null, { status: 200 });
    };
    await notifyPending(store, bindingsV2, handClock(), fetchImpl);
    expect(seen).toHaveLength(1);
    expect(textTotal(seen[0])).toBeLessThanOrEqual(4000);
    expect(await notification(id, "comment")).toMatchObject({ shown_status: "rejected", parked_at: null, failed_attempts: 0 });
  });

  it("[LDB-MD25] if Discord still answers 400 for any other reason the card parks after one edit", async () => {
    const { id, card } = await stuckComment(100);
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const fake = fakeDiscord(() => 400, card, { code: 50035, message: "Invalid Form Body" });
    const clock = handClock();
    for (let i = 0; i < 4; i++) { await notifyPending(store, bindingsV2, clock, fake.fetchImpl); clock.advanceHours(1); }
    expect(fake.patches).toBe(1);
    expect((await notification(id, "comment"))?.parked_at).not.toBeNull();
    expect(log.mock.calls.map((c) => String(c[0])).filter((l) => l.includes(id))).toHaveLength(1);
  });
});
