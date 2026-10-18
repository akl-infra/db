// [SITE-40] a WPM proof is shown IN FULL as a new-tab, noopener link; a
// non-http(s) value is never made a link.
import { describe, expect, it } from "vitest";
import { renderToString } from "@solidjs/web";
import ProofLink from "../../src/ui/ProofLink.tsx";

describe("[SITE-40] ProofLink", () => {
  it("renders the whole URL as the link text, target=_blank rel=noopener", () => {
    const url = "https://monkeytype.com/profile/someone?tab=results&x=1";
    const html = renderToString(() => ProofLink({ proof: url }));
    expect(html).toContain(">https://monkeytype.com/profile/someone?tab=results&amp;x=1<");
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener"');
  });

  it("never links a javascript: value", () => {
    const html = renderToString(() => ProofLink({ proof: "javascript:alert(1)" }));
    expect(html).not.toContain("<a ");
  });
});
