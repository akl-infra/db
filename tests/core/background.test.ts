import { afterEach, describe, expect, it, vi } from "vitest";
import { workersPlatform } from "../../src/platform/workers";

const env = { DB: {}, DUMPS: {} } as never;

afterEach(() => vi.restoreAllMocks());

describe("platform.background", () => {
  it("passes the task to waitUntil and logs a rejection under a stable prefix", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const waited: Promise<unknown>[] = [];
    const platform = workersPlatform(env, { waitUntil: (p) => void waited.push(p) });
    platform.background(Promise.reject(new Error("boom")));
    expect(waited).toHaveLength(1);
    await expect(waited[0]).resolves.toBeUndefined(); // waitUntil never sees a rejection
    expect(err).toHaveBeenCalledWith("background task failed: boom");
  });

  it("without an execution context it is a no-op that does not throw or leave an unhandled rejection", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const platform = workersPlatform(env, undefined);
    platform.background(Promise.reject(new Error("nope")));
    await Promise.resolve();
    expect(err).toHaveBeenCalledWith("background task failed: nope");
  });
});
