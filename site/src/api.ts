// The one fetch wrapper for talking to this site's own Worker (never
// akl-db directly -- S3). Adds `X-Requested-With: akldb` on every non-safe
// request (the CSRF header server/proxy.ts checks) and centralizes error
// shape handling so every page/component gets the same `ApiResult`.
import type { LikesWire } from "./lib/likes.ts";
import type {
  AdminRow,
  Author,
  BanRow,
  ChangesPage,
  ClientRevokeResult,
  ClientRow,
  ClientStatusResult,
  LayoutRecord,
  LinkSubmission,
  MeResponse,
  SuspendedClientInfo,
} from "./lib/types.ts";

export type ApiResult<T> = { ok: true; data: T } | { ok: false; status: number; error: string; message?: string };

async function request<T>(path: string, init: RequestInit = {}): Promise<ApiResult<T>> {
  const method = (init.method ?? "GET").toUpperCase();
  const headers = new Headers(init.headers);
  if (method !== "GET" && method !== "HEAD") {
    headers.set("X-Requested-With", "akldb");
    if (init.body !== undefined && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  }
  let res: Response;
  try {
    res = await fetch(path, { ...init, method, headers });
  } catch {
    return { ok: false, status: 0, error: "network_error" };
  }
  const text = await res.text();
  let body: unknown = undefined;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = undefined;
    }
  }
  if (!res.ok) {
    const b = (body ?? {}) as { error?: string; message?: string };
    return { ok: false, status: res.status, error: b.error ?? "unknown_error", message: b.message };
  }
  return { ok: true, data: body as T };
}

const FORMAT = "spark/1";

export function getMe(): Promise<ApiResult<MeResponse>> {
  return request<MeResponse>("/auth/me");
}

export function logout(): Promise<ApiResult<{ ok: boolean }>> {
  return request("/auth/logout", { method: "POST" });
}

export interface ListLayoutsParams {
  owner?: string;
  hasMagic?: boolean;
  since?: string;
  likedBy?: string;
  sort?: string;
  limit?: number;
  cursor?: string;
  full?: boolean;
}

function buildLayoutsQuery(params: ListLayoutsParams): string {
  const q = new URLSearchParams();
  q.set("format", FORMAT);
  if (params.owner) q.set("owner", params.owner);
  if (params.hasMagic !== undefined) q.set("has_magic", String(params.hasMagic));
  if (params.since) q.set("since", params.since);
  if (params.likedBy) q.set("liked_by", params.likedBy);
  if (params.sort) q.set("sort", params.sort);
  if (params.limit) q.set("limit", String(params.limit));
  if (params.cursor) q.set("cursor", params.cursor);
  if (params.full) q.set("full", "1");
  return q.toString();
}

/** The live route answers a bare array for `?full=1` and a
 * `{items, next_cursor}` page otherwise (`db/src/routes/layouts.ts:164` --
 * NOT `next`, which is `/v1/changes`'s own field name for a different
 * pagination scheme) -- normalized to one shape here so callers never
 * branch or misname the cursor. */
export async function listLayouts(params: ListLayoutsParams = {}): Promise<ApiResult<{ items: LayoutRecord[]; next: string | null }>> {
  const qs = buildLayoutsQuery(params);
  const result = await request<LayoutRecord[] | { items: LayoutRecord[]; next_cursor?: string | null }>(`/api/v1/layouts?${qs}`);
  if (!result.ok) return result;
  const data = result.data;
  if (Array.isArray(data)) return { ok: true, data: { items: data, next: null } };
  return { ok: true, data: { items: data.items, next: data.next_cursor ?? null } };
}

export function getLayout(ref: string): Promise<ApiResult<LayoutRecord>> {
  return request<LayoutRecord>(`/api/v1/layouts/${encodeURIComponent(ref)}?format=${FORMAT}`);
}

export function getLayoutHistory(ref: string, format?: string): Promise<ApiResult<import("./lib/types.ts").HistoryEvent[]>> {
  const qs = format ? `?format=${encodeURIComponent(format)}` : "";
  return request(`/api/v1/layouts/${encodeURIComponent(ref)}/history${qs}`);
}

export function getLikes(ref: string): Promise<ApiResult<LikesWire>> {
  return request(`/api/v1/layouts/${encodeURIComponent(ref)}/likes`);
}

/** `GET /v1/authors` is NOT an array -- it's a lossless id-keyed map,
 * `{ "<user_id>": "<name>" }`, with `?by=id` (the default, `by=name`,
 * collapses two ids sharing a name into one entry, `db/src/routes/
 * authors.ts:19-23`). Found while Chrome-QA'ing W1b's author-name
 * resolution against the real DB: an earlier version of this function
 * (typed `Author[]`) parsed the real response as an array and threw on
 * every `for...of` over it -- silently, since `lib/authorNames.ts`'s
 * `loadAuthorNames()` swallows a failed fetch but not a thrown iteration. */
export function getAuthors(): Promise<ApiResult<Record<string, string>>> {
  return request<Record<string, string>>("/api/v1/authors?by=id");
}

export function getAuthor(userId: string): Promise<ApiResult<Author>> {
  return request<Author>(`/api/v1/authors/${encodeURIComponent(userId)}`);
}

export function getHeadSeq(): Promise<ApiResult<{ seq: number }>> {
  return request<{ seq: number }>("/api/v1/meta");
}

/** `GET /v1/meta`'s `health.clients` (LDB-A12), the only PUBLIC place a
 * suspension's `at`/`reason` are exposed -- `GET /v1/admin/clients` itself
 * carries neither (`ClientRow`'s own comment). Only this narrow slice of
 * the route's much larger body is typed/read; nothing here is admin-only,
 * so this is a safe, ordinary (non-`X-Requested-With`) GET like
 * `getHeadSeq`. */
export async function getMetaHealthClients(): Promise<ApiResult<{ suspended: SuspendedClientInfo[] }>> {
  const result = await request<{ health: { clients: { suspended: SuspendedClientInfo[] } } }>("/api/v1/meta");
  if (!result.ok) return result;
  return { ok: true, data: result.data.health.clients };
}

export function getChanges(since = 0, limit = 50): Promise<ApiResult<ChangesPage>> {
  return request<ChangesPage>(`/api/v1/changes?since=${since}&limit=${limit}`);
}

// ── Owner + admin actions (W1b UI; typed here now per §4's contract so W1b
// wires them without inventing a request shape) ─────────────────────────

export function likeLayout(ref: string): Promise<ApiResult<{ like_count: number }>> {
  return request(`/api/v1/layouts/${encodeURIComponent(ref)}/like`, { method: "PUT" });
}
export function unlikeLayout(ref: string): Promise<ApiResult<{ like_count: number }>> {
  return request(`/api/v1/layouts/${encodeURIComponent(ref)}/like`, { method: "DELETE" });
}
export function renameLayout(ref: string, name: string, ifMatch: string): Promise<ApiResult<LayoutRecord>> {
  return request(`/api/v1/layouts/${encodeURIComponent(ref)}`, {
    method: "PATCH",
    headers: { "If-Match": ifMatch },
    body: JSON.stringify({ name }),
  });
}
export function deleteLayout(ref: string, ifMatch: string): Promise<ApiResult<LayoutRecord>> {
  return request(`/api/v1/layouts/${encodeURIComponent(ref)}`, { method: "DELETE", headers: { "If-Match": ifMatch } });
}
export function restoreLayout(ref: string, name?: string): Promise<ApiResult<LayoutRecord>> {
  return request(`/api/v1/layouts/${encodeURIComponent(ref)}/restore`, {
    method: "POST",
    body: name ? JSON.stringify({ name }) : undefined,
  });
}
export function transferLayout(ref: string, to: string, ifMatch: string): Promise<ApiResult<LayoutRecord>> {
  return request(`/api/v1/layouts/${encodeURIComponent(ref)}/transfer`, {
    method: "POST",
    headers: { "If-Match": ifMatch },
    body: JSON.stringify({ to }),
  });
}
export function getLink(ref: string): Promise<ApiResult<{ link: string | null; pending: LinkSubmission | null }>> {
  return request(`/api/v1/layouts/${encodeURIComponent(ref)}/link`);
}
export function submitLink(ref: string, url: string): Promise<ApiResult<{ link: string } | { submission: LinkSubmission }>> {
  return request(`/api/v1/layouts/${encodeURIComponent(ref)}/link`, { method: "PUT", body: JSON.stringify({ url }) });
}
export function clearLink(ref: string): Promise<ApiResult<{ link: null }>> {
  return request(`/api/v1/layouts/${encodeURIComponent(ref)}/link`, { method: "DELETE" });
}

// ── Admin-only (W1b UI, §4 contract) ─────────────────────────────────────

export function adminListBans(): Promise<ApiResult<{ bans: BanRow[] }>> {
  return request("/api/v1/admin/bans");
}
export function adminBanUser(userId: string, reason?: string): Promise<ApiResult<BanRow>> {
  return request(`/api/v1/admin/bans/${encodeURIComponent(userId)}`, {
    method: "PUT",
    body: JSON.stringify({ reason }),
  });
}
export function adminUnbanUser(userId: string): Promise<ApiResult<{ unbanned: string }>> {
  return request(`/api/v1/admin/bans/${encodeURIComponent(userId)}`, { method: "DELETE" });
}
export function adminSetAuthorName(userId: string, name: string): Promise<ApiResult<Author>> {
  return request(`/api/v1/admin/authors/${encodeURIComponent(userId)}`, {
    method: "PUT",
    body: JSON.stringify({ name }),
  });
}
export function adminLinkQueue(status = "pending"): Promise<ApiResult<{ submissions: LinkSubmission[] }>> {
  return request(`/api/v1/admin/link-queue?status=${encodeURIComponent(status)}`);
}
export function adminApproveLink(id: string): Promise<ApiResult<{ link: string | null }>> {
  return request(`/api/v1/admin/link-queue/${encodeURIComponent(id)}/approve`, { method: "POST" });
}
export function adminRejectLink(id: string, reason?: string): Promise<ApiResult<{ submission: LinkSubmission }>> {
  return request(`/api/v1/admin/link-queue/${encodeURIComponent(id)}/reject`, {
    method: "POST",
    body: JSON.stringify({ reason }),
  });
}
export function adminListAdmins(): Promise<ApiResult<AdminRow[]>> {
  return request("/api/v1/admin/admins");
}
export function adminAddAdmin(userId: string, note?: string): Promise<ApiResult<AdminRow>> {
  return request("/api/v1/admin/admins", { method: "POST", body: JSON.stringify({ user_id: userId, note }) });
}
export function adminRemoveAdmin(userId: string): Promise<ApiResult<{ removed: string }>> {
  return request(`/api/v1/admin/admins/${encodeURIComponent(userId)}`, { method: "DELETE" });
}
export function adminListClients(): Promise<ApiResult<ClientRow[]>> {
  return request("/api/v1/admin/clients");
}

// [LDB-A11] `reason` is optional (the DB defaults it to "manual admin
// suspension" when omitted) -- `JSON.stringify({ reason })` drops the key
// entirely when `reason` is `undefined`, matching the DB's own conformance
// fixture body for the no-reason case (`{}`, `db/tests/conformance/
// admin-clients/suspend-200.json`) rather than sending `{"reason":null}`.
export function adminSuspendClient(id: string, reason?: string): Promise<ApiResult<ClientStatusResult>> {
  return request(`/api/v1/admin/clients/${encodeURIComponent(id)}/suspend`, {
    method: "POST",
    body: JSON.stringify({ reason }),
  });
}
export function adminReactivateClient(id: string): Promise<ApiResult<ClientStatusResult>> {
  return request(`/api/v1/admin/clients/${encodeURIComponent(id)}/reactivate`, { method: "POST" });
}
// Terminal: DELETE is revoke, same as `deleteLayout`'s verb but with no
// `If-Match` (client rows aren't rev'd the way layouts are, `SITE-14`).
export function adminRevokeClient(id: string): Promise<ApiResult<ClientRevokeResult>> {
  return request(`/api/v1/admin/clients/${encodeURIComponent(id)}`, { method: "DELETE" });
}
