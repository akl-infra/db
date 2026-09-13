// [LDB-G40] The public repo carries exactly one human contributor identity and no
// personal traces: every author/committer reachable from HEAD is on the allow-list,
// no tracked file names a home directory, none carries a personal-mailbox address.
// Generic on purpose: it names what is ALLOWED, never what was removed.
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const ALLOWED = new Set([
  "saltorbit <hi@akl.gg>",
  "cmini-live-sync[bot] <actions@github.com>",
  "magic-rules-backup[bot] <actions@github.com>",
  "Claude Code <noreply@anthropic.com>",
  "GitHub <noreply@github.com>",
]);
const EXCLUDE = [".", ":!package-lock.json", ":!*/package-lock.json"];

function git(args: string[]): string {
  try {
    return execFileSync("git", args, { encoding: "utf8", maxBuffer: 1 << 28 });
  } catch (e: any) {
    if (e.status === 1 && !e.stderr) return ""; // git grep: no match
    throw e;
  }
}

describe("[LDB-G40] one contributor identity, no personal traces", () => {
  it("every identity reachable from HEAD is on the allow-list", () => {
    const ids = new Set(git(["log", "--format=%an <%ae>%n%cn <%ce>", "HEAD"]).split("\n").filter(Boolean));
    expect([...ids].filter((id) => !ALLOWED.has(id))).toEqual([]);
  });
  it("no tracked file names a home directory", () => {
    expect(git(["grep", "-I", "-l", "-E", "/Users/[A-Za-z0-9_-]+/|/home/[A-Za-z0-9_-]+/", "--", ...EXCLUDE]).split("\n").filter(Boolean)).toEqual([]);
  });
  it("no tracked file carries a personal-mailbox address", () => {
    expect(git(["grep", "-I", "-l", "-i", "-E", "[a-z0-9._%+-]+@(gmail|icloud|outlook|hotmail|proton|protonmail|yahoo)\\.[a-z]+", "--", ...EXCLUDE]).split("\n").filter(Boolean)).toEqual([]);
  });
});
