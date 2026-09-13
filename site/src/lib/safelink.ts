// H17 ("never repeat unvalidated user strings") applied to a layout's
// user-submitted `link` field (design/akldb-site/01-plan.md §5, SITE-11):
// the href is used only if it re-parses as `https:` client-side, and the
// visible text is always the hostname, never the raw string an owner typed.
export interface SafeExternalLink {
  href: string;
  hostname: string;
}

export function safeExternalLink(url: string | null | undefined): SafeExternalLink | null {
  if (!url) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:") return null;
  return { href: parsed.toString(), hostname: parsed.hostname };
}
