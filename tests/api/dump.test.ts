// [LDB-D1] The nightly dump (07 §6 S7): `latest.json`'s fields, its
// `sha256` against the bytes actually served, the `302` -> object streaming
// chain, and the monthly copy's on-the-1st-only rule. Drives the real
// `0 3 * * *` cron via `worker.scheduled()` (not `writeDump()` directly) so
// this is the same code path production runs; `vi.setSystemTime()` pins the
// date `systemClock()` sees -- proven to reach the Worker's own `Date` in
// this pool (same realm as `vi.stubGlobal("fetch", ...)`, already relied on
// by tests/import/tick.test.ts's "scheduled() wiring" tests).
import { createExecutionContext, createScheduledController, SELF, env, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import type { Bindings } from "../../src/env";
import worker from "../../src/index";
import { seedUpstream100 } from "./support";

const bindings = env as unknown as Bindings;

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
