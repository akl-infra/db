// The nondeterminism lint (SH9): a replica replays logged statements, so SQL
// that reads the clock or a random source would give every replica a
// different answer. Timestamps and ids come from JS parameters.
export const NONDETERMINISTIC: [name: string, re: RegExp][] = [
  ["random()", /(?<![\w.$])random\s*\(/i],
  ["randomblob()", /(?<![\w.$])randomblob\s*\(/i],
  ["CURRENT_TIMESTAMP/DATE/TIME", /\bCURRENT_(?:TIMESTAMP|DATE|TIME)\b/i],
  ["'now' in a date/time function", /(?<![\w.$])(?:date|time|datetime|julianday|strftime|unixepoch)\s*\([^)]*['"]now['"]/i],
  ["sqlite_version()", /(?<![\w.$])sqlite_(?:version|source_id)\s*\(/i],
];

/** The nondeterministic constructs in `sql`, by name. */
export function nondeterminism(sql: string): string[] {
  return NONDETERMINISTIC.filter(([, re]) => re.test(sql)).map(([name]) => name);
}

/** SQL text with `--` and block comments removed (string literals are respected). */
export function stripSqlComments(sql: string): string {
  let out = "";
  let i = 0;
  while (i < sql.length) {
    const c = sql[i]!;
    if (c === "'" || c === '"' || c === "`") {
      let j = i + 1;
      while (j < sql.length && !(sql[j] === c && sql[j + 1] !== c)) j += sql[j] === c ? 2 : 1;
      out += sql.slice(i, j + 1);
      i = j + 1;
    } else if (c === "-" && sql[i + 1] === "-") {
      const nl = sql.indexOf("\n", i);
      i = nl < 0 ? sql.length : nl;
    } else if (c === "/" && sql[i + 1] === "*") {
      const end = sql.indexOf("*/", i + 2);
      i = end < 0 ? sql.length : end + 2;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}
