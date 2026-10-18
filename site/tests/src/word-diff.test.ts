// [SITE-43] the Inbox's comment edit view: a word-level diff of the live text
// to the pending one, and the "Read all" collapse of a long new comment.
// Pure functions (`lib/wordDiff.ts`), no DOM.
import { describe, expect, it } from "vitest";
import { COLLAPSE_AT, clampParts, collapsedPreview, diffWords, sideOf, tokenize, type DiffPart } from "../../src/lib/wordDiff.ts";

function before(parts: DiffPart[]): string {
  return parts.filter((p) => p.op !== "ins").map((p) => p.text).join("");
}
function after(parts: DiffPart[]): string {
  return parts.filter((p) => p.op !== "del").map((p) => p.text).join("");
}

describe("[SITE-43] tokenize", () => {
  it("keeps whitespace as tokens so joining reproduces the input exactly", () => {
    for (const s of ["", "a", "a b", "  a   b\n\nc\t", "one\r\ntwo", "\u{1F600} emoji  here"]) {
      expect(tokenize(s).join("")).toBe(s);
    }
    expect(tokenize("ab  cd")).toEqual(["ab", "  ", "cd"]);
  });
});

describe("[SITE-43] diffWords", () => {
  it("identical text is one unchanged part", () => {
    expect(diffWords("the same text", "the same text")).toEqual([{ op: "eq", text: "the same text" }]);
    expect(diffWords("", "")).toEqual([]);
  });

  it("a replaced word is a deletion then an insertion between unchanged text", () => {
    expect(diffWords("I like this layout", "I love this layout")).toEqual([
      { op: "eq", text: "I " },
      { op: "del", text: "like" },
      { op: "ins", text: "love" },
      { op: "eq", text: " this layout" },
    ]);
  });

  it("an added and a removed span", () => {
    expect(diffWords("alpha beta", "alpha beta gamma")).toEqual([
      { op: "eq", text: "alpha beta" },
      { op: "ins", text: " gamma" },
    ]);
    expect(diffWords("alpha beta gamma", "alpha gamma")).toEqual([
      { op: "eq", text: "alpha " },
      { op: "del", text: "beta " },
      { op: "eq", text: "gamma" },
    ]);
  });

  it("from nothing and to nothing", () => {
    expect(diffWords("", "new text")).toEqual([{ op: "ins", text: "new text" }]);
    expect(diffWords("old text", "")).toEqual([{ op: "del", text: "old text" }]);
  });

  it("a whitespace-only change shows as a change in the whitespace token", () => {
    const parts = diffWords("a b", "a\nb");
    expect(before(parts)).toBe("a b");
    expect(after(parts)).toBe("a\nb");
    expect(parts.some((p) => p.op !== "eq")).toBe(true);
  });

  it("is lossless on a range of texts: eq+del rebuilds the old text, eq+ins the new one", () => {
    const cases: [string, string][] = [
      ["", ""],
      ["a", "b"],
      ["one two three four", "four three two one"],
      ["line one\nline two\n\nline three", "line one\nline 2\n\nline three\nline four"],
      ["\u{1F600} happy", "happy \u{1F600}"],
      ["a  b   c", "a b c"],
      ["x ".repeat(300), "x ".repeat(150) + "y ".repeat(150)],
    ];
    for (const [a, b] of cases) {
      const parts = diffWords(a, b);
      expect(before(parts), JSON.stringify([a, b])).toBe(a);
      expect(after(parts), JSON.stringify([a, b])).toBe(b);
      // adjacent parts never share an op (they are merged)
      for (let i = 1; i < parts.length; i++) expect(parts[i]!.op).not.toBe(parts[i - 1]!.op);
    }
  });

  it("two maximum-length comments still diff (past the cell cap it degrades to remove-all / add-all, still lossless)", () => {
    const a = Array.from({ length: 1000 }, (_, i) => `w${i}`).join(" ");
    const b = Array.from({ length: 1000 }, (_, i) => `v${i}`).join(" ");
    const parts = diffWords(a, b);
    expect(before(parts)).toBe(a);
    expect(after(parts)).toBe(b);
    const huge = diffWords("a ".repeat(3000), "b ".repeat(3000));
    expect(huge).toEqual([
      { op: "del", text: "a ".repeat(3000) },
      { op: "ins", text: "b ".repeat(3000) },
    ]);
  });
});

describe("[SITE-43] collapsedPreview", () => {
  it("short text is shown whole (no preview)", () => {
    expect(collapsedPreview("short")).toBeNull();
    expect(collapsedPreview("x".repeat(COLLAPSE_AT))).toBeNull();
  });

  it("long text is cut at the limit, in code points", () => {
    const long = "x".repeat(COLLAPSE_AT + 1);
    expect(collapsedPreview(long)).toBe("x".repeat(COLLAPSE_AT));
    const emoji = "\u{1F600}".repeat(COLLAPSE_AT + 5);
    expect(collapsedPreview(emoji)).toBe("\u{1F600}".repeat(COLLAPSE_AT));
    expect(collapsedPreview("abcdef", 3)).toBe("abc");
  });
});

describe("[SITE-43] sideOf and clampParts", () => {
  it("each side is a complete text: current rebuilds the old one, proposed the new one", () => {
    const parts = diffWords("I like this layout", "I love this layout a lot");
    expect(sideOf(parts, "current").map((p) => p.text).join("")).toBe("I like this layout");
    expect(sideOf(parts, "proposed").map((p) => p.text).join("")).toBe("I love this layout a lot");
    expect(sideOf(parts, "current").every((p) => p.op !== "ins")).toBe(true);
    expect(sideOf(parts, "proposed").every((p) => p.op !== "del")).toBe(true);
  });

  it("clampParts folds only trailing unchanged text and never hides a mark", () => {
    const long = "w ".repeat(400);
    expect(clampParts([{ op: "eq", text: "short" }])).toBeNull();
    const plain = clampParts([{ op: "eq", text: long }])!;
    expect([...plain.map((p) => p.text).join("")].length).toBe(COLLAPSE_AT);
    const lateChange: DiffPart[] = [
      { op: "eq", text: long },
      { op: "ins", text: "late" },
    ];
    expect(clampParts(lateChange)).toBeNull(); // the change is at the very end: nothing may be hidden
    const earlyChange: DiffPart[] = [
      { op: "del", text: "early" },
      { op: "eq", text: long },
    ];
    const cut = clampParts(earlyChange)!;
    expect(cut[0]).toEqual({ op: "del", text: "early" });
    expect([...cut.map((p) => p.text).join("")].length).toBe(COLLAPSE_AT);
  });

  it("cuts on code points, never inside an emoji", () => {
    const parts: DiffPart[] = [{ op: "eq", text: "\u{1F600}".repeat(COLLAPSE_AT + 3) }];
    expect(clampParts(parts)![0]!.text).toBe("\u{1F600}".repeat(COLLAPSE_AT));
  });
});
