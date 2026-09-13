// Regression coverage for a real bug caught only by manual Chrome QA (never
// a unit test): `GET /v1/layouts` pages via `next_cursor`, NOT `next` --
// `next` is `/v1/changes`'s own field name for a different pagination
// scheme (db/src/routes/layouts.ts:164). listLayouts() silently stopped
// after one page of 1000 (showing 1000 of ~4179 real layouts) when this
// was named wrong; nothing failed loudly because `next` was simply always
// `undefined`, ending the loop early instead of erroring.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { listLayouts } from "../../src/api.ts";

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
}

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe("listLayouts pagination", () => {
  it("carries next_cursor through as `next`, not the (nonexistent) `next` field", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ items: [{ id: "1", name: "a" }], next_cursor: "abc123" }));
    const result = await listLayouts({ limit: 1 });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.data.next).toBe("abc123");
    expect(result.data.items).toHaveLength(1);
  });

  it("a final page with no next_cursor reports next: null (stops paging)", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ items: [], next_cursor: null }));
    const result = await listLayouts({});
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.data.next).toBeNull();
  });

  it("a bare array response (the ?full=1 shape) is normalized with next: null", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse([{ id: "1", name: "a" }]));
    const result = await listLayouts({ full: true });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.data.next).toBeNull();
    expect(result.data.items).toHaveLength(1);
  });
});
