// [LDB-I9] Upstream JSON is parsed through core/safejson.ts: Go's HTML
// escapes for < > & are rewritten to literals before JSON.parse (the V8
// escaped-key bug, see the module header), the rewrite never touches an
// escaped backslash, and the parse is checked against a second parse.
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { parseUpstreamJson, unescapeGoHtml } from "../../src/core/safejson";

describe("safejson", () => {
  it("[LDB-I9] rewrites \\u003c \\u003e \\u0026 to literals and nothing else", () => {
    expect(unescapeGoHtml('{"\\u003c":1,"\\u003e":2,"\\u0026":3,"\\u00e9":4}')).toBe('{"<":1,">":2,"&":3,"\\u00e9":4}');
    expect(unescapeGoHtml('{"\\u003C":1}')).toBe('{"<":1}'); // case-insensitive hex
  });

  it("[LDB-I9] leaves an escaped backslash followed by u0026 alone", () => {
    const text = '{"a":"\\\\u0026","b":"\\\\\\u0026"}'; // JSON: "\\u0026" (backslash + u0026) and "\\&" (backslash + &)
    expect(JSON.parse(unescapeGoHtml(text))).toEqual({ a: "\\u0026", b: "\\&" });
    expect(JSON.parse(unescapeGoHtml(text))).toEqual(JSON.parse(text));
  });

  it("[LDB-I9] parseUpstreamJson equals JSON.parse semantically on the upstream-100 snapshot and every key with < > & or a backslash survives", () => {
    const file = path.resolve(import.meta.dirname, "..", "fixtures", "upstream-100", "full.json");
    const text = fs.readFileSync(file, "utf8");
    const reference = JSON.parse(text) as { layouts?: unknown } | unknown[];
    for (let i = 0; i < 5; i++) expect(parseUpstreamJson(text)).toEqual(reference);
    // a synthetic document with every hazardous key shape, Go-escaped as upstream writes them
    const doc = '{"layouts":[' + Array.from({ length: 200 }, (_, i) => `{"name":"l${i}","keys":{"\\u003c":{"row":0},"\\u003e":{"row":1},"\\u0026":{"row":2},"\\\\":{"row":3},"a":{"row":4}}}`).join(",") + "]}";
    const parsed = parseUpstreamJson(doc) as { layouts: Array<{ keys: Record<string, unknown> }> };
    for (const l of parsed.layouts) expect(Object.keys(l.keys).sort()).toEqual(["&", "<", ">", "\\", "a"]);
  });
});
