// [LDB-A10] [LDB-A11] rogue-trusted-client hardening (saltorbit 2026-09-13):
// end-to-end over real HTTP -- a client-lane actor hits the destructive-
// write budget, gets auto-suspended (every further request from it, not
// just writes, refused `403 client_suspended`), shows up in `GET /v1/meta`
// `health.clients`, and an admin's `POST .../reactivate` restores it. The
// pure boundary-arithmetic property lives in tests/core/destructive-
// budget.test.ts; this file proves the real wiring (auth/client.ts's live
// status check, core/write.ts's post-commit budget check, the admin
// lifecycle routes) agrees with it.
//
// Reaching the REAL budget (base 200) with 200 real writes would be slow
// and pointless -- the boundary is a pure function of the counter alone,
// so this seeds the shared `ratelimit` counter row one below the
// threshold (`core/destructive-budget.ts`'s own key/window-start formula,
// reproduced here so a change to either drifts this test loudly) and
// proves the NEXT TWO real client-lane writes land (crossing exactly onto
// then over the threshold) while the one after is refused before it ever
// reaches the write pipeline.
import { SELF, env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Bindings } from "../../src/env";
import { DESTRUCTIVE_BUDGET_BASE, DESTRUCTIVE_WINDOW_SECONDS, destructiveThreshold } from "../../src/core/destructive-budget";
import { type EventDbRow, commitWrite, rowToEvent, type CommitInput } from "../../src/core/events";
import { fixedClock } from "../../src/core/time";
import { ulid } from "ulidx";
import { generateKeyPair, seedClient, signHeaders } from "../auth/client-support";
import { actorFixture, BOOTSTRAP_ADMIN, pinTestClock, register, uniqueName, writeFetch } from "./write-support";

const bindings = env as unknown as Bindings;
const db = bindings.DB;
const CLOCK_ISO = "2026-09-13T00:00:00.000Z";
const clock = fixedClock(CLOCK_ISO);
pinTestClock(env as unknown as { TEST_CLOCK?: typeof clock }, clock);

const OWNER = "900000000000000801";
const SOURCE = { client: "discord-app:test", version: null };

afterEach(() => {
  vi.unstubAllGlobals();
});

async function seedLayout(owner: string, name: string): Promise<{ id: string }> {
  const input: CommitInput = {
    layoutId: ulid(),
    creating: true,
    currentN: 0,
    currentLayout: null,
    currentFormats: new Map(),
    layout: { kind: "created", name, owner, created_at: CLOCK_ISO, deleted: false },
    format: { kind: "format_added", lineage: "spark", format: "spark/1", payload: { keys: [], board: "ansi" as const }, hasMagic: false },
    modified_at: CLOCK_ISO,
    actor: owner,
    via: "discord",
    source: SOURCE,
    upstream: null,
  };
  const { layout } = await commitWrite(db, clock, input);
  return { id: layout.id };
}

// The SAME key/window-start formula `destructiveBudgetStatement` uses --
// reproduced (not imported) so this test independently confirms the real
// module's own convention rather than trivially agreeing with whatever it
// happens to do.
async function seedCounterOneBelowThreshold(clientId: string, liveLayouts: number): Promise<void> {
  const threshold = destructiveThreshold(liveLayouts);
  const nowSeconds = Math.floor(new Date(CLOCK_ISO).getTime() / 1000);
  const windowStart = Math.floor(nowSeconds / DESTRUCTIVE_WINDOW_SECONDS) * DESTRUCTIVE_WINDOW_SECONDS;
  await db
    .prepare("INSERT INTO ratelimit (key, window_start, n) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET window_start = excluded.window_start, n = excluded.n")
    .bind(`destructive:${clientId}`, windowStart, threshold - 1)
    .run();
}

async function freshClient(): Promise<{ clientId: string; privateKey: CryptoKey }> {
  const { privateKey, pubkeyB64url } = await generateKeyPair();
  const clientId = `rogue-${uniqueName("client")}`;
  await seedClient(db, clock, { id: clientId, pubkeyB64url, ownerUserId: OWNER, caps: "act-as-user" });
  return { clientId, privateKey };
}

async function clientRename(client: { clientId: string; privateKey: CryptoKey }, layoutId: string, name: string): Promise<Response> {
  const headers = await signHeaders({
    privateKey: client.privateKey,
    clientId: client.clientId,
    actor: OWNER,
    method: "PATCH",
    pathWithQuery: `/v1/layouts/${layoutId}`,
    body: new TextEncoder().encode(JSON.stringify({ name })),
    timestamp: Math.floor(Date.now() / 1000),
  });
  return SELF.fetch(`https://example.com/v1/layouts/${layoutId}`, {
    method: "PATCH",
    headers: { ...headers, "Content-Type": "application/json", "If-Match": "*" },
    body: JSON.stringify({ name }),
  });
}

async function clientMe(client: { clientId: string; privateKey: CryptoKey }): Promise<Response> {
  const headers = await signHeaders({
    privateKey: client.privateKey,
    clientId: client.clientId,
    actor: OWNER,
    method: "GET",
    pathWithQuery: "/v1/me",
    timestamp: Math.floor(Date.now() / 1000),
  });
  return SELF.fetch("https://example.com/v1/me", { headers });
}

function statusOf(clientId: string): Promise<string | null> {
  return db
    .prepare("SELECT status FROM clients WHERE id = ?")
    .bind(clientId)
    .first<{ status: string }>()
    .then((r) => r?.status ?? null);
}

function adminHeaders(token: string) {
  const fake = actorFixture();
  return register(fake, token, BOOTSTRAP_ADMIN);
}

describe("[LDB-A10] [LDB-A11] rogue-trusted-client hardening: destructive-write budget trips auto-suspend, reactivate restores", () => {
  it("[LDB-A10] [LDB-A12] the (threshold+1)th destructive write lands; the one after is refused 403 client_suspended -- on EVERY lane request, not just writes; visible on GET /v1/meta's health.clients", async () => {
    const client = await freshClient();
    const layout = await seedLayout(OWNER, uniqueName("rogue-target"));
    // liveLayouts=0 in this isolated test DB -> threshold is the base.
    expect(destructiveThreshold(0)).toBe(DESTRUCTIVE_BUDGET_BASE);
    await seedCounterOneBelowThreshold(client.clientId, 0);

    // Attempt N (crosses onto the threshold exactly): lands, not suspended.
    const atThreshold = await clientRename(client, layout.id, uniqueName("rogue-rename-a"));
    expect(atThreshold.status, await atThreshold.clone().text()).toBe(200);
    expect(await statusOf(client.clientId)).toBe("active");

    // Attempt N+1 (the tripping write): still lands -- "the tripping write
    // may land" (this slice's own choice, pinned here) -- but the client is
    // suspended immediately afterward.
    const tripping = await clientRename(client, layout.id, uniqueName("rogue-rename-b"));
    expect(tripping.status, await tripping.clone().text()).toBe(200);
    expect(await statusOf(client.clientId)).toBe("suspended");

    // Attempt N+2: refused before it ever reaches the write pipeline.
    const refused = await clientRename(client, layout.id, uniqueName("rogue-rename-c"));
    expect(refused.status).toBe(403);
    const refusedBody = await refused.json<{ error: string }>();
    expect(refusedBody.error).toBe("client_suspended");

    // [LDB-A11] "every further client-lane request", not just writes --
    // a signed GET /v1/me from the SAME client is refused the same way.
    const meRes = await clientMe(client);
    expect(meRes.status).toBe(403);
    expect((await meRes.json<{ error: string }>()).error).toBe("client_suspended");

    // The trip itself is a public, admin-kind system event.
    const { results } = await db
      .prepare("SELECT * FROM events WHERE kind = 'admin.client_suspended' AND detail_json LIKE ? ORDER BY seq DESC LIMIT 1")
      .bind(`%${client.clientId}%`)
      .all<EventDbRow>();
    expect(results).toHaveLength(1);
    const e = rowToEvent(results[0]!);
    expect(e.admin).toBe(true);
    expect(e.actor).toBe("system:budget-guard");

    // [LDB-A12] visible on GET /v1/meta.
    const meta = await (await writeFetch("/v1/meta", "GET")).json<{ health: { clients: { suspended: { id: string; reason: string | null }[] } } }>();
    const row = meta.health.clients.suspended.find((s) => s.id === client.clientId);
    expect(row, JSON.stringify(meta.health.clients.suspended)).toBeDefined();
    expect(row!.reason).toContain("exceeded");

    // [LDB-A11] an admin reactivates it -- access is restored, including a
    // FRESH destructive-write window (no instant re-trip on the very next
    // write within the same clock hour).
    const reactivateRes = await writeFetch(`/v1/admin/clients/${client.clientId}/reactivate`, "POST", adminHeaders(`tok-${uniqueName("reactivate")}`));
    expect(reactivateRes.status, await reactivateRes.clone().text()).toBe(200);
    const reactivateBody = await reactivateRes.json<{ status: string }>();
    expect(reactivateBody.status).toBe("active");
    expect(await statusOf(client.clientId)).toBe("active");

    const afterReactivate = await clientRename(client, layout.id, uniqueName("rogue-rename-d"));
    expect(afterReactivate.status, await afterReactivate.clone().text()).toBe(200);
    expect(await statusOf(client.clientId)).toBe("active");

    // No longer listed as suspended.
    const metaAfter = await (await writeFetch("/v1/meta", "GET")).json<{ health: { clients: { suspended: { id: string }[] } } }>();
    expect(metaAfter.health.clients.suspended.some((s) => s.id === client.clientId)).toBe(false);
  });

  it("[LDB-A10] a NON-destructive write (create) never counts against the budget", async () => {
    const client = await freshClient();
    await seedCounterOneBelowThreshold(client.clientId, 0); // one below threshold, from renames/deletes/etc only

    const body = JSON.stringify({ name: uniqueName("rogue-create"), format: "spark/1", payload: { keys: [], board: "ansi" } });
    const headers = await signHeaders({
      privateKey: client.privateKey,
      clientId: client.clientId,
      actor: OWNER,
      method: "POST",
      pathWithQuery: "/v1/layouts",
      body: new TextEncoder().encode(body),
      timestamp: Math.floor(Date.now() / 1000),
    });
    const res = await SELF.fetch("https://example.com/v1/layouts", {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body,
    });
    expect(res.status, await res.clone().text()).toBe(201);
    // A create never counts -- the client is still active, one write away
    // from the threshold exactly as seeded, not tripped by this one.
    expect(await statusOf(client.clientId)).toBe("active");
    const row = await db.prepare("SELECT n FROM ratelimit WHERE key = ?").bind(`destructive:${client.clientId}`).first<{ n: number }>();
    expect(row?.n).toBe(DESTRUCTIVE_BUDGET_BASE - 1); // unchanged by the create
  });

  it("[LDB-A11] suspend/reactivate never touches a REVOKED client (terminal)", async () => {
    const client = await freshClient();
    const revokeRes = await writeFetch(`/v1/admin/clients/${client.clientId}`, "DELETE", adminHeaders(`tok-${uniqueName("revoke")}`));
    expect(revokeRes.status).toBe(200);

    const suspendRes = await writeFetch(`/v1/admin/clients/${client.clientId}/suspend`, "POST", adminHeaders(`tok-${uniqueName("suspend")}`), {});
    expect(suspendRes.status).toBe(409);
    expect((await suspendRes.json<{ error: string }>()).error).toBe("client_already_revoked");
    expect(await statusOf(client.clientId)).toBe("revoked");

    const reactivateRes = await writeFetch(`/v1/admin/clients/${client.clientId}/reactivate`, "POST", adminHeaders(`tok-${uniqueName("reactivate")}`));
    expect(reactivateRes.status).toBe(409);
    expect((await reactivateRes.json<{ error: string }>()).error).toBe("client_already_revoked");
    expect(await statusOf(client.clientId)).toBe("revoked");
  });
});
