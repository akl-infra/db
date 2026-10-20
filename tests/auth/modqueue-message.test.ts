import { describe, expect, it } from "vitest";
import { buildV2Payload, buildV2StatusPatch, DISCORD_COMPONENTS_V2_FLAG } from "../../src/core/modqueue-message";

function nested(components: unknown[]): Record<string, unknown>[] {
  return components.flatMap((component) => {
    if (component === null || typeof component !== "object") return [];
    const row = component as Record<string, unknown>;
    const children = Array.isArray(row.components) ? nested(row.components) : [];
    return [row, ...children];
  });
}

it("[LDB-WPM14] YouTube previews retain the V2 card, bounded text, original proof and independently gated controls", () => {
  const id = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
  const videoUrl = "https://www.youtube.com/watch?v=aBcD_123-45&t=60";
  const thumbnailUrl = "https://i.ytimg.com/vi/aBcD_123-45/hqdefault.jpg";
  for (const proof of ["https://youtu.be/aBcD_123-45?t=60", `https://youtube.com/watch?v=aBcD_123-45&extra=${"(".repeat(450)}`]) {
    const c = { id, layout_id: id, user_id: "900000000000000001", user_name: "*😀*".repeat(100),
      layout_name: "[😀](https://evil.test)".repeat(100), wpm: 100, proof, review_version: 3 };
    const initial = buildV2Payload("wpm", c, true, { kind: "youtube", videoUrl, thumbnailUrl });
    expect(initial.flags).toBe(DISCORD_COMPONENTS_V2_FLAG);
    expect(initial).not.toHaveProperty("content");
    expect(initial).not.toHaveProperty("embeds");
    const parts = nested(initial.components as unknown[]);
    expect(parts.find((p) => p.type === 12)?.items).toEqual([{ media: { url: thumbnailUrl }, description: "YouTube video thumbnail" }]);
    expect(parts.find((p) => p.id === 41011)?.content).toBe(`[Watch on YouTube](<${videoUrl}>)`);
    expect(parts.find((p) => p.id === 41004)?.content).toContain("[View proof]");
    for (const status of ["pending", "approved", "rejected"] as const) {
      const changed = buildV2StatusPatch(initial, "wpm", id, { status, review_version: 3,
        decider_name: "*😀*".repeat(100), reason: "😀".repeat(250) })!;
      const rows = nested(changed.components as unknown[]);
      expect(rows.reduce((sum, row) => sum + (typeof row.content === "string" ? row.content.length : 0), 0)).toBeLessThanOrEqual(4000);
      expect(rows.find((p) => p.type === 12)).toEqual(parts.find((p) => p.type === 12));
      expect(rows.find((p) => p.id === 41011)).toEqual(parts.find((p) => p.id === 41011));
      expect(changed.allowed_mentions).toEqual({ parse: [] });
      const disabled = buildV2StatusPatch(initial, "wpm", id, { status, decider_name: null, review_version: 3 }, false)!;
      expect(nested(disabled.components as unknown[]).filter((p) => p.type === 2).map((p) => p.label)).toEqual(["Open in akldb"]);
    }
  }
});

describe("[LDB-MD15] Components V2 mod-queue message", () => {
  it("[LDB-MD15] [LDB-MD16] renders link and WPM cards with safe links, exact action ids, and no invented speed duration; actions are independently gated", () => {
    const link = buildV2Payload("link", {
      id: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
      layout_id: "01BX5ZZKBKACTAV9WEVGEMMVRY",
      url: "https://example.org/a>b c",
      submitted_by: "900000000000000001",
      layout_name: "*layout*",
      submitter_name: "@everyone",
    });
    expect(link.flags).toBe(DISCORD_COMPONENTS_V2_FLAG);
    expect(link).not.toHaveProperty("content");
    expect(link).not.toHaveProperty("embeds");
    expect(link.allowed_mentions).toEqual({ parse: [] });
    const linkParts = nested(link.components as unknown[]);
    const card = (link.components as { components: Record<string, unknown>[] }[])[0]!;
    expect(card.components.map((c) => c.type)).toEqual([10, 10, 14, 10, 14, 1]);
    expect(JSON.stringify(link)).not.toContain("PENDING REVIEW");
    expect(linkParts.filter((c) => c.type === 14)).toHaveLength(2);
    expect(linkParts.filter((c) => c.type === 14).every((c) => c.divider === true)).toBe(true);
    const ids = linkParts.flatMap((c) => typeof c.id === "number" ? [c.id] : []);
    expect(new Set(ids).size).toBe(ids.length);
    expect(linkParts.find((c) => c.type === 10 && c.id === 41002)?.content).toContain("\\*layout\\*");
    expect(linkParts.find((c) => c.type === 10 && c.id === 41004)?.content).toContain("<https://example.org/a%3Eb%20c>");
    expect(linkParts.filter((c) => c.type === 2).map((c) => c.custom_id)).toEqual([
      "aklmod2|link|approve|01ARZ3NDEKTSV4RRFFQ69G5FAV|0",
      "aklmod2|link|deny|01ARZ3NDEKTSV4RRFFQ69G5FAV|0",
      undefined,
    ]);
    expect(linkParts.find((c) => c.type === 2 && c.style === 5)).toMatchObject({ label: "Open in akldb", url: "https://akldb.org/admin?tab=inbox" });

    const wpm = buildV2Payload("wpm", {
      id: "01ARZ3NDEKTSV4RRFFQ69G5FAA",
      layout_id: "01BX5ZZKBKACTAV9WEVGEMMVRY",
      user_id: "900000000000000002",
      wpm: 142,
      proof: "https://example.org/proof",
      layout_name: "graphite",
      user_name: "mira_dev",
    });
    const wpmBody = nested(wpm.components as unknown[]).find((c) => c.type === 10 && c.id === 41004)?.content as string;
    expect(wpmBody).toContain("142 WPM");
    expect(wpmBody).toContain("https://example.org/proof");
    expect(wpmBody).not.toMatch(/seconds|duration/i);
    expect(nested(wpm.components as unknown[]).filter((c) => c.type === 2).map((c) => c.custom_id)).toEqual([
      "aklmod2|wpm|approve|01ARZ3NDEKTSV4RRFFQ69G5FAA|0",
      "aklmod2|wpm|deny|01ARZ3NDEKTSV4RRFFQ69G5FAA|0",
      undefined,
    ]);

    const noActions = buildV2Payload("link", {
      id: "01ARZ3NDEKTSV4RRFFQ69G5FAE", layout_id: "01BX5ZZKBKACTAV9WEVGEMMVRY",
      url: "https://example.org/", submitted_by: "900000000000000006", layout_name: "layout", submitter_name: null,
    }, false);
    expect(nested(noActions.components as unknown[]).filter((c) => c.type === 2).map((c) => c.style)).toEqual([5]);
  });

  it("[LDB-MD21] keeps WPM context and proof intact through decisions and reopening without pending labels", () => {
    const id = "01ARZ3NDEKTSV4RRFFQ69G5FAA";
    const candidate = { id, layout_id: "01BX5ZZKBKACTAV9WEVGEMMVRY", user_id: "900000000000000002",
      wpm: 150, proof: "https://example.org/proof(a)\\b>x y<z", layout_name: "*bemboo10*", user_name: "mira_dev" };
    const initial = buildV2Payload("wpm", candidate);
    const rows = (card: Record<string, unknown>) => nested(card.components as unknown[]);
    const texts = (card: Record<string, unknown>) => rows(card).filter((row) => row.type === 10).map((row) => row.content);
    const context = "**WPM submission** on **[\\*bemboo10\\*](<https://akldb.org/l/01BX5ZZKBKACTAV9WEVGEMMVRY>)** by **mira\\_dev**";
    const proof = "**150 WPM** · [View proof](<https://example.org/proof%28a%29%5Cb%3Ex%20y%3Cz>)";
    expect(texts(initial)).toEqual([context, proof]);
    expect(JSON.stringify(initial)).not.toMatch(/Pending|PENDING|## /);
    expect(texts(initial).join(" ")).not.toContain(id);
    for (const status of ["approved", "rejected"] as const) {
      const decided = buildV2StatusPatch(initial, "wpm", id, { status, decider_name: "mod*name", reason: "Wrong *layout*", review_version: 2 })!;
      expect(texts(decided)).toEqual([context, proof, status === "approved"
        ? "**✅ Approved** · by mod\\*name" : "**❌ Denied** · by mod\\*name\n**Reason:** Wrong \\*layout\\*"]);
      expect((decided.components as { components: { id: number }[] }[])[0]!.components.map((row) => row.id))
        .toEqual([41003, 41004, 41005, 41001, 41006]);
      expect(rows(decided).filter((row) => row.type === 2).map((row) => row.custom_id))
        .toEqual([`aklmod2|wpm|reopen-${status}|${id}|2`, undefined]);
      const reopened = buildV2StatusPatch(decided, "wpm", id, { status: "pending", decider_name: null, review_version: 3 })!;
      expect(texts(reopened)).toEqual([context, proof]);
      expect(rows(reopened).filter((row) => row.type === 2).map((row) => row.custom_id))
        .toEqual([`aklmod2|wpm|approve|${id}|3`, `aklmod2|wpm|deny|${id}|3`, undefined]);
    }
  });

  it("[LDB-MD21] budgets WPM proof links and decision reasons without truncating either URL", () => {
    const id = "01ARZ3NDEKTSV4RRFFQ69G5FAA";
    const candidate = { id, layout_id: id, user_id: "900000000000000002", wpm: 150,
      proof: "https://example.org/" + ")".repeat(490), layout_name: "*".repeat(100), user_name: "*".repeat(60) };
    const initial = buildV2Payload("wpm", candidate);
    expect(initial).not.toHaveProperty("__files");
    const decided = buildV2StatusPatch(initial, "wpm", id, { status: "rejected", decider_name: "*".repeat(60), reason: "*".repeat(500) })!;
    const text = nested(decided.components as unknown[]).filter((row) => row.type === 10).map((row) => String(row.content));
    expect(text.reduce((length, value) => length + value.length, 0)).toBeLessThanOrEqual(4000);
    expect(text[1]).toContain("%29".repeat(490));
    const largeProof = "https://example.org/" + "\u2000".repeat(490);
    const attached = buildV2Payload("wpm", { ...candidate, proof: largeProof });
    expect((attached.__files as { content: string }[])[0]?.content).toBe(largeProof);
    const updated = buildV2StatusPatch(attached, "wpm", id, { status: "rejected", decider_name: null, reason: "*".repeat(500) })!;
    expect(updated.attachments).toEqual(attached.attachments);
    expect(nested(updated.components as unknown[]).find((row) => row.id === 41004)?.content).toBe("**150 WPM** · Full proof URL attached.");
  });

  it("[LDB-MD21] keeps legacy WPM cards editable without introducing pending labels", () => {
    const old = { components: [{ type: 17, id: 41000, components: [
      { type: 10, id: 41001, content: "**✅ APPROVED** · by mod" },
      { type: 10, id: 41002, content: "## WPM submission on finch" },
      { type: 10, id: 41003, content: "Submitted by mod · Words per minute · Submission `old-id`" },
      { type: 10, id: 41004, content: "**150 WPM**\nProof: <https://example.org/proof>" },
      { type: 1, id: 41006, components: [] },
    ] }] };
    const pending = buildV2StatusPatch(old, "wpm", "old-id", { status: "pending", decider_name: null, review_version: 1 })!;
    expect(JSON.stringify(pending)).not.toMatch(/Pending|PENDING|APPROVED/);
    expect(JSON.stringify(pending)).toContain("https://example.org/proof");
    expect(JSON.stringify(pending)).toContain("approve|old-id|1");
    const approved = buildV2StatusPatch(pending, "wpm", "old-id", { status: "approved", decider_name: "mod", review_version: 1 })!;
    expect(nested(approved.components as unknown[]).find((row) => row.id === 41001)?.content).toBe("**✅ APPROVED** · by mod");
    expect(JSON.stringify(approved)).toContain("reopen-approved|old-id|1");
  });

  it("[LDB-MD15] renders full comment edit before/after previews and escapes user markdown", () => {
    const comment = buildV2Payload("comment", {
      id: "01ARZ3NDEKTSV4RRFFQ69G5FAB",
      layout_id: "01BX5ZZKBKACTAV9WEVGEMMVRY",
      user_id: "900000000000000003",
      body: "*new* text",
      live_body: "old [text]",
      layout_name: "finch",
      user_name: "reeve_",
    });
    const body = nested(comment.components as unknown[]).find((c) => c.type === 10 && c.id === 41004)?.content as string;
    expect(body).toBe("> \\*new\\* text\n\n-# Previous version\n> old \\[text\\]");
    expect(body).toContain("old \\[text\\]");
    expect(body).toContain("\\*new\\* text");

    const bounded = buildV2Payload("comment", {
      id: "01ARZ3NDEKTSV4RRFFQ69G5FAC",
      layout_id: "01BX5ZZKBKACTAV9WEVGEMMVRY",
      user_id: "900000000000000004",
      body: "z".repeat(2000),
      live_body: "x".repeat(2000),
      layout_name: "finch",
      user_name: null,
    });
    const boundedBody = nested(bounded.components as unknown[]).find((c) => c.type === 10 && c.id === 41004)?.content as string;
    expect(boundedBody).toBe("Full comment text attached as a .txt file.");
    const allText = nested(bounded.components as unknown[]).filter((c) => c.type === 10).map((c) => c.content as string);
    expect(allText.reduce((total, text) => total + text.length, 0)).toBeLessThan(4000);
    const files = bounded.__files as { filename: string; content: string }[];
    expect(files).toHaveLength(1);
    expect(files[0]!.content).toBe(`BEFORE\n\n${"x".repeat(2000)}\n\nAFTER\n\n${"z".repeat(2000)}`);
    expect(bounded.attachments).toEqual([{ id: "0", filename: files[0]!.filename, description: "Complete comment text before and after the edit" }]);
    expect(nested(bounded.components as unknown[]).find((c) => c.type === 13 && c.id === 41009))
      .toEqual({ type: 13, id: 41009, file: { url: `attachment://${files[0]!.filename}` } });

    const hostile = buildV2Payload("comment", {
      id: "01ARZ3NDEKTSV4RRFFQ69G5FAC",
      layout_id: "01BX5ZZKBKACTAV9WEVGEMMVRY",
      user_id: "900000000000000004",
      body: "\\".repeat(2000) + "😀".repeat(1000),
      live_body: "\\".repeat(2000),
      layout_name: "*".repeat(1000),
      user_name: "\\".repeat(1000),
    });
    const hostileParts = nested(hostile.components as unknown[]);
    const hostileText = hostileParts.filter((c) => c.type === 10).map((c) => c.content as string);
    expect(hostileText.reduce((total, text) => total + text.length, 0)).toBeLessThan(4000);
    for (const text of hostileText) expect(/[\uD800-\uDBFF]$/.test(text)).toBe(false);
    const hostileFile = (hostile.__files as { content: string }[])[0]!.content;
    expect(hostileFile).toBe(`BEFORE\n\n${"\\".repeat(2000)}\n\nAFTER\n\n${"\\".repeat(2000) + "😀".repeat(1000)}`);
  });

  it("[LDB-MD15] keeps context, quote, divider and decision footer in the same order for each state", () => {
    const id = "01ARZ3NDEKTSV4RRFFQ69G5FAB";
    const initial = buildV2Payload("comment", {
      id, layout_id: "01BX5ZZKBKACTAV9WEVGEMMVRY", user_id: "900000000000000003",
      body: "These layouts were part of a rollmaxxing test, do not use.", live_body: null,
      layout_name: "bemboo10", user_name: "deeroh",
    });
    for (const status of ["pending", "approved", "rejected", "superseded", "removed"] as const) {
      const card = status === "pending" ? initial : buildV2StatusPatch(initial, "comment", id, { status, decider_name: "deeroh" })!;
      const text = nested(card.components as unknown[]).filter((c) => c.type === 10).map((c) => c.content as string);
      expect(text[0]).toBe("**New comment** on **[bemboo10](<https://akldb.org/l/01BX5ZZKBKACTAV9WEVGEMMVRY>)** by **deeroh**");
      expect(text[1]).toBe("> These layouts were part of a rollmaxxing test, do not use.");
      const labels = { pending: "⏳ Pending review", approved: "✅ Approved", rejected: "❌ Denied", superseded: "↪️ Superseded", removed: "⚠️ Removed" };
      expect(text[2]).toBe(status === "pending" ? undefined : `**${labels[status]}** · by deeroh`);
      expect(nested(card.components as unknown[]).filter((c) => c.type === 14)).toHaveLength(1);
      expect((card.components as { components: { id: number }[] }[])[0]!.components.map((c) => c.id)).toEqual(status === "pending" ? [41003, 41004, 41005, 41006] : [41003, 41004, 41005, 41001, 41006]);
      expect(text.join("\n")).not.toContain(id);
      expect(text.some((value) => /^#{1,3} /m.test(value))).toBe(false);
      expect(text.join("\n")).not.toContain("**Comment**");
      if (status !== "pending") {
        expect(text).toHaveLength(3);
        const again = buildV2StatusPatch(card, "comment", id, { status, decider_name: "deeroh" });
        expect(again).toEqual(card);
      }
    }
  });

  it("[LDB-MD15] edits only the controlled status and moderation buttons, preserving other components without content", () => {
    const initial = buildV2Payload("link", {
      id: "01ARZ3NDEKTSV4RRFFQ69G5FAD",
      layout_id: "01BX5ZZKBKACTAV9WEVGEMMVRY",
      url: "https://example.org/link",
      submitted_by: "900000000000000005",
      layout_name: "finch",
      submitter_name: null,
    });
    const original = nested(initial.components as unknown[]);
    const titleBefore = original.find((c) => c.id === 41002)?.content;
    const patched = buildV2StatusPatch(initial, "link", "01ARZ3NDEKTSV4RRFFQ69G5FAD", {
      status: "approved",
      decider_name: "Mod*Name",
    });
    expect(patched).not.toBeNull();
    if (patched === null) throw new Error("Expected V2 status patch");
    expect(patched).not.toHaveProperty("content");
    expect(patched).not.toHaveProperty("embeds");
    expect(patched.allowed_mentions).toEqual({ parse: [] });
    const parts = nested(patched.components as unknown[]);
    expect(parts.find((c) => c.id === 41001)?.content).toBe("**✅ APPROVED** · by Mod\\*Name");
    expect(parts.find((c) => c.id === 41002)?.content).toBe(titleBefore);
    const controls = parts.filter((c) => c.type === 2);
    expect(controls).toHaveLength(1);
    expect(controls[0]?.label).toBe("Open in akldb");
    const secondPatch = buildV2StatusPatch(patched, "link", "01ARZ3NDEKTSV4RRFFQ69G5FAD", {
      status: "rejected",
      decider_name: null,
    });
    expect(secondPatch).not.toBeNull();
    const secondParts = nested(secondPatch!.components as unknown[]);
    expect(secondParts.filter((c) => c.type === 2).map((c) => c.label)).toEqual(["Open in akldb"]);
    expect(secondParts.filter((c) => c.id === 41001)).toHaveLength(1);
    expect(buildV2StatusPatch({ components: [] }, "link", "id", { status: "approved", decider_name: null })).toBeNull();
  });

  it("[LDB-MD15] quotes every line and budgets for an escaped denial reason without truncating the comment", () => {
    const id = "01ARZ3NDEKTSV4RRFFQ69G5FAB";
    const candidate = { id, layout_id: "01BX5ZZKBKACTAV9WEVGEMMVRY", user_id: "900000000000000003",
      body: "# Heading\n\n> quoted *text*", live_body: null, layout_name: "bemboo10", user_name: "deeroh" };
    const initial = buildV2Payload("comment", candidate);
    expect(nested(initial.components as unknown[]).find((c) => c.id === 41004)?.content)
      .toBe("> \\# Heading\n> \n> \\> quoted \\*text\\*");
    const long = buildV2Payload("comment", { ...candidate, body: "z".repeat(2000) });
    const denied = buildV2StatusPatch(long, "comment", id, { status: "rejected", decider_name: "*".repeat(100), reason: "*".repeat(500) })!;
    const text = nested(denied.components as unknown[]).filter((c) => c.type === 10).map((c) => String(c.content));
    expect(text.reduce((length, value) => length + value.length, 0)).toBeLessThanOrEqual(4000);
    expect(text[1]).toBe(`> ${"z".repeat(2000)}`);
    expect(text[2]).toContain(`\n**Reason:** ${"\\*".repeat(500)}`);
    const pending = buildV2StatusPatch(denied, "comment", id, { status: "pending", decider_name: null, reason: null, review_version: 1 })!;
    expect(JSON.stringify(pending)).not.toContain("Reason:");
    expect(JSON.stringify(pending)).not.toContain("Pending review");
    const lines = "z\n".repeat(1000);
    const attached = buildV2Payload("comment", { ...candidate, body: lines });
    expect((attached.__files as { content: string }[])[0]?.content).toBe(`COMMENT\n\n${lines}`);
  });

  it("[LDB-MD16] erases comment previews when a comment is deleted or replaced", () => {
    const initial = buildV2Payload("comment", {
      id: "01ARZ3NDEKTSV4RRFFQ69G5FAE", layout_id: "01BX5ZZKBKACTAV9WEVGEMMVRY",
      user_id: "900000000000000005", body: "private current text", live_body: "private former text",
      layout_name: "finch", user_name: null,
    });
    for (const status of ["deleted", "replaced"] as const) {
      const patched = buildV2StatusPatch(initial, "comment", "01ARZ3NDEKTSV4RRFFQ69G5FAE", { status, decider_name: null });
      const parts = nested(patched!.components as unknown[]);
      const body = parts.find((c) => c.id === 41004)?.content as string;
      expect(body).toBe("**Comment preview removed**");
      expect(JSON.stringify(patched)).not.toContain("private current text");
      expect(JSON.stringify(patched)).not.toContain("private former text");
    }

    const long = buildV2Payload("comment", {
      id: "01ARZ3NDEKTSV4RRFFQ69G5FAE", layout_id: "01BX5ZZKBKACTAV9WEVGEMMVRY",
      user_id: "900000000000000005", body: "private current text ".repeat(120), live_body: "private former text ".repeat(120),
      layout_name: "finch", user_name: null,
    });
    const preserve = buildV2StatusPatch(long, "comment", "01ARZ3NDEKTSV4RRFFQ69G5FAE", { status: "approved", decider_name: null });
    expect(preserve?.attachments).toEqual(long.attachments);
    const erased = buildV2StatusPatch(long, "comment", "01ARZ3NDEKTSV4RRFFQ69G5FAE", { status: "deleted", decider_name: null });
    expect(erased?.attachments).toEqual([]);
    expect(nested(erased!.components as unknown[]).some((c) => c.type === 13 && c.id === 41009)).toBe(false);
    expect(JSON.stringify(erased)).not.toContain("private current text");
    expect(JSON.stringify(erased)).not.toContain("private former text");
  });
});

describe("[LDB-MD21] versioned review controls", () => {
  const id = "01ARZ3NDEKTSV4RRFFQ69G5FAB";
  const initial = buildV2Payload("comment", {
    id, layout_id: "01BX5ZZKBKACTAV9WEVGEMMVRY", user_id: "900000000000000003",
    body: "These layouts were part of a rollmaxxing test, do not use.", live_body: null,
    layout_name: "bemboo10", user_name: "deeroh",
  });
  it("[LDB-MD21] offers Reopen review after either decision and restores fresh Approve/Deny controls on the same card", () => {
    for (const status of ["approved", "rejected"] as const) {
      const decided = buildV2StatusPatch(initial, "comment", id, { status, decider_name: "mod", review_version: 8 })!;
      const controls = nested(decided.components as unknown[]).filter((c) => c.type === 2);
      expect(controls.map((c) => c.label)).toEqual(["Reopen review", "Open in akldb"]);
      expect(controls[0]?.custom_id).toBe(`aklmod2|comment|reopen-${status}|${id}|8`);
      const reopened = buildV2StatusPatch(decided, "comment", id, { status: "pending", decider_name: null, review_version: 9 })!;
      const parts = nested(reopened.components as unknown[]);
      expect(parts.some((c) => c.id === 41001)).toBe(false);
      expect(JSON.stringify(reopened)).not.toContain("Pending review");
      expect(parts.find((c) => c.id === 41004)?.content).toBe("> These layouts were part of a rollmaxxing test, do not use.");
      expect(parts.filter((c) => c.type === 2).map((c) => c.custom_id)).toEqual([
        `aklmod2|comment|approve|${id}|9`, `aklmod2|comment|deny|${id}|9`, undefined,
      ]);
      const disabled = buildV2StatusPatch(reopened, "comment", id, { status, decider_name: null, review_version: 9 }, false)!;
      expect(nested(disabled.components as unknown[]).filter((c) => c.type === 2).map((c) => c.label)).toEqual(["Open in akldb"]);
    }
  });
  it("[LDB-MD21] refreshes pending WPM controls without requiring a previous status component, and bounds custom IDs", () => {
    const wpm = buildV2Payload("wpm", { id, layout_id: id, user_id: "900000000000000003", wpm: 150,
      proof: "https://example.org/proof", layout_name: "finch", user_name: null, review_version: 12 });
    expect(JSON.stringify(wpm)).toContain(`aklmod2|wpm|approve|${id}|12`);
    const patched = buildV2StatusPatch(wpm, "wpm", id, { status: "pending", decider_name: null, review_version: Number.MAX_SAFE_INTEGER })!;
    expect(patched).not.toBeNull();
    const ids = nested(patched.components as unknown[]).flatMap((c) => typeof c.custom_id === "string" ? [c.custom_id] : []);
    expect(ids).toHaveLength(2);
    for (const customId of ids) expect(new TextEncoder().encode(customId).length).toBeLessThanOrEqual(100);
  });

  it("[LDB-MD21] keeps older compact cards usable when reopening removes their pending label", () => {
    const old = { components: [{ type: 17, id: 41000, components: [
      { type: 10, id: 41004, content: "Original comment" },
      { type: 10, id: 41003, content: "-# (Approved) New comment on bemboo10 by deeroh" },
      { type: 1, id: 41006, components: [] },
    ] }] };
    const pending = buildV2StatusPatch(old, "comment", id, { status: "pending", decider_name: null, review_version: 1 })!;
    expect(JSON.stringify(pending)).not.toMatch(/Pending|Approved/);
    expect(JSON.stringify(pending)).toContain(`approve|${id}|1`);
    const approved = buildV2StatusPatch(pending, "comment", id, { status: "approved", decider_name: "mod", review_version: 1 })!;
    expect(nested(approved.components as unknown[]).find((c) => c.id === 41003)?.content)
      .toBe("-# (✅ Approved) New comment on bemboo10 by deeroh");
    expect(nested(approved.components as unknown[]).filter((c) => c.type === 10)).toHaveLength(2);
  });
});

it("[LDB-WPM17] original receipt is independent of moderation controls and survives every decision and reopening", () => {
  const id = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
  const source = "https://discord.com/channels/900000000000000001/900000000000000002/900000000000000003";
  const candidate = { id, layout_id: id, user_id: "900000000000000001", user_name: "qwertron", layout_name: "Dvorak", wpm: 184, proof: "https://example.org/proof", source_message_url: source };
  for (const actions of [true, false]) {
    const initial = buildV2Payload("wpm", candidate, actions);
    const buttons = (card: Record<string, unknown>) => nested(card.components as unknown[]).filter((p) => p.type === 2);
    expect(buttons(initial).map((p) => p.label)).toEqual([...(actions ? ["✓ Approve", "✕ Deny"] : []), "Original message", "Open in akldb"]);
    let current = initial;
    for (const [status, version] of [["approved", 0], ["pending", 1], ["rejected", 1], ["pending", 2], ["superseded", 2]] as const) {
      current = buildV2StatusPatch(current, "wpm", id, { status, review_version: version, decider_name: "mod", source_message_url: source }, actions)!;
      expect(buttons(current).slice(-2)).toEqual([{ type: 2, style: 5, label: "Original message", url: source }, { type: 2, style: 5, label: "Open in akldb", url: "https://akldb.org/admin?tab=inbox" }]);
      expect(current.allowed_mentions).toEqual({ parse: [] });
    }
    const unbound = buildV2Payload("wpm", { ...candidate, source_message_url: null }, actions);
    expect(buttons(unbound).some((p) => p.label === "Original message")).toBe(false);
  }
});
