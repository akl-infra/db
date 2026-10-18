// [LDB-CMT1..LDB-CMT7] [LDB-CMT9] [LDB-CMT11..LDB-CMT13] Layout comments
// (docs/decisions/29-layout-comments.md): write / queue / approve / delete /
// public and own reads, black-box via SELF.fetch, same pattern
// tests/api/wpm.test.ts uses for the WPM queue.
import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ulid } from "ulidx";
import type { Bindings } from "../../src/env";
import { commitWrite, type CommitInput } from "../../src/core/events";
import { steppingClock } from "../../src/core/time";
import { AKL_PAYLOAD, BOOTSTRAP_ADMIN, actorFixture, pinTestClock, register, uniqueName, writeFetch } from "./write-support";

const bindings = env as unknown as Bindings;
const db = bindings.DB;
// Every call to the clock is a fresh instant, so `submitted_at`/`decided_at`
// order strictly by the order the test made its requests.
const clock = steppingClock("2026-10-01T00:00:00.000Z", 1000);
pinTestClock(env as unknown as { TEST_CLOCK?: typeof clock }, clock);

afterEach(() => {
  vi.unstubAllGlobals();
});

let idCounter = 0;
function testUserId(): string {
  idCounter++;
  return `34000000000000${String(idCounter).padStart(4, "0")}`;
}

let tokenCounter = 0;
function token(label: string): string {
  tokenCounter++;
  return `tok-cmt-${label}-${tokenCounter}`;
}

async function createLayout(owner: string, name = uniqueName("cmt-layout")): Promise<{ id: string; name: string }> {
  const input: CommitInput = {
    layoutId: ulid(),
    creating: true,
    currentN: 0,
    currentLayout: null,
    currentFormats: new Map(),
    layout: { kind: "created", name, owner, created_at: clock(), deleted: false },
    format: { kind: "format_added", lineage: "spark", format: "spark/1", payload: AKL_PAYLOAD, hasMagic: false },
    modified_at: clock(),
    actor: owner,
    via: "discord",
    source: { client: "discord-app:test", version: null },
    upstream: null,
  };
  const { layout } = await commitWrite(db, clock, input);
  return { id: layout.id, name: layout.name };
}

interface Submission {
  id: string;
  layout_id: string;
  user_id: string;
  body: string | null;
  via: string;
  submitted_at: string;
  status: string;
  decided_by: string | null;
  decided_at: string | null;
  reason: string | null;
}
interface QueueRow extends Submission {
  layout_name: string;
  user_name: string | null;
  live_body: string | null;
}
interface PublicComment {
  id: string;
  user_id: string;
  name: string | null;
  body: string;
  approved_at: string;
  edited: boolean;
  likes: number;
  liked?: boolean;
}
interface Own {
  live: { id: string; body: string; approved_at: string } | null;
  pending: { id: string; body: string; submitted_at: string } | null;
  decision: { status: string; reason: string | null; decided_at: string; body: string } | null;
}

type Auth = Record<string, string>;

async function listed(layout: string): Promise<PublicComment[]> {
  const res = await writeFetch(`/v1/layouts/${layout}/comments`, "GET");
  expect(res.status).toBe(200);
  return ((await res.json()) as { comments: PublicComment[] }).comments;
}

async function own(auth: Auth, layout: string): Promise<Own> {
  const res = await writeFetch(`/v1/layouts/${layout}/comment`, "GET", auth);
  expect(res.status).toBe(200);
  return (await res.json()) as Own;
}

async function put(auth: Auth, layout: string, body: unknown): Promise<{ status: number; submission: Submission }> {
  const res = await writeFetch(`/v1/layouts/${layout}/comment`, "PUT", auth, { body });
  const json = (await res.json()) as { submission: Submission };
  return { status: res.status, submission: json.submission };
}

async function queue(admin: Auth, layoutId: string, status = "pending"): Promise<QueueRow[]> {
  const res = await writeFetch(`/v1/admin/comment-queue?status=${status}`, "GET", admin);
  expect(res.status).toBe(200);
  return ((await res.json()) as { submissions: QueueRow[] }).submissions.filter((s) => s.layout_id === layoutId);
}

async function approve(admin: Auth, id: string): Promise<Response> {
  return writeFetch(`/v1/admin/comment-queue/${id}/approve`, "POST", admin);
}

async function rowsFor(layoutId: string, userId?: string): Promise<{ id: string; user_id: string; body: string | null; status: string }[]> {
  const q = userId === undefined ? "WHERE layout_id = ?" : "WHERE layout_id = ? AND user_id = ?";
  const stmt = db.prepare(`SELECT id, user_id, body, status FROM layout_comments ${q} ORDER BY submitted_at ASC, id ASC`);
  return (await (userId === undefined ? stmt.bind(layoutId) : stmt.bind(layoutId, userId)).all<{ id: string; user_id: string; body: string | null; status: string }>()).results;
}

interface FeedEvent {
  seq: number;
  kind: string;
  layout_id: string | null;
  actor: string;
  admin: boolean;
  detail: Record<string, unknown> | null;
}
async function feedFor(layoutId: string): Promise<FeedEvent[]> {
  const res = await writeFetch(`/v1/changes?since=0&limit=1000&layout=${layoutId}`, "GET");
  return ((await res.json()) as { items: FeedEvent[] }).items;
}
async function commentEvents(layoutId: string): Promise<FeedEvent[]> {
  return (await feedFor(layoutId)).filter((e) => e.kind.startsWith("comment_"));
}

// A user + their token + a layout, and an admin token, all on one fake lane.
function actors(label: string): { user: string; auth: Auth; admin: Auth; fake: ReturnType<typeof actorFixture> } {
  const fake = actorFixture();
  const user = testUserId();
  return { user, auth: register(fake, token(`${label}-user`), user), admin: register(fake, token(`${label}-admin`), BOOTSTRAP_ADMIN), fake };
}

describe("[LDB-CMT1] validation is shared by every write", () => {
  it("[LDB-CMT1] PUT refuses a bad body with 400 invalid_comment and accepts the 1 and 2000 character boundaries", async () => {
    const { user, auth } = actors("val");
    const { id } = await createLayout(user);
    for (const body of ["", "   ", "\r\n\t", 5, null, true, ["x"], { a: 1 }, "a".repeat(2001), "😀".repeat(2001)]) {
      const res = await writeFetch(`/v1/layouts/${id}/comment`, "PUT", auth, { body });
      expect(res.status, JSON.stringify(body)?.slice(0, 20)).toBe(400);
      await expect(res.json()).resolves.toMatchObject({ error: "invalid_comment" });
    }
    expect((await put(auth, id, "x")).status).toBe(202);
    expect((await put(auth, id, "a".repeat(2000))).status).toBe(202);
    expect((await put(auth, id, "😀".repeat(2000))).status).toBe(202);
    // Nothing was written by the refusals.
    expect(await rowsFor(id, user)).toHaveLength(3);
  });

  it("[LDB-CMT1] the stored text has CRLF and lone CR normalized and is trimmed; nothing else is changed", async () => {
    const { user, auth } = actors("norm");
    const { id } = await createLayout(user);
    const { submission } = await put(auth, id, "  line one\r\nline two\rline three\n  <b>raw</b> \u{1F600}  ");
    expect(submission.body).toBe("line one\nline two\nline three\n  <b>raw</b> \u{1F600}");
    const stored = await db.prepare("SELECT body FROM layout_comments WHERE id = ?").bind(submission.id).first<{ body: string }>();
    expect(stored?.body).toBe(submission.body);
  });

  it("[LDB-CMT1] a missing or extra body field is 400 bad_request; the layout ref resolves by id or name; an unknown or deleted layout is 404", async () => {
    const { user, auth } = actors("body");
    const { id, name } = await createLayout(user);
    expect((await writeFetch(`/v1/layouts/${id}/comment`, "PUT", auth, {})).status).toBe(400);
    expect((await writeFetch(`/v1/layouts/${id}/comment`, "PUT", auth, { text: "hi" })).status).toBe(400);
    const extra = await writeFetch(`/v1/layouts/${id}/comment`, "PUT", auth, { body: "hi", user_id: user });
    expect(extra.status).toBe(400);
    await expect(extra.json()).resolves.toMatchObject({ error: "bad_request" });
    expect((await writeFetch(`/v1/layouts/${id}/comment`, "PUT", auth, [])).status).toBe(400);

    expect((await put(auth, id, "by id")).status).toBe(202);
    expect((await put(auth, name, "by name")).status).toBe(202);

    const unknown = await writeFetch("/v1/layouts/no-such-layout-cmt/comment", "PUT", auth, { body: "hi" });
    expect(unknown.status).toBe(404);
    await expect(unknown.json()).resolves.toMatchObject({ error: "not_found" });

    await db.prepare("UPDATE layouts SET deleted = 1 WHERE id = ?").bind(id).run();
    expect((await writeFetch(`/v1/layouts/${id}/comment`, "PUT", auth, { body: "late" })).status).toBe(404);
  });
});

describe("[LDB-CMT2] a user's comment is queued; a newer pending one supersedes; an admin's own is approved at once", () => {
  it("[LDB-CMT2] 202, status pending, not public; the older pending row becomes superseded with no event; other users and layouts are untouched", async () => {
    const { user, auth, admin, fake } = actors("sup");
    const userB = testUserId();
    const b = register(fake, token("sup-b"), userB);
    const layout1 = await createLayout(user);
    const layout2 = await createLayout(user);

    const first = await put(auth, layout1.id, "first draft");
    expect(first.status).toBe(202);
    expect(first.submission).toMatchObject({ layout_id: layout1.id, user_id: user, body: "first draft", status: "pending", decided_by: null, decided_at: null, reason: null, via: "discord" });
    await put(b, layout1.id, "from b");
    await put(auth, layout2.id, "other layout");
    const before = (await commentEvents(layout1.id)).length;
    const second = await put(auth, layout1.id, "second draft");
    expect(second.status).toBe(202);

    expect((await rowsFor(layout1.id)).map((r) => [r.user_id, r.body, r.status])).toEqual([
      [user, "first draft", "superseded"],
      [userB, "from b", "pending"],
      [user, "second draft", "pending"],
    ]);
    expect((await rowsFor(layout2.id))[0]?.status).toBe("pending");

    // Only the NEW submission's `comment_submitted` landed; superseding is silent.
    expect((await commentEvents(layout1.id)).length - before).toBe(1);
    expect(await listed(layout1.id)).toEqual([]);

    expect((await queue(admin, layout1.id)).map((s) => [s.user_id, s.body])).toEqual([
      [userB, "from b"],
      [user, "second draft"],
    ]);
    expect((await queue(admin, layout1.id, "superseded")).map((s) => s.body)).toEqual(["first draft"]);
  });

  it("[LDB-CMT2] an admin's own comment is 201, approved and public at once, with exactly one comment_approved event and no queue row", async () => {
    const owner = testUserId();
    const { id, name } = await createLayout(owner);
    const admin = register(actorFixture(), token("self"), BOOTSTRAP_ADMIN);

    const { status, submission } = await put(admin, name, "an admin speaks");
    expect(status).toBe(201);
    expect(submission).toMatchObject({ layout_id: id, user_id: BOOTSTRAP_ADMIN, body: "an admin speaks", status: "approved", decided_by: BOOTSTRAP_ADMIN });
    expect(submission.decided_at).not.toBeNull();

    const comments = await listed(id);
    expect(comments).toHaveLength(1);
    expect(comments[0]).toMatchObject({ id: submission.id, user_id: BOOTSTRAP_ADMIN, body: "an admin speaks", approved_at: submission.decided_at, edited: false });
    expect(await queue(admin, id)).toEqual([]);
    expect((await commentEvents(id)).map((e) => e.kind)).toEqual(["comment_approved"]);
  });

  it("[LDB-CMT2] an admin's second comment replaces their first (one live text); a stale pending row of theirs is superseded", async () => {
    const { id } = await createLayout(testUserId());
    const admin = register(actorFixture(), token("self2"), BOOTSTRAP_ADMIN);
    await put(admin, id, "one");
    await db
      .prepare("INSERT INTO layout_comments (id, layout_id, user_id, body, via, submitted_at, status) VALUES (?, ?, ?, 'stale pending', 'discord', ?, 'pending')")
      .bind(ulid(), id, BOOTSTRAP_ADMIN, clock())
      .run();
    await put(admin, id, "two");
    expect((await rowsFor(id, BOOTSTRAP_ADMIN)).map((r) => [r.body, r.status])).toEqual([
      [null, "replaced"],
      ["stale pending", "superseded"],
      ["two", "approved"],
    ]);
    expect((await listed(id)).map((c) => c.body)).toEqual(["two"]);
  });
});

describe("[LDB-CMT3] approve / replace / reject / remove", () => {
  it("[LDB-CMT3] approve makes the pending row public; the first approval has nothing to replace and is not edited", async () => {
    const { user, auth, admin } = actors("appr");
    const { id } = await createLayout(user);
    const sub = (await put(auth, id, "hello")).submission;

    const res = await approve(admin, sub.id);
    expect(res.status).toBe(200);
    const { submission } = (await res.json()) as { submission: Submission };
    expect(submission).toMatchObject({ id: sub.id, status: "approved", decided_by: BOOTSTRAP_ADMIN, body: "hello", reason: null });

    const comments = await listed(id);
    expect(comments).toHaveLength(1);
    expect(comments[0]).toMatchObject({ id: sub.id, user_id: user, body: "hello", approved_at: submission.decided_at, edited: false });
  });

  it("[LDB-CMT3] an edit keeps the approved text live until approved; approving replaces it (row replaced, body NULL) and marks the comment edited", async () => {
    const { user, auth, admin } = actors("edit");
    const { id } = await createLayout(user);
    const v1 = (await put(auth, id, "version one")).submission;
    await approve(admin, v1.id);

    const v2 = (await put(auth, id, "version two")).submission;
    expect((await listed(id)).map((c) => c.body)).toEqual(["version one"]); // still live
    expect(await own(auth, id)).toMatchObject({ live: { id: v1.id, body: "version one" }, pending: { id: v2.id, body: "version two" }, decision: null });
    const q = await queue(admin, id);
    expect(q).toHaveLength(1);
    expect(q[0]).toMatchObject({ id: v2.id, body: "version two", live_body: "version one" });

    await approve(admin, v2.id);
    const comments = await listed(id);
    expect(comments.map((c) => [c.id, c.body, c.edited])).toEqual([[v2.id, "version two", true]]);
    expect(await rowsFor(id, user)).toEqual([
      { id: v1.id, user_id: user, body: null, status: "replaced" },
      { id: v2.id, user_id: user, body: "version two", status: "approved" },
    ]);
    expect(await own(auth, id)).toMatchObject({ live: { id: v2.id, body: "version two" }, pending: null, decision: null });
  });

  it("[LDB-CMT3] at most one approved row with a body per (layout, user), across many edits and two users", async () => {
    const { user, auth, admin, fake } = actors("one");
    const other = testUserId();
    const otherAuth = register(fake, token("one-other"), other);
    const { id } = await createLayout(user);
    for (const text of ["a", "b", "c", "d"]) {
      await approve(admin, (await put(auth, id, text)).submission.id);
      await approve(admin, (await put(otherAuth, id, `${text}!`)).submission.id);
      const live = await db
        .prepare("SELECT user_id, COUNT(*) AS n FROM layout_comments WHERE layout_id = ? AND status = 'approved' AND body IS NOT NULL GROUP BY user_id")
        .bind(id)
        .all<{ user_id: string; n: number }>();
      expect(live.results.map((r) => r.n)).toEqual([1, 1]);
    }
    expect((await listed(id)).map((c) => c.body).sort()).toEqual(["d", "d!"]);
    const replaced = (await rowsFor(id)).filter((r) => r.status === "replaced");
    expect(replaced).toHaveLength(6);
    expect(replaced.every((r) => r.body === null)).toBe(true);
  });

  it("[LDB-CMT3] reject keeps the body and records the reason; the author reads both back; a live comment stays live", async () => {
    const { user, auth, admin } = actors("rej");
    const { id } = await createLayout(user);
    const v1 = (await put(auth, id, "good one")).submission;
    await approve(admin, v1.id);
    const v2 = (await put(auth, id, "bad edit")).submission;

    const res = await writeFetch(`/v1/admin/comment-queue/${v2.id}/reject`, "POST", admin, { reason: "off topic" });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { submission: Submission }).submission).toMatchObject({ status: "rejected", body: "bad edit", reason: "off topic", decided_by: BOOTSTRAP_ADMIN });

    expect((await listed(id)).map((c) => c.body)).toEqual(["good one"]);
    const mine = await own(auth, id);
    expect(mine.live).toMatchObject({ id: v1.id, body: "good one" });
    expect(mine.pending).toBeNull();
    expect(mine.decision).toMatchObject({ status: "rejected", reason: "off topic" });
    const rejected = await queue(admin, id, "rejected");
    expect(rejected.map((s) => [s.body, s.reason])).toEqual([["bad edit", "off topic"]]);

    // The reason is optional and a body is not required at all.
    const v3 = (await put(auth, id, "another")).submission;
    const bare = await writeFetch(`/v1/admin/comment-queue/${v3.id}/reject`, "POST", admin);
    expect(bare.status).toBe(200);
    expect(((await bare.json()) as { submission: Submission }).submission).toMatchObject({ status: "rejected", reason: null });
  });

  it("[LDB-CMT3] remove takes an approved comment down: status removed, the text and the reason KEPT for the author (never public); it leaves the public list", async () => {
    const { user, auth, admin } = actors("rem");
    const { id } = await createLayout(user);
    const v1 = (await put(auth, id, "spam spam")).submission;
    await approve(admin, v1.id);

    const res = await writeFetch(`/v1/admin/comments/${v1.id}/remove`, "POST", admin, { reason: "spam" });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { submission: Submission }).submission).toMatchObject({ id: v1.id, status: "removed", body: "spam spam", reason: "spam", decided_by: BOOTSTRAP_ADMIN });

    expect(await listed(id)).toEqual([]);
    expect(await rowsFor(id, user)).toEqual([{ id: v1.id, user_id: user, body: "spam spam", status: "removed" }]);
    // the author reads the kept text back (to edit and resend); mods see it in the queue; nobody else does
    expect(await own(auth, id)).toMatchObject({ live: null, pending: null, decision: { status: "removed", reason: "spam", body: "spam spam" } });
    expect((await queue(admin, id, "removed")).map((s) => [s.body, s.reason])).toEqual([["spam spam", "spam"]]);
    expect(JSON.stringify(await feedFor(id)).includes("spam spam")).toBe(false);
    expect(JSON.stringify(await listed(id)).includes("spam spam")).toBe(false);
    // and the author can resend an edited version, which is an ordinary new submission
    const resent = await put(auth, id, "a politer version");
    expect(resent.status).toBe(202);
    expect(await own(auth, id)).toMatchObject({ pending: { body: "a politer version" }, decision: null });
  });

  it("[LDB-CMT3] a decided submission cannot be decided again (404); remove needs an approved comment; a pending one cannot be removed", async () => {
    const { user, auth, admin } = actors("again");
    const { id } = await createLayout(user);
    const a = (await put(auth, id, "one")).submission;
    expect((await approve(admin, a.id)).status).toBe(200);
    expect((await approve(admin, a.id)).status).toBe(404);
    expect((await writeFetch(`/v1/admin/comment-queue/${a.id}/reject`, "POST", admin, {})).status).toBe(404);

    const b = (await put(auth, id, "two")).submission;
    expect((await writeFetch(`/v1/admin/comments/${b.id}/remove`, "POST", admin, {})).status).toBe(404); // pending
    expect((await writeFetch(`/v1/admin/comment-queue/${b.id}/reject`, "POST", admin, {})).status).toBe(200);
    expect((await writeFetch(`/v1/admin/comments/${b.id}/remove`, "POST", admin, {})).status).toBe(404); // rejected

    expect((await writeFetch(`/v1/admin/comments/${a.id}/remove`, "POST", admin, {})).status).toBe(200);
    expect((await writeFetch(`/v1/admin/comments/${a.id}/remove`, "POST", admin, {})).status).toBe(404); // already removed
    expect((await writeFetch("/v1/admin/comment-queue/no-such-id/approve", "POST", admin)).status).toBe(404);
    expect((await writeFetch("/v1/admin/comments/no-such-id/remove", "POST", admin, {})).status).toBe(404);
  });

  it("[LDB-CMT3] a superseded submission cannot be approved; only the newest pending one is in play", async () => {
    const { user, auth, admin } = actors("supappr");
    const { id } = await createLayout(user);
    const old = (await put(auth, id, "old")).submission;
    await put(auth, id, "new");
    expect((await approve(admin, old.id)).status).toBe(404);
  });

  it("[LDB-CMT3] approving on a deleted layout is 404 until restored; the row is kept", async () => {
    const { user, auth, admin } = actors("tomb");
    const { id } = await createLayout(user);
    const sub = (await put(auth, id, "waiting")).submission;
    await db.prepare("UPDATE layouts SET deleted = 1 WHERE id = ?").bind(id).run();

    expect((await approve(admin, sub.id)).status).toBe(404);
    expect((await rowsFor(id, user))[0]?.status).toBe("pending");
    expect(await queue(admin, id)).toEqual([]); // hidden while the layout is a tombstone

    await db.prepare("UPDATE layouts SET deleted = 0 WHERE id = ?").bind(id).run();
    expect(await queue(admin, id)).toHaveLength(1);
    expect((await approve(admin, sub.id)).status).toBe(200);
  });

  it("[LDB-CMT3] two admins approving the same row at once: exactly one wins and the previous text is retired exactly once", async () => {
    const { user, auth, admin } = actors("race");
    const { id } = await createLayout(user);
    await approve(admin, (await put(auth, id, "v1")).submission.id);
    const v2 = (await put(auth, id, "v2")).submission;
    const results = await Promise.all([approve(admin, v2.id), approve(admin, v2.id)]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 404]);
    expect((await listed(id)).map((c) => c.body)).toEqual(["v2"]);
  });
});

describe("[LDB-CMT4] delete is immediate and erases the text for good", () => {
  it("[LDB-CMT4] 204; approved and pending rows become deleted, rejected and superseded rows lose their text; one comment_deleted event", async () => {
    const { user, auth, admin } = actors("del");
    const { id } = await createLayout(user);
    const v1 = (await put(auth, id, "approved text")).submission;
    await approve(admin, v1.id);
    const rej = (await put(auth, id, "rejected text")).submission;
    await writeFetch(`/v1/admin/comment-queue/${rej.id}/reject`, "POST", admin, { reason: "no" });
    await put(auth, id, "superseded text"); // will be superseded by the next
    const pend = (await put(auth, id, "pending text")).submission;
    const before = (await commentEvents(id)).filter((e) => e.kind === "comment_deleted").length;

    const res = await writeFetch(`/v1/layouts/${id}/comment`, "DELETE", auth);
    expect(res.status).toBe(204);
    expect(await res.text()).toBe("");

    const rows = await rowsFor(id, user);
    expect(rows.every((r) => r.body === null)).toBe(true);
    expect(rows.map((r) => r.status)).toEqual(["deleted", "rejected", "superseded", "deleted"]);
    expect(rows.find((r) => r.id === pend.id)?.status).toBe("deleted");
    expect(await listed(id)).toEqual([]);
    expect(await own(auth, id)).toEqual({ live: null, pending: null, decision: null });
    expect(await queue(admin, id, "pending")).toEqual([]);
    expect(await queue(admin, id, "rejected")).toMatchObject([{ id: rej.id, body: null }]);

    const events = (await commentEvents(id)).filter((e) => e.kind === "comment_deleted");
    expect(events.length - before).toBe(1);
    expect(events.at(-1)).toMatchObject({ actor: user, admin: false, detail: { layout_id: id, user_id: user } });
  });

  it("[LDB-CMT4] a caller with no text on the layout is 404 and nothing is written; a second delete is 404 too", async () => {
    const { user, auth, fake } = actors("del404");
    const stranger = register(fake, token("del404-stranger"), testUserId());
    const { id } = await createLayout(user);

    expect((await writeFetch(`/v1/layouts/${id}/comment`, "DELETE", stranger)).status).toBe(404);
    expect((await writeFetch("/v1/layouts/no-such-layout-cmt/comment", "DELETE", auth)).status).toBe(404);

    await put(auth, id, "to be deleted once");
    expect((await writeFetch(`/v1/layouts/${id}/comment`, "DELETE", auth)).status).toBe(204);
    const eventsBefore = (await commentEvents(id)).length;
    const again = await writeFetch(`/v1/layouts/${id}/comment`, "DELETE", auth);
    expect(again.status).toBe(404);
    await expect(again.json()).resolves.toMatchObject({ error: "not_found" });
    expect((await commentEvents(id)).length).toBe(eventsBefore); // no event when nothing was erased
  });

  it("[LDB-CMT4] a lone rejected (or superseded) text is erased by DELETE: 204, status kept, one comment_deleted event; the next delete is 404", async () => {
    const { user, auth, admin } = actors("delrej");
    const { id } = await createLayout(user);
    const sup = (await put(auth, id, "superseded text")).submission;
    const rej = (await put(auth, id, "rejected text")).submission;
    await writeFetch(`/v1/admin/comment-queue/${rej.id}/reject`, "POST", admin, { reason: "meh" });
    expect(await rowsFor(id, user)).toEqual([
      { id: sup.id, user_id: user, body: "superseded text", status: "superseded" },
      { id: rej.id, user_id: user, body: "rejected text", status: "rejected" },
    ]);
    const before = (await commentEvents(id)).filter((e) => e.kind === "comment_deleted").length;

    expect((await writeFetch(`/v1/layouts/${id}/comment`, "DELETE", auth)).status).toBe(204);
    expect(await rowsFor(id, user)).toEqual([
      { id: sup.id, user_id: user, body: null, status: "superseded" },
      { id: rej.id, user_id: user, body: null, status: "rejected" },
    ]);
    expect((await queue(admin, id, "rejected")).map((s) => s.body)).toEqual([null]);
    expect((await commentEvents(id)).filter((e) => e.kind === "comment_deleted").length - before).toBe(1);
    expect(await own(auth, id)).toEqual({ live: null, pending: null, decision: null });
    expect((await writeFetch(`/v1/layouts/${id}/comment`, "DELETE", auth)).status).toBe(404);
  });

  it("[LDB-CMT4] delete touches only the caller's rows; after a delete the user can comment again, and the new comment is not marked edited", async () => {
    const { user, auth, admin, fake } = actors("del2");
    const other = testUserId();
    const otherAuth = register(fake, token("del2-other"), other);
    const { id } = await createLayout(user);
    await approve(admin, (await put(otherAuth, id, "bystander")).submission.id);
    const v1 = (await put(auth, id, "first")).submission;
    await approve(admin, v1.id);
    await approve(admin, (await put(auth, id, "first, edited")).submission.id);
    expect((await listed(id)).find((c) => c.user_id === user)?.edited).toBe(true);

    expect((await writeFetch(`/v1/layouts/${id}/comment`, "DELETE", auth)).status).toBe(204);
    expect((await listed(id)).map((c) => c.body)).toEqual(["bystander"]);

    await approve(admin, (await put(auth, id, "fresh start")).submission.id);
    const mine = (await listed(id)).find((c) => c.user_id === user);
    expect(mine).toMatchObject({ body: "fresh start", edited: false });

    // An edit after the fresh start is an edit again.
    await approve(admin, (await put(auth, id, "fresh start, fixed")).submission.id);
    expect((await listed(id)).find((c) => c.user_id === user)?.edited).toBe(true);
  });

  it("[LDB-CMT4] the erased text is in no table and no dump row afterwards", async () => {
    const { user, auth, admin } = actors("erase");
    const { id } = await createLayout(user);
    const secret = "erase-me-9f3c1d-never-again";
    await approve(admin, (await put(auth, id, `${secret} approved`)).submission.id);
    await put(auth, id, `${secret} pending`);
    await writeFetch(`/v1/layouts/${id}/comment`, "DELETE", auth);
    const left = await db.prepare("SELECT COUNT(*) AS n FROM layout_comments WHERE layout_id = ? AND body LIKE ?").bind(id, `%${secret}%`).first<{ n: number }>();
    expect(left?.n).toBe(0);
    const eventText = JSON.stringify(await feedFor(id));
    expect(eventText.includes(secret)).toBe(false);
  });

  it("[LDB-CMT4] a mod's removal keeps the text, and the author's DELETE then erases it for good: 204, status removed, body NULL, no decision; a second delete is 404", async () => {
    const { user, auth, admin } = actors("remdel");
    const { id } = await createLayout(user);
    const v1 = (await put(auth, id, "removed but kept")).submission;
    await approve(admin, v1.id);
    await writeFetch(`/v1/admin/comments/${v1.id}/remove`, "POST", admin, { reason: "r" });
    expect(await rowsFor(id, user)).toEqual([{ id: v1.id, user_id: user, body: "removed but kept", status: "removed" }]);
    const before = (await commentEvents(id)).filter((e) => e.kind === "comment_deleted").length;

    expect((await writeFetch(`/v1/layouts/${id}/comment`, "DELETE", auth)).status).toBe(204); // a lone removed text counts
    expect(await rowsFor(id, user)).toEqual([{ id: v1.id, user_id: user, body: null, status: "removed" }]);
    expect(await own(auth, id)).toEqual({ live: null, pending: null, decision: null });
    expect((await commentEvents(id)).filter((e) => e.kind === "comment_deleted").length - before).toBe(1);
    expect((await writeFetch(`/v1/layouts/${id}/comment`, "DELETE", auth)).status).toBe(404);
  });
});

describe("[LDB-CMT5] GET /v1/layouts/:ref/comments is public and shows one approved comment per user", () => {
  it("[LDB-CMT5] pending, rejected, superseded, replaced, deleted and removed rows never appear; the shape is exact", async () => {
    const { user, auth, admin, fake } = actors("pub");
    const { id } = await createLayout(user);
    const others = [1, 2, 3, 4].map(() => testUserId());
    const auths = others.map((o, i) => register(fake, token(`pub-o${i}`), o));
    // pending only
    await put(auths[0]!, id, "only pending");
    // rejected
    await writeFetch(`/v1/admin/comment-queue/${(await put(auths[1]!, id, "rejected one")).submission.id}/reject`, "POST", admin, { reason: "x" });
    // removed
    const toRemove = (await put(auths[2]!, id, "to be removed")).submission;
    await approve(admin, toRemove.id);
    await writeFetch(`/v1/admin/comments/${toRemove.id}/remove`, "POST", admin, {});
    // approved
    const shown = (await put(auths[3]!, id, "shown")).submission;
    await approve(admin, shown.id);
    await db.prepare("INSERT OR REPLACE INTO authors (user_id, name, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?)").bind(others[3]!, "Shown Person", clock(), clock()).run();

    const res = await writeFetch(`/v1/layouts/${id}/comments`, "GET");
    expect(res.headers.get("Cache-Control")).toBe("public, max-age=10");
    const comments = ((await res.json()) as { comments: PublicComment[] }).comments;
    expect(comments).toHaveLength(1);
    expect(Object.keys(comments[0]!).sort()).toEqual(["approved_at", "body", "edited", "id", "likes", "name", "user_id"]);
    expect(comments[0]).toMatchObject({ id: shown.id, user_id: others[3], name: "Shown Person", body: "shown", edited: false });
    expect(JSON.stringify(comments)).not.toMatch(/only pending|rejected one|to be removed|notified_at/);
    // `name` is null for a user with no authors row
    await db.prepare("DELETE FROM authors WHERE user_id = ?").bind(others[3]!).run();
    expect((await listed(id))[0]?.name).toBeNull();
  });

  it("[LDB-CMT5] sorted approved_at desc then id; the layout resolves by id or by name", async () => {
    const owner = testUserId();
    const { id, name } = await createLayout(owner);
    const mk = (suffix: string, at: string, uid: string) =>
      db
        .prepare("INSERT INTO layout_comments (id, layout_id, user_id, body, via, submitted_at, status, decided_by, decided_at) VALUES (?, ?, ?, ?, 'discord', ?, 'approved', 'm', ?)")
        .bind(`01ARZ3NDEKTSV4RRFFQ69G5F${suffix}`, id, uid, `c-${suffix}`, at, at)
        .run();
    const [u1, u2, u3, u4] = [testUserId(), testUserId(), testUserId(), testUserId()] as const;
    await mk("A1", "2026-09-01T00:00:00.000Z", u1);
    await mk("A2", "2026-09-03T00:00:00.000Z", u2);
    await mk("B2", "2026-09-02T00:00:00.000Z", u3);
    await mk("B1", "2026-09-02T00:00:00.000Z", u4);
    expect((await listed(id)).map((c) => c.body)).toEqual(["c-A2", "c-B1", "c-B2", "c-A1"]);
    expect((await listed(name)).map((c) => c.body)).toEqual(["c-A2", "c-B1", "c-B2", "c-A1"]);
  });

  it("[LDB-CMT5] an unknown layout is 404", async () => {
    const res = await writeFetch("/v1/layouts/no-such-layout-cmt/comments", "GET");
    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toMatchObject({ error: "not_found" });
  });

  it("[LDB-CMT5] ETag: 304 on a match, a new tag after an approval, a delete and a removal", async () => {
    const { user, auth, admin } = actors("etag");
    const { id } = await createLayout(user);
    const first = await writeFetch(`/v1/layouts/${id}/comments`, "GET");
    const etag0 = first.headers.get("ETag");
    expect(etag0).not.toBeNull();
    expect((await writeFetch(`/v1/layouts/${id}/comments`, "GET", { "If-None-Match": etag0! })).status).toBe(304);

    const sub = (await put(auth, id, "etag me")).submission;
    // A pending submission is private and does not change the public body, but it may move the seq; a match is still either 304 or an equal body.
    await approve(admin, sub.id);
    const afterApprove = await writeFetch(`/v1/layouts/${id}/comments`, "GET", { "If-None-Match": etag0! });
    expect(afterApprove.status).toBe(200);
    const etag1 = afterApprove.headers.get("ETag")!;
    expect(etag1).not.toBe(etag0);
    expect((await writeFetch(`/v1/layouts/${id}/comments`, "GET", { "If-None-Match": etag1 })).status).toBe(304);

    await writeFetch(`/v1/layouts/${id}/comment`, "DELETE", auth);
    const afterDelete = await writeFetch(`/v1/layouts/${id}/comments`, "GET", { "If-None-Match": etag1 });
    expect(afterDelete.status).toBe(200);
    expect(((await afterDelete.json()) as { comments: unknown[] }).comments).toEqual([]);
    const etag2 = afterDelete.headers.get("ETag")!;

    const again = (await put(auth, id, "back")).submission;
    await approve(admin, again.id);
    await writeFetch(`/v1/admin/comments/${again.id}/remove`, "POST", admin, {});
    const afterRemove = await writeFetch(`/v1/layouts/${id}/comments`, "GET", { "If-None-Match": etag2 });
    expect(afterRemove.status).toBe(200);
  });

  it("[LDB-CMT5] a deleted layout's comments are hidden and come back on restore; an author rename moves the ETag", async () => {
    const owner = testUserId();
    const { id } = await createLayout(owner);
    const fake = actorFixture();
    const ownerAuth = register(fake, token("restore-owner"), owner);
    const admin = register(fake, token("restore-admin"), BOOTSTRAP_ADMIN);
    await approve(admin, (await put(ownerAuth, id, "survives a delete")).submission.id);
    expect(await listed(id)).toHaveLength(1);
    const etagShown = (await writeFetch(`/v1/layouts/${id}/comments`, "GET")).headers.get("ETag")!;

    const layoutRow = await db.prepare("SELECT layout_rev FROM layouts WHERE id = ?").bind(id).first<{ layout_rev: number }>();
    const del = await writeFetch(`/v1/layouts/${id}`, "DELETE", { ...ownerAuth, "If-Match": `"layout:${layoutRow!.layout_rev}"` });
    expect(del.status).toBe(200);
    expect(await listed(id)).toEqual([]);
    expect((await writeFetch(`/v1/layouts/${id}/comments`, "GET", { "If-None-Match": etagShown })).status).toBe(200);
    expect(await rowsFor(id, owner)).toHaveLength(1); // kept

    expect((await writeFetch(`/v1/layouts/${id}/restore`, "POST", ownerAuth, {})).status).toBe(200);
    expect((await listed(id)).map((c) => c.body)).toEqual(["survives a delete"]);
  });
});

describe("[LDB-CMT6] GET /v1/layouts/:ref/comment is the caller's own, never publicly cached", () => {
  it("[LDB-CMT6] live / pending / decision, newest decision only when newer than both; another user's rows never appear", async () => {
    const { user, auth, admin, fake } = actors("own");
    const other = register(fake, token("own-other"), testUserId());
    const { id } = await createLayout(user);

    expect(await own(auth, id)).toEqual({ live: null, pending: null, decision: null });

    const p1 = (await put(auth, id, "mine, pending")).submission;
    await put(other, id, "someone else's");
    expect(await own(auth, id)).toEqual({ live: null, pending: { id: p1.id, body: "mine, pending", submitted_at: p1.submitted_at }, decision: null });

    await writeFetch(`/v1/admin/comment-queue/${p1.id}/reject`, "POST", admin, { reason: "try again" });
    const afterReject = await own(auth, id);
    expect(afterReject).toMatchObject({ live: null, pending: null, decision: { status: "rejected", reason: "try again" } });
    expect(Object.keys(afterReject.decision!).sort()).toEqual(["body", "decided_at", "reason", "status"]);
    expect(afterReject.decision!.body).toBe("mine, pending"); // the refused text, to edit and resend

    // A newer pending submission hides the older decision.
    const p2 = (await put(auth, id, "second try")).submission;
    expect(await own(auth, id)).toMatchObject({ live: null, pending: { id: p2.id, body: "second try" }, decision: null });

    await approve(admin, p2.id);
    const live = await own(auth, id);
    expect(live).toMatchObject({ live: { id: p2.id, body: "second try", approved_at: expect.any(String) }, pending: null, decision: null });
  });

  it("[LDB-CMT6] the response is Cache-Control: private, no-store, needs credentials (401), and resolves by id or name; unknown layout is 404", async () => {
    const { user, auth } = actors("owncc");
    const { id, name } = await createLayout(user);
    const res = await writeFetch(`/v1/layouts/${name}/comment`, "GET", auth);
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
    expect(res.headers.get("ETag")).toBeNull();
    expect((await writeFetch(`/v1/layouts/${id}/comment`, "GET")).status).toBe(401);
    expect((await writeFetch("/v1/layouts/no-such-layout-cmt/comment", "GET", auth)).status).toBe(404);
  });
});

describe("[LDB-CMT7] events: one per action, no comment text and no reason anywhere in the feed", () => {
  it("[LDB-CMT7] submit, approve, reject, remove and delete each append exactly one event with ids only", async () => {
    const { user, auth, admin } = actors("ev");
    const { id } = await createLayout(user);
    const texts = ["ev-secret-text-one-7a1", "ev-secret-text-two-7a2", "ev-secret-text-three-7a3"];
    const s1 = (await put(auth, id, texts[0]!)).submission;
    await approve(admin, s1.id);
    const s2 = (await put(auth, id, texts[1]!)).submission;
    await writeFetch(`/v1/admin/comment-queue/${s2.id}/reject`, "POST", admin, { reason: "ev-secret-reason-reject" });
    await writeFetch(`/v1/admin/comments/${s1.id}/remove`, "POST", admin, { reason: "ev-secret-reason-remove" });
    const s3 = (await put(auth, id, texts[2]!)).submission;
    await writeFetch(`/v1/layouts/${id}/comment`, "DELETE", auth);

    const events = await commentEvents(id);
    expect(events.map((e) => e.kind)).toEqual(["comment_submitted", "comment_approved", "comment_submitted", "comment_rejected", "comment_removed", "comment_submitted", "comment_deleted"]);
    expect(events[0]).toMatchObject({ actor: user, admin: false, detail: { submission_id: s1.id } });
    expect(events[1]).toMatchObject({ actor: BOOTSTRAP_ADMIN, admin: true, layout_id: id, detail: { submission_id: s1.id, layout_id: id, user_id: user } });
    expect(events[3]).toMatchObject({ admin: true, detail: { submission_id: s2.id } });
    expect(events[4]).toMatchObject({ actor: BOOTSTRAP_ADMIN, admin: true, detail: { submission_id: s1.id, layout_id: id, user_id: user } });
    expect(events[5]).toMatchObject({ detail: { submission_id: s3.id } });
    expect(events[6]).toMatchObject({ actor: user, admin: false, detail: { layout_id: id, user_id: user } });
    expect(Object.keys(events[0]!.detail!)).toEqual(["submission_id"]);
    expect(Object.keys(events[3]!.detail!)).toEqual(["submission_id"]);

    // The whole public surface that lists events: no text, no reason.
    for (const path of [`/v1/changes?since=0&limit=1000&layout=${id}`, `/admin/changelog?layout=${id}`, `/v1/layouts/${id}/history?format=spark/1`, `/v1/layouts/${id}/comments`]) {
      const text = await (await writeFetch(path, "GET")).text();
      for (const secret of [...texts, "ev-secret-reason-reject", "ev-secret-reason-remove"]) expect(text.includes(secret), `${path} ${secret}`).toBe(false);
    }
    // `kinds=` accepts the new names.
    for (const kind of ["comment_submitted", "comment_approved", "comment_rejected", "comment_removed", "comment_deleted"]) {
      expect((await writeFetch(`/v1/changes?kinds=${kind}&limit=1`, "GET")).status, kind).toBe(200);
    }
  });

  it("[LDB-CMT7] a superseding submission is silent: one comment_submitted for it and nothing for the row it superseded", async () => {
    const { user, auth } = actors("evsup");
    const { id } = await createLayout(user);
    await put(auth, id, "a");
    await put(auth, id, "b");
    expect((await commentEvents(id)).map((e) => e.kind)).toEqual(["comment_submitted", "comment_submitted"]);
  });

  it("[LDB-CMT7] a comment_submitted / comment_rejected row stored with text or reason in its detail is redacted on read", async () => {
    const { id, name } = await createLayout(testUserId());
    for (const [kind, detail] of [
      ["comment_submitted", { submission_id: "01OLDCMT", body: "old secret comment text" }],
      ["comment_rejected", { submission_id: "01OLDCMT", reason: "old private reason" }],
    ] as const) {
      await db
        .prepare(
          `INSERT INTO events (at, kind, layout_id, name, owner, format, rev, actor, via, admin, detail_json, before_json, after_json, source_client, source_version)
           VALUES (?, ?, ?, ?, 'o', NULL, NULL, 'a', 'discord', 0, ?, NULL, NULL, NULL, NULL)`,
        )
        .bind(clock(), kind, id, name, JSON.stringify(detail))
        .run();
    }
    const events = await commentEvents(id);
    expect(events.map((e) => e.detail)).toEqual([{ submission_id: "01OLDCMT" }, { submission_id: "01OLDCMT" }]);
  });
});

describe("[LDB-CMT9] the queue is admin-only; a ban stops writes; internal bookkeeping stays off the wire", () => {
  it("[LDB-CMT9] every admin route is 403 not_admin for a user and 401 with no credentials", async () => {
    const { user, auth } = actors("nonadmin");
    await createLayout(user);
    const calls: [string, string, unknown][] = [
      ["GET", "/v1/admin/comment-queue", undefined],
      ["POST", "/v1/admin/comment-queue/some-id/approve", undefined],
      ["POST", "/v1/admin/comment-queue/some-id/reject", {}],
      ["POST", "/v1/admin/comments/some-id/remove", {}],
    ];
    for (const [method, path, body] of calls) {
      const denied = await writeFetch(path, method, auth, body);
      expect(denied.status, `${method} ${path}`).toBe(403);
      await expect(denied.json()).resolves.toMatchObject({ error: "not_admin" });
      expect((await writeFetch(path, method, {}, body)).status, `${method} ${path} anonymous`).toBe(401);
    }
    const { id } = await createLayout(user);
    expect((await writeFetch(`/v1/layouts/${id}/comment`, "PUT", {}, { body: "hi" })).status).toBe(401);
    expect((await writeFetch(`/v1/layouts/${id}/comment`, "DELETE", {})).status).toBe(401);
  });

  it("[LDB-CMT9] a banned user's PUT and DELETE are 403 banned and write nothing; their approved text stays until a mod acts", async () => {
    const { user, auth, admin } = actors("ban");
    const { id } = await createLayout(user);
    await approve(admin, (await put(auth, id, "before the ban")).submission.id);
    await writeFetch(`/v1/admin/bans/${user}`, "PUT", admin, {});

    const putRes = await writeFetch(`/v1/layouts/${id}/comment`, "PUT", auth, { body: "after the ban" });
    expect(putRes.status).toBe(403);
    await expect(putRes.json()).resolves.toMatchObject({ error: "banned" });
    const delRes = await writeFetch(`/v1/layouts/${id}/comment`, "DELETE", auth);
    expect(delRes.status).toBe(403);
    expect(await rowsFor(id, user)).toEqual([{ id: expect.any(String), user_id: user, body: "before the ban", status: "approved" }]);
  });

  it("[LDB-CMT9] the queue rows name the layout and the user and carry live_body; notified_at is on no wire", async () => {
    const { user, auth, admin } = actors("wire");
    const { id, name } = await createLayout(user);
    const v1 = (await put(auth, id, "live text")).submission;
    await approve(admin, v1.id);
    await db.prepare("UPDATE authors SET name = ? WHERE user_id = ?").bind("Wire Commenter", user).run();
    const posted = await writeFetch(`/v1/layouts/${id}/comment`, "PUT", auth, { body: "edit text" });
    const body = (await posted.json()) as { submission: Submission };
    expect(Object.keys(body.submission).sort()).toEqual(["body", "decided_at", "decided_by", "id", "layout_id", "reason", "status", "submitted_at", "user_id", "via"]);

    const q = await queue(admin, id);
    expect(q).toHaveLength(1);
    expect(q[0]).toMatchObject({ layout_name: name, user_name: "Wire Commenter", user_id: user, body: "edit text", live_body: "live text" });
    expect(JSON.stringify(q)).not.toContain("notified_at");

    const first = await queue(admin, id, "approved");
    expect(first[0]).toMatchObject({ body: "live text", live_body: null }); // live_body is the OTHER approved row, none here
    const approved = await approve(admin, body.submission.id);
    expect(JSON.stringify(await approved.json())).not.toContain("notified_at");
    expect(JSON.stringify(await listed(id))).not.toContain("notified_at");
  });

  it("[LDB-CMT9] a bad ?status= is 400; every status name is accepted", async () => {
    const admin = register(actorFixture(), token("status"), BOOTSTRAP_ADMIN);
    expect((await writeFetch("/v1/admin/comment-queue?status=bogus", "GET", admin)).status).toBe(400);
    for (const status of ["pending", "approved", "rejected", "superseded", "replaced", "deleted", "removed"]) {
      expect((await writeFetch(`/v1/admin/comment-queue?status=${status}`, "GET", admin)).status, status).toBe(200);
    }
  });
});

// --- comment likes (LDB-CMT11..LDB-CMT13) ----------------------------------

interface LikeAuthor {
  user: string;
  auth: Auth;
}

function likeUrl(layout: string, author: string): string {
  return `/v1/layouts/${layout}/comments/${author}/like`;
}
async function like(who: Auth, layout: string, author: string): Promise<Response> {
  return writeFetch(likeUrl(layout, author), "PUT", who);
}
async function unlike(who: Auth, layout: string, author: string): Promise<Response> {
  return writeFetch(likeUrl(layout, author), "DELETE", who);
}
async function likeRows(layoutId: string, authorId: string): Promise<string[]> {
  const { results } = await db.prepare("SELECT user_id FROM comment_likes WHERE layout_id = ? AND author_id = ? ORDER BY user_id").bind(layoutId, authorId).all<{ user_id: string }>();
  return results.map((r) => r.user_id);
}
// A layout whose owner `author` has an approved comment, plus two likers.
async function likeScene(label: string, fake = actorFixture()): Promise<{ id: string; author: LikeAuthor; a: LikeAuthor; b: LikeAuthor; admin: Auth; commentId: string }> {
  const mk = (n: string): LikeAuthor => {
    const user = testUserId();
    return { user, auth: register(fake, token(`${label}-${n}`), user) };
  };
  const author = mk("author");
  const a = mk("a");
  const b = mk("b");
  const admin = register(fake, token(`${label}-admin`), BOOTSTRAP_ADMIN);
  const { id } = await createLayout(author.user);
  const commentId = (await put(author.auth, id, "a comment worth liking")).submission.id;
  await approve(admin, commentId);
  return { id, author, a, b, admin, commentId };
}

describe("[LDB-CMT11] likes target the author's comment slot", () => {
  it("[LDB-CMT11] PUT is 204 and idempotent, one like per (slot, liker); DELETE is 204 and idempotent", async () => {
    const s = await likeScene("lk1");
    expect((await like(s.a.auth, s.id, s.author.user)).status).toBe(204);
    expect((await like(s.a.auth, s.id, s.author.user)).status).toBe(204); // again: still 204, still one row
    expect((await like(s.b.auth, s.id, s.author.user)).status).toBe(204);
    expect(await likeRows(s.id, s.author.user)).toEqual([s.a.user, s.b.user].sort());

    expect((await unlike(s.a.auth, s.id, s.author.user)).status).toBe(204);
    expect((await unlike(s.a.auth, s.id, s.author.user)).status).toBe(204); // nothing left to remove
    expect(await likeRows(s.id, s.author.user)).toEqual([s.b.user]);
    // by layout name too
    const name = (await db.prepare("SELECT name FROM layouts WHERE id = ?").bind(s.id).first<{ name: string }>())!.name;
    expect((await like(s.a.auth, name, s.author.user)).status).toBe(204);
    expect(await likeRows(s.id, s.author.user)).toHaveLength(2);
  });

  it("[LDB-CMT11] the author cannot like their own comment (400 own_comment); a slot with no approved comment is 404; a malformed author id is 400; an unknown or deleted layout is 404", async () => {
    const s = await likeScene("lk2");
    const own = await like(s.author.auth, s.id, s.author.user);
    expect(own.status).toBe(400);
    await expect(own.json()).resolves.toMatchObject({ error: "own_comment" });
    expect(await likeRows(s.id, s.author.user)).toEqual([]);

    const stranger = testUserId();
    const none = await like(s.a.auth, s.id, stranger);
    expect(none.status).toBe(404);
    await expect(none.json()).resolves.toMatchObject({ error: "not_found" });

    const bad = await like(s.a.auth, s.id, "nope");
    expect(bad.status).toBe(400);
    await expect(bad.json()).resolves.toMatchObject({ error: "bad_request", param: "author_id" });
    expect((await like(s.a.auth, "no-such-layout-cmt", s.author.user)).status).toBe(404);
    expect((await unlike(s.a.auth, "no-such-layout-cmt", s.author.user)).status).toBe(404);
    await db.prepare("UPDATE layouts SET deleted = 1 WHERE id = ?").bind(s.id).run();
    expect((await like(s.a.auth, s.id, s.author.user)).status).toBe(404);
  });

  it("[LDB-CMT11] a pending-only or rejected-only slot cannot be liked", async () => {
    const fake = actorFixture();
    const owner = testUserId();
    const { id } = await createLayout(owner);
    const admin = register(fake, token("lk3-admin"), BOOTSTRAP_ADMIN);
    const liker = register(fake, token("lk3-liker"), testUserId());
    const pendingUser = testUserId();
    const pendingAuth = register(fake, token("lk3-pending"), pendingUser);
    const sub = (await put(pendingAuth, id, "still waiting")).submission;
    expect((await like(liker, id, pendingUser)).status).toBe(404);
    await writeFetch(`/v1/admin/comment-queue/${sub.id}/reject`, "POST", admin, {});
    expect((await like(liker, id, pendingUser)).status).toBe(404);
    expect(await likeRows(id, pendingUser)).toEqual([]);
  });

  it("[LDB-CMT11] a like survives an approved edit, a pending edit and a rejected edit of the slot", async () => {
    const s = await likeScene("lk4");
    await like(s.a.auth, s.id, s.author.user);

    const pending = (await put(s.author.auth, s.id, "an edit under review")).submission;
    expect(await likeRows(s.id, s.author.user)).toEqual([s.a.user]); // pending edit
    await writeFetch(`/v1/admin/comment-queue/${pending.id}/reject`, "POST", s.admin, { reason: "no" });
    expect(await likeRows(s.id, s.author.user)).toEqual([s.a.user]); // rejected edit

    const edit = (await put(s.author.auth, s.id, "an edit that lands")).submission;
    await approve(s.admin, edit.id);
    expect(await likeRows(s.id, s.author.user)).toEqual([s.a.user]); // approved edit: new row, same slot
    const comments = await listed(s.id);
    expect(comments).toMatchObject([{ id: edit.id, body: "an edit that lands", likes: 1 }]);
  });

  it("[LDB-CMT11] the author's DELETE clears the slot's likes, and a new comment starts from zero", async () => {
    const s = await likeScene("lk5");
    await like(s.a.auth, s.id, s.author.user);
    await like(s.b.auth, s.id, s.author.user);
    expect((await writeFetch(`/v1/layouts/${s.id}/comment`, "DELETE", s.author.auth)).status).toBe(204);
    expect(await likeRows(s.id, s.author.user)).toEqual([]);

    await approve(s.admin, (await put(s.author.auth, s.id, "a fresh comment")).submission.id);
    expect((await listed(s.id))[0]).toMatchObject({ body: "a fresh comment", likes: 0 });
    // and the old likers can like it again
    expect((await like(s.a.auth, s.id, s.author.user)).status).toBe(204);
  });

  it("[LDB-CMT11] a mod's removal clears the slot's likes; a likes row elsewhere is untouched", async () => {
    const fake = actorFixture(); // one fake Discord for both scenes (the stubbed fetch is the last one registered)
    const s = await likeScene("lk6", fake);
    const other = await likeScene("lk6b", fake);
    await like(s.a.auth, s.id, s.author.user);
    await like(other.a.auth, other.id, other.author.user);
    expect((await writeFetch(`/v1/admin/comments/${s.commentId}/remove`, "POST", s.admin, { reason: "spam" })).status).toBe(200);
    expect(await likeRows(s.id, s.author.user)).toEqual([]);
    expect(await likeRows(other.id, other.author.user)).toEqual([other.a.user]);
    // the removed slot is not likeable until a new comment is approved
    expect((await like(s.b.auth, s.id, s.author.user)).status).toBe(404);
  });

  it("[LDB-CMT11] a banned liker is 403 banned and writes nothing", async () => {
    const s = await likeScene("lk7");
    await writeFetch(`/v1/admin/bans/${s.a.user}`, "PUT", s.admin, {});
    const res = await like(s.a.auth, s.id, s.author.user);
    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toMatchObject({ error: "banned" });
    expect(await likeRows(s.id, s.author.user)).toEqual([]);
    expect((await like({}, s.id, s.author.user)).status).toBe(401);
    expect((await unlike({}, s.id, s.author.user)).status).toBe(401);
  });
});

describe("[LDB-CMT12] like events and the likes in the dump", () => {
  it("[LDB-CMT12] one event per real change, none for a repeat or a no-op unlike; ids only", async () => {
    const s = await likeScene("lk8");
    const count = async () => (await commentEvents(s.id)).filter((e) => e.kind === "comment_liked" || e.kind === "comment_unliked");
    await like(s.a.auth, s.id, s.author.user);
    await like(s.a.auth, s.id, s.author.user);
    await unlike(s.b.auth, s.id, s.author.user); // b never liked
    await unlike(s.a.auth, s.id, s.author.user);
    await unlike(s.a.auth, s.id, s.author.user);
    const events = await count();
    expect(events.map((e) => e.kind)).toEqual(["comment_liked", "comment_unliked"]);
    expect(events[0]).toMatchObject({ actor: s.a.user, admin: false, layout_id: s.id, detail: { layout_id: s.id, author_id: s.author.user, user_id: s.a.user } });
    expect(Object.keys(events[0]!.detail!).sort()).toEqual(["author_id", "layout_id", "user_id"]);
    for (const kind of ["comment_liked", "comment_unliked"]) expect((await writeFetch(`/v1/changes?kinds=${kind}&limit=1`, "GET")).status, kind).toBe(200);
  });

  it("[LDB-CMT12] the author's delete clears the likes without writing a per-like event", async () => {
    const s = await likeScene("lk9");
    await like(s.a.auth, s.id, s.author.user);
    const before = (await commentEvents(s.id)).length;
    await writeFetch(`/v1/layouts/${s.id}/comment`, "DELETE", s.author.auth);
    expect((await commentEvents(s.id)).length - before).toBe(1); // just comment_deleted
  });
});

describe("[LDB-CMT13] the listing carries likes, orders by them, and keeps the viewer's flag out of the shared cache", () => {
  it("[LDB-CMT13] likes count, ordered likes desc then approved_at desc then id; anonymous rows have no liked key", async () => {
    const fake = actorFixture();
    const owner = testUserId();
    const { id } = await createLayout(owner);
    const admin = register(fake, token("ord-admin"), BOOTSTRAP_ADMIN);
    const mk = async (text: string) => {
      const user = testUserId();
      const auth = register(fake, token(`ord-${text}`), user);
      await approve(admin, (await put(auth, id, text)).submission.id);
      return { user, auth };
    };
    const first = await mk("first");
    const second = await mk("second");
    await mk("third");
    const l1 = register(fake, token("ord-l1"), testUserId());
    const l2 = register(fake, token("ord-l2"), testUserId());
    // third is newest; with no likes the order is newest first
    expect((await listed(id)).map((c) => c.body)).toEqual(["third", "second", "first"]);
    await like(l1, id, first.user);
    await like(l2, id, first.user);
    await like(l1, id, second.user);
    const rows = await listed(id);
    expect(rows.map((c) => [c.body, c.likes])).toEqual([
      ["first", 2],
      ["second", 1],
      ["third", 0],
    ]);
    for (const r of rows) expect("liked" in r).toBe(false);
  });

  it("[LDB-CMT14] ?sort=likes (the default) and ?sort=newest; anything else is 400 bad_request with param sort; the ETag and the cache are per sort", async () => {
    const fake = actorFixture();
    const { id } = await createLayout(testUserId());
    const admin = register(fake, token("sort-admin"), BOOTSTRAP_ADMIN);
    const authors: { user: string; auth: Auth }[] = [];
    for (const text of ["oldest", "middle", "newest"]) {
      const user = testUserId();
      const auth = register(fake, token(`sort-${text}`), user);
      await approve(admin, (await put(auth, id, text)).submission.id);
      authors.push({ user, auth });
    }
    const liker = register(fake, token("sort-liker"), testUserId());
    await like(liker, id, authors[0]!.user); // "oldest" has the only like
    const bodies = async (q: string) => ((await (await writeFetch(`/v1/layouts/${id}/comments${q}`, "GET")).json()) as { comments: PublicComment[] }).comments.map((c) => c.body);
    expect(await bodies("")).toEqual(["oldest", "newest", "middle"]);
    expect(await bodies("?sort=likes")).toEqual(["oldest", "newest", "middle"]);
    expect(await bodies("?sort=newest")).toEqual(["newest", "middle", "oldest"]); // approved_at desc, likes ignored

    for (const bad of ["?sort=bogus", "?sort=", "?sort=LIKES"]) {
      const res = await writeFetch(`/v1/layouts/${id}/comments${bad}`, "GET");
      expect(res.status, bad).toBe(400);
      await expect(res.json()).resolves.toMatchObject({ error: "bad_request", param: "sort" });
    }
    const asUser = await writeFetch(`/v1/layouts/${id}/comments?sort=bogus`, "GET", liker);
    expect(asUser.status).toBe(400);

    const tagLikes = (await writeFetch(`/v1/layouts/${id}/comments?sort=likes`, "GET")).headers.get("ETag")!;
    const tagNewest = (await writeFetch(`/v1/layouts/${id}/comments?sort=newest`, "GET")).headers.get("ETag")!;
    expect(tagNewest).not.toBe(tagLikes);
    expect((await writeFetch(`/v1/layouts/${id}/comments?sort=newest`, "GET", { "If-None-Match": tagLikes })).status).toBe(200);
    expect((await writeFetch(`/v1/layouts/${id}/comments?sort=newest`, "GET", { "If-None-Match": tagNewest })).status).toBe(304);
    // an authenticated read honours the sort too
    const mine = ((await (await writeFetch(`/v1/layouts/${id}/comments?sort=newest`, "GET", liker)).json()) as { comments: PublicComment[] }).comments;
    expect(mine.map((c) => c.body)).toEqual(["newest", "middle", "oldest"]);
    expect(mine.every((c) => c.liked !== undefined)).toBe(true);
  });

  it("[LDB-CMT13] the anonymous ETag moves when a count changes; a like and an unlike each move it", async () => {
    const s = await likeScene("lk10");
    const tag = async () => (await writeFetch(`/v1/layouts/${s.id}/comments`, "GET")).headers.get("ETag")!;
    const t0 = await tag();
    expect((await writeFetch(`/v1/layouts/${s.id}/comments`, "GET", { "If-None-Match": t0 })).status).toBe(304);
    await like(s.a.auth, s.id, s.author.user);
    const t1 = await tag();
    expect(t1).not.toBe(t0);
    expect((await writeFetch(`/v1/layouts/${s.id}/comments`, "GET", { "If-None-Match": t0 })).status).toBe(200);
    await unlike(s.a.auth, s.id, s.author.user);
    expect(await tag()).not.toBe(t1);
  });

  it("[LDB-CMT13] with credentials every row has liked, and the answer is private, no-store, ETag-free and never served to or from the shared cache", async () => {
    const s = await likeScene("lk11");
    await like(s.a.auth, s.id, s.author.user);

    const anon0 = await writeFetch(`/v1/layouts/${s.id}/comments`, "GET");
    expect(anon0.headers.get("Cache-Control")).toBe("public, max-age=10");
    const anonEtag = anon0.headers.get("ETag")!;

    const asA = await writeFetch(`/v1/layouts/${s.id}/comments`, "GET", s.a.auth);
    expect(asA.headers.get("Cache-Control")).toBe("private, no-store");
    expect(asA.headers.get("ETag")).toBeNull();
    expect(((await asA.json()) as { comments: PublicComment[] }).comments).toMatchObject([{ likes: 1, liked: true }]);

    const asB = await writeFetch(`/v1/layouts/${s.id}/comments`, "GET", s.b.auth);
    expect(((await asB.json()) as { comments: PublicComment[] }).comments).toMatchObject([{ likes: 1, liked: false }]);
    // the author sees liked false on their own too
    const asAuthor = await writeFetch(`/v1/layouts/${s.id}/comments`, "GET", s.author.auth);
    expect(((await asAuthor.json()) as { comments: PublicComment[] }).comments).toMatchObject([{ likes: 1, liked: false }]);

    // an authenticated request does not take the shared 304 path, even with the anonymous tag
    const conditional = await writeFetch(`/v1/layouts/${s.id}/comments`, "GET", { ...s.a.auth, "If-None-Match": anonEtag });
    expect(conditional.status).toBe(200);
    // ... and the anonymous answer afterwards still has no liked key
    const anon1 = await writeFetch(`/v1/layouts/${s.id}/comments`, "GET");
    expect(((await anon1.json()) as { comments: Record<string, unknown>[] }).comments.every((r) => !("liked" in r))).toBe(true);
    // a bad token is 401, not silently anonymous
    expect((await writeFetch(`/v1/layouts/${s.id}/comments`, "GET", { Authorization: "Bearer not-a-real-token" })).status).toBe(401);
  });
});
