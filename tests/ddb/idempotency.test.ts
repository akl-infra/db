// [LDB-DDB34] [LDB-DDB35] Idempotency on DynamoDB: reserve, takeover,
// complete and delete are the same CASes as D1; bodies replay byte for byte,
// and one over 350 KB goes in gzip-compressed.
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { describe, expect, it } from "vitest";
import { ddbHarness } from "../harness/ddb";

const { store, doc, tables } = ddbHarness;
let n = 0;
const scope = () => `client:${n++}-${Math.random().toString(36).slice(2, 8)}`;
const reserve = (s: string, k: string, at = "2026-08-01T00:00:00.000Z") =>
  store.auth.reserveIdempotency({ scope: s, key: k, method: "POST", path: "/v1/layouts", request_hash: "h1", at });

describe("idempotency", () => {
  it("[LDB-DDB34] reserve claims a fresh key once, even under concurrency; the row is pending", async () => {
    const s = scope();
    const wins = await Promise.all(Array.from({ length: 10 }, () => reserve(s, "k")));
    expect(wins.filter(Boolean)).toHaveLength(1);
    expect(await store.auth.getIdempotency(s, "k")).toEqual({
      scope: s, key: "k", method: "POST", path: "/v1/layouts", request_hash: "h1", status: 0, response_body: "", at: "2026-08-01T00:00:00.000Z",
    });
    expect(await store.auth.getIdempotency(s, "absent")).toBeNull();
  });

  it("[LDB-DDB34] complete stores the exact bytes; delete removes; complete of a missing row creates nothing", async () => {
    const s = scope();
    await reserve(s, "k");
    const body = JSON.stringify({ a: "é\u0000 \"x\"", n: [1, 2] }) + "\n";
    await store.auth.completeIdempotency(s, "k", 201, body, "2026-08-01T00:00:01.000Z");
    expect(await store.auth.getIdempotency(s, "k")).toMatchObject({ status: 201, response_body: body, at: "2026-08-01T00:00:01.000Z" });
    await store.auth.deleteIdempotency(s, "k");
    expect(await store.auth.getIdempotency(s, "k")).toBeNull();
    await store.auth.completeIdempotency(s, "ghost", 200, "x", "2026-08-01T00:00:02.000Z");
    expect(await store.auth.getIdempotency(s, "ghost")).toBeNull();
  });

  it("[LDB-DDB34] takeover is a CAS on the stored at: one of N racers wins, a wrong expectedAt loses", async () => {
    const s = scope();
    await reserve(s, "k", "2026-08-01T00:00:00.000Z");
    const take = (expectedAt: string, hash: string) =>
      store.auth.takeOverIdempotency({ scope: s, key: "k", method: "PUT", path: "/p", request_hash: hash, at: "2026-08-02T00:00:00.000Z", expectedAt });
    expect(await take("2020-01-01T00:00:00.000Z", "x")).toBe(false);
    const results = await Promise.all(Array.from({ length: 8 }, (_, i) => take("2026-08-01T00:00:00.000Z", `h${i}`)));
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await store.auth.getIdempotency(s, "k")).toMatchObject({ method: "PUT", path: "/p", status: 0, response_body: "", at: "2026-08-02T00:00:00.000Z" });
  });

  it("[LDB-DDB35] a body over 350 KB is stored gzip-compressed and replays byte for byte", async () => {
    const s = scope();
    await reserve(s, "big");
    const body = JSON.stringify({ payload: "abcdefghij".repeat(60_000) }); // 600 KB
    await store.auth.completeIdempotency(s, "big", 200, body, "2026-08-01T00:00:01.000Z");
    const raw = await doc.send(new GetCommand({ TableName: tables.ephemeral, Key: { pk: `IDEM#${s}`, sk: "big" }, ConsistentRead: true }));
    expect(raw.Item?.response_gz).toBeInstanceOf(Uint8Array);
    expect(raw.Item?.response_body).toBeUndefined();
    expect((await store.auth.getIdempotency(s, "big"))?.response_body).toBe(body);
    // A takeover turns it back into a plain pending row.
    expect(await store.auth.takeOverIdempotency({ scope: s, key: "big", method: "POST", path: "/p", request_hash: "h", at: "2026-08-03T00:00:00.000Z", expectedAt: "2026-08-01T00:00:01.000Z" })).toBe(true);
    expect((await store.auth.getIdempotency(s, "big"))?.response_body).toBe("");
  });

  it("[LDB-DDB35] ttl = at + 25 h, and prune drops rows older than the cutoff", async () => {
    const s = scope();
    const now = new Date().toISOString();
    await reserve(s, "now", now);
    const raw = await doc.send(new GetCommand({ TableName: tables.ephemeral, Key: { pk: `IDEM#${s}`, sk: "now" }, ConsistentRead: true }));
    expect(raw.Item?.ttl).toBe(Math.floor(Date.parse(now) / 1000) + 25 * 3600);
    await reserve(s, "old", "2026-01-01T00:00:00.000Z");
    await reserve(s, "new", "2026-06-01T00:00:00.000Z");
    await store.auth.pruneIdempotency("2026-03-01T00:00:00.000Z");
    expect(await store.auth.getIdempotency(s, "old")).toBeNull();
    expect(await store.auth.getIdempotency(s, "new")).not.toBeNull();
  });

  it("[LDB-DDB35] an expired-but-present row is treated as absent by reserve; a live one is not", async () => {
    const s = scope();
    const t0 = Date.now();
    const iso = (ms: number) => new Date(ms).toISOString();
    expect(await reserve(s, "k", iso(t0))).toBe(true);
    expect(await reserve(s, "k", iso(t0 + 24 * 3600_000))).toBe(false);
    expect(await reserve(s, "k", iso(t0 + 26 * 3600_000))).toBe(true);
  });
});
