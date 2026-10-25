// [LDB-MD18] Private rejection Discord DMs: atomic winner/enqueue,
// durable lease fencing, nonce retry suppression, and public dump exclusion.
import { env, store, testStore } from "../harness";
import { pick } from "./store-support";
import { describe, expect, it } from "vitest";
import { ulid } from "ulidx";
import type { Actor } from "../../src/auth/actor";
import { approveComment, rejectComment, reopenComment, deleteOwnComment } from "../../src/core/comments";
import { rejectSubmission } from "../../src/core/links";
import { buildApprovalDmMessage, buildRejectionDmMessage, dispatchRejectionDms } from "../../src/core/rejection-dm";
import { approveWpm, rejectWpm } from "../../src/core/wpm";
import type { Bindings } from "../../src/env";
import { buildDump } from "../../src/dump/write";
import { restoreSql } from "../../src/dump/restore";

const bindingsDb = (env as unknown as Bindings).DB;
const actor: Actor = {
  user_id: "900000000000000001", name: "moderator", via: "discord", admin: true, banned: false,
  source_client: "discord-app:test",
};
const t0 = "2026-10-18T00:00:00.000Z";
const clock = () => t0;
const recipient = "900000000000000002";
const ids = { layout: "", comment: "", link: "", wpm: "" };

async function setup(): Promise<string> {
  // This file intentionally tests queued rows across several dispatches;
  // start each case with no delivery work left by the previous case.
  await testStore.remove("discord_rejection_dm_outbox", {});
  const layoutId = ulid();
  const name = `dm-test-${layoutId.toLowerCase()}`;
  await testStore.insert("layouts", { id: layoutId, name, owner: actor.user_id, n: 1, layout_rev: 1, created_at: t0, modified_at: t0 });
  const commentId = ulid();
  const linkId = ulid();
  const wpmId = ulid();
  await testStore.insert("layout_comments", { id: commentId, layout_id: layoutId, user_id: recipient, body: "private text", via: "discord", submitted_at: t0, status: "pending" });
  await testStore.insert("link_submissions", { id: linkId, layout_id: layoutId, url: "https://example.org/submitted-link", submitted_by: recipient, submitted_at: t0, status: "pending" });
  await testStore.insert("wpm_submissions", { id: wpmId, layout_id: layoutId, user_id: recipient, wpm: 84, proof: "https://example.org/proof", submitted_by: recipient, via: "discord", submitted_at: t0, status: "pending" });
  ids.layout = layoutId;
  ids.comment = commentId;
  ids.link = linkId;
  ids.wpm = wpmId;
  return layoutId;
}

async function outbox(id: string) {
  return testStore.row<Record<string, unknown>>("discord_rejection_dm_outbox", { submission_id: id });
}

describe("[LDB-MD18] rejection DM outbox", () => {
  it("atomically appends exactly one winning rejection event and optional private outbox row for each domain", async () => {
    const layoutId = await setup();
    await rejectComment(store, clock, actor, null, ids.comment, "Please revise", { notifySubmitter: true });
    await rejectSubmission(store, clock, actor, null, ids.link, "Needs a canonical URL", { notifySubmitter: true });
    await rejectWpm(store, clock, actor, null, ids.wpm, "Proof is unclear", { notifySubmitter: true });

    const rows = { results: await testStore.rows<Record<string, unknown>>("discord_rejection_dm_outbox", {}, ["kind"]) };
    expect(rows.results).toHaveLength(3);
    expect(rows.results?.map((r) => r.kind).sort()).toEqual(["comment", "link", "wpm"]);
    expect(rows.results?.every((r) => r.recipient_id === recipient && typeof r.event_seq === "number" && String(r.nonce).length === 24)).toBe(true);
    for (const id of [ids.comment, ids.link, ids.wpm]) {
      const row = await outbox(id);
      expect(row?.event_seq).toBeTypeOf("number");
      const event = pick<Record<string, unknown>>(await testStore.row("events", { seq: row?.event_seq }), "kind", "actor", "via", "admin");
      expect(event).toMatchObject({ actor: actor.user_id, via: "discord", admin: 1 });
    }
    const eventCount = (await testStore.rows<{ kind: string }>("events", { layout_id: layoutId })).filter((e) => /^.+rejected$/s.test(e.kind)).length;
    expect(eventCount).toBe(3);
  });

  it("defaults quiet, never creates an approval DM, and a losing concurrent decision cannot duplicate the event or outbox", async () => {
    await setup();
    const raceId = ulid();
    await testStore.insert("link_submissions", { id: raceId, layout_id: ids.layout, url: "https://example.org/race", submitted_by: recipient, submitted_at: t0, status: "pending" });
    const results = await Promise.allSettled([
      rejectSubmission(store, clock, actor, null, raceId, undefined, { notifySubmitter: true }),
      rejectSubmission(store, clock, actor, null, raceId, undefined, { notifySubmitter: true }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
    expect(await outbox(raceId)).not.toBeNull();
    const events = (await testStore.rows<{ detail_json: string | null }>("events", { kind: "link_rejected" })).filter((e) => (e.detail_json ?? "").includes(raceId)).length;
    expect(events).toBe(1);

    const quietId = ulid();
    await testStore.insert("link_submissions", { id: quietId, layout_id: ids.layout, url: "https://example.org/quiet", submitted_by: recipient, submitted_at: t0, status: "pending" });
    await rejectSubmission(store, clock, actor, null, quietId);
    expect(await outbox(quietId)).toBeNull();

    const approvalId = ulid();
    await testStore.insert("wpm_submissions", { id: approvalId, layout_id: ids.layout, user_id: recipient, wpm: 90, proof: "https://example.org/proof", submitted_by: recipient, via: "discord", submitted_at: t0, status: "pending" });
    const { approveWpm } = await import("../../src/core/wpm");
    await approveWpm(store, clock, actor, null, approvalId);
    expect(await outbox(approvalId)).toBeNull();
    const priorRejected = pick<{ status: string }>(await testStore.row("link_submissions", { id: raceId }), "status");
    expect(priorRejected?.status).toBe("rejected");

    await testStore.remove("discord_rejection_dm_outbox", {});
    const historicalId = ulid();
    await testStore.insert("link_submissions", { id: historicalId, layout_id: ids.layout, url: "https://example.org/old", submitted_by: recipient, submitted_at: t0, status: "rejected", decided_by: actor.user_id, decided_at: t0 });
    let historicalFetches = 0;
    await dispatchRejectionDms(store, { DB: bindingsDb, MODQUEUE_DISCORD_DMS: "true", MODQUEUE_DISCORD_BOT_TOKEN: "test-only-token" }, clock, async () => {
      historicalFetches++;
      return Response.json({ id: "900000000000000101" });
    });
    expect(historicalFetches).toBe(0);
  });

  it("reclaims an expired lease once under concurrent drainers", async () => {
    await setup();
    await rejectSubmission(store, clock, actor, null, ids.link, undefined, { notifySubmitter: true });
    await testStore.patch("discord_rejection_dm_outbox", { submission_id: ids.link }, { status: "leased", lease_token: "crashed-worker", lease_until: "2026-10-17T23:59:00.000Z" });
    let messagePosts = 0;
    const fakeFetch: typeof fetch = async (input) => {
      if (String(input).endsWith("/users/@me/channels")) return Response.json({ id: "900000000000000101" });
      messagePosts++;
      await Promise.resolve();
      return Response.json({ id: "900000000000000102" });
    };
    const bindings = { DB: bindingsDb, MODQUEUE_DISCORD_DMS: "true", MODQUEUE_DISCORD_BOT_TOKEN: "test-only-token", DISCORD_API_URL: "https://discord.test/api" };
    await Promise.all([
      dispatchRejectionDms(store, bindings, clock, fakeFetch),
      dispatchRejectionDms(store, bindings, clock, fakeFetch),
    ]);
    expect(messagePosts).toBe(1);
    expect((await outbox(ids.link))?.status).toBe("sent");
  });

  it("sends safe content with allowed_mentions disabled and stable enforced nonce; retries a 429, terminally records blocked DMs", async () => {
    await setup();
    await rejectComment(store, clock, actor, null, ids.comment, "@everyone revise *this*", { notifySubmitter: true });
    const payloads: Array<Record<string, unknown>> = [];
    let first = true;
    const fakeFetch: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.endsWith("/users/@me/channels")) return Response.json({ id: "900000000000000101" });
      if (url.endsWith("/messages")) {
        const payload = JSON.parse(String(init?.body)) as Record<string, unknown>;
        payloads.push(payload);
        if (first) { first = false; return new Response(JSON.stringify({ retry_after: 300 }), { status: 429 }); }
        return Response.json({ id: "900000000000000102" });
      }
      throw new Error(`unexpected URL ${url}`);
    };
    const bindings = { DB: bindingsDb, MODQUEUE_DISCORD_DMS: "true", MODQUEUE_DISCORD_BOT_TOKEN: "test-only-token", DISCORD_API_URL: "https://discord.test/api" };
    expect(await dispatchRejectionDms(store, bindings, clock, fakeFetch)).toMatchObject({ sent: 0, retried: 1 });
    const scheduled = await outbox(ids.comment);
    expect(scheduled?.status).toBe("pending");
    expect(scheduled?.next_attempt_at).toBe("2026-10-18T00:05:00.000Z");

    const later = () => "2026-10-18T00:06:00.000Z";
    expect(await dispatchRejectionDms(store, bindings, later, fakeFetch)).toMatchObject({ sent: 1 });
    expect(payloads).toHaveLength(2);
    expect(payloads[0]?.nonce).toBe(payloads[1]?.nonce);
    expect(payloads[0]?.enforce_nonce).toBe(true);
    expect(payloads[0]?.allowed_mentions).toEqual({ parse: [] });
    const textContent = (payload: Record<string, unknown>) => (payload.components as Array<{ content?: string }> | undefined)?.map((component) => component.content ?? "").join("") ?? String(payload.content);
    expect(textContent(payloads[0]!)).not.toContain("@everyone");
    expect(textContent(payloads[0]!)).not.toContain("*this*");
    expect(textContent(payloads[0]!)).toContain("was not approved.");
    expect(textContent(payloads[0]!)).toContain("https://akldb.org/l/");
    expect((await outbox(ids.comment))?.status).toBe("sent");

    const linkId = ulid();
    await testStore.insert("link_submissions", { id: linkId, layout_id: ids.layout, url: "https://example.org/blocked", submitted_by: recipient, submitted_at: t0, status: "pending" });
    await rejectSubmission(store, clock, actor, null, linkId, undefined, { notifySubmitter: true });
    const blockedFetch: typeof fetch = async (input) => String(input).endsWith("/users/@me/channels")
      ? Response.json({ id: "900000000000000101" })
      : Response.json({ code: 50007, message: "Cannot send messages to this user" }, { status: 403 });
    expect(await dispatchRejectionDms(store, bindings, later, blockedFetch)).toMatchObject({ terminal: 1 });
    expect((await outbox(linkId))?.status).toBe("blocked");
  });

  it("expires erased comments, marks a crash retry uncertain after the nonce window, and excludes outbox from public dump/restore", async () => {
    await setup();
    await rejectComment(store, clock, actor, null, ids.comment, undefined, { notifySubmitter: true });
    await testStore.patch("layout_comments", { id: ids.comment }, { body: null });
    let calls = 0;
    const fakeFetch: typeof fetch = async () => { calls++; throw new Error("network unavailable"); };
    const bindings = { DB: bindingsDb, MODQUEUE_DISCORD_DMS: "true", MODQUEUE_DISCORD_BOT_TOKEN: "test-only-token", DISCORD_API_URL: "https://discord.test/api" };
    await expect(dispatchRejectionDms(store, bindings, clock, fakeFetch)).resolves.toMatchObject({ terminal: 1 });
    expect(calls).toBe(0);
    expect((await outbox(ids.comment))?.status).toBe("expired");

    const wpmId = ulid();
    await testStore.insert("wpm_submissions", { id: wpmId, layout_id: ids.layout, user_id: recipient, wpm: 81, proof: "https://example.org/proof", submitted_by: recipient, via: "discord", submitted_at: t0, status: "pending" });
    await rejectWpm(store, clock, actor, null, wpmId, undefined, { notifySubmitter: true });
    let messagePost = false;
    const ambigFetch: typeof fetch = async (input) => {
      if (String(input).endsWith("/users/@me/channels")) return Response.json({ id: "900000000000000101" });
      messagePost = true;
      throw new Error("connection lost after request may have reached Discord");
    };
    await dispatchRejectionDms(store, bindings, clock, ambigFetch);
    expect(messagePost).toBe(true);
    const uncertainTime = () => "2026-10-18T00:03:00.000Z";
    await dispatchRejectionDms(store, bindings, uncertainTime, async (input) => {
      if (String(input).endsWith("/users/@me/channels")) return Response.json({ id: "900000000000000101" });
      throw new Error("must not blindly resend a message beyond the nonce window");
    });
    expect((await outbox(wpmId))?.status).toBe("uncertain");

    const dump = await buildDump(env as unknown as Bindings, clock);
    expect(JSON.stringify(dump)).not.toContain("discord_rejection_dm_outbox");
    expect(Object.keys(dump)).not.toContain("discord_rejection_dm_outbox");
    expect(restoreSql(dump).join("\n")).not.toContain("INSERT INTO discord_rejection_dm_outbox");
  });

  it("[LDB-MD18] renderer strips mention and formatting injection", () => {
    const text = JSON.stringify(buildRejectionDmMessage({ kind: "link", layoutName: "@everyone *hi*", layoutUrl: "javascript:alert(1)", reason: "<@123>\n`hello` [click](https://evil.example)", context: "Link submission" }));
    expect(text).not.toContain("@everyone");
    expect(text).not.toContain("<@123>");
    expect(text).not.toContain("javascript:");
    expect(text).not.toContain("[click]");
    expect(text).not.toContain("https://evil.example");
    expect(text).toContain("https://akldb.org");
  });

  it("[LDB-MQ-DM2] a WPM rejection is the comment card: intro, the submitted speed and proof quoted, then the reason and the layout link", () => {
    const { payload } = buildRejectionDmMessage({ kind: "wpm", layoutName: "opal", layoutUrl: "https://akldb.org/l/01M2CZGR0RYXNCB777GPZGGBFN", reason: "liar", context: "WPM submission", wpm: 108, proof: "https://discord.com/channels/1/2/3" });
    expect(payload.flags).toBe(1 << 15);
    expect(payload.allowed_mentions).toEqual({ parse: [] });
    expect(payload.components!.map((c) => c.content)).toEqual([
      "Your WPM record submission for **opal** was not approved.",
      "> **108 WPM** · proof: <https://discord.com/channels/1/2/3>",
      "**Reason:** liar\nhttps://akldb.org/l/01M2CZGR0RYXNCB777GPZGGBFN",
    ]);
  });

  it("[LDB-MQ-DM2] a link rejection quotes the submitted link; an unsafe submitted URL or proof is left out, never rendered", () => {
    const link = buildRejectionDmMessage({ kind: "link", layoutName: "opal", layoutUrl: "https://akldb.org/l/X", reason: null, context: "Link submission", linkUrl: "https://example.test/opal" });
    expect(link.payload.components!.map((c) => c.content)).toEqual(["Your link submission for **opal** was not approved.", "> <https://example.test/opal>", "**Reason:** No reason was provided.\nhttps://akldb.org/l/X"]);
    for (const bad of ["javascript:alert(1)", "https://x.test/a b", "https://x.test/a>@everyone", "not a url"]) {
      const w = JSON.stringify(buildRejectionDmMessage({ kind: "wpm", layoutName: "opal", layoutUrl: "https://akldb.org/l/X", reason: "r", context: "WPM submission", wpm: 90, proof: bad }));
      expect(w, bad).toContain("**90 WPM**");
      expect(w, bad).not.toContain("proof:");
      const l = buildRejectionDmMessage({ kind: "link", layoutName: "opal", layoutUrl: "https://akldb.org/l/X", reason: "r", context: "Link submission", linkUrl: bad });
      expect(l.payload.components!.length, bad).toBe(2);
    }
  });

  it("includes the complete maximum comment with Markdown escaped and Unicode preserved", () => {
    const body = `${"*emoji 😅 [link](x) @everyone_".repeat(40)}${"x".repeat(840)}`;
    expect(Array.from(body).length).toBe(2000);
    const rendered = buildRejectionDmMessage({
      kind: "comment", layoutName: "Test", layoutUrl: "https://akldb.org/l/test", reason: "Please revise", context: "Comment submission", commentBody: body,
    });
    expect(rendered.attachmentText).toBeUndefined();
    const components = rendered.payload.components ?? [];
    const joined = components.map((component) => String(component.content ?? "")).join("");
    expect(joined).not.toContain("Rejected comment:");
    expect(joined).toContain("\\*emoji 😅 \\[link\\]\\(x\\) @everyone\\_");
    expect(joined).toContain("**Reason:** Please revise");
    expect(joined.length).toBeLessThanOrEqual(4000);
    expect(components.every((component) => String(component.content).length <= 1800)).toBe(true);
    const quotedBody = components.slice(1, -1).map((component) => String(component.content));
    expect(quotedBody.every((chunk) => chunk.startsWith("> "))).toBe(true);
    expect(quotedBody.map((chunk) => chunk.slice(2).replace(/\\([\\*_~|`>#\[\]()<>])/g, "$1")).join("")).toBe(body);
    expect(rendered.payload.allowed_mentions).toEqual({ parse: [] });
  });

  it("[LDB-MD19] uses Discord UTF-16 accounting for astral characters and keeps the full comment attached", () => {
    const body = "😅".repeat(2000);
    expect(Array.from(body).length).toBe(2000);
    expect(body.length).toBe(4000);
    const rendered = buildRejectionDmMessage({
      kind: "comment", layoutName: "Test", layoutUrl: "https://akldb.org/l/test", reason: null,
      context: "Comment submission", commentBody: body,
    });
    expect(rendered.attachmentText).toBe(body);
    expect(rendered.payload.components?.some((component) => String(component.content ?? "").includes(body))).toBe(false);
  });

  it("attaches the full plaintext comment when escaped content would exceed component limits", () => {
    const body = "*😀".repeat(2000);
    const rendered = buildRejectionDmMessage({
      kind: "comment", layoutName: "Test", layoutUrl: "https://akldb.org/l/test", reason: null, context: "Comment submission", commentBody: body,
    });
    expect(rendered.payload.components).toHaveLength(3);
    expect(rendered.payload.attachments).toEqual([{ id: 0, filename: "rejected-comment.txt" }]);
    expect(rendered.attachmentText).toBe(body);
    expect(rendered.payload.components?.[0]).toEqual({ type: 10, content: "Your comment submission for **Test** was not approved." });
    expect(rendered.payload.components?.[1]).toEqual({ type: 13, file: { url: "attachment://rejected-comment.txt" } });
    expect(String(rendered.payload.components?.[2]?.content)).toBe("**Reason:** No reason was provided.\nhttps://akldb.org/l/test");
  });

  it("[LDB-MD18] explains the outcome, quotes the comment, then gives the reason and layout link", () => {
    const body = "These layouts were part of a rollmaxxing test, do not use.";
    const rendered = buildRejectionDmMessage({
      kind: "comment", layoutName: "bemboo10", layoutUrl: "https://akldb.org/l/01M2CZ670ZTQMT2YQQR7ATH0J6",
      reason: "off topic", context: "Comment submission", commentBody: body,
    });
    expect(rendered.payload.components).toEqual([
      { type: 10, content: "Your comment submission for **bemboo10** was not approved." },
      { type: 10, content: `> ${body}` },
      { type: 10, content: "**Reason:** off topic\nhttps://akldb.org/l/01M2CZ670ZTQMT2YQQR7ATH0J6" },
    ]);
    expect(rendered.payload.allowed_mentions).toEqual({ parse: [] });
  });

  it("quotes each line including blank lines, and keeps submitted Markdown literal", () => {
    const rendered = buildRejectionDmMessage({
      kind: "comment", layoutName: "@everyone **Test**\n# fake", layoutUrl: "https://akldb.org/l/test",
      reason: "off topic", context: "Comment submission", commentBody: "first\n\n> nested *text*\nlast\n",
    });
    expect(rendered.payload.components?.[0]?.content).toBe("Your comment submission for **＠everyone Test # fake** was not approved.");
    expect(rendered.payload.components?.[1]?.content).toBe("> first\n> \n> \\> nested \\*text\\*\n> last\n> ");
    expect(rendered.payload.allowed_mentions).toEqual({ parse: [] });
  });

  it("counts introduction, multiline quote prefixes and continuation prefixes at the exact UTF-16 limit", () => {
    const input = {
      kind: "comment" as const, layoutName: "Test", layoutUrl: "https://akldb.org/l/test",
      reason: "off topic", context: "Comment submission",
    };
    const intro = "Your comment submission for **Test** was not approved.";
    const summary = "**Reason:** off topic\nhttps://akldb.org/l/test";
    // Three quote chunks: each newline adds two prefix characters, and each
    // component starts with two more. The raw comment remains under 2,000 chars.
    const body = "\n".repeat(1200) + "x".repeat(4000 - intro.length - summary.length - 3600 - 6);
    const rendered = buildRejectionDmMessage({ ...input, commentBody: body });
    expect(rendered.attachmentText).toBeUndefined();
    const components = rendered.payload.components ?? [];
    expect(components.reduce((length, component) => length + String(component.content).length, 0)).toBe(4000);
    expect(components.every((component) => String(component.content).length <= 1800)).toBe(true);
    expect(components.slice(1, -1).map((component) => String(component.content).slice(2).replace(/\n> /g, "\n")).join("")).toBe(body);
    const overLimit = buildRejectionDmMessage({ ...input, commentBody: body + "x" });
    expect(overLimit.attachmentText).toBe(body + "x");
  });
});

describe("[LDB-MD23] approval DMs", () => {
  it("[LDB-MD23] queues only winning opted-in approvals with event and history, and expires a reopened cycle", async () => {
    await setup();
    await approveComment(store, clock, actor, null, ids.comment, 0, true);
    await approveWpm(store, clock, actor, null, ids.wpm, 0, true);
    for (const id of [ids.comment, ids.wpm]) {
      const row = await outbox(id);
      expect(row).toMatchObject({ decision: "approval", status: "pending", review_version: 0, recipient_id: recipient });
      expect(String(row?.delivery_key)).toMatch(/^approval:/);
      expect(await testStore.row("events", { seq: row?.event_seq })).not.toBeNull();
      expect(pick(await testStore.row("moderation_review_history", { submission_id: id }), "action")).toEqual({ action: "approved" });
    }
    await expect(approveComment(store, clock, actor, null, ids.comment, 0, true)).rejects.toBeTruthy();
    expect(await testStore.count("discord_rejection_dm_outbox", { submission_id: ids.comment })).toBe(1);
    await reopenComment(store, clock, actor, null, ids.comment, { status: "approved", review_version: 0 });
    expect((await outbox(ids.comment))?.status).toBe("expired");
    await approveComment(store, clock, actor, null, ids.comment, 1, true);
    const deliveries = { results: await testStore.rows<{ delivery_key: string; nonce: string; status: string }>("discord_rejection_dm_outbox", { submission_id: ids.comment }, ["review_version"]) };
    expect(deliveries.results).toHaveLength(2);
    expect(deliveries.results[0]!.nonce).not.toBe(deliveries.results[1]!.nonce);
    expect(deliveries.results.map((r) => r.status)).toEqual(["expired", "pending"]);
  });

  it("[LDB-MD23] renders both cards, sends via the durable path, and stops an erased comment", async () => {
    await setup();
    const comment = buildApprovalDmMessage({ kind: "comment", layoutName: "Test", layoutUrl: "https://akldb.org/l/test", commentBody: "hello @everyone **there**" });
    expect(comment.payload.components?.map((c) => c.content)).toEqual([
      "Your comment on **Test** was approved.", "> hello @everyone \\*\\*there\\*\\*", "View the layout: <https://akldb.org/l/test>",
    ]);
    expect(comment.payload.allowed_mentions).toEqual({ parse: [] });
    const long = buildApprovalDmMessage({ kind: "comment", layoutName: "Test", layoutUrl: "https://akldb.org/l/test", commentBody: "x".repeat(4000) });
    expect(long.attachmentText).toHaveLength(4000);
    expect(long.payload.attachments?.[0]?.filename).toBe("approved-comment.txt");
    const wpm = buildApprovalDmMessage({ kind: "wpm", layoutName: "Test", layoutUrl: "https://akldb.org/l/test", wpm: 84, proof: "https://example.org/proof" });
    expect(wpm.payload.components?.map((c) => c.content)).toEqual([
      "Your WPM record for **Test** was approved.", "> **84 WPM** · proof: <https://example.org/proof>", "View the layout: <https://akldb.org/l/test>",
    ]);
    await approveWpm(store, clock, actor, null, ids.wpm, 0, true);
    await approveComment(store, clock, actor, null, ids.comment, 0, true);
    await deleteOwnComment(store, clock, { ...actor, user_id: recipient, admin: false }, null, ids.layout);
    const sent: Record<string, unknown>[] = [];
    const result = await dispatchRejectionDms(store, {
      DB: bindingsDb, MODQUEUE_DISCORD_DMS: "true", MODQUEUE_DISCORD_BOT_TOKEN: "test-only-token", DISCORD_API_URL: "https://discord.test/api",
    }, clock, async (url, init) => {
      if (String(url).endsWith("/users/@me/channels")) return Response.json({ id: "900000000000000101" });
      sent.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return Response.json({ id: "900000000000000102" });
    });
    expect(result).toEqual({ sent: 1, retried: 0, terminal: 1 });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.nonce).toHaveLength(24);
    expect(sent[0]?.allowed_mentions).toEqual({ parse: [] });
    expect((await outbox(ids.comment))?.status).toBe("expired");
    expect((await outbox(ids.wpm))?.status).toBe("sent");
  });
});
