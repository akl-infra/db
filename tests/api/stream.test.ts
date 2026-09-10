// [LDB-H2] GET /v1/changes/stream (12 §2.2, §3 X1): SSE framing, `since`
// exclusive, `Last-Event-ID` override, `kinds` filter, the idle ping, the
// close frame + bound, gap/duplicate-free reconnect, and the Free-plan
// `503 stream_unavailable` setting. `STREAM_MAX_MS`/`STREAM_POLL_MS` are
// overridden to `500`/`20` for every workers-project test via
// `vitest.config.ts`'s miniflare `bindings` -- every case here runs to
// completion in well under a second of real wall time.
import { SELF, env } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import type { Bindings } from "../../src/env";
import { canonical } from "../../src/core/canonical";
import { headSeq } from "../../src/core/etag";
import { appendLike, appendWrite, feed, type Event } from "../../src/core/events";
import { fixedClock } from "../../src/core/time";

const bindings = env as unknown as Bindings;
const db = bindings.DB;

interface ParsedFrame {
  id?: number;
  event?: string;
  data?: string;
  ping?: boolean;
}

function parseFrames(text: string): ParsedFrame[] {
  return text
    .split("\n\n")
    .filter((block) => block.trim().length > 0)
    .map((block) => {
      const frame: ParsedFrame = {};
      for (const line of block.split("\n")) {
        if (line.startsWith(": ")) frame.ping = true;
        else if (line.startsWith("id: ")) frame.id = Number(line.slice(4));
        else if (line.startsWith("event: ")) frame.event = line.slice(7);
        else if (line.startsWith("data: ")) frame.data = line.slice(6);
      }
      return frame;
    });
}

let apCounter = 0;
async function appendOne(owner = "stream-owner"): Promise<Event> {
  const { seq } = await appendWrite(db, fixedClock("2026-08-01T00:00:00.000Z"), {
      upstream: null,
    kind: "created",
    name: `stream-fixture-${apCounter++}-${Math.random().toString(36).slice(2)}`,
    owner,
    modified_at: "2026-08-01T00:00:00.000Z",
    format: "cmini/1",
    payload: {},
    actor: owner,
    via: "discord",
    source: { client: "discord-app:test", version: null },
    hasMagic: false,
  });
  const { items } = await feed(db, seq - 1, 1);
  return items[0]!;
}

function resolveTestBindings(): { TEST_STREAM_HEARTBEAT_MS?: number } {
  return bindings as unknown as { TEST_STREAM_HEARTBEAT_MS?: number };
}

afterEach(() => {
  delete resolveTestBindings().TEST_STREAM_HEARTBEAT_MS;
  bindings.STREAM_MAX_MS = "500";
});

describe("[LDB-H2] GET /v1/changes/stream", () => {
  it("headers: Content-Type text/event-stream, Cache-Control no-store", async () => {
    const since = await headSeq(db);
    const res = await SELF.fetch(`https://example.com/v1/changes/stream?since=${since}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/event-stream");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    await res.text(); // drain to the bound so the test doesn't leave a dangling waitUntil
  });

  it("events appended after the stream opens arrive as id:<seq>/event:<kind> frames, in order, data = canonical(feed item)", async () => {
    const since = await headSeq(db);
    const resPromise = SELF.fetch(`https://example.com/v1/changes/stream?since=${since}`);
    const res = await resPromise;

    const a = await appendOne();
    const b = await appendOne();

    const text = await res.text();
    const frames = parseFrames(text).filter((f) => f.id !== undefined);
    expect(frames.map((f) => f.id)).toEqual([a.seq, b.seq]);
    expect(frames[0]!.event).toBe("created");
    expect(frames[0]!.data).toBe(canonical(a));
    expect(frames[1]!.data).toBe(canonical(b));
  });

  it("since is exclusive: an event at exactly `since` does not appear", async () => {
    const pre = await appendOne();
    const resPromise = SELF.fetch(`https://example.com/v1/changes/stream?since=${pre.seq}`);
    const res = await resPromise;
    const after = await appendOne();

    const frames = parseFrames(await res.text()).filter((f) => f.id !== undefined);
    expect(frames.map((f) => f.id)).toEqual([after.seq]);
  });

  it("Last-Event-ID overrides `since`", async () => {
    const pre = await appendOne();
    const resPromise = SELF.fetch("https://example.com/v1/changes/stream?since=0", {
      headers: { "Last-Event-ID": String(pre.seq) },
    });
    const res = await resPromise;
    const after = await appendOne();

    const frames = parseFrames(await res.text()).filter((f) => f.id !== undefined);
    expect(frames.map((f) => f.id)).toEqual([after.seq]); // NOT pre.seq -- since=0 would have included it
  });

  it("kinds filters the stream", async () => {
    const since = await headSeq(db);
    const resPromise = SELF.fetch(`https://example.com/v1/changes/stream?since=${since}&kinds=liked`);
    const res = await resPromise;

    const created = await appendOne();
    await appendLike(db, fixedClock("2026-08-01T00:00:01.000Z"), { kind: "liked", layoutId: created.layout_id!, userId: "stream-liker", via: "discord", source: { client: "discord-app:test", version: null } });

    const frames = parseFrames(await res.text()).filter((f) => f.id !== undefined);
    expect(frames).toHaveLength(1);
    expect(frames[0]!.event).toBe("liked");
  });

  it("a `: ping` frame appears after the idle interval when nothing new arrives", async () => {
    resolveTestBindings().TEST_STREAM_HEARTBEAT_MS = 50; // well under STREAM_MAX_MS=500
    const since = await headSeq(db);
    const res = await SELF.fetch(`https://example.com/v1/changes/stream?since=${since}`);
    const frames = parseFrames(await res.text());
    expect(frames.some((f) => f.ping === true)).toBe(true);
    expect(frames.some((f) => f.id !== undefined)).toBe(false);
  });

  it("[LDB-H2] closes at the bound with `event: close` + `{\"next\":cursor}`, and a reconnect from `Last-Event-ID` sees no gap or duplicate", async () => {
    const originalSince = await headSeq(db);
    const first = await appendOne();

    const firstRes = await SELF.fetch(`https://example.com/v1/changes/stream?since=${originalSince}`);
    const firstText = await firstRes.text();
    const firstFrames = parseFrames(firstText);
    const closeFrame = firstFrames.find((f) => f.event === "close");
    expect(closeFrame).toBeDefined();
    const next = (JSON.parse(closeFrame!.data!) as { next: number }).next;
    expect(next).toBeGreaterThanOrEqual(first.seq);

    // More events land while the first stream is closed.
    const second = await appendOne();
    const third = await appendOne();

    const reconnectRes = await SELF.fetch("https://example.com/v1/changes/stream", { headers: { "Last-Event-ID": String(next) } });
    const reconnectFrames = parseFrames(await reconnectRes.text());
    const reconnectIds = reconnectFrames.filter((f) => f.id !== undefined).map((f) => f.id);

    const firstIds = firstFrames.filter((f) => f.id !== undefined).map((f) => f.id);
    const unionIds = [...new Set([...firstIds, ...reconnectIds])].sort((a, b) => a! - b!);

    const wholeFeed = await feed(db, originalSince, 1000);
    expect(unionIds).toEqual(wholeFeed.items.map((e) => e.seq));
    // No duplicate across the two streams: reconnectIds start strictly
    // after firstIds' last id (== next).
    expect(Math.min(...reconnectIds.filter((x): x is number => x !== undefined))).toBeGreaterThan(next);
    void second;
    void third;
  });

  it("STREAM_MAX_MS = \"0\" -> 503 stream_unavailable", async () => {
    bindings.STREAM_MAX_MS = "0";
    const res = await SELF.fetch("https://example.com/v1/changes/stream");
    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toMatchObject({ error: "stream_unavailable" });
  });

  it("bad `since` -> 400 bad_request", async () => {
    const res = await SELF.fetch("https://example.com/v1/changes/stream?since=not-a-number");
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ error: "bad_request" });
  });

  it("bad `Last-Event-ID` -> 400 bad_request", async () => {
    const res = await SELF.fetch("https://example.com/v1/changes/stream", { headers: { "Last-Event-ID": "not-a-number" } });
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ error: "bad_request" });
  });

  it("bad `kinds` -> 400 bad_request", async () => {
    const res = await SELF.fetch("https://example.com/v1/changes/stream?kinds=not-a-real-kind");
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ error: "bad_request" });
  });

  // X4 follow-up: KNOWN_KINDS (routes/changes.ts) once had `InfoKind`
  // members (`admin.client_registered`/`admin.client_revoked`, 10 C1) that
  // never made it into the list, so this route 400'd on them too --
  // tests/core/known-kinds.test.ts is the regression suite for the type;
  // this is the black-box proof it reaches the stream's own `kinds` filter.
  it("admin.client_registered / admin.client_revoked are accepted kinds", async () => {
    const since = await headSeq(db);
    const res = await SELF.fetch(`https://example.com/v1/changes/stream?since=${since}&kinds=admin.client_registered,admin.client_revoked`);
    expect(res.status).toBe(200);
    await res.text(); // drain to the bound so the test doesn't leave a dangling waitUntil
  });
});
