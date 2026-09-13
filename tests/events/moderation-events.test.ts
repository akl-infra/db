// [LDB-MD7] L5 moderation (design/akldb-site/01-plan.md §4): every
// moderation action is exactly one event, `admin: 1`, `via`/`source` the
// actor's own lane -- `appendAdmin` (bans, author-rename), `appendModeration`
// (link_rejected) and `appendLinkChange` (the layout-scoped writer that
// also touches `layouts` itself) all carry it through, extending LDB-A5.
// (H24, 2026-09-13: `appendLikeAdjust`/`admin.likes_set` were removed with
// the admin like-count override -- this file no longer covers them.)
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { Bindings } from "../../src/env";
import { appendAdmin, appendLinkChange, appendModeration, commitWrite, rowToEvent, type CommitInput, type EventDbRow } from "../../src/core/events";
import { fixedClock } from "../../src/core/time";
import { ulid } from "ulidx";

const db = (env as unknown as Bindings).DB;
const clock = fixedClock("2026-09-12T00:00:00.000Z");
const SOURCE = { client: "client:mod-events-test", version: "1.2.3" };

async function createLayout(owner = "mod-events-owner"): Promise<string> {
  const input: CommitInput = {
    layoutId: ulid(),
    creating: true,
    currentN: 0,
    currentLayout: null,
    currentFormats: new Map(),
    layout: { kind: "created", name: `mod-events-${ulid()}`, owner, created_at: clock(), deleted: false },
    format: { kind: "format_added", lineage: "spark", format: "spark/1", payload: { keys: {} }, hasMagic: false },
    modified_at: clock(),
    actor: owner,
    via: "discord",
    source: { client: "discord-app:test", version: null },
    upstream: null,
  };
  const { layout } = await commitWrite(db, clock, input);
  return layout.id;
}

async function lastEvent(seq: number): Promise<ReturnType<typeof rowToEvent>> {
  const row = await db.prepare("SELECT * FROM events WHERE seq = ?").bind(seq).first<EventDbRow>();
  if (row === null) throw new Error("no such event");
  return rowToEvent(row);
}

describe("[LDB-MD7] every moderation writer carries the actor's own lane", () => {
  it("[LDB-MD7] appendAdmin: via/source default to the pre-L5 hard-coded values when omitted (existing callers unchanged)", async () => {
    const { seq } = await appendAdmin(db, clock, { kind: "admin.added", actor: "someone" });
    const e = await lastEvent(seq);
    expect(e.via).toBe("discord");
    expect(e.admin).toBe(true);
    expect(e.source).toEqual({ client: "legacy:discord", version: null });
  });

  it("[LDB-MD7] appendAdmin: via/source, when given, are the actor's own -- admin.user_banned/admin.user_unbanned", async () => {
    const { seq: bannedSeq } = await appendAdmin(db, clock, {
      kind: "admin.user_banned",
      actor: "an-admin",
      via: "client:bot-1",
      source: SOURCE,
      detail: { user_id: "target-1", reason: null },
    });
    const banned = await lastEvent(bannedSeq);
    expect(banned.admin).toBe(true);
    expect(banned.via).toBe("client:bot-1");
    expect(banned.source).toEqual(SOURCE);
    expect(banned.layout_id).toBeNull();
    expect(banned.rev).toBeNull();
  });

  it("[LDB-MD7] appendModeration: layout-scoped, admin: 1, rev NULL, via/source the actor's own -- link_rejected", async () => {
    const layoutId = await createLayout();
    const { seq } = await appendModeration(db, clock, {
      kind: "link_rejected",
      layoutId,
      actor: "an-admin",
      via: "discord",
      source: SOURCE,
      detail: { submission_id: "sub-1", reason: "spam" },
    });
    const e = await lastEvent(seq);
    expect(e.admin).toBe(true);
    expect(e.rev).toBeNull();
    expect(e.layout_id).toBe(layoutId);
    expect(e.via).toBe("discord");
    expect(e.source).toEqual(SOURCE);
    expect(e.detail).toEqual({ submission_id: "sub-1", reason: "spam" });
  });

  it("[LDB-MD7] appendLinkChange: layout-scoped, admin flag reflects the caller, via/source the actor's own, after carries link", async () => {
    const layoutId = await createLayout();
    const { seq } = await appendLinkChange(db, clock, {
      layoutId,
      kind: "link_approved",
      link: "https://example.org/x",
      actor: "an-admin",
      via: "discord",
      admin: true,
      source: SOURCE,
    });
    const e = await lastEvent(seq);
    expect(e.kind).toBe("link_approved");
    expect(e.admin).toBe(true);
    expect(e.rev).toBeNull();
    expect(e.via).toBe("discord");
    expect(e.source).toEqual(SOURCE);
    expect(e.after).toEqual({ scope: "link", link: "https://example.org/x" });
  });

  it("[LDB-MD7] every moderation action is exactly ONE event -- appendLinkChange never appends a second row", async () => {
    const layoutId = await createLayout();
    const before = await db.prepare("SELECT COUNT(*) AS n FROM events").first<{ n: number }>();
    await appendLinkChange(db, clock, { layoutId, kind: "link_approved", link: "https://example.org/one-event", actor: "an-admin", via: "discord", admin: true, source: SOURCE });
    const afterLink = await db.prepare("SELECT COUNT(*) AS n FROM events").first<{ n: number }>();
    expect((afterLink?.n ?? 0) - (before?.n ?? 0)).toBe(1);
  });
});
