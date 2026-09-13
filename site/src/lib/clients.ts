// Admin console, Clients tab (LDB-A10..A14 "rogue trusted client"
// hardening): the pure merge/sort logic pulled out of ClientsTab.tsx --
// same reasoning as `lib/apiError.ts`'s own `loadErrorMessage` ("tested
// here directly rather than through four separate component mounts") --
// so [SITE-35] can pin it against a real recorded fixture without needing
// a DOM/SSR mount (this package's vitest config runs in plain `node`, no
// jsdom/testing-library, and Solid SSR's `renderToString` here is
// synchronous -- it cannot itself wait out an async `createAsync` fetch,
// which is why every other admin tab in this codebase is tested at the
// pure-logic layer too, `tests/tools/admin-tabs-error.test.ts`).
import type { ClientRow, ClientStatus, SuspendedClientInfo } from "./types.ts";

export interface ClientsData {
  clients: ClientRow[];
  suspended: SuspendedClientInfo[];
}

export interface ClientTableRow {
  client: ClientRow;
  suspendedInfo: SuspendedClientInfo | undefined;
}

// Suspended first (the row an admin most needs to see/act on), then
// active, then revoked (terminal -- nothing left to do with it) last.
const STATUS_ORDER: Record<ClientStatus, number> = { suspended: 0, active: 1, revoked: 2 };

/** Pure and total: never throws on an empty client list, an empty
 * suspended list, or a suspended list naming an id absent from `clients`
 * (a client revoked between the two fetches, say) -- that entry is simply
 * unused. `GET /v1/admin/clients` itself never carries `suspended_at`/
 * `reason` (`ClientRow`'s own comment); this is the ONLY place those two
 * real routes' answers are combined for the Clients tab to render. */
export function sortAndMergeClients(data: ClientsData): ClientTableRow[] {
  const byId = new Map(data.suspended.map((s) => [s.id, s] as const));
  return [...data.clients]
    .sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status])
    .map((client) => ({
      client,
      suspendedInfo: client.status === "suspended" ? byId.get(client.id) : undefined,
    }));
}
