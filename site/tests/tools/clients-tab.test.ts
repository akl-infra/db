// [SITE-35] the Clients tab's table-shaping logic (`src/lib/clients.ts`'s
// `sortAndMergeClients`) against `db/tests/fixtures/db-responses/
// admin-clients.json` -- a REAL recorded merge of `GET /v1/admin/clients`
// and `GET /v1/meta`'s `health.clients.suspended` (`db/tests/api/
// admin-clients-site-fixture.test.ts`'s RECORD procedure, not hand-typed).
// Same layer this codebase already tests every other admin tab at
// (`tests/tools/admin-tabs-error.test.ts`'s own header doc): this package's
// vitest config runs in plain `node` with no jsdom/testing-library, and
// Solid SSR's `renderToString` is synchronous -- it can't itself wait out
// ClientsTab's async `createAsync` fetch, so the pure logic layer is where
// this invariant is actually enforceable.
import { describe, expect, it } from "vitest";
import { sortAndMergeClients, type ClientsData } from "../../src/lib/clients.ts";
import fixture from "../../../tests/fixtures/db-responses/admin-clients.json" with { type: "json" };

const data = fixture as ClientsData;

describe("[SITE-35] sortAndMergeClients renders from the pinned admin-clients.json fixture", () => {
  it("carries all three recorded clients (active, suspended, revoked) with their real fields", () => {
    const rows = sortAndMergeClients(data);
    expect(rows).toHaveLength(3);
    const byName = new Map(rows.map((r) => [r.client.name, r]));

    const active = byName.get("site-fixture-active");
    expect(active?.client.status).toBe("active");
    expect(active?.client.owner_user_id).toBe("800000000000000101");
    expect(active?.client.caps).toBe("act-as-user");
    expect(active?.client.revoked_at).toBeNull();
    expect(active?.suspendedInfo).toBeUndefined();

    const suspended = byName.get("site-fixture-suspend");
    expect(suspended?.client.status).toBe("suspended");
    expect(suspended?.suspendedInfo?.reason).toBe("site fixture: manual suspension for QA");
    expect(suspended?.suspendedInfo?.at).toBe("2026-09-13T00:00:00.000Z");
    // The merge is BY ID -- the suspended entry belongs to the suspended
    // client's own id, not any other row's.
    expect(suspended?.suspendedInfo?.id).toBe(suspended?.client.id);

    const revoked = byName.get("site-fixture-revoke");
    expect(revoked?.client.status).toBe("revoked");
    expect(revoked?.client.revoked_at).toBe("2026-09-13T00:00:00.000Z");
    expect(revoked?.suspendedInfo).toBeUndefined();
  });

  it("sorts suspended first, then active, then revoked", () => {
    const rows = sortAndMergeClients(data);
    expect(rows.map((r) => r.client.status)).toEqual(["suspended", "active", "revoked"]);
  });

  it("is total: an empty client list, an empty suspended list, and a suspended id absent from clients never throw", () => {
    expect(sortAndMergeClients({ clients: [], suspended: [] })).toEqual([]);
    expect(() =>
      sortAndMergeClients({
        clients: data.clients,
        suspended: [{ id: "not-a-real-client-id", name: "ghost", at: "2026-01-01T00:00:00.000Z", reason: "stale" }],
      }),
    ).not.toThrow();
  });
});
