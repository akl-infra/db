// Admin client-registration routes (10 C1): register/revoke/list clients
// for the client lane (02 §3). Same discipline as `core/admins.ts` --
// `src/routes/admin.ts` is glue only, every D1 statement for these verbs
// lives here, and every action is an `admin.*` event (`appendAdmin`) so the
// public changelog sees it the same way it sees any other admin write.
import type { Bindings } from "../env";
import { budgetSummary, destructiveThreshold, DESTRUCTIVE_WINDOW_SECONDS, type BudgetSummary } from "./destructive-budget";
import { badRequest, notFound } from "./errors";
import { appendAdmin } from "./events";
import { base64UrlToBytes, EXTRA_CAPS, parseCaps, SCOPE_CAPS } from "../auth/client";
import type { Clock } from "./time";
import { ulid } from "ulidx";

const OWNER_ID_RE = /^\d{17,20}$/;

// LEDGER.md L4: `caps` is a comma-separated set now (`auth/client.ts`'s
// `parseCaps`/`SCOPE_CAPS`/`EXTRA_CAPS`) -- exactly ONE scope cap
// (mutually exclusive: whom the client may act as) plus zero or more
// extra caps (additive: `feed:wait` the first one). `"act-as-owner-only"`
// alone, or `"act-as-owner-only,feed:wait"`, are both valid; `"feed:wait"`
// alone (no scope cap) or two scope caps together are not.
function validateCaps(raw: string): string | null {
  const tokens = parseCaps(raw);
  const scopeTokens = tokens.filter((t) => (SCOPE_CAPS as string[]).includes(t));
  const unknown = tokens.filter((t) => !(SCOPE_CAPS as string[]).includes(t) && !(EXTRA_CAPS as string[]).includes(t));
  if (scopeTokens.length !== 1) {
    return `caps must name exactly one of ${SCOPE_CAPS.join(", ")}, plus any of ${EXTRA_CAPS.join(", ")}`;
  }
  if (unknown.length > 0) {
    return `caps names unknown capability/ies: ${unknown.join(", ")}`;
  }
  return null;
}

// saltorbit 2026-09-13 ("rogue trusted client" hardening): `suspended` is a
// NEW value on the same `status` column (`migrations/0003_clients.sql`
// declared it plain `TEXT NOT NULL`, no CHECK constraint -- confirmed
// before this slice; a new value needs no migration). Distinct from
// `revoked`: an admin can move `suspended` back to `active`
// (`reactivateClient`, below), `revoked` never moves anywhere.
export type ClientStatus = "active" | "revoked" | "suspended";

export interface ClientRow {
  id: string;
  name: string;
  pubkey: string;
  owner_user_id: string;
  caps: string;
  discord_app_id: string | null;
  status: ClientStatus;
  created_at: string;
  revoked_at: string | null;
}

export interface RegisterClientBody {
  name: string;
  pubkey: string;
  owner_user_id: string;
  caps: string;
  discord_app_id?: string;
}

// `pubkey` must decode to exactly the raw 32-byte Ed25519 public key (10 C1
// §4); `caps` exactly one scope cap plus any extra caps (LEDGER.md L4);
// `owner_user_id` Discord-id shaped. Bad-request `param` names the
// offending field, JSON-pointer style, like every other write schema in
// this service.
export async function registerClient(db: Bindings["DB"], now: Clock, actorId: string, body: RegisterClientBody): Promise<ClientRow> {
  const pubkeyBytes = base64UrlToBytes(body.pubkey);
  if (pubkeyBytes === null || pubkeyBytes.length !== 32) {
    throw badRequest("pubkey must be base64url of exactly 32 bytes", "/pubkey");
  }
  const capsError = validateCaps(body.caps);
  if (capsError !== null) {
    throw badRequest(capsError, "/caps");
  }
  if (!OWNER_ID_RE.test(body.owner_user_id)) {
    throw badRequest("owner_user_id must be a 17-20 digit Discord id", "/owner_user_id");
  }

  const row: ClientRow = {
    id: ulid(),
    name: body.name,
    pubkey: body.pubkey,
    owner_user_id: body.owner_user_id,
    caps: body.caps,
    discord_app_id: body.discord_app_id ?? null,
    status: "active",
    created_at: now(),
    revoked_at: null,
  };

  await db
    .prepare(
      `INSERT INTO clients (id, name, pubkey, owner_user_id, caps, discord_app_id, status, created_at, revoked_at)
       VALUES (?, ?, ?, ?, ?, ?, 'active', ?, NULL)`,
    )
    .bind(row.id, row.name, row.pubkey, row.owner_user_id, row.caps, row.discord_app_id, row.created_at)
    .run();

  // `detail` never carries the pubkey (10 C1 §4) -- the public changelog
  // shows a client was registered and by/for whom, not its key material.
  await appendAdmin(db, now, {
    kind: "admin.client_registered",
    actor: actorId,
    detail: { id: row.id, name: row.name, owner_user_id: row.owner_user_id, caps: row.caps },
  });

  return row;
}

// Idempotent past the first revoke (10 C1 §4: "200 idempotent on revoked (no
// event)"), matching `admins.remove`'s idempotency shape. Returns null on an
// unknown id so the route can 404.
export async function revokeClient(
  db: Bindings["DB"],
  now: Clock,
  actorId: string,
  id: string,
): Promise<{ id: string; status: "revoked"; revoked_at: string } | null> {
  const existing = await db.prepare("SELECT status, revoked_at FROM clients WHERE id = ?").bind(id).first<{ status: string; revoked_at: string | null }>();
  if (existing === null) return null;

  if (existing.status === "revoked") {
    return { id, status: "revoked", revoked_at: existing.revoked_at! };
  }

  const revoked_at = now();
  await db.prepare("UPDATE clients SET status = 'revoked', revoked_at = ? WHERE id = ?").bind(revoked_at, id).run();
  await appendAdmin(db, now, { kind: "admin.client_revoked", actor: actorId, detail: { id } });
  return { id, status: "revoked", revoked_at };
}

export async function listClients(db: Bindings["DB"]): Promise<ClientRow[]> {
  const { results } = await db
    .prepare(
      "SELECT id, name, pubkey, owner_user_id, caps, discord_app_id, status, created_at, revoked_at FROM clients ORDER BY created_at ASC, id ASC",
    )
    .all<ClientRow>();
  return results;
}

export function unknownClientId(id: string) {
  return notFound(`no client '${id}'`, id);
}

// --- suspend / reactivate (saltorbit 2026-09-13, "rogue trusted client" hardening) ---

// `import_state` (the same key-value table `core/admins.ts`'s import
// pause switch and the dump/diff bookkeeping already use -- no new table,
// no migration) carries the suspension's `{at, reason}`: `clients.status`
// alone has nowhere to put either, and both are needed for
// `GET /v1/meta`'s `health.clients.suspended` list.
function suspendStateKey(id: string): string {
  return `client_suspend:${id}`;
}

interface SuspendState {
  at: string;
  reason: string;
}

async function readSuspendState(db: Bindings["DB"], id: string): Promise<SuspendState | null> {
  const row = await db.prepare("SELECT value FROM import_state WHERE key = ?").bind(suspendStateKey(id)).first<{ value: string }>();
  if (row === null) return null;
  return JSON.parse(row.value) as SuspendState;
}

export interface ClientStatusResult {
  id: string;
  status: ClientStatus;
  suspended_at: string | null;
  reason: string | null;
}

// Idempotent past the first suspend (same posture as `revokeClient`), and
// NEVER moves a `revoked` client anywhere (revoke is terminal) -- returns
// the client's CURRENT (unchanged) status in both of those cases rather
// than throwing, so `checkDestructiveBudget`'s automatic call site (a
// write's own hot path, however rare the trip) never has to handle an
// exception from a status race it can't do anything about. The two ADMIN
// routes (`routes/admin.ts`) are what turn `status === "revoked"` into a
// loud `409` for a human caller; the automatic path just no-ops.
export async function suspendClient(db: Bindings["DB"], now: Clock, actorId: string, id: string, reason: string): Promise<ClientStatusResult | null> {
  const existing = await db.prepare("SELECT status FROM clients WHERE id = ?").bind(id).first<{ status: string }>();
  if (existing === null) return null;

  if (existing.status === "revoked") {
    return { id, status: "revoked", suspended_at: null, reason: null };
  }
  if (existing.status === "suspended") {
    const state = await readSuspendState(db, id);
    return { id, status: "suspended", suspended_at: state?.at ?? null, reason: state?.reason ?? null };
  }

  const at = now();
  await db.batch([
    db.prepare("UPDATE clients SET status = 'suspended' WHERE id = ?").bind(id),
    db
      .prepare("INSERT INTO import_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .bind(suspendStateKey(id), JSON.stringify({ at, reason } satisfies SuspendState)),
  ]);
  // [LDB-A10] the tripping (or the admin's manual) action is itself an
  // `admin`-kind system event, so it shows on the public changelog exactly
  // like any other admin action (LDB-A5's own rule, extended).
  await appendAdmin(db, now, { kind: "admin.client_suspended", actor: actorId, detail: { id, reason } });
  return { id, status: "suspended", suspended_at: at, reason };
}

// Only `suspended -> active` moves; `active` is idempotent (no event, same
// shape `revokeClient`'s "idempotent past the first revoke" already has),
// and `revoked` never moves (terminal, same as `suspendClient` above).
export async function reactivateClient(db: Bindings["DB"], now: Clock, actorId: string, id: string): Promise<ClientStatusResult | null> {
  const existing = await db.prepare("SELECT status FROM clients WHERE id = ?").bind(id).first<{ status: string }>();
  if (existing === null) return null;

  if (existing.status === "revoked") {
    return { id, status: "revoked", suspended_at: null, reason: null };
  }
  if (existing.status === "active") {
    return { id, status: "active", suspended_at: null, reason: null };
  }

  await db.batch([
    db.prepare("UPDATE clients SET status = 'active' WHERE id = ?").bind(id),
    db.prepare("DELETE FROM import_state WHERE key = ?").bind(suspendStateKey(id)),
  ]);
  await appendAdmin(db, now, { kind: "admin.client_reactivated", actor: actorId, detail: { id } });
  return { id, status: "active", suspended_at: null, reason: null };
}

// Called by `core/write.ts`'s `commitWithRetry` and `core/links.ts`'s
// `clearLink` right after a destructive, client-lane write's own batch
// commits (`CommitResult.budgetProbe` / `appendLinkChange`'s own return) --
// NEVER inside the write's own batch (the suspension itself is a SEPARATE,
// rare-path write: the write that TRIPS the budget still lands, only every
// request AFTER it is refused, `403 client_suspended`, from
// `auth/client.ts`). `actor: "system:budget-guard"` names the automatic
// trip distinctly from a human admin's manual suspend.
export const BUDGET_GUARD_ACTOR = "system:budget-guard";

export async function checkDestructiveBudget(db: Bindings["DB"], now: Clock, probe: { clientId: string; countInWindow: number; liveLayouts: number }): Promise<void> {
  const threshold = destructiveThreshold(probe.liveLayouts);
  if (probe.countInWindow <= threshold) return;
  await suspendClient(
    db,
    now,
    BUDGET_GUARD_ACTOR,
    probe.clientId,
    `exceeded ${threshold} destructive writes in ${DESTRUCTIVE_WINDOW_SECONDS}s (auto-suspend; live_layouts=${probe.liveLayouts})`,
  );
}

// GET /v1/meta's `health.clients` (LDB-A12): `liveLayoutCount` comes from
// the SAME `readMetaCore` call `/v1/meta`'s handler already makes -- no
// extra query just for the budget half. The suspended list itself costs
// at most two small reads (the clients table, then one batched
// `import_state` lookup) -- negligible next to `/v1/meta`'s existing
// per-request cost, and only paid on a cache MISS (this route's ETag
// check already short-circuits the common case, same as `health.dump`/
// `health.diff`).
export interface SuspendedClientInfo {
  id: string;
  name: string;
  at: string | null;
  reason: string | null;
}

export interface ClientsHealth {
  suspended: SuspendedClientInfo[];
  budget: BudgetSummary;
}

export async function clientsHealth(db: Bindings["DB"], liveLayoutCount: number): Promise<ClientsHealth> {
  const { results } = await db.prepare("SELECT id, name FROM clients WHERE status = 'suspended' ORDER BY id ASC").all<{ id: string; name: string }>();
  let states = new Map<string, SuspendState>();
  if (results.length > 0) {
    const keys = results.map((r) => suspendStateKey(r.id));
    const { results: stateRows } = await db
      .prepare(`SELECT key, value FROM import_state WHERE key IN (${keys.map(() => "?").join(",")})`)
      .bind(...keys)
      .all<{ key: string; value: string }>();
    states = new Map(stateRows.map((r) => [r.key, JSON.parse(r.value) as SuspendState]));
  }
  const suspended: SuspendedClientInfo[] = results.map((r) => {
    const state = states.get(suspendStateKey(r.id));
    return { id: r.id, name: r.name, at: state?.at ?? null, reason: state?.reason ?? null };
  });
  return { suspended, budget: budgetSummary(liveLayoutCount) };
}
