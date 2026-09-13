// [SITE-6] the admin UI is unreachable without `admin: true`, and every
// admin* function in api.ts targets /api/v1/admin/*.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { canSeeAdmin } from "../../src/lib/adminGate.ts";
import type { MeResponse } from "../../src/lib/types.ts";

describe("[SITE-6] canSeeAdmin", () => {
  it("is false with no session, signed-out, or a non-admin user", () => {
    const cases: (MeResponse | undefined)[] = [
      undefined,
      { user: null, signin: false },
      { user: null, signin: true },
      { user: { user_id: "1", name: "n", via: "discord", admin: false }, signin: true },
    ];
    for (const me of cases) expect(canSeeAdmin(me)).toBe(false);
  });

  it("is true only when the fresh /auth/me answer says admin:true", () => {
    const me: MeResponse = { user: { user_id: "1", name: "n", via: "discord", admin: true }, signin: true };
    expect(canSeeAdmin(me)).toBe(true);
  });
});

describe("[SITE-6] every admin* api.ts function targets /api/v1/admin/*", () => {
  it("no admin-prefixed export builds a non-admin path", () => {
    const source = fs.readFileSync(path.resolve(import.meta.dirname, "..", "..", "src", "api.ts"), "utf8");
    const fnBodies = source.split(/^export function admin/m).slice(1);
    expect(fnBodies.length).toBeGreaterThan(0);
    for (const body of fnBodies) {
      const firstBraceIdx = body.indexOf("{");
      const closeIdx = body.indexOf("\n}");
      const fnSource = body.slice(firstBraceIdx, closeIdx === -1 ? undefined : closeIdx);
      const pathLiterals = [...fnSource.matchAll(/`(\/api\/[^`]*)`|"(\/api\/[^"]*)"/g)].map((m) => m[1] ?? m[2]);
      expect(pathLiterals.length).toBeGreaterThan(0);
      for (const p of pathLiterals) expect(p!.startsWith("/api/v1/admin/")).toBe(true);
    }
  });
});
