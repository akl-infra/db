// A minimal JSONC reader for mana2's own `.jsonc` layout files
// (vendor/mana2/data/layouts/*.jsonc, docs/layouts.md: "JSON files that can
// contain comments and trailing commas"). Strips `//` line comments and
// `/* */` block comments that fall OUTSIDE string literals, then removes
// trailing commas before a closing `]`/`}`, then hands the result to plain
// `JSON.parse`.
//
// Not `core/safejson.ts`'s `parseUpstreamJson`: that function exists to
// undo a specific Go `encoding/json` escaping quirk (`<`/`>`/
// `&` rewritten to literals) in bytes fetched live over HTTP from the
// cmini API (07-implementation-phase1.md's LDB-I9). Mana2's layout files
// are plain local files this repo vendors -- nothing rewrites their bytes
// in flight, so there is no Go-marshal quirk to undo here. Plain
// `JSON.parse` after stripping comments/trailing-commas is the whole job.
//
// Self-contained like every other format module (07 §5): no import of
// core/safejson.ts, no import of src/formats/registry.ts.

// Walks the raw text one code point at a time, copying everything through
// UNCHANGED except: (1) a `//`...end-of-line run outside a string, replaced
// by nothing (the newline itself is kept, so line numbers in a syntax error
// downstream still line up); (2) a `/* ... */` run outside a string,
// dropped entirely. String literals (single- OR double-quoted -- mana2's
// own files use double quotes exclusively, but nothing here assumes that)
// are copied verbatim, INCLUDING any `//`/`/*` they contain, and an escaped
// quote (`\"` inside a `"..."` string) does not end the string.
function stripComments(text: string): string {
  const out: string[] = [];
  let inString = false;
  let quote = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    const next = text[i + 1];

    if (inString) {
      out.push(c);
      if (c === "\\") {
        // Copy the escaped character too, whatever it is (`\"`, `\\`,
        // `\n`, `<`, ...) -- the ONLY job here is to not mistake an
        // escaped quote for the string's end.
        if (next !== undefined) {
          out.push(next);
          i++;
        }
        continue;
      }
      if (c === quote) inString = false;
      continue;
    }

    if (c === '"' || c === "'") {
      inString = true;
      quote = c;
      out.push(c);
      continue;
    }

    if (c === "/" && next === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      // `i` now sits on the newline (or end of text) -- keep it; the
      // outer loop's `i++` will step past it next iteration if present.
      i--;
      continue;
    }

    if (c === "/" && next === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i++; // now on the closing `/`; the outer loop's i++ steps past it
      continue;
    }

    out.push(c);
  }
  return out.join("");
}

// A trailing comma before `]`/`}` (only whitespace between them) is
// dropped. Safe to run AFTER stripComments: no comment markers survive, and
// a comma inside a string was never touched above, but this regex only
// matches a comma immediately followed by close-bracket/brace-and-optional-
// whitespace -- a comma inside a string is essentially never followed
// directly by an unescaped `]`/`}` in valid JSON text without intervening
// non-whitespace, so this is safe in practice for the files this format
// reads (mana2's own vendored layouts; a hand-authored file that manages to
// end a string in `,]` with nothing else between is not something this
// reader needs to defend against -- JSON.parse below is the final judge).
function stripTrailingCommas(text: string): string {
  return text.replace(/,(\s*[\]}])/g, "$1");
}

export function stripJsonc(text: string): string {
  return stripTrailingCommas(stripComments(text));
}

export function parseJsonc(text: string): unknown {
  return JSON.parse(stripJsonc(text));
}
