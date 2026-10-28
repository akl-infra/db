// [LDB-F48][LDB-F49][LDB-F51] Publishing must preserve every skip wire
// shape through the real Worker and D1, including the 2026-10-20 report.
// The fixture contains only the reported keyboard and rules, no user data.
// Skip is withheld from `/v1` unless the request says `features=skip` (API 1.32,
// LDB-V9), so every request here opts in; tests/api/v1-features-skip.test.ts
// covers the withheld side.
import { afterEach, describe, expect, it, vi } from "vitest";
import reportedPayload from "../fixtures/skip-repeat-publish.json";
import { actorFixture, register, scopedToken, uniqueName, writeFetch } from "./write-support";

interface LayoutResponse {
  id: string;
  payload: unknown;
  formats: Record<string, { rev: number; has_magic: boolean }>;
}

afterEach(() => vi.unstubAllGlobals());

describe("[LDB-F48][LDB-F49][LDB-F51] skip magic publish round trip", () => {
  const cases = [
    { name: "reported skip-repeat", magic: reportedPayload.magic },
    { name: "explicit skip rule", magic: { magic_keys: [{ key: "∯", rules: [{ after: ["h", null], emit: "e" }] }] } },
    { name: "skip chiral", magic: { chiral_keys: [{ key: "∯", skip: true, same: { kind: "repeat" }, opposite: { kind: "char", char: "e" } }] } },
  ];

  for (const { name, magic } of cases) {
    it(`[LDB-F48][LDB-F49][LDB-F51] creates, reads and updates ${name} without losing its meaning`, async () => {
      const headers = register(actorFixture(), uniqueName("skip-token"), uniqueName("skip-owner"));
      const payload = { ...reportedPayload, magic };
      const created = await writeFetch("/v1/layouts?features=skip", "POST", headers, {
        name: uniqueName("skip-publish"), format: "spark/1", payload,
      });
      expect(created.status).toBe(201);
      const first = await created.json<LayoutResponse>();
      expect(first.payload).toEqual(payload);
      expect(first.formats["spark/1"]!.has_magic).toBe(true);

      const read = await writeFetch(`/v1/layouts/${first.id}?format=spark/1&features=skip`, "GET");
      expect(read.status).toBe(200);
      expect((await read.json<LayoutResponse>()).payload).toEqual(payload);

      const revised = structuredClone(payload);
      revised.keys[0]!.finger = "LR";
      const ifMatch = scopedToken("spark", first.formats["spark/1"]!.rev);
      const updated = await writeFetch(`/v1/layouts/${first.id}?features=skip`, "PUT", { ...headers, "If-Match": ifMatch }, {
        format: "spark/1", payload: revised,
      });
      expect(updated.status).toBe(200);
      expect((await updated.json<LayoutResponse>()).payload).toEqual(revised);

      const stale = await writeFetch(`/v1/layouts/${first.id}?features=skip`, "PUT", { ...headers, "If-Match": ifMatch }, {
        format: "spark/1", payload,
      });
      expect(stale.status).toBe(409);
      await stale.text();
      const afterStale = await writeFetch(`/v1/layouts/${first.id}?format=spark/1&features=skip`, "GET");
      expect((await afterStale.json<LayoutResponse>()).payload).toEqual(revised);
    });
  }
});
