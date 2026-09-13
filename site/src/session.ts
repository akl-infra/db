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

export async function refreshMe(): Promise<void> {
  const result = await getMe();
  setMe(result.ok ? result.data : { user: null, signin: false });
}

void refreshMe();
