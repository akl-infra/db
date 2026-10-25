// Lane K's slice of the item model (src/store/ddb/contracts.ts `LaneSchema`,
// design/p2-p5-briefs.md): rows of these tables <-> their DynamoDB items.
// All of them live in the main table; each row is one item with every D1
// column flat (NULL stored as a NULL attribute).
//
//   modqueue_notifications       MQN#<kind>#<sid>/ROW      + IX#mqn#dirty/<kind>#<sid> (derived hint)
//   modqueue_delivery_gate       META/MQGATE
//   discord_pending_actions      DPA#discord_pending_actions/<interaction_id>   + DINT#<id>/CLAIM (derived)
//   discord_reopen_actions       DPA#discord_reopen_actions/<interaction_id>    + DINT#<id>/CLAIM (derived)
//   discord_deny_modals          DMOD/<modal_id>           + DINT#<initial_interaction_id>/CLAIM (derived)
//   discord_reopen_confirmations DCONF/<confirmation_id>   + DINT#<initial_interaction_id>/CLAIM, and
//                                DINT#<consumed_interaction_id>/CLAIM when no reopen action holds that id (derived)
//   discord_rejection_dm_outbox  DMO#<delivery_key>/ROW    + DMO#seq#<n>/CLAIM, DMO#nonce#<x>/CLAIM,
//                                IX#dmo#due/<status>#<next_attempt_at>#<key> for pending and leased rows (derived)
//
// The dirty set is a hint, not a function of the rows: toItems marks every
// notification dirty (a superset of the stale ones), and the reconciler
// drops a mark once it has seen the card agree with its source. An index
// checker may therefore only require "every stale notification has a mark".
import type { D1Row, D1TableName, Item, LaneSchema, RowsByTable } from "../contracts";
import {
  actionKey, denyModalKey, interactionClaimKey, MQGATE_KEY, mqnDirtyKey, mqnKey, outboxDueKey, outboxKey, outboxNonceClaimKey,
  outboxSeqClaimKey, reopenConfKey, type SubKind,
} from "../keys-discord";

type Defaults = Record<string, unknown>;
interface Spec {
  columns: readonly string[];
  defaults: Defaults;
}

const SPECS = {
  modqueue_notifications: {
    columns: ["kind", "submission_id", "message_id", "shown_status", "failed_attempts", "message_format", "transport", "channel_id", "reconcile_lease_token", "reconcile_lease_until", "shown_review_version", "shown_source_message_url"],
    defaults: { failed_attempts: 0, message_format: "text", transport: "legacy_webhook", channel_id: null, reconcile_lease_token: null, reconcile_lease_until: null, shown_review_version: 0, shown_source_message_url: null },
  },
  modqueue_delivery_gate: {
    columns: ["id", "lease_token", "lease_until", "retry_at"],
    defaults: { id: 1, lease_token: null, lease_until: 0, retry_at: 0 },
  },
  discord_pending_actions: {
    columns: ["interaction_id", "application_id", "token", "actor_id", "actor_name", "kind", "action", "submission_id", "reason", "channel_id", "message_id", "guild_id", "created_at", "expires_at", "state", "lease_until", "lease_token", "attempts", "result", "expected_review_version", "response_mode"],
    defaults: { reason: null, state: "pending", lease_until: null, lease_token: null, attempts: 0, result: null, expected_review_version: 0, response_mode: "reply" },
  },
  discord_reopen_actions: {
    columns: ["interaction_id", "application_id", "token", "actor_id", "actor_name", "kind", "action", "submission_id", "reason", "expected_review_version", "expected_status", "channel_id", "message_id", "guild_id", "created_at", "expires_at", "state", "lease_until", "lease_token", "attempts", "result", "response_mode"],
    defaults: { reason: null, expected_review_version: 0, state: "pending", lease_until: null, lease_token: null, attempts: 0, result: null, response_mode: "reply" },
  },
  discord_deny_modals: {
    columns: ["modal_id", "initial_interaction_id", "actor_id", "kind", "submission_id", "channel_id", "message_id", "guild_id", "created_at", "expires_at", "consumed_at", "consumed_interaction_id", "expected_review_version"],
    defaults: { consumed_at: null, consumed_interaction_id: null, expected_review_version: 0 },
  },
  discord_reopen_confirmations: {
    columns: ["confirmation_id", "initial_interaction_id", "actor_id", "kind", "submission_id", "channel_id", "message_id", "guild_id", "expected_status", "expected_review_version", "created_at", "expires_at", "consumed_at", "consumed_interaction_id"],
    defaults: { consumed_at: null, consumed_interaction_id: null },
  },
  discord_rejection_dm_outbox: {
    columns: ["delivery_key", "event_seq", "kind", "submission_id", "layout_id", "recipient_id", "nonce", "status", "attempts", "next_attempt_at", "lease_token", "lease_until", "ambiguous_message_attempt_at", "dm_channel_id", "discord_message_id", "last_error_class", "created_at", "updated_at", "sent_at", "review_version", "decision"],
    defaults: { status: "pending", attempts: 0, lease_token: null, lease_until: null, ambiguous_message_attempt_at: null, dm_channel_id: null, discord_message_id: null, last_error_class: null, sent_at: null, review_version: 0, decision: "rejection" },
  },
} as const satisfies Record<string, Spec>;

type LaneTable = keyof typeof SPECS;

/** A row with every column present: absent ones take the column's D1 default (or NULL). */
export function normalize(table: LaneTable, row: D1Row): D1Row {
  const spec: Spec = SPECS[table];
  const out: D1Row = {};
  for (const c of spec.columns) out[c] = row[c] !== undefined ? row[c] : c in spec.defaults ? spec.defaults[c] : null;
  return out;
}

const ACTION_TABLES = ["discord_pending_actions", "discord_reopen_actions"] as const;

/** The claim item for an interaction id; `tbl` is the D1 table whose row holds it (fault injection and the checker read it). */
function claim(interactionId: string, tbl: D1TableName): Item {
  return { ...interactionClaimKey(interactionId), tbl };
}

function dedupe(items: Item[]): Item[] {
  const seen = new Map<string, Item>();
  for (const it of items) seen.set(`${it.pk as string}|${it.sk as string}`, it);
  return [...seen.values()];
}

export function toItems(rows: RowsByTable): { main: Item[]; ephemeral: Item[] } {
  const main: Item[] = [];
  const actionIds = new Set<string>();
  for (const t of ACTION_TABLES) for (const r of rows[t] ?? []) actionIds.add(r.interaction_id as string);

  for (const r of rows.modqueue_notifications ?? []) {
    const n = normalize("modqueue_notifications", r);
    main.push({ ...mqnKey(n.kind as SubKind, n.submission_id as string), ...n });
    main.push({ ...mqnDirtyKey(n.kind as SubKind, n.submission_id as string) });
  }
  for (const r of rows.modqueue_delivery_gate ?? []) {
    const g = normalize("modqueue_delivery_gate", r);
    main.push({ ...MQGATE_KEY, lease_token: g.lease_token, lease_until: g.lease_until, retry_at: g.retry_at });
  }
  for (const t of ACTION_TABLES) {
    for (const r of rows[t] ?? []) {
      const a = normalize(t, r);
      main.push({ ...actionKey(t, a.interaction_id as string), ...a });
      main.push(claim(a.interaction_id as string, t));
    }
  }
  for (const r of rows.discord_deny_modals ?? []) {
    const m = normalize("discord_deny_modals", r);
    main.push({ ...denyModalKey(m.modal_id as string), ...m });
    main.push(claim(m.initial_interaction_id as string, "discord_deny_modals"));
  }
  for (const r of rows.discord_reopen_confirmations ?? []) {
    const c = normalize("discord_reopen_confirmations", r);
    main.push({ ...reopenConfKey(c.confirmation_id as string), ...c });
    main.push(claim(c.initial_interaction_id as string, "discord_reopen_confirmations"));
    const used = c.consumed_interaction_id as string | null;
    if (used !== null && !actionIds.has(used)) main.push(claim(used, "discord_reopen_confirmations"));
  }
  for (const r of rows.discord_rejection_dm_outbox ?? []) {
    const o = normalize("discord_rejection_dm_outbox", r);
    const dk = o.delivery_key as string;
    main.push({ ...outboxKey(dk), ...o });
    main.push({ ...outboxSeqClaimKey(o.event_seq as number), delivery_key: dk });
    main.push({ ...outboxNonceClaimKey(o.nonce as string), delivery_key: dk });
    if (o.status === "pending" || o.status === "leased") main.push({ ...outboxDueKey(o.status, o.next_attempt_at as string, dk) });
  }
  return { main: dedupe(main), ephemeral: [] };
}

export function tableOf(item: Item): D1TableName | null {
  const pk = typeof item.pk === "string" ? item.pk : "";
  const sk = typeof item.sk === "string" ? item.sk : "";
  if (pk.startsWith("MQN#") || pk === "IX#mqn#dirty") return "modqueue_notifications";
  if (pk === "META" && sk === "MQGATE") return "modqueue_delivery_gate";
  if (pk === "DPA#discord_pending_actions") return "discord_pending_actions";
  if (pk === "DPA#discord_reopen_actions") return "discord_reopen_actions";
  if (pk === "DMOD") return "discord_deny_modals";
  if (pk === "DCONF") return "discord_reopen_confirmations";
  if (pk.startsWith("DINT#")) {
    // Writes by key alone (Update/Delete) carry no `tbl`; the pending-actions table is the common owner.
    const tbl = item.tbl;
    return typeof tbl === "string" ? (tbl as D1TableName) : "discord_pending_actions";
  }
  if (pk.startsWith("DMO#") || pk === "IX#dmo#due") return "discord_rejection_dm_outbox";
  return null;
}

export function fromItems(items: { main: readonly Item[]; ephemeral: readonly Item[] }): RowsByTable {
  const out: RowsByTable = {
    modqueue_notifications: [], modqueue_delivery_gate: [], discord_pending_actions: [], discord_reopen_actions: [],
    discord_deny_modals: [], discord_reopen_confirmations: [], discord_rejection_dm_outbox: [],
  };
  let gate = false;
  for (const it of items.main) {
    const pk = it.pk as string;
    const sk = it.sk as string;
    if (pk.startsWith("MQN#") && sk === "ROW") out.modqueue_notifications!.push(normalize("modqueue_notifications", it));
    else if (pk === "META" && sk === "MQGATE") {
      gate = true;
      out.modqueue_delivery_gate!.push(normalize("modqueue_delivery_gate", { id: 1, lease_token: it.lease_token, lease_until: it.lease_until, retry_at: it.retry_at }));
    } else if (pk === "DPA#discord_pending_actions") out.discord_pending_actions!.push(normalize("discord_pending_actions", it));
    else if (pk === "DPA#discord_reopen_actions") out.discord_reopen_actions!.push(normalize("discord_reopen_actions", it));
    else if (pk === "DMOD") out.discord_deny_modals!.push(normalize("discord_deny_modals", it));
    else if (pk === "DCONF") out.discord_reopen_confirmations!.push(normalize("discord_reopen_confirmations", it));
    else if (pk.startsWith("DMO#") && sk === "ROW") out.discord_rejection_dm_outbox!.push(normalize("discord_rejection_dm_outbox", it));
  }
  // The migration seeds the gate row, so a database always has one.
  if (!gate) out.modqueue_delivery_gate!.push(normalize("modqueue_delivery_gate", {}));
  const byKey = (cols: string[]) => (a: D1Row, b: D1Row) => {
    for (const c of cols) {
      const x = a[c] as string;
      const y = b[c] as string;
      if (x !== y) return x < y ? -1 : 1;
    }
    return 0;
  };
  out.modqueue_notifications!.sort(byKey(["kind", "submission_id"]));
  out.discord_pending_actions!.sort(byKey(["interaction_id"]));
  out.discord_reopen_actions!.sort(byKey(["interaction_id"]));
  out.discord_deny_modals!.sort(byKey(["modal_id"]));
  out.discord_reopen_confirmations!.sort(byKey(["confirmation_id"]));
  out.discord_rejection_dm_outbox!.sort(byKey(["delivery_key"]));
  return out;
}

export const discordSchema: LaneSchema = {
  lane: "K",
  tables: ["modqueue_notifications", "modqueue_delivery_gate", "discord_pending_actions", "discord_reopen_actions", "discord_deny_modals", "discord_reopen_confirmations", "discord_rejection_dm_outbox"],
  toItems,
  tableOf,
  fromItems,
};
