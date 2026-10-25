// DynamoDB equivalent of tests/api/mf-l2-unlike-race.test.ts (D1-only): the
// same properties, on real parallelism instead of a hook between a read and
// a batch. [LDB-DDB2] Of N concurrent unlikes by one user exactly one wins;
// [LDB-DDB3] a like or unlike racing a delete never leaves a stray like row,
// event or count; fold == row after every race. Run clean and with 20%
// injected transaction conflicts.
import { GetCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { CommitInput } from "../../src/core/events";
import { catKey, likesPrefix, userLikesPrefix } from "../../src/store/ddb/keys";
import { openDdb, queryPk, type TestDdb } from "./helpers";

const src = { client: "test", version: "1" };
const now = () => new Date().toISOString();

async function seed(t: TestDdb, id: string, name: string) {
  const input: CommitInput = {
    layoutId: id, creating: true, currentN: 0, currentLayout: null, currentFormats: new Map(),
    layout: { kind: "created", name, owner: "owner", created_at: now(), deleted: false },
    format: { kind: "created", lineage: "spark", format: "spark/1", payload: { a: 1 }, hasMagic: false },
    modified_at: now(), actor: "owner", via: "test", source: src, upstream: null,
  };
  await t.events.commitWrite(now, input);
}

/** MF-3: the stored row equals what the events fold to, and both like indexes agree. */
async function assertConsistent(t: TestDdb, id: string) {
  const cat = (await t.ctx.doc.send(new GetCommand({ TableName: t.ctx.tables.main, Key: catKey(id), ConsistentRead: true }))).Item!;
  const likes = await queryPk(t.ctx, `L#${id}`);
  const likers = likes.filter((i) => (i.sk as string).startsWith("LK#")).map((i) => i.user_id as string);
  expect(cat.like_count).toBe(likers.length);
  for (const u of likers) {
    const mine = await t.ctx.doc.send(new QueryCommand({
      TableName: t.ctx.tables.main, KeyConditionExpression: "pk = :p AND begins_with(sk, :s)",
      ExpressionAttributeValues: { ":p": userLikesPrefix(u).pk, ":s": `LK#${id}` }, ConsistentRead: true,
    }));
    expect(mine.Count).toBe(1);
  }
  void likesPrefix;
  const events = (await t.layouts.history(id)).filter((e) => e.kind === "liked" || e.kind === "unliked");
  const net = new Map<string, number>();
  for (const e of events) net.set(e.actor, (net.get(e.actor) ?? 0) + (e.kind === "liked" ? 1 : -1));
  const folded = [...net].filter(([, n]) => n === 1).map(([u]) => u).sort();
  expect([...net.values()].every((n) => n === 0 || n === 1)).toBe(true);
  expect(folded).toEqual([...likers].sort());
}

for (const rate of [0, 0.2]) {
  describe(`races at fault rate ${rate}`, () => {
    let t: TestDdb;
    beforeAll(async () => {
      t = await openDdb(`g-race-${rate === 0 ? "clean" : "faulty"}`, { faultRate: rate, seed: 11 });
    });
    afterAll(async () => {
      await t.drop();
    });
    beforeEach(async () => {
      await t.reset();
    });

    const like = (id: string, userId: string) => t.events.appendLike(now, { kind: "liked", layoutId: id, userId, via: "t", source: src });
    const unlike = (id: string, userId: string) => t.events.appendLike(now, { kind: "unliked", layoutId: id, userId, via: "t", source: src });
    const outcome = (p: Promise<unknown>) => p.then(() => "ok", (e: { status?: number; body?: { error?: string } }) => `${e.status}`);

    it("[LDB-DDB2] N concurrent unlikes by one user: exactly one 200, the rest 409 not_liked, one event", async () => {
      for (let round = 0; round < 4; round++) {
        const id = `R${round}`;
        await seed(t, id, `race${round}`);
        await like(id, "liker");
        const results = await Promise.all(Array.from({ length: 6 }, () => outcome(unlike(id, "liker"))));
        expect(results.filter((r) => r === "ok")).toHaveLength(1);
        expect(results.filter((r) => r === "409")).toHaveLength(5);
        expect((await t.layouts.history(id)).filter((e) => e.kind === "unliked")).toHaveLength(1);
        await assertConsistent(t, id);
      }
    });

    it("[LDB-DDB2] N concurrent likes by one user: exactly one 200, the rest 409 already_liked", async () => {
      await seed(t, "R9", "race9");
      const results = await Promise.all(Array.from({ length: 6 }, () => outcome(like("R9", "liker"))));
      expect(results.filter((r) => r === "ok")).toHaveLength(1);
      expect(results.filter((r) => r === "409")).toHaveLength(5);
      await assertConsistent(t, "R9");
    });

    it("[LDB-DDB2] likes by different users all land, gap-free", async () => {
      await seed(t, "R8", "race8");
      await Promise.all(Array.from({ length: 12 }, (_, i) => like("R8", `user${i}`)));
      expect((await t.layouts.likers(["R8"])).get("R8")).toHaveLength(12);
      expect(await t.head.headSeq()).toBe(2 + 12);
      const feed = await t.events.feed(0, 100);
      expect(feed.items.map((e) => e.seq)).toEqual(Array.from({ length: 14 }, (_, i) => i + 1));
      await assertConsistent(t, "R8");
    });

    for (const kind of ["like", "unlike"] as const) {
      it(`[LDB-DDB3] a ${kind} racing a delete: either order is consistent, a lost ${kind} is 404 with no stray row or event`, async () => {
        for (let round = 0; round < 6; round++) {
          const id = `D${kind}${round}`;
          await seed(t, id, `del${kind}${round}`);
          if (kind === "unlike") await like(id, "liker");
          const cur = (await t.layouts.byId(id))!;
          const del = t.events.commitWrite(now, {
            layoutId: id, creating: false, currentN: cur.n, currentLayout: cur, currentFormats: await t.layouts.formatsForLayout(id),
            layout: { kind: "deleted", name: cur.name, owner: "owner", created_at: cur.created_at, deleted: true },
            modified_at: now(), actor: "owner", via: "t", source: src, upstream: null,
          });
          const racer = round % 2 === 0 ? (kind === "like" ? like(id, "liker") : unlike(id, "liker")) : undefined;
          const [d, r] = await Promise.all([outcome(del), racer === undefined ? Promise.resolve("late") : outcome(racer)]);
          expect(d).toBe("ok");
          if (racer === undefined) {
            // The delete landed first: the late like/unlike is a 404 and changes nothing.
            const before = await t.head.headSeq();
            expect(await outcome(kind === "like" ? like(id, "liker") : unlike(id, "liker"))).toBe("404");
            expect(await t.head.headSeq()).toBe(before);
          } else {
            expect(["ok", "404"]).toContain(r);
          }
          const row = (await t.layouts.byId(id))!;
          expect(row.deleted).toBe(true);
          await assertConsistent(t, id);
        }
      });
    }
  });
}
