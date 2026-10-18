// [SITE-40] the admin Inbox: link submissions and WPM submissions in one
// list, newest first; a failure of either queue is the whole load's failure.
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadInbox, mergeInbox } from "../../src/lib/inbox.ts";
import type { LinkSubmission, WpmQueueRow } from "../../src/lib/types.ts";

function link(id: string, submitted_at: string, status: LinkSubmission["status"] = "pending"): LinkSubmission {
  return { id, layout_id: "L1", url: `https://example.org/${id}`, submitted_by: "100000000000000001", submitted_at, status, decided_by: null, decided_at: null, reason: null };
}
function wpm(id: string, submitted_at: string, status: WpmQueueRow["status"] = "pending"): WpmQueueRow {
  return {
    id,
    layout_id: "L2",
    user_id: "100000000000000002",
    wpm: 90,
    proof: `https://example.org/${id}`,
    submitted_by: "100000000000000002",
    via: "discord",
    submitted_at,
    status,
    decided_by: null,
    decided_at: null,
    reason: null,
    layout_name: "io",
    user_name: "Typist",
  };
}

describe("[SITE-40] mergeInbox", () => {
  it("interleaves both kinds newest first", () => {
    const merged = mergeInbox(
      [link("l-old", "2026-10-01T00:00:00.000Z"), link("l-new", "2026-10-03T00:00:00.000Z")],
      [wpm("w-mid", "2026-10-02T00:00:00.000Z"), wpm("w-newest", "2026-10-04T00:00:00.000Z")],
    );
    expect(merged.map((i) => [i.kind, i.id])).toEqual([
      ["wpm", "w-newest"],
      ["link", "l-new"],
      ["wpm", "w-mid"],
      ["link", "l-old"],
    ]);
  });

  it("orders equal timestamps by id, newest id first, whatever order the queues arrive in", () => {
    const at = "2026-10-01T00:00:00.000Z";
    const a = mergeInbox([link("01A", at)], [wpm("01B", at)]);
    const b = mergeInbox([link("01A", at)], [wpm("01B", at)].reverse());
    expect(a.map((i) => i.id)).toEqual(["01B", "01A"]);
    expect(b.map((i) => i.id)).toEqual(["01B", "01A"]);
  });

  it("an empty inbox is an empty list", () => {
    expect(mergeInbox([], [])).toEqual([]);
  });

  it("each item carries its own row and kind", () => {
    const [item] = mergeInbox([], [wpm("w1", "2026-10-01T00:00:00.000Z")]);
    expect(item).toMatchObject({ kind: "wpm", id: "w1", status: "pending", row: { wpm: 90, layout_name: "io" } });
  });
});

describe("[SITE-40] loadInbox", () => {
  afterEach(() => vi.unstubAllGlobals());

  function stub(answers: Record<string, { status: number; body: unknown }>): string[] {
    const urls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input.toString();
        urls.push(url);
        const key = Object.keys(answers).find((k) => url.startsWith(k))!;
        const { status, body } = answers[key]!;
        return Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }));
      }),
    );
    return urls;
  }

  it("reads both queues for the chosen status and merges them", async () => {
    const urls = stub({
      "/api/v1/admin/link-queue": { status: 200, body: { submissions: [link("l1", "2026-10-01T00:00:00.000Z")] } },
      "/api/v1/admin/wpm-queue": { status: 200, body: { submissions: [wpm("w1", "2026-10-02T00:00:00.000Z")] } },
    });
    const result = await loadInbox("rejected");
    expect(urls.sort()).toEqual(["/api/v1/admin/link-queue?status=rejected", "/api/v1/admin/wpm-queue?status=rejected"]);
    expect(result.ok && result.data.map((i) => i.id)).toEqual(["w1", "l1"]);
  });

  it("either queue failing fails the whole load with that queue's own error", async () => {
    stub({
      "/api/v1/admin/link-queue": { status: 200, body: { submissions: [link("l1", "2026-10-01T00:00:00.000Z")] } },
      "/api/v1/admin/wpm-queue": { status: 403, body: { error: "not_admin", message: "admin only" } },
    });
    const wpmFails = await loadInbox("pending");
    expect(wpmFails).toMatchObject({ ok: false, status: 403, error: "not_admin", message: "admin only" });

    stub({
      "/api/v1/admin/link-queue": { status: 500, body: { error: "internal", message: "boom" } },
      "/api/v1/admin/wpm-queue": { status: 200, body: { submissions: [] } },
    });
    const linkFails = await loadInbox("pending");
    expect(linkFails).toMatchObject({ ok: false, status: 500, error: "internal" });
  });
});
