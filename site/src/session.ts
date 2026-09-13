// The signed-in state, shared by the header and the admin gate. One
// module-scope signal for the whole app (the standard Solid "global store"
// shape -- it lives as long as the tab) so navigating between pages never
// re-fetches `/auth/me` on its own; `refreshMe()` re-fetches explicitly
// (after login redirects back to `/`, after logout).
import { createSignal } from "solid-js";
import { getMe } from "./api.ts";
import type { MeResponse } from "./lib/types.ts";

const [me, setMe] = createSignal<MeResponse | undefined>(undefined);

export const meResource = me;

// Set once `setMeForDevMock` (below) wins: `void refreshMe()` below fires
// its `/auth/me` fetch at import time, before `index.tsx`'s dev-mock guard
// runs -- without this flag, that already-in-flight (real, signed-out)
// response would resolve a tick later and silently clobber the mock. Dead
// in production (never set), so `refreshMe()`'s behavior there is
// unchanged.
let devMockActive = false;

export async function refreshMe(): Promise<void> {
  const result = await getMe();
  if (devMockActive) return;
  setMe(result.ok ? result.data : { user: null, signin: false });
}

void refreshMe();

/** Dev-only escape hatch for `lib/devMock.ts` ([SITE-16]: that module is
 * imported only behind a build-time-dead `import.meta.env.DEV` branch, so
 * this export reaches production too, but nothing in a production bundle
 * ever calls it). Bypasses the network round trip entirely -- unlike
 * `refreshMe()`, there is no `/auth/me` to disagree with it; once called,
 * it also wins any `refreshMe()` already in flight (see `devMockActive`). */
export function setMeForDevMock(mock: MeResponse): void {
  devMockActive = true;
  setMe(mock);
}
