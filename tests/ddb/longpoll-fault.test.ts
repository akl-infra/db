// DynamoDB equivalent of tests/api/changes-longpoll-d1.test.ts's head-read
// faults (D1-only: it wrapped the D1 binding's `prepare`). [LDB-DDB4] A
// failing HEAD read during a held wait ends the hold early and never throws;
// every read of a hold is bounded by wait+1; a failing final page read throws
// (the route retries it once) and a retry succeeds.
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { waitForChanges } from "../../src/core/longpoll";
import type { DdbContext } from "../../src/store/ddb/contracts";
import { ddbEventStore } from "../../src/store/ddb/events";
import { ddbHeadStore } from "../../src/store/ddb/head";
import type { Store } from "../../src/store/port";
import { openDdb, type TestDdb } from "./helpers";

let t: TestDdb;
beforeAll(async () => {
  t = await openDdb("g-longpoll");
});
afterAll(async () => {
  await t.drop();
});
beforeEach(async () => {
  await t.reset();
});

/** A store whose HEAD reads throw on the listed 0-based calls. */
function flakyHeadStore(failOn: Set<number>): { store: Store; reads: () => number } {
  let n = 0;
  const doc = new Proxy(t.ctx.doc, {
    get(target, prop) {
      if (prop === "send") {
        return (cmd: { constructor: { name: string }; input: { Key?: { pk?: string; sk?: string } } }, ...rest: unknown[]) => {
          if (cmd instanceof GetCommand && cmd.input.Key?.pk === "META" && cmd.input.Key?.sk === "HEAD") {
            const k = n++;
            if (failOn.has(k)) return Promise.reject(Object.assign(new Error(`injected DynamoDB failure #${k}`), { name: "InjectedReadFault" }));
          }
          return (target.send as (...a: unknown[]) => Promise<unknown>).call(target, cmd, ...rest);
        };
      }
      const v = Reflect.get(target, prop, target);
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
  const ctx: DdbContext = { ...t.ctx, doc };
  return { store: { head: ddbHeadStore(ctx), events: ddbEventStore(ctx) } as unknown as Store, reads: () => n };
}

describe("[LDB-DDB4] a failing HEAD read during a held wait", () => {
  it("[LDB-DDB4] a throwing read on attempt k ends the hold early, logs it, never throws", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const sleeps: number[] = [];
      const { store, reads } = flakyHeadStore(new Set([2]));
      await waitForChanges(store, 1_000_000, 10, async (ms) => void sleeps.push(ms));
      expect(reads()).toBe(3);
      expect(sleeps.length).toBe(2);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(String(spy.mock.calls[0]![0])).toContain("attempt 2");

      const all = flakyHeadStore(new Set([0, 1, 2, 3, 4, 5]));
      await waitForChanges(all.store, 0, 3, async () => {});
      expect(all.reads()).toBeLessThanOrEqual(Math.ceil(3) + 1);
    } finally {
      spy.mockRestore();
    }
  });

  it("[LDB-DDB4] a hold on a quiet store makes at most wait+1 HEAD reads, and ends the moment HEAD moves", async () => {
    const { store, reads } = flakyHeadStore(new Set());
    const sleeps: number[] = [];
    await waitForChanges(store, 5, 3, async (ms) => void sleeps.push(ms));
    expect(reads()).toBe(4);
    expect(sleeps).toEqual([1000, 1000, 1000]);
    const m = flakyHeadStore(new Set());
    const src = { client: "t", version: null };
    await waitForChanges(m.store, 0, 5, async () => {
      await t.events.appendAdmin(() => new Date().toISOString(), { kind: "admin.import_unstalled" as never, actor: "a" });
    });
    expect(m.reads()).toBe(2);
    void src;
  });

  it("[LDB-DDB4] a failing final page read throws, and the retry succeeds", async () => {
    const { store } = flakyHeadStore(new Set([0]));
    await expect(store.events.feed(0, 10)).rejects.toThrow(/injected/);
    expect((await store.events.feed(0, 10)).items).toEqual([]);
    const twice = flakyHeadStore(new Set([0, 1]));
    await expect(twice.store.events.feed(0, 10)).rejects.toThrow();
    await expect(twice.store.events.feed(0, 10)).rejects.toThrow();
  });
});
