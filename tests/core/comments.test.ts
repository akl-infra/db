// [LDB-CMT1] Layout comments (docs/decisions/29-layout-comments.md): the pure
// validator -- table-tested accept/refuse cases, no DB, no clock.
import { describe, expect, it } from "vitest";
import { MAX_COMMENT_LENGTH, validateComment } from "../../src/core/comments";

describe("[LDB-CMT1] validateComment accepts", () => {
  const ok: [string, unknown, string][] = [
    ["a short sentence", "Nice layout", "Nice layout"],
    ["a single character", "x", "x"],
    ["surrounding whitespace, trimmed", "  \n hello \t ", "hello"],
    ["interior blank lines and spaces, kept", "a\n\n  b", "a\n\n  b"],
    ["CRLF line endings, normalized to LF", "one\r\ntwo\r\nthree", "one\ntwo\nthree"],
    ["a lone CR, normalized to LF", "one\rtwo", "one\ntwo"],
    ["mixed endings", "a\r\nb\rc\nd", "a\nb\nc\nd"],
    ["a trailing CRLF, trimmed away", "hello\r\n", "hello"],
    ["markup-looking text, stored as is", "<b>*bold*</b> [x](y)", "<b>*bold*</b> [x](y)"],
    ["exactly 2000 ASCII characters", "a".repeat(2000), "a".repeat(2000)],
    ["exactly 2000 astral code points (4000 UTF-16 units)", "😀".repeat(2000), "😀".repeat(2000)],
    ["2000 code points, the last a CRLF that normalizes to one", `${"a".repeat(1997)}b\r\nc`, `${"a".repeat(1997)}b\nc`],
  ];
  for (const [label, input, stored] of ok) {
    it(`[LDB-CMT1] ${label}`, () => {
      expect(validateComment(input)).toEqual({ ok: true, body: stored });
    });
  }
});

describe("[LDB-CMT1] validateComment refuses", () => {
  const refused: [string, unknown][] = [
    ["a number", 5],
    ["null", null],
    ["undefined", undefined],
    ["an object", { text: "hi" }],
    ["an array of strings", ["hi"]],
    ["a boolean", true],
    ["the empty string", ""],
    ["spaces only", "   "],
    ["whitespace of every kind only", " \t\r\n   "],
    ["one over the maximum, 2001 ASCII characters", "a".repeat(2001)],
    ["one over the maximum in astral code points", "😀".repeat(2001)],
    ["2001 code points even though trimmed text is shorter padded", `${"a".repeat(2001)}   `],
  ];
  for (const [label, input] of refused) {
    it(`[LDB-CMT1] ${label}`, () => {
      const r = validateComment(input);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.message.length).toBeGreaterThan(0);
    });
  }

  it("[LDB-CMT1] the limit is counted in code points, not UTF-16 units", () => {
    expect(MAX_COMMENT_LENGTH).toBe(2000);
    expect("😀".repeat(2000).length).toBe(4000);
    expect(validateComment("😀".repeat(2000)).ok).toBe(true);
    expect(validateComment("😀".repeat(2000) + "a").ok).toBe(false);
  });

  it("[LDB-CMT1] the limit applies after line endings are normalized and trimmed", () => {
    // "a\r\n" x 1000 is 3000 UTF-16 units but 2000 code points once each CRLF is one LF, so it fits (the
    // trailing LF is trimmed, leaving 1999); one more character per line
    // does not.
    expect(validateComment("a\r\n".repeat(1000)).ok).toBe(true);
    expect(validateComment("a\r\n".repeat(1000) + "b").ok).toBe(false);
    expect(validateComment(`   ${"a".repeat(2000)}   `).ok).toBe(true);
  });
});
