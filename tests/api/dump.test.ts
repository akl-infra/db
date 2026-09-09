// [LDB-D1] The nightly dump (07 §6 S7): `latest.json`'s fields, its
// `sha256` against the bytes actually served, the `302` -> object streaming
// chain, and the monthly copy's on-the-1st-only rule. Drives the real
// `0 3 * * *` cron via `worker.scheduled()` (not `writeDump()` directly) so
// this is the same code path production runs; `vi.setSystemTime()` pins the
// date `systemClock()` sees -- proven to reach the Worker's own `Date` in
// this pool (same realm as `vi.stubGlobal("fetch", ...)`, already relied on
// by tests/import/tick.test.ts's "scheduled() wiring" tests).
//
// This file also carries the bot's dump fixture (10-implementation-
// phase4.md §4 V3: "a db/ test writes it"): `bot/tests/fixtures/db/
// dump.json.gz`, the same `writeDump()` output over the `upstream-100` seed
// that `bot/tests/cache/boot.test.ts` folds. Same RECORD-and-print
// constraint as tests/api/fixture-export.test.ts's own header doc: this
// "workers" pool has no real filesystem at all (verified there), so
// recording means printing the gzip bytes (base64, since they're binary)
// between two unique markers and slicing them out host-side. Flip
// RECORD_BOT_FIXTURE below to true, run
//   npx vitest run tests/api/dump.test.ts --reporter=verbose > /tmp/ldb-b10.out
// then:
//   python3 -c "
//   import base64, re, pathlib
//   text = pathlib.Path('/tmp/ldb-b10.out').read_text()
//   m = re.search(r'===LDB-B10-BOT-FIXTURE-START:dump.json.gz.b64===\n(.*?)\n===LDB-B10-BOT-FIXTURE-END:dump.json.gz.b64===', text, re.S)
//   out = pathlib.Path('../bot/tests/fixtures/db/dump.json.gz')
//   out.parent.mkdir(parents=True, exist_ok=True)
//   out.write_bytes(base64.b64decode(m.group(1)))
//   "
// then flip RECORD_BOT_FIXTURE back to false.
import { createExecutionContext, createScheduledController, SELF, env, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import type { Bindings } from "../../src/env";
import worker from "../../src/index";
import { seedUpstream100 } from "./support";

const bindings = env as unknown as Bindings;
const RECORD_BOT_FIXTURE = false; // NEVER true on a committed run -- see the header doc above

// Chunked to stay well clear of any call-stack/argument-count limit on
// `String.fromCharCode(...bytes)` for a many-KB gzip buffer.
function bytesToBase64(bytes: Uint8Array): string {
  const CHUNK = 8192;
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

async function runDumpCron(dateIso: string): Promise<void> {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(dateIso));
  try {
    const ctx = createExecutionContext();
    const controller = createScheduledController({ cron: "0 3 * * *" });
    await worker.scheduled(controller, bindings, ctx);
    await waitOnExecutionContext(ctx);
  } finally {
    vi.useRealTimers();
  }
}

async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function gunzipJson(gz: ArrayBuffer): Promise<unknown> {
  const ds = new DecompressionStream("gzip");
  const stream = new Response(gz).body!.pipeThrough(ds);
  const text = await new Response(stream).text();
  return JSON.parse(text);
}

describe("dump routes", () => {
  it("[LDB-D1] 404s before any dump has been written", async () => {
    const dumpRes = await SELF.fetch("https://example.com/v1/dump");
    expect(dumpRes.status).toBe(404);
    const latestRes = await SELF.fetch("https://example.com/v1/dump/latest.json");
    expect(latestRes.status).toBe(404);
  });

  it("[LDB-D1] does not write a monthly key on a non-1st date", async () => {
    await seedUpstream100();
    await runDumpCron("2026-07-15T03:00:00.000Z");

    const monthlyRes = await SELF.fetch("https://example.com/v1/dump/monthly/dump-2026-07.json.gz");
    expect(monthlyRes.status).toBe(404);
  });

  it("[LDB-D1] latest.json's fields, the sha256, the 302 chain, and the monthly key on the 1st", async () => {
    await runDumpCron("2026-07-01T03:00:00.000Z");

    const metaRes = await SELF.fetch("https://example.com/v1/meta");
    const meta = await metaRes.json<{ layout_count: number; seq: number }>();

    const latestRes = await SELF.fetch("https://example.com/v1/dump/latest.json");
    expect(latestRes.status).toBe(200);
    expect(latestRes.headers.get("Content-Type")).toContain("application/json");
    const latest = await latestRes.json<{
      date: string;
      key: string;
      url: string;
      sha256: string;
      bytes: number;
      layout_count: number;
      seq: number;
    }>();
    expect(latest.date).toBe("2026-07-01");
    expect(latest.key).toBe("dump-2026-07-01.json.gz");
    expect(latest.url).toBe("/v1/dump/dump-2026-07-01.json.gz");
    expect(latest.layout_count).toBe(meta.layout_count);
    expect(latest.seq).toBe(meta.seq);

    // The redirect target, streamed with the right content type and a
    // matching R2-derived ETag.
    const dumpRes = await SELF.fetch("https://example.com/v1/dump", { redirect: "manual" });
    expect(dumpRes.status).toBe(302);
    expect(dumpRes.headers.get("Location")).toBe("/v1/dump/dump-2026-07-01.json.gz");

    const gzRes = await SELF.fetch(`https://example.com${latest.url}`);
    expect(gzRes.status).toBe(200);
    expect(gzRes.headers.get("Content-Type")).toBe("application/gzip");
    expect(gzRes.headers.get("Content-Encoding")).toBeNull();
    expect(gzRes.headers.get("ETag")).not.toBeNull();

    const bytes = await gzRes.arrayBuffer();
    expect(bytes.byteLength).toBe(latest.bytes);
    expect(await sha256Hex(bytes)).toBe(latest.sha256);

    // The 1st of the month also gets a monthly copy, byte-identical to the
    // daily one (same gzip written to both keys).
    const monthlyRes = await SELF.fetch("https://example.com/v1/dump/monthly/dump-2026-07.json.gz");
    expect(monthlyRes.status).toBe(200);
    expect(monthlyRes.headers.get("Content-Type")).toBe("application/gzip");
    const monthlyBytes = await monthlyRes.arrayBuffer();
    expect(await sha256Hex(monthlyBytes)).toBe(latest.sha256);
  });

  // [LDB-H4]: a webhook `secret` never leaves the `webhooks` table -- the
  // dump's own half of that scan (webhooks.test.ts covers every response
  // body and event). A live subscription exists at cron time (registered
  // through the real route, so its `secret` is genuinely in D1) yet the
  // dump's `webhooks` field is `[]` regardless.
  it("[LDB-H4] the dump's `webhooks` field is always [] even with a live subscription", async () => {
    await bindings.DB
      .prepare(
        `INSERT INTO webhooks (id, owner_user_id, url, secret, kinds, owner_filter, status, cursor, failures, failing_since, next_at, last_error, created_at)
         VALUES ('wh-dump-1', '800000000000000099', 'https://example.com/hook', 'a-very-secret-value-16plus', NULL, NULL, 'active', 0, 0, NULL, '2026-07-08T00:00:00.000Z', NULL, '2026-07-08T00:00:00.000Z')`,
      )
      .run();

    await runDumpCron("2026-07-08T03:00:00.000Z");
    const latestRes = await SELF.fetch("https://example.com/v1/dump/latest.json");
    const latest = await latestRes.json<{ url: string }>();
    const gzRes = await SELF.fetch(`https://example.com${latest.url}`);
    const dump = (await gunzipJson(await gzRes.arrayBuffer())) as { webhooks: unknown[] };

    expect(dump.webhooks).toEqual([]);
    expect(JSON.stringify(dump)).not.toContain("a-very-secret-value-16plus");
  });

  it("[LDB-D1] a following day's tick overwrites latest.json without touching the existing monthly key", async () => {
    await runDumpCron("2026-07-02T03:00:00.000Z");

    const latestRes = await SELF.fetch("https://example.com/v1/dump/latest.json");
    const latest = await latestRes.json<{ date: string; key: string }>();
    expect(latest.date).toBe("2026-07-02");
    expect(latest.key).toBe("dump-2026-07-02.json.gz");

    // July's monthly copy (written on the 1st) is still there, untouched by
    // a day that isn't itself the 1st.
    const monthlyRes = await SELF.fetch("https://example.com/v1/dump/monthly/dump-2026-07.json.gz");
    expect(monthlyRes.status).toBe(200);
  });
});

// bot/tests/fixtures/db/dump.json.gz -- see the header doc for how this is
// (re)recorded. Skipped on every committed run (RECORD_BOT_FIXTURE is
// false); `bot/tests/cache/boot.test.ts` (LDB-B10, the bot's own registry)
// is what actually exercises the committed fixture -- deliberately UNTAGGED
// here: this is a fixture-export utility, not an assertion of DB behavior,
// and LDB-B10 is not a db/INVARIANTS.md id (db/tests/tools/invariants.test.ts
// would refuse an orphaned tag were this ever un-skipped and detected).
describe("bot/ dump fixture (10 §4 V3)", () => {
  it.skipIf(!RECORD_BOT_FIXTURE)("prints bot/tests/fixtures/db/dump.json.gz (base64) from the upstream-100 seed", async () => {
    await seedUpstream100();
    await runDumpCron("2026-07-01T03:00:00.000Z");

    const latestRes = await SELF.fetch("https://example.com/v1/dump/latest.json");
    expect(latestRes.status).toBe(200);
    const latest = await latestRes.json<{ url: string }>();
    const gzRes = await SELF.fetch(`https://example.com${latest.url}`);
    expect(gzRes.status).toBe(200);
    const bytes = new Uint8Array(await gzRes.arrayBuffer());

    // eslint-disable-next-line no-console -- the whole point of RECORD mode
    console.log(`===LDB-B10-BOT-FIXTURE-START:dump.json.gz.b64===\n${bytesToBase64(bytes)}\n===LDB-B10-BOT-FIXTURE-END:dump.json.gz.b64===`);
  });
});
