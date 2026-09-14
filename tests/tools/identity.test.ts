// [LDB-G40] The public repo carries exactly one human contributor identity and no
// personal traces: every author/committer reachable from HEAD is on the allow-list,
// no tracked file names a home directory, none carries a personal-mailbox address.
// Generic on purpose: it names what is ALLOWED, never what was removed.
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const ALLOWED = new Set([
  "saltorbit <hi@akl.gg>",
  "saltorbit <saltorbit@outermail.com>", // saltorbit, 2026-09-13: "also this is ok"
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

// A merge commit GitHub itself made (committer `GitHub <noreply@github.com>`,
// two parents) carries as its AUTHOR GitHub's own rendering of the account
// that pressed the button -- the account's GitHub email, which no commit
// in this repo was ever authored with. On a `pull_request` run that is the
// synthetic `refs/pull/N/merge` commit CI checks out (never part of any
// branch); on `main` it is a web-UI merge. Either way the identity to
// audit is in the commits BEHIND it, so the walk starts from its parents
// and the synthetic commit's own author is not counted. Its committer
// (GitHub) is on the allow-list regardless.
const GITHUB_COMMITTER = "GitHub <noreply@github.com>";
function auditRoots(): string[] {
  const [committer, parents] = git(["log", "-1", "--format=%cn <%ce>%n%P", "HEAD"]).split("\n");
  const parentList = (parents ?? "").split(" ").filter(Boolean);
  return committer === GITHUB_COMMITTER && parentList.length >= 2 ? parentList : ["HEAD"];
}

describe("[LDB-G40] one contributor identity, no personal traces", () => {
  it("every identity reachable from HEAD is on the allow-list", () => {
    const ids = new Set(git(["log", "--format=%an <%ae>%n%cn <%ce>", ...auditRoots()]).split("\n").filter(Boolean));
    expect([...ids].filter((id) => !ALLOWED.has(id))).toEqual([]);
  });
  it("no tracked file names a home directory", () => {
    expect(git(["grep", "-I", "-l", "-E", "/Users/[A-Za-z0-9_-]+/|/home/[A-Za-z0-9_-]+/", "--", ...EXCLUDE]).split("\n").filter(Boolean)).toEqual([]);
  });
  it("no tracked file carries a personal-mailbox address", () => {
    expect(git(["grep", "-I", "-l", "-i", "-E", "[a-z0-9._%+-]+@(gmail|icloud|outlook|hotmail|proton|protonmail|yahoo)\\.[a-z]+", "--", ...EXCLUDE]).split("\n").filter(Boolean)).toEqual([]);
  });
});
