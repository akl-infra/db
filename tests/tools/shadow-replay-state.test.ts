// [LDB-CV24] The GET replay differ reports `edited` on comment objects and a wpm `user_name` that shadow holds as null as diff-state (informational),
// because the public dump cannot carry the rows they come from; every other difference in those routes is still a diff.
import { describe, expect, it } from "vitest";
// @ts-expect-error -- plain script, no declaration file
import { judge } from "../../scripts/lab/shadow/replay/diff.mjs";

const ans = (body: unknown, headers: Record<string, string> = {}, status = 200) => ({ status, headers: { "content-type": "application/json", etag: '"10:h"', ...headers }, body: Buffer.from(JSON.stringify(body)) });
const comment = (extra: Record<string, unknown> = {}) => ({ id: 1, slot: 1, body: "nice", author: "ada", likes: 2, ...extra });
const comments = { class: "layout-comments", group: "state", path: "/v1/layouts/x/comments" };
const many = { class: "comments", group: "state", path: "/v1/comments" };
const wpm = { class: "wpm", group: "state", path: "/v1/wpm" };
const rec = (extra: Record<string, unknown> = {}) => ({ id: "w1", wpm: 120, user_id: "u1", user_name: "ada", ...extra });

describe("state the shadow cannot hold (CV24)", () => {
  it("[LDB-CV24] `edited` on a comment is diff-state, in the per-layout and in the bulk comments route", () => {
    const prod = ans({ comments: [comment({ edited: "2026-10-01T00:00:00Z" })] });
    const shadow = ans({ comments: [comment()] });
    const j = judge(comments, prod, shadow);
    expect(j.verdict).toBe("diff-state");
    expect(j.problems[0].detail).toContain("state shadow cannot hold: /comments/0/edited");
    expect(judge(many, ans({ layouts: { x: [comment({ edited: "t" })] } }), ans({ layouts: { x: [comment({ edited: null })] } })).verdict).toBe("diff-state");
    // equal stays equal, whichever side carries the field
    expect(judge(comments, ans({ comments: [comment({ edited: "t" })] }), ans({ comments: [comment({ edited: "t" })] })).verdict).toBe("equal");
  });

  it("[LDB-CV24] ... but a real difference next to it is a diff and names the real field", () => {
    const prod = ans({ comments: [comment({ edited: "t", body: "nice" })] });
    const shadow = ans({ comments: [comment({ body: "nicer" })] });
    const j = judge(comments, prod, shadow);
    expect(j.verdict).toBe("diff");
    expect(j.problems.map((p: { detail: string }) => p.detail).join(" ")).toContain("/comments/0/body");
    // a different number of comments is a diff, `edited` or not
    expect(judge(comments, ans({ comments: [comment({ edited: "t" }), comment({ id: 2 })] }), ans({ comments: [comment()] })).verdict).toBe("diff");
    // a header difference is a diff even when the body differs only in `edited`
    expect(judge(comments, ans({ comments: [comment({ edited: "t" })] }, { "cache-control": "public, max-age=10" }), ans({ comments: [comment()] }, { "cache-control": "no-store" })).verdict).toBe("diff");
    // `edited` is only state on a comments route: on a layout it is a diff
    expect(judge({ class: "layout", group: "feed", path: "/v1/layouts/x" }, ans({ id: "x", edited: "t" }), ans({ id: "x" })).verdict).toBe("diff");
  });

  it("[LDB-CV24] a wpm user_name is diff-state only when shadow has null and production has a value", () => {
    const j = judge(wpm, ans({ records: [rec()] }), ans({ records: [rec({ user_name: null })] }));
    expect(j.verdict).toBe("diff-state");
    expect(j.problems[0].detail).toContain('/records/0/user_name: "ada" vs null');
    // the other direction, and two different values, are real differences
    expect(judge(wpm, ans({ records: [rec({ user_name: null })] }), ans({ records: [rec()] })).verdict).toBe("diff");
    expect(judge(wpm, ans({ records: [rec()] }), ans({ records: [rec({ user_name: "bob" })] })).verdict).toBe("diff");
    // the real diff next to a masked user_name is reported
    const real = judge(wpm, ans({ records: [rec({ wpm: 120 })] }), ans({ records: [rec({ wpm: 121, user_name: null })] }));
    expect(real.verdict).toBe("diff");
    expect(real.problems.map((p: { detail: string }) => p.detail).join(" ")).toContain("/records/0/wpm");
    // and a user_name null on both sides, or equal, is equal
    expect(judge(wpm, ans({ records: [rec({ user_name: null })] }), ans({ records: [rec({ user_name: null })] })).verdict).toBe("equal");
  });

  it("[LDB-CV24] a body-derived ETag that follows a user_name diff-state is diff-state; with any other difference it stays a diff", () => {
    const j = judge(wpm, ans({ records: [rec()] }, { etag: '"10:aaaa"' }), ans({ records: [rec({ user_name: null })] }, { etag: '"10:bbbb"' }));
    expect(j.verdict).toBe("diff-state");
    expect(j.problems.map((p: { detail: string }) => p.detail).join(" ")).toContain("header etag");
    // the same ETag difference without the state difference is a diff
    expect(judge(wpm, ans({ records: [rec()] }, { etag: '"10:aaaa"' }), ans({ records: [rec()] }, { etag: '"10:bbbb"' })).verdict).toBe("diff");
    // and with a real body difference next to it
    expect(judge(wpm, ans({ records: [rec()] }, { etag: '"10:aaaa"' }), ans({ records: [rec({ user_name: null, wpm: 99 })] }, { etag: '"10:bbbb"' })).verdict).toBe("diff");
  });

  it("[LDB-CV24] Vary's accept-encoding token is transport (Cloudflare adds it relaying an origin gzip); any other Vary difference is a diff", () => {
    const layout = { class: "layout", group: "feed", path: "/v1/layouts/x" };
    expect(judge(layout, ans({ id: "x" }, { vary: "accept-encoding" }), ans({ id: "x" })).verdict).toBe("equal");
    expect(judge(layout, ans({ id: "x" }, { vary: "Accept-Encoding, Authorization" }), ans({ id: "x" }, { vary: "authorization" })).verdict).toBe("equal");
    expect(judge(layout, ans({ id: "x" }, { vary: "accept-encoding, authorization" }), ans({ id: "x" })).verdict).toBe("diff");
  });

  it("[LDB-CV24] when production changed that state after shadow's last dump the answer is skipped, as for any state class", () => {
    const ctx = { stateMoved: { "layout-comments": true } };
    expect(judge(comments, ans({ comments: [comment({ edited: "t" })] }), ans({ comments: [comment()] }), ctx).verdict).toBe("skipped");
  });
});
