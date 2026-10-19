import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToString } from "@solidjs/web";
import { copy } from "../../src/copy.ts";
import type { InboxItem } from "../../src/lib/inbox.ts";
import type { ModerationHistoryEntry } from "../../src/lib/types.ts";

afterEach(() => vi.unstubAllGlobals());

function item(kind: InboxItem["kind"], status: InboxItem["status"], body: string | null = "a comment"): InboxItem {
  // Only fields read by this isolated action are relevant here.
  return { kind, id: "submission", status, submitted_at: "2026-10-18T00:00:00Z", row: { body, review_version: 2 } } as InboxItem;
}

describe("[SITE-46] reopening controls and history", () => {
  it("only decided comments with retained text and speeds offer reopen", async () => {
    const { default: ReopenReview } = await import("../../src/pages/admin/ReopenReview.tsx");
    for (const kind of ["link", "comment", "wpm"] as const) {
      for (const status of ["pending", "approved", "rejected", "superseded"] as const) {
        const html = renderToString(() => ReopenReview({ item: item(kind, status), onReopened: () => {}, onRefresh: () => {} }));
        const expected = kind !== "link" && (status === "approved" || status === "rejected");
        expect(html.includes(copy.admin.inbox.reopen), `${kind}/${status}`).toBe(expected);
        expect(html).not.toContain(copy.admin.inbox.reopenCommentConfirm);
      }
    }
    const erased = renderToString(() => ReopenReview({ item: item("comment", "rejected", null), onReopened: () => {}, onRefresh: () => {} }));
    expect(erased).not.toContain(copy.admin.inbox.reopen);
  });

  it("approved confirmation names the actual visibility effect with normal text and cancel", async () => {
    const { ReopenConfirmation } = await import("../../src/pages/admin/ReopenReview.tsx");
    for (const kind of ["comment", "wpm"] as const) {
      const html = renderToString(() => ReopenConfirmation({ kind, busy: false, onConfirm: () => {}, onCancel: () => {} }));
      expect(html).toContain(kind === "comment" ? copy.admin.inbox.reopenCommentConfirm : copy.admin.inbox.reopenWpmConfirm);
      expect(html).toContain(copy.actions.cancel);
      expect(html).toContain(copy.admin.inbox.reopen);
      expect(html).not.toMatch(/<h[1-6]|<strong/);
    }
  });

  it("history starts collapsed and does not fetch before being expanded", async () => {
    vi.resetModules();
    const fetcher = vi.fn(() => Promise.resolve(new Response("{}")));
    vi.stubGlobal("fetch", fetcher);
    const { default: ModerationHistory } = await import("../../src/pages/admin/ModerationHistory.tsx");
    fetcher.mockClear();
    const html = renderToString(() => ModerationHistory({ kind: "comment", id: "comment1" }));
    expect(html).toContain("<details");
    expect(html).toContain(copy.admin.inbox.history);
    expect(html).not.toContain(" open");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("history preserves each actor, decision, reason and timestamp without rendering reason markup", async () => {
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response("{}"))));
    const { HistoryEntries } = await import("../../src/pages/admin/ModerationHistory.tsx");
    const entries: ModerationHistoryEntry[] = [
      { action: "rejected", actor: "moderator1", at: "2026-10-18T12:00:00Z", reason: "<b>off topic</b>", review_version: 0 },
      { action: "reopened", actor: "moderator2", at: "2026-10-18T12:30:00Z", reason: null, review_version: 1 },
      { action: "approved", actor: "moderator3", at: "2026-10-18T13:00:00Z", reason: null, review_version: 1 },
    ];
    const html = renderToString(() => HistoryEntries({ entries }));
    for (const entry of entries) { expect(html).toContain(entry.actor); expect(html).toContain(entry.at); }
    for (const label of [copy.admin.inbox.statusApproved, copy.admin.inbox.statusRejected, copy.admin.inbox.historyReopened]) expect(html).toContain(label);
    expect(html).toContain("&lt;b>off topic&lt;/b>");
    expect(html).not.toContain("<b>");
  });
});
