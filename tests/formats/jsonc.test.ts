// jsonc.ts's stripJsonc/parseJsonc: comment/trailing-comma stripping, and
// that every vendored .jsonc this format ships a committed copy of parses
// to its own committed `.json` (12-implementation-phase5.md §X2's file
// list). Split out from mana2.test.ts (X2's own file list names both).
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseJsonc, stripJsonc } from "../../formats/mana2/1/jsonc.ts";

const MANA2_FIXTURES_DIR = path.resolve(import.meta.dirname, "..", "..", "formats", "mana2", "1", "fixtures");

describe("stripJsonc/parseJsonc", () => {
  const cases: Array<[string, string, unknown]> = [
    ["line comment", '{\n  "a": 1 // trailing\n}', { a: 1 }],
    ["block comment", '{ "a": /* mid */ 1 }', { a: 1 }],
    ["block comment spanning lines", '{\n  "a": 1,\n  /* skip\n     this */\n  "b": 2\n}', { a: 1, b: 2 }],
    ["trailing comma in object", '{ "a": 1, "b": 2, }', { a: 1, b: 2 }],
    ["trailing comma in array", '{ "a": [1, 2, 3,] }', { a: [1, 2, 3] }],
    ["// inside a string is not a comment", '{ "a": "http://example.com" }', { a: "http://example.com" }],
    ["/* inside a string is not a comment", '{ "a": "a /* b */ c" }', { a: "a /* b */ c" }],
    ["a comma right before a quote-adjacent close is not stripped mid-string", '{ "a": "x, " }', { a: "x, " }],
    ["an escaped quote inside a string does not end it", '{ "a": "she said \\"hi\\"" }', { a: 'she said "hi"' }],
    ["a backslash right before a real closing quote", '{ "a": "line\\\\" }', { a: "line\\" }],
    ["unicode escape (mana2's own <, > style)", '{ "a": "\\u003cspace\\u003e" }', { a: "<space>" }],
    ["nested tap-hold/directional text inside a string is untouched", '{ "a": "(<x y> $z)" }', { a: "(<x y> $z)" }],
  ];

  for (const [label, input, expected] of cases) {
    it(`parses: ${label}`, () => {
      expect(parseJsonc(input)).toEqual(expected);
    });
  }

  it("stripJsonc output is itself valid JSON (sanity: JSON.parse doesn't need a second pass)", () => {
    for (const [, input] of cases) {
      expect(() => JSON.parse(stripJsonc(input))).not.toThrow();
    }
  });
});

describe("every committed vendored .jsonc parses to its committed .json", () => {
  const files = fs.readdirSync(MANA2_FIXTURES_DIR).filter((f) => f.endsWith(".jsonc"));

  it("at least the 13 named fixtures carry a committed .jsonc copy", () => {
    expect(files.length).toBeGreaterThanOrEqual(13);
  });

  for (const file of files) {
    const stem = file.slice(0, -".jsonc".length);
    it(`${stem}: parseJsonc(<committed .jsonc>) equals the committed .json`, () => {
      const raw = fs.readFileSync(path.join(MANA2_FIXTURES_DIR, file), "utf8");
      const parsed = parseJsonc(raw);
      const committed = JSON.parse(fs.readFileSync(path.join(MANA2_FIXTURES_DIR, `${stem}.json`), "utf8"));
      expect(parsed).toEqual(committed);
    });
  }
});
