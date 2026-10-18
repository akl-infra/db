// [SITE-41] a freshly mounted "Submit a speed for a user" form shows its
// four labelled fields and NO validation error: unfinished (here: empty)
// input is never an error until a field is left or a submit is attempted.
// Rendered with `renderToString` like tests/tools/admin-render.test.ts.
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToString } from "@solidjs/web";
import { copy } from "../../src/copy.ts";

afterEach(() => vi.unstubAllGlobals());

describe("[SITE-41] SpeedForm initial render", () => {
  it("has every field and no error text", async () => {
    vi.resetModules();
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } }))));
    const { default: SpeedForm } = await import("../../src/pages/admin/SpeedForm.tsx");
    const html = renderToString(() => SpeedForm({}));
    for (const label of [copy.admin.speed.userLabel, copy.admin.speed.layoutLabel, copy.admin.speed.wpmLabel, copy.admin.speed.proofLabel, copy.admin.speed.submitButton]) {
      expect(html).toContain(label);
    }
    for (const err of [copy.admin.speed.errorUser, copy.admin.speed.errorLayout, copy.admin.speed.errorWpm, copy.admin.speed.errorProof]) {
      expect(html).not.toContain(err);
    }
    expect(html).not.toContain('aria-invalid="true"');
  });
});
