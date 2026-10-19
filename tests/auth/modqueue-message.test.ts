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
      "aklmod1|link|approve|01ARZ3NDEKTSV4RRFFQ69G5FAV",
      "aklmod1|link|deny|01ARZ3NDEKTSV4RRFFQ69G5FAV",
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
      "aklmod1|wpm|approve|01ARZ3NDEKTSV4RRFFQ69G5FAA",
      "aklmod1|wpm|deny|01ARZ3NDEKTSV4RRFFQ69G5FAA",
      undefined,
    ]);

    const noActions = buildV2Payload("link", {
      id: "01ARZ3NDEKTSV4RRFFQ69G5FAE", layout_id: "01BX5ZZKBKACTAV9WEVGEMMVRY",
      url: "https://example.org/", submitted_by: "900000000000000006", layout_name: "layout", submitter_name: null,
    }, false);
    expect(nested(noActions.components as unknown[]).filter((c) => c.type === 2).map((c) => c.style)).toEqual([5]);
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
    expect(body).toBe("\\*new\\* text\n\n-# Previous version\nold \\[text\\]");
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

  it("[LDB-MD15] keeps the comment first and metadata compact before and after each decision", () => {
    const id = "01ARZ3NDEKTSV4RRFFQ69G5FAB";
    const initial = buildV2Payload("comment", {
      id, layout_id: "01BX5ZZKBKACTAV9WEVGEMMVRY", user_id: "900000000000000003",
      body: "These layouts were part of a rollmaxxing test, do not use.", live_body: null,
      layout_name: "bemboo10", user_name: "deeroh",
    });
    for (const status of ["pending", "approved", "rejected", "superseded", "removed"] as const) {
      const card = status === "pending" ? initial : buildV2StatusPatch(initial, "comment", id, { status, decider_name: "deeroh" })!;
      const text = nested(card.components as unknown[]).filter((c) => c.type === 10).map((c) => c.content as string);
      expect(text[0]).toBe("These layouts were part of a rollmaxxing test, do not use.");
      const label = status === "rejected" ? "Denied" : status[0]!.toUpperCase() + status.slice(1);
      expect(text[1]).toBe(`-# (${label}) New comment on [bemboo10](<https://akldb.org/l/01BX5ZZKBKACTAV9WEVGEMMVRY>) by deeroh`);
      expect(nested(card.components as unknown[]).some((c) => c.type === 14)).toBe(false);
      expect(text.join("\n")).not.toContain(id);
      expect(text.some((value) => /^#{1,3} /m.test(value))).toBe(false);
      expect(text.join("\n")).not.toContain("**Comment**");
      if (status !== "pending") {
        expect(text).toHaveLength(2);
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
