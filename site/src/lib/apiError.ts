// Shared by every admin tab's list load (Bans, Admins, Link queue,
// Import's health): `createAsync`'s own `error()` signal only fires on a
// THROWN/rejected fetch -- `api.ts`'s `request()` never rejects for an
// HTTP-level failure (it resolves to `{ok:false, error, message}`), so a
// real `403 not_admin` (this dev-mock admin carrying no real bearer token
// against the live DB, found during this slice's own Chrome QA) resolved
// successfully at the network layer and was rendering as a silent EMPTY
// list instead of the DB's error. Pulled out as a pure function (no Solid
// import) so it's unit-testable without mounting any component.
import type { ApiResult } from "../api.ts";

export function loadErrorMessage<T>(result: ApiResult<T> | undefined, fallback: string): string | null {
  if (!result || result.ok) return null;
  return result.message ?? fallback;
}
