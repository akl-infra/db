// [LDB-WPM18] migrations/0036_discord_users.sql is purely additive: new
// tables and triggers only (docs/decisions/28-wpm-records.md). Complements
// LDB-G15's forbidden-statement scan with a positive allow-list.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("[LDB-WPM18] migration 0036 is purely additive", () => {
  it("[LDB-WPM18] creates only discord_users, its head and their triggers; no existing table, column or row is touched", () => {
    const sql = fs.readFileSync(path.resolve(import.meta.dirname, "../../migrations/0036_discord_users.sql"), "utf8")
      .split("\n").map((l) => l.replace(/--.*$/, "")).join("\n");
    // a trigger body holds its own `;`, so a trigger is matched through its END
    const statements = [...sql.matchAll(/\s*(CREATE TRIGGER[\s\S]*?\bEND\s*;|[^;]+;)/g)].map((m) => m[1]!.trim());
    expect(statements.length).toBeGreaterThan(0);
    for (const s of statements) {
      expect(s, s).toMatch(/^(CREATE TABLE discord_users(_head)? \(|CREATE TRIGGER discord_users_head_on_(insert|rename) |INSERT INTO discord_users_head )/);
    }
    // the triggers' own UPDATE touches only the new head table
    expect(sql.match(/\bUPDATE\s+(?!OF\b)\w+/g)?.every((m) => m.endsWith("discord_users_head"))).toBe(true);
    expect(sql).not.toMatch(/\b(ALTER|DROP|DELETE)\b/i);
  });
});
