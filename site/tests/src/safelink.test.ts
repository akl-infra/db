// [SITE-11] a rendered link is https:, hostname-only text -- this covers
// the pure classifier; the actual `rel`/`target` attributes are fixed
// markup in src/pages/Layout.tsx (a static JSX check, not worth a DOM test
// for this small a site).
import { describe, expect, it } from "vitest";
import { safeExternalLink, safeProofLink } from "../../src/lib/safelink.ts";

describe("[SITE-11] safeExternalLink", () => {
  it("accepts an https url and exposes only its hostname as display text", () => {
    const result = safeExternalLink("https://github.com/someone/some-layout?ref=readme#top");
    expect(result).not.toBeNull();
    expect(result!.hostname).toBe("github.com");
    expect(result!.href.startsWith("https://github.com/")).toBe(true);
  });

  it("refuses a plain http url", () => {
    expect(safeExternalLink("http://example.com")).toBeNull();
  });

  it("refuses javascript: and data: schemes", () => {
    expect(safeExternalLink("javascript:alert(1)")).toBeNull();
    expect(safeExternalLink("data:text/html,<script>alert(1)</script>")).toBeNull();
  });

  it("refuses malformed input", () => {
    expect(safeExternalLink("not a url")).toBeNull();
    expect(safeExternalLink("")).toBeNull();
    expect(safeExternalLink(null)).toBeNull();
    expect(safeExternalLink(undefined)).toBeNull();
  });

  it("never surfaces the raw string as display text, even embedded in the hostname position", () => {
    const raw = "https://evil.example/<script>alert(1)</script>";
    const result = safeExternalLink(raw);
    expect(result).not.toBeNull();
    expect(result!.hostname).toBe("evil.example");
    expect(result!.hostname).not.toContain("<script>");
  });
});

describe("[SITE-40] safeProofLink (a WPM proof may be http or https)", () => {
  it("accepts http and https and exposes only the hostname as display text", () => {
    expect(safeProofLink("https://www.youtube.com/watch?v=abc")).toMatchObject({ hostname: "www.youtube.com" });
    expect(safeProofLink("http://example.org/p")).toMatchObject({ hostname: "example.org" });
  });

  it("refuses every other scheme and malformed input", () => {
    for (const bad of ["javascript:alert(1)", "data:text/html,x", "ftp://example.org/x", "not a url", "", null, undefined]) {
      expect(safeProofLink(bad as string | null | undefined)).toBeNull();
    }
  });
});
