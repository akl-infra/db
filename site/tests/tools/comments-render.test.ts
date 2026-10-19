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
    review_version: 0,
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

  it("a first comment is one block with its full text, no Current/Proposed labels and no Read all when short", async () => {
    const html = await details(row({ body: "Nice home row" }));
    expect(html).toContain("Nice home row");
    expect(html).not.toContain(copy.admin.inbox.commentCurrent);
    expect(html).not.toContain(copy.admin.inbox.commentProposed);
    expect(html).not.toContain(copy.admin.inbox.readAll);
    expect(html).not.toContain("<del");
    expect(html).not.toContain("<ins");
  });

  it("an approved comment matching its live text is shown once, without a redundant diff", async () => {
    const html = await details(row({ status: "approved", live_body: "Same comment text", body: "Same comment text" }));
    expect(html.match(/Same comment text/g)).toHaveLength(1);
    expect(html).not.toContain(copy.admin.inbox.commentCurrent);
    expect(html).not.toContain(copy.admin.inbox.commentProposed);
  });

  it("a long first comment is collapsed behind Read all", async () => {
    const body = `${"word ".repeat(120)}END-OF-LONG-COMMENT`;
    const html = await details(row({ body }));
    expect(html).toContain(copy.admin.inbox.readAll);
    expect(html).not.toContain("END-OF-LONG-COMMENT");
    expect(html).toContain('aria-expanded="false"');
  });

  it("an edit is two stacked blocks: Current with only deletions marked, Proposed with only insertions marked, each the whole text", async () => {
    const html = await details(row({ live_body: "I like this layout", body: "I love this layout a lot" }));
    const current = html.slice(html.indexOf(copy.admin.inbox.commentCurrent), html.indexOf(copy.admin.inbox.commentProposed));
    const proposed = html.slice(html.indexOf(copy.admin.inbox.commentProposed));
    expect(html.indexOf(copy.admin.inbox.commentCurrent)).toBeGreaterThan(-1);
    expect(html.indexOf(copy.admin.inbox.commentCurrent)).toBeLessThan(html.indexOf(copy.admin.inbox.commentProposed));
    expect(current).toMatch(/<del[^>]*>like<\/del>/);
    expect(current).not.toContain("<ins");
    expect(current).not.toContain("love");
    expect(proposed).toMatch(/<ins[^>]*>love<\/ins>/);
    expect(proposed).toMatch(/<ins[^>]*> a lot<\/ins>/);
    expect(proposed).not.toContain("<del");
    expect(proposed).not.toContain("like");
    expect(html).not.toContain(copy.admin.inbox.readAll);
  });

  it("a long edit never folds away a change: Read all only hides trailing unchanged text", async () => {
    const shared = "same ".repeat(150);
    const html = await details(row({ live_body: `${shared}old-ending`, body: `${shared}new-ending` }));
    expect(html).toMatch(/<del[^>]*>old-ending<\/del>/);
    expect(html).toMatch(/<ins[^>]*>new-ending<\/ins>/);
    const tail = await details(row({ live_body: `old-start ${shared}trailing`, body: `new-start ${shared}trailing` }));
    expect(tail).toContain(copy.admin.inbox.readAll);
    expect(tail).toMatch(/<del[^>]*>old-start<\/del>/);
    expect(tail).not.toContain("trailing");
  });

  it("markup in a comment is escaped, never rendered", async () => {
    const html = await details(row({ body: '<img src=x onerror="alert(1)"> <script>boom()</script>' }));
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<script");
    expect(html).toContain("&lt;img");
  });

  it("keeps the author's paragraphs and line breaks in the text (the stylesheet preserves them), proportional, nothing parsed", async () => {
    const html = await details(row({ body: "para one line a\nline b\n\npara two" }));
    expect(html).toContain("para one line a\nline b\n\npara two");
    expect(html).not.toContain("<br");
    const css = (await import("node:fs")).readFileSync(new URL("../../src/styles.css", import.meta.url), "utf8");
    const rule = css.match(/\n\.akl-comment-text \{[^}]*\}/)![0];
    expect(rule).toContain("white-space: pre-wrap");
    expect(rule).toContain("font-family: var(--font-display)");
    expect(rule).toMatch(/line-height: 1\.[5-6]/);
  });

  it("markdown and links are shown literally: no emphasis, no anchor, no HTML from a body", async () => {
    const html = await details(row({ body: "**bold** _it_ `code` [x](https://example.org/a) https://example.org/b <b>hi</b> <script>boom()</script>" }));
    expect(html).toContain("**bold** _it_ `code` [x](https://example.org/a) https://example.org/b");
    expect(html).not.toMatch(/<(strong|em|code|a|b|script)[\s>]/);
    expect(html).toContain("&lt;b>hi&lt;/b>");
  });

  it("a changed paragraph break is visible in the diff: Current and Proposed keep their own paragraphs, the break part carries a pilcrow", async () => {
    const html = await details(row({ live_body: "one\n\ntwo", body: "one\ntwo" }));
    const current = html.slice(html.indexOf(copy.admin.inbox.commentCurrent), html.indexOf(copy.admin.inbox.commentProposed));
    const proposed = html.slice(html.indexOf(copy.admin.inbox.commentProposed));
    expect(current).toMatch(/<del[^>]*>(<span[^>]*>¶<\/span>)?\n\n<\/del>/);
    expect(proposed).toMatch(/<ins[^>]*>(<span[^>]*>¶<\/span>)?\n<\/ins>/);
    expect(current).toContain("one");
    expect(current).toContain("two");
    expect(proposed).toContain("two");
    expect(current).not.toContain("<ins");
    expect(proposed).not.toContain("<del");
  });

  it("an erased text shows the erased notice instead of a body", async () => {
    const html = await details(row({ body: null }));
    expect(html).toContain(copy.admin.inbox.commentErased);
  });
});

describe("[SITE-44] the layout page's comment list", () => {
  const comments: PublicComment[] = [
    { id: "c1", user_id: "100000000000000001", name: "Ada", body: "first <b>comment</b>", approved_at: "2026-10-18T00:00:00.000Z", edited: false, likes: 3, is_author: true },
    { id: "c2", user_id: "100000000000000002", name: null, body: "second comment", approved_at: "2026-10-17T00:00:00.000Z", edited: true, likes: 1, is_author: false },
  ];
  const list = (isAdmin: boolean) => render(async () => ({ default: (await import("../../src/ui/LayoutComments.tsx")).CommentList as never }), { comments, isAdmin, onRemoved: () => {} });

  it("renders each comment in the shared plain-text class (proportional, line breaks kept) with the text escaped", async () => {
    const html = await list(false);
    expect(html).toContain('<p class="akl-comment-text">');
  });

  it("lists every approved comment as escaped text with its date, and marks an edited one", async () => {
    const html = await list(false);
    expect(html).toContain("first &lt;b>comment&lt;/b>"); // Solid escapes < and &; a bare > is inert in a text node
    expect(html).toContain("second comment");
    expect(html).toContain("2026-10-18T00:00:00.000Z");
    expect(html.split(copy.layout.commentEdited).length - 1).toBe(1);
  });

  it("labels the layout author's comment, and only that one", async () => {
    const html = await list(false);
    expect(html.split(copy.layout.commentAuthor).length - 1).toBe(1);
    expect(html.indexOf(copy.layout.commentAuthor)).toBeLessThan(html.indexOf("second comment"));
  });

  it("shows each comment's like count, in the order the API sent, with no like button", async () => {
    const html = await list(false);
    expect(html).toContain(copy.layout.commentLikes(3));
    expect(html).toContain(copy.layout.commentLikes(1));
    expect(html.indexOf("first")).toBeLessThan(html.indexOf("second comment"));
    expect(copy.layout.commentLikes(0)).toBe("0 likes");
    expect(html).not.toMatch(/<button[^>]*>[^<]*[Ll]ike/);
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

// The Inbox's columns: Details wraps inside a bounded cell, Layout and the
// action buttons never wrap, and the 560px stacked layout still wraps all of
// them. Asserted on the source (the table loads asynchronously, so a render
// shows no rows) -- the real-width check is a browser walk.
describe("[SITE-44] Inbox column widths", () => {
  const read = async (rel: string) => (await import("node:fs")).readFileSync(new URL(`../../${rel}`, import.meta.url), "utf8");

  it("the Inbox cells carry the width classes", async () => {
    const tab = await read("src/pages/admin/InboxTab.tsx");
    expect(tab).toMatch(/<td class="akl-nowrap" data-col=\{copy\.admin\.inbox\.colLayout\}>/);
    expect(tab).toContain('class={item.kind === "comment" ? "akl-url" : "akl-url akl-details"}');
    expect(tab).toMatch(/<td class="akl-actions">/);
  });

  it("the stylesheet bounds Details, never wraps actions, and the stacked layout wraps every one again", async () => {
    const css = await read("src/styles.css");
    expect(css).toMatch(/\.akl-table td\.akl-details \{[^}]*width: 40%/);
    expect(css).toMatch(/\.akl-table td\.akl-actions \{[^}]*white-space: nowrap/);
    const mobile = css.slice(css.indexOf("@media (max-width: 560px) {\n  .akl-table thead"));
    for (const cls of ["akl-nowrap", "akl-details", "akl-actions"]) expect(mobile.slice(0, 900)).toContain(`.akl-table td.${cls}`);
    expect(mobile.slice(0, 900)).toMatch(/white-space: normal/);
  });
});

// A comment's text is its own full-width line under the row's metadata (a
// second row with a colspan cell), at a readable measure; the 40% Details
// width stays for link and speed rows only.
describe("[SITE-44] Inbox comment rows put the text on its own line", () => {
  const read = async (rel: string) => (await import("node:fs")).readFileSync(new URL(`../../${rel}`, import.meta.url), "utf8");

  it("InboxTab renders a second colspan row for a comment, and keeps the Details width off comment rows", async () => {
    const tab = await read("src/pages/admin/InboxTab.tsx");
    expect(tab).toContain('<tr class="akl-comment-row">');
    expect(tab).toContain("<td colspan={7}>");
    expect(tab).toContain('class={item.kind === "comment" ? "akl-has-text" : undefined}');
  });

  it("the stylesheet caps the text at 75ch and stacks cleanly on a phone", async () => {
    const css = await read("src/styles.css");
    expect(css).toMatch(/\.akl-comment-body \{[^}]*max-width: 75ch/);
    expect(css).toMatch(/tr\.akl-has-text > td \{[^}]*border-bottom: none/);
    expect(css).toMatch(/@media \(max-width: 560px\) \{\s*\.akl-table tr\.akl-has-text/);
  });
});
