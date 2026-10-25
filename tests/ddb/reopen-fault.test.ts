// [LDB-DDB44] Lane J: DynamoDB equivalent of tests/api/moderation-reopen-d1.test.ts' trigger fault
// ("rolls all changes back on event failure"): a reopen whose event, history row or DM expiry fails
// changes nothing; the same reopen works once the fault clears.
import { afterEach, describe, expect, it } from "vitest";
import { ddbHarness } from "../harness/ddb";
import { AT, eventsOf, expectIndexesConsistent, history, id, itemOf, moderation, MOD, outbox, review, scanMain, seedLayout, USER, wpm } from "./community-support";

afterEach(() => ddbHarness.faults.clearFaults());

async function rejectedWpm() {
  const l = await seedLayout();
  const w = { id: id(), layout_id: l.id, user_id: USER, wpm: 120, proof: "https://example.org/p", submitted_by: USER, via: "discord", submitted_at: AT };
  await wpm.submit({ by: USER, at: AT, row: w });
  const dm = outbox({ kind: "wpm", submissionId: w.id, layoutId: l.id });
  await wpm.reject({
    id: w.id, by: MOD, at: AT, reason: "original", reviewVersion: 0, event: moderation({ kind: "wpm_rejected", layoutId: l.id }), outbox: dm,
    history: history({ kind: "wpm", submissionId: w.id, action: "rejected", reason: "original" }),
  });
  return { l, w, dm };
}

const reopen = (layoutId: string, subId: string) =>
  review.reopen({
    kind: "wpm", id: subId, expected: { status: "rejected", review_version: 0 }, at: "2026-10-18T05:00:00.000Z",
    event: moderation({ kind: "wpm_reopened", layoutId }), history: history({ kind: "wpm", submissionId: subId, action: "reopened", reviewVersion: 1 }),
  });

describe("[LDB-DDB44] reopen atomicity under injected write faults", () => {
  const faults: [string, (subId: string) => (t: { key: { pk: string; sk: string }; item?: Record<string, unknown> }) => boolean][] = [
    ["the event write", () => (t) => t.key.pk.startsWith("EV") && t.item?.kind === "wpm_reopened"],
    ["the reopened history row", (subId) => (t) => t.key.pk === `SUB#wpm#${subId}` && t.key.sk.startsWith("H") && t.item?.action === "reopened"],
    ["the DM expiry", (subId) => (t) => t.key.pk === `DMO#rejection:wpm:${subId}`],
  ];

  for (const [name, predicate] of faults) {
    it(`[LDB-DDB44] failing ${name} rolls the whole reopen back`, async () => {
      const { l, w, dm } = await rejectedWpm();
      const before = (await scanMain()).filter((i) => i.pk !== "META");
      const events = (await eventsOf("wpm_reopened")).length;
      ddbHarness.faults.failWritesFor(predicate(w.id));
      await expect(reopen(l.id, w.id)).rejects.toThrow();
      ddbHarness.faults.clearFaults();
      expect(await wpm.get(w.id)).toMatchObject({ status: "rejected", review_version: 0, reason: "original" });
      expect(await review.history("wpm", w.id)).toHaveLength(1);
      expect(await itemOf(`DMO#${dm.deliveryKey}`, "ROW")).toMatchObject({ status: "pending" });
      expect((await eventsOf("wpm_reopened")).length).toBe(events);
      expect((await scanMain()).filter((i) => i.pk !== "META")).toEqual(before);
      // Nothing is stuck: the same reopen goes through once the fault clears.
      expect(await reopen(l.id, w.id)).toEqual({ claimed: true, eventAppended: true });
      expect(await itemOf(`DMO#${dm.deliveryKey}`, "ROW")).toMatchObject({ status: "expired" });
      await expectIndexesConsistent();
    });
  }
});
