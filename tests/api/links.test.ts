// [LDB-MD5] [LDB-MD6] L5 moderation (design/akldb-site/01-plan.md §4.4):
// `link` + its moderation queue. Black-box via SELF.fetch, same pattern
// tests/api/moderation.test.ts uses for bans/likes/authors.
import { env, store, testStore } from "../harness";
import { afterEach, describe, expect, it, vi } from "vitest";
import { commitWrite, type CommitInput } from "../../src/core/events";
import { fixedClock } from "../../src/core/time";
import { ulid } from "ulidx";
import { AKL_PAYLOAD, BOOTSTRAP_ADMIN, actorFixture, pinTestClock, register, uniqueName, writeFetch } from "./write-support";

const clock = fixedClock("2026-09-12T00:00:00.000Z");
pinTestClock(env as unknown as { TEST_CLOCK?: typeof clock }, clock);

afterEach(() => {
  vi.unstubAllGlobals();
});

function adminHeaders(token: string) {
  const fake = actorFixture();
  return register(fake, token, BOOTSTRAP_ADMIN);
}

let idCounter = 0;
function testUserId(): string {
  idCounter++;
  return `32000000000000${String(idCounter).padStart(3, "0")}`;
}

function ownerHeaders(token: string, id: string) {
  const fake = actorFixture();
  return register(fake, token, id);
}

async function createLayout(owner: string, name = uniqueName("link-layout")): Promise<{ id: string; name: string }> {
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
  const { layout } = await commitWrite(store, clock, input);
  return { id: layout.id, name: layout.name };
}

describe("[LDB-MD5] only an approved link appears on a public wire", () => {
  it("[LDB-MD5] a pending submission never shows on GET /v1/layouts/:ref or the plain list", async () => {
    const owner = testUserId();
    const { id, name } = await createLayout(owner);
    const ownerAuth = ownerHeaders("tok-link-owner-1", owner);

    const submit = await writeFetch(`/v1/layouts/${id}/link`, "PUT", ownerAuth, { url: "https://example.org/pending" });
    expect(submit.status).toBe(202);
    const submitBody = (await submit.json()) as { submission: { status: string; url: string } };
    expect(submitBody.submission).toMatchObject({ status: "pending", url: "https://example.org/pending" });

    const detail = await writeFetch(`/v1/layouts/${name}?format=spark/1`, "GET");
    const detailBody = (await detail.json()) as { link: string | null };
    expect(detailBody.link).toBeNull();

    const list = await writeFetch(`/v1/layouts?format=spark/1&limit=1000`, "GET");
    const listBody = (await list.json()) as { items: { name: string; link?: string | null }[] };
    const row = listBody.items.find((i) => i.name === name);
    expect(row?.link ?? null).toBeNull();
  });

  it("[LDB-MD5] an approved link shows on the layout detail and list; rejecting a later resubmission leaves it untouched", async () => {
    const owner = testUserId();
    const { id, name } = await createLayout(owner);
    // Both actors share ONE FakeDiscord/global-fetch-stub: `actorFixture()`
    // stubs global fetch anew every call, so a second call would silently
    // orphan the first actor's token for the rest of this test.
    const fake = actorFixture();
    const ownerAuth = register(fake, "tok-link-owner-2", owner);
    const admin = register(fake, "tok-link-admin-2", BOOTSTRAP_ADMIN);

    await writeFetch(`/v1/layouts/${id}/link`, "PUT", ownerAuth, { url: "https://example.org/first" });
    const queueRes = await writeFetch("/v1/admin/link-queue?status=pending", "GET", admin);
    const queue = (await queueRes.json()) as { submissions: { id: string; layout_id: string }[] };
    const submissionId = queue.submissions.find((s) => s.layout_id === id)!.id;

    const approve = await writeFetch(`/v1/admin/link-queue/${submissionId}/approve`, "POST", admin);
    expect(approve.status).toBe(200);
    await expect(approve.json()).resolves.toEqual({ link: "https://example.org/first" });

    const detail = await writeFetch(`/v1/layouts/${name}?format=spark/1`, "GET");
    await expect(detail.json()).resolves.toMatchObject({ link: "https://example.org/first" });

    // A new submission after approval is queued, but does not touch the
    // already-approved public link until IT is decided.
    await writeFetch(`/v1/layouts/${id}/link`, "PUT", ownerAuth, { url: "https://example.org/second" });
    const stillFirst = await writeFetch(`/v1/layouts/${name}?format=spark/1`, "GET");
    await expect(stillFirst.json()).resolves.toMatchObject({ link: "https://example.org/first" });

    const queue2 = (await (await writeFetch("/v1/admin/link-queue?status=pending", "GET", admin)).json()) as { submissions: { id: string; layout_id: string }[] };
    const secondId = queue2.submissions.find((s) => s.layout_id === id)!.id;
    const reject = await writeFetch(`/v1/admin/link-queue/${secondId}/reject`, "POST", admin, { reason: "not relevant" });
    expect(reject.status).toBe(200);
    const rejectBody = (await reject.json()) as { submission: { status: string; reason: string | null } };
    expect(rejectBody.submission).toMatchObject({ status: "rejected", reason: "not relevant" });

    // The approved link is unaffected by the rejection of a LATER submission.
    const stillFirst2 = await writeFetch(`/v1/layouts/${name}?format=spark/1`, "GET");
    await expect(stillFirst2.json()).resolves.toMatchObject({ link: "https://example.org/first" });
  });

  it("[LDB-MD5] [LDB-MD6] an admin's own PUT is queued like an owner's: 202, pending, not on the public wire, in the queue; the admin approves it in the Inbox", async () => {
    const owner = testUserId();
    const { id, name } = await createLayout(owner);
    const admin = adminHeaders("tok-link-admin-3");

    const res = await writeFetch(`/v1/layouts/${id}/link`, "PUT", admin, { url: "https://example.org/admin-direct" });
    expect(res.status).toBe(202);
    const { submission } = (await res.json()) as { submission: { id: string; status: string; url: string; submitted_by: string } };
    expect(submission).toMatchObject({ status: "pending", url: "https://example.org/admin-direct" });

    const detail = await writeFetch(`/v1/layouts/${name}?format=spark/1`, "GET");
    await expect(detail.json()).resolves.toMatchObject({ link: null });

    const queue = (await (await writeFetch("/v1/admin/link-queue?status=pending", "GET", admin)).json()) as { submissions: { id: string; layout_id: string }[] };
    expect(queue.submissions.filter((s) => s.layout_id === id).map((s) => s.id)).toEqual([submission.id]);

    expect((await writeFetch(`/v1/admin/link-queue/${submission.id}/approve`, "POST", admin)).status).toBe(200);
    const after = await writeFetch(`/v1/layouts/${name}?format=spark/1`, "GET");
    await expect(after.json()).resolves.toMatchObject({ link: "https://example.org/admin-direct" });
  });

  it("clearing an approved link removes it from the public wire", async () => {
    const owner = testUserId();
    const { id, name } = await createLayout(owner);
    const fake = actorFixture();
    const ownerAuth = register(fake, "tok-link-owner-4", owner);
    const admin = register(fake, "tok-link-admin-4", BOOTSTRAP_ADMIN);
    await writeFetch(`/v1/layouts/${id}/link`, "PUT", ownerAuth, { url: "https://example.org/toclear" });
    const queue = (await (await writeFetch("/v1/admin/link-queue?status=pending", "GET", admin)).json()) as { submissions: { id: string; layout_id: string }[] };
    const submissionId = queue.submissions.find((s) => s.layout_id === id)!.id;
    await writeFetch(`/v1/admin/link-queue/${submissionId}/approve`, "POST", admin);

    const clear = await writeFetch(`/v1/layouts/${id}/link`, "DELETE", ownerAuth);
    expect(clear.status).toBe(200);
    await expect(clear.json()).resolves.toEqual({ link: null });

    const detail = await writeFetch(`/v1/layouts/${name}?format=spark/1`, "GET");
    await expect(detail.json()).resolves.toMatchObject({ link: null });
  });
});

describe("[LDB-MD6] at most one pending submission per layout", () => {
  it("[LDB-MD16] competing link approvals have one atomic winner and one event", async () => {
    const owner = testUserId();
    const { id } = await createLayout(owner);
    const fake = actorFixture();
    const ownerAuth = register(fake, "tok-link-race-owner", owner);
    const admin = register(fake, "tok-link-race-admin", BOOTSTRAP_ADMIN);
    const competingAdminId = testUserId();
    await testStore.insert("admins", { user_id: competingAdminId, added_at: clock() });
    const competingAdmin = register(fake, "tok-link-race-admin-2", competingAdminId);
    await writeFetch(`/v1/layouts/${id}/link`, "PUT", ownerAuth, { url: "https://example.org/race" });
    const queue = (await (await writeFetch("/v1/admin/link-queue?status=pending", "GET", admin)).json()) as { submissions: { id: string; layout_id: string }[] };
    const submissionId = queue.submissions.find((s) => s.layout_id === id)!.id;

    const results = await Promise.all([
      writeFetch(`/v1/admin/link-queue/${submissionId}/approve`, "POST", admin),
      writeFetch(`/v1/admin/link-queue/${submissionId}/approve`, "POST", competingAdmin),
    ]);
    expect(results.map((response) => response.status).sort()).toEqual([200, 404]);
    const row = await testStore.row<{ status: string }>("link_submissions", { id: submissionId });
    const events = await testStore.count("events", { layout_id: id, kind: "link_approved" });
    const layout = await testStore.row<{ link: string | null }>("layouts", { id });
    expect(row?.status).toBe("approved");
    expect(events).toBe(1);
    expect(layout?.link).toBe("https://example.org/race");
  });

  it("[LDB-MD6] a fresh owner submission supersedes the layout's existing pending one", async () => {
    const owner = testUserId();
    const { id } = await createLayout(owner);
    const fake = actorFixture();
    const ownerAuth = register(fake, "tok-link-supersede-1", owner);
    const admin = register(fake, "tok-link-supersede-admin", BOOTSTRAP_ADMIN);

    await writeFetch(`/v1/layouts/${id}/link`, "PUT", ownerAuth, { url: "https://example.org/one" });
    await writeFetch(`/v1/layouts/${id}/link`, "PUT", ownerAuth, { url: "https://example.org/two" });

    const rows = (await testStore.rows<{ url: string; status: string }>("link_submissions", { layout_id: id }, ["submitted_at", "url"])).map((r) => ({ url: r.url, status: r.status }));
    expect(rows).toEqual([
      { url: "https://example.org/one", status: "superseded" },
      { url: "https://example.org/two", status: "pending" },
    ]);

    const pendingOnly = (await (await writeFetch("/v1/admin/link-queue?status=pending", "GET", admin)).json()) as { submissions: { layout_id: string; url: string }[] };
    const mine = pendingOnly.submissions.filter((s) => s.layout_id === id);
    expect(mine.map((s) => s.url)).toEqual(["https://example.org/two"]);
  });

  it("[LDB-MD6] approving a submission also supersedes any other still-pending one for that layout", async () => {
    const owner = testUserId();
    const { id } = await createLayout(owner);
    const admin = adminHeaders("tok-link-supersede-2");
    // Two admin-side approvals in a row both go through appendLinkChange's
    // own sweep -- the second must not leave a stray pending row behind
    // from a hypothetical race; simulate by inserting a pending row
    // directly, then submitting a fresh one via the normal PUT (admin lane: queued too).
    await testStore.insert("link_submissions", { id: ulid(), layout_id: id, url: "https://example.org/stray-pending", submitted_by: owner, submitted_at: clock(), status: "pending" });

    await writeFetch(`/v1/layouts/${id}/link`, "PUT", admin, { url: "https://example.org/admin-approved" });
    const nextPending = await testStore.row<{ status: string }>("link_submissions", { layout_id: id, url: "https://example.org/admin-approved" });
    expect(nextPending?.status).toBe("pending");

    const stray = await testStore.row<{ status: string }>("link_submissions", { layout_id: id, url: "https://example.org/stray-pending" });
    expect(stray?.status).toBe("superseded");
  });
});

describe("link ownership and error shapes", () => {
  it("a stranger gets 403 not_owner on GET/PUT/DELETE", async () => {
    const owner = testUserId();
    const stranger = testUserId();
    const { id } = await createLayout(owner);
    const strangerAuth = ownerHeaders("tok-link-stranger", stranger);
    expect((await writeFetch(`/v1/layouts/${id}/link`, "GET", strangerAuth)).status).toBe(403);
    expect((await writeFetch(`/v1/layouts/${id}/link`, "PUT", strangerAuth, { url: "https://example.org/x" })).status).toBe(403);
    expect((await writeFetch(`/v1/layouts/${id}/link`, "DELETE", strangerAuth)).status).toBe(403);
  });

  it("an unknown layout is 404 not_found", async () => {
    const owner = testUserId();
    const auth = ownerHeaders("tok-link-404", owner);
    expect((await writeFetch("/v1/layouts/no-such-layout-xyz/link", "GET", auth)).status).toBe(404);
  });

  it("a non-https url is 400 invalid_link", async () => {
    const owner = testUserId();
    const { id } = await createLayout(owner);
    const auth = ownerHeaders("tok-link-invalid", owner);
    const res = await writeFetch(`/v1/layouts/${id}/link`, "PUT", auth, { url: "ftp://example.org/x" });
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ error: "invalid_link" });
  });

  it("approving/rejecting an unknown submission id is 404 not_found", async () => {
    const admin = adminHeaders("tok-link-queue-404");
    expect((await writeFetch("/v1/admin/link-queue/nonexistent/approve", "POST", admin)).status).toBe(404);
    expect((await writeFetch("/v1/admin/link-queue/nonexistent/reject", "POST", admin, {})).status).toBe(404);
  });
});

// [LDB-MD13] A non-approved submission is private to admins: its url and a
// rejection's reason never reach the public event feed -- not for events
// written from now on, and not for rows stored before the fix (redacted on
// read, nothing rewritten).
describe("[LDB-MD13] the public feed carries no non-approved link content", () => {
  const SECRET_URL = "https://example.org/md13-pending-secret";
  const SECRET_REASON = "md13 private moderator reason";

  async function publicTexts(layoutId: string): Promise<string[]> {
    const paths = [`/v1/changes?since=0&limit=1000&layout=${layoutId}`, `/v1/changes?since=0&limit=1000`, `/admin/changelog?layout=${layoutId}`];
    return Promise.all(paths.map(async (p) => (await writeFetch(p, "GET")).text()));
  }

  it("[LDB-MD13] link_submitted and link_rejected expose only the submission id; the admin queue still shows url and reason", async () => {
    const owner = testUserId();
    const { id } = await createLayout(owner);
    const fake = actorFixture();
    const ownerAuth = register(fake, "tok-md13-owner", owner);
    const admin = register(fake, "tok-md13-admin", BOOTSTRAP_ADMIN);

    const submitted = (await (await writeFetch(`/v1/layouts/${id}/link`, "PUT", ownerAuth, { url: SECRET_URL })).json()) as { submission: { id: string } };
    await writeFetch(`/v1/admin/link-queue/${submitted.submission.id}/reject`, "POST", admin, { reason: SECRET_REASON });

    const feed = (await (await writeFetch(`/v1/changes?since=0&limit=1000&layout=${id}`, "GET")).json()) as { items: { kind: string; detail: unknown }[] };
    const byKind = Object.fromEntries(feed.items.map((e) => [e.kind, e.detail]));
    expect(byKind.link_submitted).toEqual({ submission_id: submitted.submission.id });
    expect(byKind.link_rejected).toEqual({ submission_id: submitted.submission.id });
    for (const text of await publicTexts(id)) {
      expect(text).not.toContain(SECRET_URL);
      expect(text).not.toContain(SECRET_REASON);
    }

    // The queue (admin) is where they are read.
    const rejected = (await (await writeFetch("/v1/admin/link-queue?status=rejected", "GET", admin)).json()) as { submissions: { id: string; url: string; reason: string }[] };
    expect(rejected.submissions.find((s) => s.id === submitted.submission.id)).toMatchObject({ url: SECRET_URL, reason: SECRET_REASON });
  });

  it("[LDB-MD13] events stored BEFORE the fix (url / reason in detail_json) are redacted on read; an approved link's event is untouched", async () => {
    const owner = testUserId();
    const { id, name } = await createLayout(owner);
    const insert = (kind: string, detail: object | null) =>
      testStore.insert("events", {
        at: clock(),
        kind,
        layout_id: id,
        name,
        owner,
        format: null,
        rev: null,
        actor: owner,
        via: "discord",
        admin: 0,
        detail_json: detail === null ? null : JSON.stringify(detail),
        before_json: null,
        after_json: null,
        source_client: null,
        source_version: null,
      });
    await insert("link_submitted", { submission_id: "01OLDSUBMISSION", url: SECRET_URL });
    await insert("link_rejected", { submission_id: "01OLDSUBMISSION", reason: SECRET_REASON });
    await insert("link_submitted", { url: SECRET_URL }); // no id at all
    await insert("link_submitted", null);
    await insert("link_approved", { submission_id: "01OLDSUBMISSION" });

    const feed = (await (await writeFetch(`/v1/changes?since=0&limit=1000&layout=${id}`, "GET")).json()) as { items: { kind: string; detail: unknown }[] };
    expect(feed.items.filter((e) => e.kind === "link_submitted").map((e) => e.detail)).toEqual([{ submission_id: "01OLDSUBMISSION" }, null, null]);
    expect(feed.items.find((e) => e.kind === "link_rejected")?.detail).toEqual({ submission_id: "01OLDSUBMISSION" });
    expect(feed.items.find((e) => e.kind === "link_approved")?.detail).toEqual({ submission_id: "01OLDSUBMISSION" });
    for (const text of await publicTexts(id)) {
      expect(text).not.toContain(SECRET_URL);
      expect(text).not.toContain(SECRET_REASON);
    }
  });
});

describe("[LDB-MD5] the admin link queue names the layout and the submitter", () => {
  it("[LDB-MD5] rows carry layout_name and submitter_name (null with no author row) beside the existing fields", async () => {
    const owner = testUserId();
    const { id, name } = await createLayout(owner);
    const fake = actorFixture();
    const ownerAuth = register(fake, "tok-linkq-names-owner", owner);
    const admin = register(fake, "tok-linkq-names-admin", BOOTSTRAP_ADMIN);
    await writeFetch(`/v1/layouts/${id}/link`, "PUT", ownerAuth, { url: "https://example.org/names" });
    await testStore.patch("authors", { user_id: owner }, { name: "Link Owner" });

    const queue = (await (await writeFetch("/v1/admin/link-queue?status=pending", "GET", admin)).json()) as { submissions: Record<string, unknown>[] };
    const row = queue.submissions.find((s) => s.layout_id === id)!;
    expect(row).toMatchObject({ layout_name: name, submitter_name: "Link Owner", url: "https://example.org/names", status: "pending" });
    expect(Object.keys(row).sort()).toEqual(["decided_at", "decided_by", "id", "layout_id", "layout_name", "reason", "status", "submitted_at", "submitted_by", "submitter_name", "url"]);
  });
});
