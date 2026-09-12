// Admin client-registration routes (10 C1): register/revoke/list clients
// for the client lane (02 §3). Same discipline as `core/admins.ts` --
// `src/routes/admin.ts` is glue only, every D1 statement for these verbs
// lives here, and every action is an `admin.*` event (`appendAdmin`) so the
// public changelog sees it the same way it sees any other admin write.
import type { Bindings } from "../env";
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

export interface ClientRow {
  id: string;
  name: string;
  pubkey: string;
  owner_user_id: string;
  caps: string;
  discord_app_id: string | null;
  status: "active" | "revoked";
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
