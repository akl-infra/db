// [LDB-DDB5] The DynamoDB analog of LDB-L8 (tests/api/l8-roundtrips.test.ts,
// D1-only): an upper bound on DynamoDB calls per store operation, one pinned
// number each. A count that grows is a regression in cost and latency, so
// raising a number needs a reason written next to it. `total` counts every
// SDK call; a TransactWrite is one call whatever its item count.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { CommitInput } from "../../src/core/events";
import { openDdb, type TestDdb } from "./helpers";

let t: TestDdb;
beforeAll(async () => {
  t = await openDdb("g-roundtrips", { faultRate: 0 }) /* call counts are exact only without injected retries */;
});
afterAll(async () => {
  await t.drop();
});
beforeEach(async () => {
  await t.reset();
});

const src = { client: "test", version: "1" };
const now = () => new Date().toISOString();

const create = (id: string, name: string): CommitInput => ({
  layoutId: id, creating: true, currentN: 0, currentLayout: null, currentFormats: new Map(),
  layout: { kind: "created", name, owner: "u1", created_at: now(), deleted: false },
  format: { kind: "created", lineage: "spark", format: "spark/1", payload: { a: 1 }, hasMagic: false },
  modified_at: now(), actor: "u1", via: "test", source: src, upstream: null,
});

async function calls<T>(fn: () => Promise<T>) {
  const { calls } = await t.counted.calls.measure(fn);
  return calls;
}

// One row per operation: [label, bound on total calls, how many of them are writes].
// Every write path is: HEAD read (1) + the one TransactWrite (1), plus the reads noted.
describe("[LDB-DDB5] DynamoDB calls per store operation", () => {
  it("[LDB-DDB5] writes", async () => {
    // create: HEAD read + one transaction. No read-back (nothing to heal on a new layout).
    expect(await calls(() => t.events.commitWrite(now, create("A", "alpha")))).toMatchObject({ total: 2, writes: 1 });
    const cur = (await t.layouts.byIdWithFormats("A"))!;
    const upd = (over: Partial<CommitInput> = {}): CommitInput => ({
      layoutId: "A", creating: false, currentN: cur.layout.n, currentLayout: cur.layout, currentFormats: cur.formats,
      format: { kind: "updated", lineage: "spark", format: "spark/1", payload: { a: 2 }, hasMagic: false },
      modified_at: now(), actor: "u1", via: "test", source: src, upstream: null, ...over,
    });
    // update: HEAD + transaction + the post-commit read of like_count/link that D1 got inside its batch.
    expect(await calls(() => t.events.commitWrite(now, upd()))).toMatchObject({ total: 3, writes: 1 });
    // with the destructive budget: + the post-commit read of the window counter, + the HEAD live count comes from the HEAD already read.
    const cur2 = (await t.layouts.byIdWithFormats("A"))!;
    expect(
      await calls(() =>
        t.events.commitWrite(now, upd({
          currentN: cur2.layout.n, currentLayout: cur2.layout, currentFormats: cur2.formats,
          layout: { kind: "renamed", name: "alpha2", owner: "u1", created_at: cur2.layout.created_at, deleted: false },
          destructiveBudget: { clientId: "c1" },
        })),
      ),
    ).toMatchObject({ total: 4, writes: 1 });
    // info / admin / moderation: [CAT read] + HEAD + transaction
    expect(await calls(() => t.events.appendInfo(now, { kind: "upstream_changed", layoutId: "A", actor: "s", via: "i", source: src }))).toMatchObject({ total: 3, writes: 1 });
    expect(await calls(() => t.events.appendAdmin(now, { kind: "admin.import_unstalled" as never, actor: "a" }))).toMatchObject({ total: 2, writes: 1 });
    expect(await calls(() => t.events.appendModeration(now, { kind: "link_submitted" as never, layoutId: "A", actor: "a", via: "d", source: src }))).toMatchObject({ total: 3, writes: 1 });
    // like: CAT read + HEAD + transaction + like_count read-back
    expect(await calls(() => t.events.appendLike(now, { kind: "liked", layoutId: "A", userId: "x", via: "t", source: src }))).toMatchObject({ total: 4, writes: 1 });
    // with the caller's fresh row (LDB-L8b): one read fewer
    expect(await calls(() => t.events.appendLike(now, { kind: "liked", layoutId: "A", userId: "y", via: "t", source: src, current: cur.layout }))).toMatchObject({ total: 3, writes: 1 });
    expect(await calls(() => t.events.appendLike(now, { kind: "unliked", layoutId: "A", userId: "y", via: "t", source: src, current: cur.layout }))).toMatchObject({ total: 3, writes: 1 });
    // refused like: no read-back
    expect(await calls(() => t.events.appendLike(now, { kind: "liked", layoutId: "A", userId: "x", via: "t", source: src, current: cur.layout }).catch(() => null))).toMatchObject({ total: 2, writes: 1 });
    // link change without a submission: CAT read + lane J's plan (guard read, pending-set query) + HEAD + transaction
    expect(await calls(() => t.events.appendLinkChange(now, { layoutId: "A", kind: "link_cleared", link: null, actor: "a", via: "d", admin: true, source: src }))).toMatchObject({ total: 5, writes: 1 });
    // inherited likes: likers query + (HEAD + transaction) per chunk of 15 + read-back
    const users = Array.from({ length: 31 }, (_, i) => `inh${i}`);
    expect(await calls(() => t.events.appendInheritedLikes(now, { layoutId: "A", name: "n", owner: "u1", userIds: users, via: "v", detail: {}, source: src }))).toMatchObject({ total: 1 + 3 * 2 + 1, writes: 3 });
  });

  it("[LDB-DDB5] reads", async () => {
    await t.events.commitWrite(now, create("A", "alpha"));
    await t.events.appendLike(now, { kind: "liked", layoutId: "A", userId: "x", via: "t", source: src });
    expect(await calls(() => t.layouts.byId("A"))).toMatchObject({ total: 1 });
    expect(await calls(() => t.layouts.byIdWithFormats("A"))).toMatchObject({ total: 1 });
    expect(await calls(() => t.layouts.byName("ALPHA"))).toMatchObject({ total: 2 }); // claim, then layout
    expect(await calls(() => t.layouts.byNameWithFormats("alpha"))).toMatchObject({ total: 2 });
    expect(await calls(() => t.layouts.byRef("01HZZZZZZZZZZZZZZZZZZZZZZZ"))).toMatchObject({ total: 2 }); // id miss, then the name path (claim miss)
    expect(await calls(() => t.layouts.readFormat("A", "spark"))).toMatchObject({ total: 1 });
    expect(await calls(() => t.layouts.formatsForLayout("A"))).toMatchObject({ total: 1 });
    expect(await calls(() => t.layouts.layoutPresence("A"))).toMatchObject({ total: 1 });
    expect(await calls(() => t.layouts.approvedLink("A"))).toMatchObject({ total: 1 });
    expect(await calls(() => t.layouts.revision("A", "spark", 1))).toMatchObject({ total: 2 }); // rev item, then its event
    expect(await calls(() => t.layouts.revisionPayload("A", "spark", 1))).toMatchObject({ total: 1 });
    expect(await calls(() => t.layouts.likers(["A"]))).toMatchObject({ total: 1 });
    expect(await calls(() => t.layouts.likeCountByUser("x"))).toMatchObject({ total: 1 });
    expect(await calls(() => t.layouts.history("A"))).toMatchObject({ total: 2 }); // HEAD, one page
    expect(await calls(() => t.layouts.latestRevBumpingEvent("A", null))).toMatchObject({ total: 2 });
    expect(await calls(() => t.layouts.authorExists("u1"))).toMatchObject({ total: 1 });
    expect(await calls(() => t.head.headSeq())).toMatchObject({ total: 1 });
    expect(await calls(() => t.head.readHead(["a", "b"]))).toMatchObject({ total: 1 }); // one BatchGet
    expect(await calls(() => t.head.readHead(["a"], "2026-01-01T00:00:00.000Z"))).toMatchObject({ total: 2 }); // + the rolling delete count
    expect(await calls(() => t.state.getMany(["a", "b", "c"]))).toMatchObject({ total: 1 });
    expect(await calls(() => t.events.feed(0, 100))).toMatchObject({ total: 2 }); // HEAD, one page
    expect(await calls(() => t.events.feed(2, 100))).toMatchObject({ total: 2 }); // HEAD, one page
    expect(await calls(() => t.events.feed(3, 100))).toMatchObject({ total: 1 }); // caught up: HEAD only
    expect(await calls(() => t.events.latestLinkEvent("A"))).toMatchObject({ total: 2 });
    expect(await calls(() => t.events.revertCandidates("test", "2000-01-01T00:00:00.000Z", 1000, 10))).toMatchObject({ total: 2 });
  });
});
