// [LDB-MD9] L5 moderation (design/akldb-site/01-plan.md §4.4): the pure
// link URL validator -- table-tested accept/refuse cases, no DB, no clock.
import { describe, expect, it } from "vitest";
import { validateLinkUrl } from "../../src/core/links";

interface Case {
  label: string;
  input: unknown;
  ok: boolean;
}

const CASES: Case[] = [
  { label: "a plain https URL", input: "https://example.org/foo", ok: true },
  { label: "https with a path, query and fragment", input: "https://example.org/foo?x=1#y", ok: true },
  { label: "https with a port", input: "https://example.org:8443/foo", ok: true },
  { label: "http (not https) is refused", input: "http://example.org/foo", ok: false },
  { label: "ftp is refused", input: "ftp://example.org/foo", ok: false },
  { label: "a bare word is not a URL at all", input: "not-a-url", ok: false },
  { label: "an empty string is refused", input: "", ok: false },
  { label: "embedded username is refused", input: "https://user@example.org/foo", ok: false },
  { label: "embedded username and password is refused", input: "https://user:pass@example.org/foo", ok: false },
  { label: "over 2048 characters is refused", input: `https://example.org/${"a".repeat(2048)}`, ok: false },
  { label: "exactly 2048 characters is accepted", input: `https://example.org/${"a".repeat(2048 - "https://example.org/".length)}`, ok: true },
  { label: "not a string at all", input: 42, ok: false },
  { label: "null", input: null, ok: false },
  { label: "undefined", input: undefined, ok: false },
];

describe("[LDB-MD9] validateLinkUrl", () => {
  for (const c of CASES) {
    it(`[LDB-MD9] ${c.label} -> ${c.ok ? "accepted" : "refused"}`, () => {
      const result = validateLinkUrl(c.input);
      expect(result.ok, c.label).toBe(c.ok);
      if (result.ok) {
        expect(result.url).toBe(c.input);
      } else {
        expect(typeof result.message).toBe("string");
        expect(result.message.length).toBeGreaterThan(0);
      }
    });
  }

  it("[LDB-MD9] the length check runs before the URL parse (an over-length garbage string is still refused, never throws)", () => {
    const result = validateLinkUrl("not a url at all ".repeat(200));
    expect(result.ok).toBe(false);
  });
});
