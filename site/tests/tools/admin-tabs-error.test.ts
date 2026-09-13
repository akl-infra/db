// Regression: every admin tab's list load (Bans, Admins, Link queue,
// Import's health) must show the DB's real error `message` when the GET
// itself answers `ok:false` (e.g. a real `403 not_admin` from the live DB
// when this dev-mock admin carries no real bearer token -- caught during
// this slice's own Chrome QA against production akl-db: `createAsync`'s
// `error()` only fires on a THROWN/rejected fetch, never on a resolved-
// but-`ok:false` `ApiResult`, so every one of these tabs was silently
// rendering its EMPTY state instead of the error one). design/akldb-site/
// 01-plan.md's W1b deliverable 3 ("shows the DB's error verbatim on
// failure") applies to every admin list load, not just the owner-action
// rows -- `lib/apiError.ts`'s `loadErrorMessage` is the one place all four
// tabs (BansTab/AdminsTab/LinkQueueTab/ImportTab) read this from, so it's
// tested here directly rather than through four separate component
// mounts.
import { describe, expect, it } from "vitest";
import { loadErrorMessage } from "../../src/lib/apiError.ts";
import type { ApiResult } from "../../src/api.ts";

describe("loadErrorMessage", () => {
  it("is null while still loading (result undefined)", () => {
    expect(loadErrorMessage(undefined, "fallback")).toBeNull();
  });

  it("is null for a successful result, however it's shaped", () => {
    const ok: ApiResult<{ bans: unknown[] }> = { ok: true, data: { bans: [] } };
    expect(loadErrorMessage(ok, "fallback")).toBeNull();
  });

  it("surfaces the DB's own message verbatim for a resolved-but-failed result", () => {
    const failed: ApiResult<unknown> = { ok: false, status: 403, error: "not_admin", message: "actor is not an admin" };
    expect(loadErrorMessage(failed, "fallback")).toBe("actor is not an admin");
  });

  it("falls back to the given copy when the DB sent no message", () => {
    const failed: ApiResult<unknown> = { ok: false, status: 500, error: "internal" };
    expect(loadErrorMessage(failed, "fallback")).toBe("fallback");
  });
});
