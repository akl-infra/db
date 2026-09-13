// `db/tests/fixtures/db-responses/admin-clients.json` -- what the akldb.org
// admin console's Clients section (`db/site/src/pages/admin/
// ClientsTab.tsx`, [SITE-35]/[SITE-36] in `db/site/INVARIANTS.md`) renders
// from, pinned against the REAL routes rather than hand-typed (same
// discipline as `authors.json`/`meta.json`/etc. next to it,
// `fixture-export.test.ts`'s own header doc). This test is scoped to
// db/tests/ (not db/site/tests/), so it carries no `[SITE-*]` tag of its
// own -- db/site's `tests/tools/invariants.test.ts` only scans db/site/
// tests/, and the actual SITE-35/36 enforcement is a db/site-side render
// test reading this same committed fixture. This file's only job is
// keeping that fixture honest against the live DB routes. One deliberate
// departure
// from that file: `GET /v1/admin/clients` (`core/clients.ts`'s
// `listClients`) does NOT carry `suspended_at`/`reason` -- those live only
// in `import_state` and surface through the PUBLIC `GET /v1/meta`'s
// `health.clients.suspended` (LDB-A12) -- so this fixture combines the two
// real routes' actual recorded bodies (`clients`, `suspended`) into one
// file rather than pinning either alone; the site's ClientsTab does the
// same merge-by-id at render time.
//
// Same RECORD procedure as fixture-export.test.ts (this suite also runs
// under the "workers" vitest project, same no-real-filesystem constraint):
// flip RECORD to true, run
//   npx vitest run tests/api/admin-clients-site-fixture.test.ts --reporter=verbose > /tmp/site-fixture.out
// then slice the one `===ADMIN-CLIENTS-FIXTURE-START:admin-clients.json===` /
// `-END-` block into db/tests/fixtures/db-responses/admin-clients.json,
// flip RECORD back to false, and re-run to confirm the checked-in file
// still matches (this test asserts against its own committed copy on every
// normal run, so a future route-shape drift here goes red exactly like
// LDB-S1a's).
import { SELF, env } from "cloudflare:test";
import { describe, expect, it, vi, afterEach } from "vitest";
import type { Bindings } from "../../src/env";
import { fixedClock } from "../../src/core/time";
import { vectors } from "../auth/client-support";
import { BOOTSTRAP_ADMIN, actorFixture, pinTestClock, register, uniqueName, writeFetch } from "./write-support";
import adminClientsFixture from "../fixtures/db-responses/admin-clients.json" with { type: "json" };

const bindings = env as unknown as Bindings;
const clock = fixedClock("2026-09-13T00:00:00.000Z");
pinTestClock(env as unknown as { TEST_CLOCK?: typeof clock }, clock);

const RECORD = false; // NEVER true on a committed run -- see the header doc

// Same fixed test pubkey the conformance fixtures reuse across several
// distinct clients (`db/tests/conformance/admin-clients/200.json`) -- there
// is no uniqueness constraint on `pubkey` across rows, and a fixed key
// keeps this fixture free of `generateKeyPair()`'s per-run randomness.
const FIXED_PUBKEY = vectors.keys[0]!.pubkey_b64url;

afterEach(() => {
  vi.unstubAllGlobals();
});

function adminHeaders(): Record<string, string> {
  const fake = actorFixture();
  return register(fake, `tok-${uniqueName("admin")}`, BOOTSTRAP_ADMIN);
}

async function getJson(path: string, headers: Record<string, string> = {}): Promise<unknown> {
  const res = await SELF.fetch(`https://example.com${path}`, { headers });
  expect(res.status, path).toBe(200);
  return res.json();
}

// `id` is a freshly-minted ULID (`ulidx`, real randomness) on every
// registration -- never fixture-stable. Collapsing every ULID to the SAME
// placeholder (support.ts's own `normalizeIds`) would be wrong here: this
// fixture is a multi-row table plus a `suspended` list that must still
// correlate an id in `clients` with the SAME id in `suspended` (and stay
// distinct from the other two clients' ids) for the site's merge-by-id
// logic to have anything real to test. This assigns one stable placeholder
// per DISTINCT id encountered, in traversal order (`clients` first, then
// `suspended` -- both recorded and re-checked in that same order every
// run), so the correlation survives normalization.
const ULID_RE = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/i;
function normalizeClientIds(value: unknown): unknown {
  const seen = new Map<string, string>();
  function placeholder(id: string): string {
    let p = seen.get(id);
    if (p === undefined) {
      p = `SITE-FIXTURE-CLIENT-${seen.size + 1}`;
      seen.set(id, p);
    }
    return p;
  }
  function walk(v: unknown): unknown {
    if (typeof v === "string") return ULID_RE.test(v) ? placeholder(v) : v;
    if (Array.isArray(v)) return v.map(walk);
    if (v !== null && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) out[k] = walk(val);
      return out;
    }
    return v;
  }
  return walk(value);
}

describe("admin-clients.json pins GET /v1/admin/clients + GET /v1/meta.health.clients.suspended", () => {
  it("records/checks the combined fixture the site's Clients tab renders from", async () => {
    // One of each status the ClientsTab must render: active, suspended
    // (with a reason), revoked (terminal).
    const active = await writeFetch("/v1/admin/clients", "POST", adminHeaders(), {
      name: "site-fixture-active",
      pubkey: FIXED_PUBKEY,
      owner_user_id: "800000000000000101",
      caps: "act-as-user",
    });
    expect(active.status).toBe(201);

    const toSuspend = await writeFetch("/v1/admin/clients", "POST", adminHeaders(), {
      name: "site-fixture-suspend",
      pubkey: FIXED_PUBKEY,
      owner_user_id: "800000000000000102",
      caps: "act-as-user",
    });
    expect(toSuspend.status).toBe(201);
    const suspendBody = await toSuspend.json<{ id: string }>();
    const suspended = await writeFetch(`/v1/admin/clients/${suspendBody.id}/suspend`, "POST", adminHeaders(), {
      reason: "site fixture: manual suspension for QA",
    });
    expect(suspended.status).toBe(200);

    const toRevoke = await writeFetch("/v1/admin/clients", "POST", adminHeaders(), {
      name: "site-fixture-revoke",
      pubkey: FIXED_PUBKEY,
      owner_user_id: "800000000000000103",
      caps: "act-as-user",
    });
    expect(toRevoke.status).toBe(201);
    const revokeBody = await toRevoke.json<{ id: string }>();
    const revoked = await writeFetch(`/v1/admin/clients/${revokeBody.id}`, "DELETE", adminHeaders());
    expect(revoked.status).toBe(200);

    const clients = await getJson("/v1/admin/clients", adminHeaders());
    const meta = (await getJson("/v1/meta")) as { health: { clients: { suspended: unknown[] } } };
    const combined = normalizeClientIds({ clients, suspended: meta.health.clients.suspended });

    if (RECORD) {
      // eslint-disable-next-line no-console -- RECORD-mode-only, see header doc
      console.log(`===ADMIN-CLIENTS-FIXTURE-START:admin-clients.json===\n${JSON.stringify(combined, null, 1)}\n===ADMIN-CLIENTS-FIXTURE-END:admin-clients.json===`);
      return;
    }
    expect(combined, "admin-clients.json fixture drifted from the live routes").toEqual(adminClientsFixture);
  });
});
