// Dev-only `?mock=admin` / `?mock=owner` switch (W1b deliverable 5): there
// is no Discord app configured locally, so a Chrome QA pass against
// `wrangler dev` would otherwise always be signed out and could never see
// the owner-action row or the moderation console. Only ever imported from
// `index.tsx` behind a static `if (import.meta.env.DEV)` -- Vite replaces
// that expression with the literal `false` in a production build, so
// Rollup's dead-code elimination drops both the branch AND this whole
// module from `dist/` (SITE-16 builds and greps for it to prove that).
import { setMeForDevMock } from "../session.ts";
import type { MeResponse } from "./types.ts";

const DEV_MOCK_ADMIN: MeResponse = {
  user: { user_id: "1", name: "Dev admin (mock)", via: "discord", admin: true },
  signin: true,
};
const DEV_MOCK_OWNER: MeResponse = {
  user: { user_id: "184412255822020608", name: "Dev owner (mock)", via: "discord", admin: false },
  signin: true,
};

export function applyDevMock(): void {
  if (typeof location === "undefined") return;
  const mock = new URLSearchParams(location.search).get("mock");
  if (mock === "admin") setMeForDevMock(DEV_MOCK_ADMIN);
  else if (mock === "owner") setMeForDevMock(DEV_MOCK_OWNER);
}
