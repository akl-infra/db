#!/usr/bin/env node
// db/scripts/gen-error-table.mjs -- LDB-G8: the error-code appendix in
// db/INTEGRATION.md is generated from `src/core/errors.ts`'s own `ApiError`
// factories, not retyped by hand, so the doc cannot silently drift from the
// real vocabulary (`db/tests/tools/error-table.test.ts` asserts the
// committed doc's table equals this script's output, the same "generator +
// --check" shape `codeowners.mjs`/`gen-vectors.mjs` already use here).
//
// Parses the source as text, not a real AST: every factory in errors.ts is
// one function of the shape
//
//   export function name(args): ApiError {
//     ...
//     return new ApiError(STATUS, { error: "code", message: ..., ... }, headers?);
//   }
//
// and every one of those function bodies runs from its own `export
// function` line to the very next column-0 `}` (verified: `grep -n
// '^export function\|^}' src/core/errors.ts` -- no nested top-level
// function needs a real parser here). `message` is either a string/
// template literal (shown as written, `${…}` placeholders included) or an
// ES6 shorthand property (`message,`/`message }` -- the function's own
// `message` parameter, i.e. caller-supplied text that varies per call
// site); either way this script shows exactly what the source says, never
// invents wording.
//
// Usage:
//   node db/scripts/gen-error-table.mjs            # prints the markdown table
//   node db/scripts/gen-error-table.mjs --check     # exits 1 if
//                                                     INTEGRATION.md's
//                                                     table would differ;
//                                                     prints nothing
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DB_ROOT = path.resolve(fileURLToPath(import.meta.url), "..", "..");
const ERRORS_FILE = path.join(DB_ROOT, "src", "core", "errors.ts");
const DOC_FILE = path.join(DB_ROOT, "INTEGRATION.md");

const BEGIN_MARKER = "<!-- BEGIN GENERATED ERROR TABLE (db/scripts/gen-error-table.mjs) -->";
const END_MARKER = "<!-- END GENERATED ERROR TABLE -->";

// Top-level-comma param names only, types stripped -- a reader of the
// table wants "which arguments shape this error", not TS's `Record<...>
// & {...}` or a union type that would itself contain a raw `|` and break
// the markdown table's own column separator (rateLimited's `scope:
// "actor" | "client"` is exactly this case). Depth-aware so a param's own
// `<...>`/`{...}`/`(...)` never gets mistaken for a param boundary.
function paramNames(raw) {
  if (raw.trim() === "") return "";
  const parts = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (ch === "<" || ch === "{" || ch === "(" || ch === "[") depth++;
    else if (ch === ">" || ch === "}" || ch === ")" || ch === "]") depth--;
    else if (ch === "," && depth === 0) {
      parts.push(raw.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(raw.slice(start));
  return parts
    .map((p) => /^\s*([A-Za-z_$][\w$]*)\??\s*:/.exec(p)?.[1] ?? p.trim())
    .join(", ");
}

// @returns {{name: string, params: string, status: string, code: string, message: string}[]}
export function parseErrors(src = fs.readFileSync(ERRORS_FILE, "utf8")) {
  const lines = src.split("\n");
  const rows = [];

  for (let i = 0; i < lines.length; i++) {
    const head = /^export function (\w+)\(([^)]*)\): ApiError \{$/.exec(lines[i]);
    if (!head) continue;
    const [, name, rawParams] = head;

    let end = i + 1;
    while (end < lines.length && lines[end] !== "}") end++;
    if (end >= lines.length) throw new Error(`gen-error-table: ${name}() never closes (no column-0 '}' found)`);
    const body = lines.slice(i + 1, end).join("\n");

    const open = /new ApiError\(\s*(\d+),\s*\{/.exec(body);
    if (!open) throw new Error(`gen-error-table: no 'new ApiError(status, {...})' found in ${name}()`);
    const status = open[1];
    // Balanced-brace scan from just after the object literal's opening
    // `{` -- the body's `error`/`message`/… object may close on the same
    // line as `new ApiError(` (badRequest) or several lines later
    // (stale, rateLimited), and may itself contain nested `{}` (nameTaken's
    // `holder`, notFound's spread) -- a fixed-shape regex can't span both,
    // a depth counter can.
    const objStart = open.index + open[0].length;
    let depth = 1;
    let k = objStart;
    for (; k < body.length && depth > 0; k++) {
      if (body[k] === "{") depth++;
      else if (body[k] === "}") depth--;
    }
    if (depth !== 0) throw new Error(`gen-error-table: unbalanced '{' in ${name}()'s ApiError body`);
    const obj = body.slice(objStart, k - 1);

    const codeMatch = /error:\s*"([a-z_]+)"/.exec(obj);
    if (!codeMatch) throw new Error(`gen-error-table: no 'error: "..."' found in ${name}()`);
    const code = codeMatch[1];

    const literal = /message:\s*(`[^`]*`|"[^"]*")/.exec(obj);
    let message;
    if (literal) {
      message = literal[1].slice(1, -1);
    } else if (/\bmessage\b\s*[,}]/.test(obj)) {
      // ES6 shorthand: the object literal writes bare `message`, so the
      // text is whatever the caller passed as this function's own
      // `message` parameter -- different at every call site.
      message = "*(caller-supplied -- this function's own `message` parameter)*";
    } else {
      throw new Error(`gen-error-table: no 'message' found in ${name}()'s ApiError body`);
    }

    rows.push({ name, params: paramNames(rawParams), status, code, message });
  }

  if (rows.length === 0) throw new Error("gen-error-table: found zero ApiError factories -- errors.ts's shape changed");
  return rows;
}

export function generate() {
  const rows = parseErrors();
  const header = "| status | error | message | thrown by |\n|---|---|---|---|";
  const body = rows
    .map((r) => `| ${r.status} | \`${r.code}\` | ${r.message.replace(/\|/g, "\\|")} | \`${r.name}(${r.params})\` |`)
    .join("\n");
  return `${header}\n${body}`;
}

function currentDocTable() {
  if (!fs.existsSync(DOC_FILE)) return null;
  const text = fs.readFileSync(DOC_FILE, "utf8");
  const start = text.indexOf(BEGIN_MARKER);
  const stop = text.indexOf(END_MARKER);
  if (start === -1 || stop === -1 || stop < start) return null;
  return text.slice(start + BEGIN_MARKER.length, stop).trim();
}

const table = generate();

if (process.argv.includes("--check")) {
  const existing = currentDocTable();
  if (existing !== table) {
    console.error("gen-error-table.mjs --check: db/INTEGRATION.md's error table does not match src/core/errors.ts.");
    console.error(`Regenerate it between ${BEGIN_MARKER} / ${END_MARKER} with: node db/scripts/gen-error-table.mjs`);
    process.exit(1);
  }
  process.exit(0);
}

console.log(table);
