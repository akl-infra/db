// [LDB-G40] No personal traces in tracked files: none names a home directory,
// none carries a personal-mailbox address. Commit identities are not checked:
// this is a community repo and any contributor may author commits.
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const EXCLUDE = [".", ":!package-lock.json", ":!*/package-lock.json"];

function git(args: string[]): string {
  try {
    return execFileSync("git", args, { encoding: "utf8", maxBuffer: 1 << 28 });
  } catch (e: any) {
    if (e.status === 1 && !e.stderr) return ""; // git grep: no match
    throw e;
  }
}

describe("[LDB-G40] no personal traces", () => {
  it("no tracked file names a home directory", () => {
    expect(git(["grep", "-I", "-l", "-E", "/Users/[A-Za-z0-9_-]+/|/home/[A-Za-z0-9_-]+/", "--", ...EXCLUDE]).split("\n").filter(Boolean)).toEqual([]);
  });
  it("no tracked file carries a personal-mailbox address", () => {
    expect(git(["grep", "-I", "-l", "-i", "-E", "[a-z0-9._%+-]+@(gmail|icloud|outlook|hotmail|proton|protonmail|yahoo)\\.[a-z]+", "--", ...EXCLUDE]).split("\n").filter(Boolean)).toEqual([]);
  });
});
