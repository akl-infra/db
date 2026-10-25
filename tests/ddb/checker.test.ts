// [LDB-DDB72] The index checker regenerates every derived item from the
// primary items and diffs it against what is stored: clean after an import,
// and every kind of damage (a lost claim or mirror, a stray one, a drifted
// HEAD, an altered mirror) is reported by name. It never repairs.
import { DeleteCommand, GetCommand, PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { checkIndexes } from "../../src/store/ddb/checker";
import { dumpToRows, importRows } from "../../src/store/ddb/codec";
import type { D1TableName, RowsByTable } from "../../src/store/ddb/contracts";
import { SCHEMAS } from "../../src/store/ddb/schema";
import { ddbHarness } from "../harness/ddb";
import { wipeTables } from "../harness/ddb-store";
import seed from "../fixtures/seed-upstream-100.dump.json" with { type: "json" };
import type { Dump } from "../../src/dump/write";

const ctx = { doc: ddbHarness.raw, tables: ddbHarness.tables, blobs: ddbHarness.blobs };
const T = ctx.tables.main;
const doc = ctx.doc;

const coreReady = (() => {
  try {
    SCHEMAS[0]!.toItems({ layouts: [] });
    return true;
  } catch {
    return false;
  }
})();

/** Five layouts of the seed dump with everything that hangs off them. */
function small(): RowsByTable {
  const all = dumpToRows(seed as unknown as Dump);
  const liked = new Set(all.likes!.map((k) => k.layout_id as string));
  const ids = new Set(all.layouts!.filter((l) => liked.has(l.id as string)).slice(0, 5).map((l) => l.id as string));
  const core: D1TableName[] = ["layouts", "layout_formats", "layout_revs", "likes", "events", "layouts_head", "import_state", "import_map"];
  const out: RowsByTable = {};
  for (const t of core) out[t] = all[t] ?? [];
  out.layouts = out.layouts!.filter((r) => ids.has(r.id as string));
  out.layout_formats = out.layout_formats!.filter((r) => ids.has(r.layout_id as string));
  out.layout_revs = out.layout_revs!.filter((r) => ids.has(r.layout_id as string));
  out.likes = out.likes!.filter((r) => ids.has(r.layout_id as string));
  out.events = out.events!.filter((r) => ids.has(r.layout_id as string));
  out.import_map = out.import_map!.filter((r) => ids.has(r.layout_id as string));
  out.layouts_head = [{ id: 1, live: out.layouts!.filter((r) => r.deleted === 0).length }];
  return out;
}

const rows = coreReady ? small() : {};
let nameClaim = { pk: "", sk: "" };
let someEvent = { pk: "EV", sk: "" };
let like = { pk: "", sk: "" };

describe.skipIf(!coreReady)("checkIndexes", () => {
  beforeAll(() => {
    const l = rows.layouts!.find((r) => r.deleted === 0)!;
    nameClaim = { pk: `NAME#${(l.name as string).replace(/[A-Z]/g, (c) => c.toLowerCase())}`, sk: "LIVE" };
    const e = rows.events![0]!;
    someEvent = { pk: "EV", sk: String(e.seq).padStart(12, "0") };
    const k = rows.likes![0]!;
    like = { pk: `U#${k.user_id}`, sk: `LK#${k.layout_id}` };
  });
  beforeEach(async () => {
    await wipeTables(ctx);
    await importRows(ctx, rows);
  });

  it("[LDB-DDB72] is clean on a freshly imported store, and on an empty one", async () => {
    expect(await checkIndexes(ctx)).toEqual({ ok: true, problems: [] });
    await wipeTables(ctx);
    expect(await checkIndexes(ctx)).toEqual({ ok: true, problems: [] });
  });

  it("[LDB-DDB72] reports a lost name claim by key", async () => {
    await doc.send(new DeleteCommand({ TableName: T, Key: nameClaim }));
    const r = await checkIndexes(ctx);
    expect(r.ok).toBe(false);
    expect(r.problems).toEqual([`main: missing ${nameClaim.pk} / LIVE`]);
  });

  it("[LDB-DDB72] reports a lost and a stray event mirror, and a user-side like that disagrees", async () => {
    const ev = rows.events!.find((e) => e.layout_id !== null)!;
    const seq = String(ev.seq).padStart(12, "0");
    await doc.send(new DeleteCommand({ TableName: T, Key: { pk: `EVA#${ev.actor}`, sk: seq } }));
    await doc.send(new PutCommand({ TableName: T, Item: { pk: "EVK#ghost", sk: "000000000001", seq: 1 } }));
    await doc.send(new UpdateCommand({ TableName: T, Key: like, UpdateExpression: "SET #at = :x", ExpressionAttributeNames: { "#at": "at" }, ExpressionAttributeValues: { ":x": "tampered" } }));
    const r = await checkIndexes(ctx);
    expect(r.problems).toContain(`main: missing EVA#${ev.actor} / ${seq}`);
    expect(r.problems).toContain("main: unexpected EVK#ghost / 000000000001");
    expect(r.problems).toContain(`main: ${like.pk} / ${like.sk} differs in at`);
    expect(r.problems).toHaveLength(3);
  });

  it("[LDB-DDB72] reports a HEAD that no longer matches the log, and an item no lane owns", async () => {
    await doc.send(new UpdateCommand({ TableName: T, Key: { pk: "META", sk: "HEAD" }, UpdateExpression: "SET seq = seq + :one", ExpressionAttributeValues: { ":one": 1 } }));
    await doc.send(new PutCommand({ TableName: T, Item: { pk: "ZZZ", sk: "x" } }));
    const r = await checkIndexes(ctx);
    expect(r.problems).toContain("main: META / HEAD differs in seq");
    expect(r.problems).toContain("main: no lane owns ZZZ / x");
  });

  it("[LDB-DDB72] a primary item missing its derived items is damage; a primary item removed takes its row with it (nothing to regenerate)", async () => {
    await doc.send(new DeleteCommand({ TableName: T, Key: someEvent }));
    const r = await checkIndexes(ctx);
    // the EV item is primary: its row is gone, so its mirrors are now strays and HEAD may differ
    expect(r.ok).toBe(false);
    expect(r.problems.some((p) => p.startsWith("main: unexpected EV"))).toBe(true);
  });

  it("[LDB-DDB72] reads bookkeeping items as fine, and never writes", async () => {
    await doc.send(new PutCommand({ TableName: T, Item: { pk: "STATE", sk: "migrations", applied: {} } }));
    const before = (await doc.send(new GetCommand({ TableName: T, Key: { pk: "META", sk: "HEAD" }, ConsistentRead: true }))).Item;
    const { result, calls } = await ddbHarness.calls.measure(() => checkIndexes({ ...ctx, doc: ddbHarness.doc }));
    expect(result.ok).toBe(true);
    expect(calls.reads).toBeGreaterThan(0);
    expect(calls.writes).toBe(0);
    expect((await doc.send(new GetCommand({ TableName: T, Key: { pk: "META", sk: "HEAD" }, ConsistentRead: true }))).Item).toEqual(before);
  });
});
