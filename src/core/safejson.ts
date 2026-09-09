// JSON.parse with the V8 escaped-key hazard removed (S8, 2026-09-09).
//
// Reproduced on the live upstream body (~5.3 MB) under Node 24/26 AND
// inside workerd: parsing the SAME string repeatedly returned two different
// results -- an object key written as a `<` / `&` / `>`
// escape (Go's json.Marshal HTML-escapes those three) sometimes decoded to a
// single backslash. Python's json agrees with the correct decoding every
// time, and a synthetic document does not trigger it, so this is a V8 JSON
// parser bug on some large inputs, not a wire problem. Rewriting those three
// escapes to their literal characters before parsing made ten parses agree
// with each other and with Python (verified on the real body).
//
// The rewrite is only applied where the backslash is itself unescaped (an
// even number of preceding backslashes) -- `"\\u0026"` is a literal
// backslash followed by `u0026` and must stay that way. `<`, `>` and `&`
// are legal literal characters inside JSON strings, so the rewritten text
// is the same JSON document.
const GO_HTML_ESCAPES: Record<string, string> = { "\\u003c": "<", "\\u003e": ">", "\\u0026": "&" };
const ESCAPE_RE = /((?:^|[^\\])(?:\\\\)*)\\u00(3c|3e|26)/gi;

export function unescapeGoHtml(text: string): string {
  return text.replace(ESCAPE_RE, (_, prefix: string, code: string) => prefix + GO_HTML_ESCAPES[`\\u00${code.toLowerCase()}`]);
}

// Parse upstream JSON: unescape first, then parse twice and require
// agreement (belt and braces -- the unescape removes every trigger seen so
// far; the double parse catches one we have not).
export function parseUpstreamJson(text: string): unknown {
  const fixed = unescapeGoHtml(text);
  const first = JSON.parse(fixed) as unknown;
  const second = JSON.parse(fixed) as unknown;
  if (JSON.stringify(first) !== JSON.stringify(second)) {
    throw new Error("JSON.parse returned two different results for the same text (V8 escaped-key bug guard)");
  }
  return first;
}
