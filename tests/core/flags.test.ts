// [LDB-CUT6] The AWS runtime flags (src/core/flags.ts): STATE/mirror.mode and STATE/jobs.enabled, deploy-time defaults, a 1 s cache.
import { describe, expect, it } from "vitest";
import { createRuntimeFlags, defaultsFromEnv } from "../../src/core/flags";

describe("runtime flags", () => {
  it("[LDB-CUT6] a flag item overrides the deploy-time default; absent or unrecognised falls back to it", async () => {
    const state: Record<string, string> = {};
    const f = createRuntimeFlags(async (k) => state[k] ?? null, defaultsFromEnv({ MIRROR_MODE: "apply", JOBS_ENABLED: "off" }), { cacheMs: 0 });
    expect(await f.mirrorMode()).toBe("apply");
    expect(await f.jobsEnabled()).toBe(false);
    state["mirror.mode"] = "record";
    state["jobs.enabled"] = "on";
    expect(await f.mirrorMode()).toBe("record");
    expect(await f.jobsEnabled()).toBe(true);
    state["mirror.mode"] = "garbage";
    state["jobs.enabled"] = "maybe";
    expect(await f.mirrorMode()).toBe("apply");
    expect(await f.jobsEnabled()).toBe(false);
    // No environment at all: mirror off, jobs on (the Worker's behaviour before the flags existed).
    const bare = createRuntimeFlags(async () => null, defaultsFromEnv({}), { cacheMs: 0 });
    expect([await bare.mirrorMode(), await bare.jobsEnabled()]).toEqual(["off", true]);
  });

  it("[LDB-CUT6] reads are cached for a second per flag, so a flip is visible within a second and a hot path costs one read a second", async () => {
    let reads = 0;
    let v: string | null = null;
    let now = 1000;
    const f = createRuntimeFlags(async () => (reads++, v), defaultsFromEnv({ MIRROR_MODE: "apply" }), { nowMs: () => now });
    expect(await f.mirrorMode()).toBe("apply");
    v = "record";
    expect(await f.mirrorMode()).toBe("apply"); // cached
    now += 999;
    expect(await f.mirrorMode()).toBe("apply");
    now += 2;
    expect(await f.mirrorMode()).toBe("record");
    expect(reads).toBe(2);
  });
});
