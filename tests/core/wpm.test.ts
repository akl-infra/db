// [LDB-WPM1] WPM records (docs/decisions/28-wpm-records.md): the pure
// validators -- table-tested accept/refuse cases, no DB, no clock.
import { describe, expect, it } from "vitest";
import { MAX_PROOF_LENGTH, validateProof, validateUserId, validateWpm } from "../../src/core/wpm";

describe("[LDB-WPM1] validateWpm", () => {
  const ok: [string, unknown][] = [
    ["the minimum, 1", 1],
    ["a typical speed", 85],
    ["the maximum, 1000", 1000],
  ];
  const refused: [string, unknown][] = [
    ["zero", 0],
    ["a negative number", -5],
    ["one over the maximum", 1001],
    ["a fraction", 85.5],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["a numeric string", "85"],
    ["null", null],
    ["undefined", undefined],
    ["a boolean", true],
  ];
  for (const [label, input] of ok) {
    it(`[LDB-WPM1] ${label} is accepted`, () => {
      expect(validateWpm(input)).toEqual({ ok: true, wpm: input });
    });
  }
  for (const [label, input] of refused) {
    it(`[LDB-WPM1] ${label} is refused`, () => {
      const r = validateWpm(input);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.message.length).toBeGreaterThan(0);
    });
  }
});

describe("[LDB-WPM1] validateProof", () => {
  const ok: [string, string, string][] = [
    ["an https URL", "https://example.org/proof", "https://example.org/proof"],
    ["an http URL", "http://example.org/proof", "http://example.org/proof"],
    ["a YouTube link (not restricted to Discord)", "https://www.youtube.com/watch?v=abc", "https://www.youtube.com/watch?v=abc"],
    ["a monkeytype link with a fragment and port", "https://monkeytype.com:8443/profile/x?y=1#z", "https://monkeytype.com:8443/profile/x?y=1#z"],
    ["surrounding whitespace is trimmed", "  https://example.org/a \n", "https://example.org/a"],
    ["a bare host", "https://example.org", "https://example.org"],
    ["exactly 512 characters", `https://example.org/${"a".repeat(MAX_PROOF_LENGTH - "https://example.org/".length)}`, `https://example.org/${"a".repeat(MAX_PROOF_LENGTH - "https://example.org/".length)}`],
  ];
  const refused: [string, unknown][] = [
    ["ftp", "ftp://example.org/x"],
    ["javascript:", "javascript:alert(1)"],
    ["a data: URL", "data:text/plain,hello"],
    ["a bare word", "not-a-url"],
    ["a relative path", "/proof/1"],
    ["a scheme with no authority", "http:example.org"],
    ["no host", "https://"],
    ["an empty string", ""],
    ["only whitespace", "   "],
    ["over 512 characters", `https://example.org/${"a".repeat(MAX_PROOF_LENGTH)}`],
    ["not a string", 42],
    ["null", null],
    ["undefined", undefined],
  ];
  for (const [label, input, expected] of ok) {
    it(`[LDB-WPM1] ${label} is accepted`, () => {
      expect(validateProof(input)).toEqual({ ok: true, proof: expected });
    });
  }
  for (const [label, input] of refused) {
    it(`[LDB-WPM1] ${label} is refused`, () => {
      const r = validateProof(input);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.message.length).toBeGreaterThan(0);
    });
  }
});

describe("[LDB-WPM4] validateUserId", () => {
  for (const id of ["12345678901234567", "184412255822020608", "12345678901234567890"]) {
    it(`[LDB-WPM4] ${id.length} digits is accepted`, () => {
      expect(validateUserId(id, "user_id")).toBe(id);
    });
  }
  for (const bad of ["1234567890123456", "123456789012345678901", "18441225582202060x", "", " 184412255822020608", 184412255822020608, null]) {
    it(`[LDB-WPM4] ${JSON.stringify(bad)} is refused with bad_request`, () => {
      expect(() => validateUserId(bad, "user_id")).toThrow(/Discord user id/);
    });
  }
});
