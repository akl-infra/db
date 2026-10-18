// [SITE-44] the comment surfaces render what the DB sent and nothing more.
// Rendered with `renderToString` like tests/tools/admin-render.test.ts: the
// Inbox's comment cell (new text collapsed behind "Read all", an edit as a
// del/ins diff, markup in a comment inert) and the layout page's list
// (read-only for everyone, Remove only for an admin, no browser dialog).
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToString } from "@solidjs/web";
import { copy } from "../../src/copy.ts";
import type { CommentQueueRow, PublicComment } from "../../src/lib/types.ts";

afterEach(() => vi.unstubAllGlobals());

function row(over: Partial<CommentQueueRow>): CommentQueueRow {
  return {
    id: "01C",
    layout_id: "L1",
    user_id: "100000000000000001",
    body: "a short comment",
    via: "discord",
    submitted_at: "2026-10-18T00:00:00.000Z",
    status: "pending",
    decided_by: null,
    decided_at: null,
    reason: null,
    layout_name: "io",
    user_name: "Commenter",
    live_body: null,
    ...over,
  };
}

async function render<P>(load: () => Promise<{ default: (p: P) => unknown }>, props: P): Promise<string> {
  vi.resetModules();
  vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response("{}", { status: 200, headers: { "Content-Type": "application/json" } }))));
  const mod = await load();
  return renderToString(() => mod.default(props) as never);
}

describe("[SITE-44] Inbox comment details", () => {
  const details = (r: CommentQueueRow) => render(() => import("../../src/pages/admin/CommentDetails.tsx"), { row: r });

  it("a first comment shows its full text, labelled New, with no Read all when short", async () => {
    const html = await details(row({ body: "Nice home row" }));
    expect(html).toContain(copy.admin.inbox.commentNew);
    expect(html).toContain("Nice home row");
    expect(html).not.toContain(copy.admin.inbox.readAll);
    expect(html).not.toContain("<del");
  });

  it("a long first comment is collapsed behind Read all", async () => {
    const body = `${"word ".repeat(100)}END-OF-LONG-COMMENT`;
    const html = await details(row({ body }));
    expect(html).toContain(copy.admin.inbox.readAll);
    expect(html).not.toContain("END-OF-LONG-COMMENT");
    expect(html).toContain('aria-expanded="false"');
  });

  it("an edit is labelled Edit and shows the live text against the pending one as deletions and insertions", async () => {
    const html = await details(row({ live_body: "I like this layout", body: "I love this layout a lot" }));
    expect(html).toContain(copy.admin.inbox.commentEdit);
    expect(html).not.toContain(copy.admin.inbox.commentNew);
    expect(html).toMatch(/<del[^>]*>like<\/del>/);
    expect(html).toMatch(/<ins[^>]*>love<\/ins>/);
    expect(html).toMatch(/<ins[^>]*> a lot<\/ins>/);
    expect(html).not.toContain(copy.admin.inbox.readAll);
  });

  it("markup in a comment is escaped, never rendered", async () => {
    const html = await details(row({ body: '<img src=x onerror="alert(1)"> <script>boom()</script>' }));
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<script");
    expect(html).toContain("&lt;img");
  });

  it("an erased text shows the erased notice instead of a body", async () => {
    const html = await details(row({ body: null }));
    expect(html).toContain(copy.admin.inbox.commentErased);
  });
});

describe("[SITE-44] the layout page's comment list", () => {
  const comments: PublicComment[] = [
    { id: "c1", user_id: "100000000000000001", name: "Ada", body: "first <b>comment</b>", approved_at: "2026-10-18T00:00:00.000Z", edited: false },
    { id: "c2", user_id: "100000000000000002", name: null, body: "second comment", approved_at: "2026-10-17T00:00:00.000Z", edited: true },
  ];
  const list = (isAdmin: boolean) => render(async () => ({ default: (await import("../../src/ui/LayoutComments.tsx")).CommentList as never }), { comments, isAdmin, onRemoved: () => {} });

  it("lists every approved comment as escaped text with its date, and marks an edited one", async () => {
    const html = await list(false);
    expect(html).toContain("first &lt;b>comment&lt;/b>"); // Solid escapes < and &; a bare > is inert in a text node
    expect(html).toContain("second comment");
    expect(html).toContain("2026-10-18T00:00:00.000Z");
    expect(html.split(copy.layout.commentEdited).length - 1).toBe(1);
  });

  it("is read-only for a non-admin: no Remove control anywhere", async () => {
    const html = await list(false);
    expect(html).not.toContain(copy.layout.commentRemove);
    expect(html).not.toContain("<input");
  });

  it("an admin gets a Remove button per comment, with no reason field until it is pressed", async () => {
    const html = await list(true);
    expect(html.split(`>${copy.layout.commentRemove}<`).length - 1).toBe(2);
    expect(html).not.toContain(copy.layout.commentRemoveConfirm);
    expect(html).not.toContain("<input");
  });
});
