// A small TypeScript string-literal scanner for the SQL lints (SH1 compiles
// every static SQL string in store/d1; SH9 greps SQL strings for
// nondeterminism). Comments are skipped; template literals are returned with
// their `${...}` holes replaced by U+0000 and flagged dynamic; literals inside
// a hole are returned too.
import fs from "node:fs";
import path from "node:path";

export interface Literal {
  text: string;
  dynamic: boolean;
  line: number;
}

export function scanLiterals(src: string): Literal[] {
  const out: Literal[] = [];
  let i = 0;
  let line = 1;
  const n = src.length;

  const lineAt = (pos: number): number => {
    let l = 1;
    for (let k = 0; k < pos; k++) if (src[k] === "\n") l++;
    return l;
  };
  void line;

  function skipRegexOrDivide(prev: string): boolean {
    // `/` starts a regex literal when the previous significant char cannot end an expression.
    return prev === "" || "(,=:[!&|?{};+-*%<>~^".includes(prev);
  }

  function code(stopAtBrace: boolean): void {
    let depth = 0;
    let prev = "";
    while (i < n) {
      const c = src[i]!;
      if (c === "/" && src[i + 1] === "/") {
        while (i < n && src[i] !== "\n") i++;
      } else if (c === "/" && src[i + 1] === "*") {
        const end = src.indexOf("*/", i + 2);
        i = end < 0 ? n : end + 2;
      } else if (c === "'" || c === '"') {
        const start = i;
        i++;
        let text = "";
        while (i < n && src[i] !== c) {
          if (src[i] === "\\") {
            text += src[i + 1] ?? "";
            i += 2;
          } else {
            text += src[i];
            i++;
          }
        }
        i++;
        out.push({ text, dynamic: false, line: lineAt(start) });
        prev = c;
      } else if (c === "`") {
        template();
        prev = "`";
      } else if (c === "/" && skipRegexOrDivide(prev)) {
        i++;
        let inClass = false;
        while (i < n && (src[i] !== "/" || inClass)) {
          if (src[i] === "\\") i++;
          else if (src[i] === "[") inClass = true;
          else if (src[i] === "]") inClass = false;
          i++;
        }
        i++;
        prev = ")";
      } else if (c === "{") {
        depth++;
        i++;
        prev = c;
      } else if (c === "}") {
        if (stopAtBrace && depth === 0) {
          i++;
          return;
        }
        depth--;
        i++;
        prev = c;
      } else {
        if (!/\s/.test(c)) prev = c;
        i++;
      }
    }
  }

  function template(): void {
    const start = i;
    i++; // opening backtick
    let text = "";
    let dynamic = false;
    while (i < n && src[i] !== "`") {
      if (src[i] === "\\") {
        text += src[i + 1] ?? "";
        i += 2;
      } else if (src[i] === "$" && src[i + 1] === "{") {
        dynamic = true;
        text += "\u0000";
        i += 2;
        code(true);
      } else {
        text += src[i];
        i++;
      }
    }
    i++;
    out.push({ text, dynamic, line: lineAt(start) });
  }

  code(false);
  return out;
}

/** Looks like SQL rather than prose. */
export function looksLikeSql(text: string): boolean {
  return /\b(SELECT\b[\s\S]*\bFROM|SELECT\s+(changes|last_insert_rowid|\d)|INSERT\s+(OR\s+\w+\s+)?INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM|CREATE\s+(TABLE|TRIGGER|INDEX|UNIQUE|VIEW)|WITH\s+\w+(\s*\([^)]*\))?\s+AS\b)/i.test(text);
}

export function walkFiles(dir: string, ext: RegExp): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walkFiles(full, ext));
    else if (ext.test(e.name)) out.push(full);
  }
  return out;
}
