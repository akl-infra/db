// `If-Match`/`If-None-Match` header parsing (21-formats.md §2.3, MF-11):
// scoped tokens only -- `"layout:3"`, `"spark:7"` (quoted or bare). `*` is
// "any" (overwrite/add on purpose); a bare number, a malformed token, or a
// token naming the WRONG scope is `400 bad_request` (param `If-Match`),
// checked before any read.
import { badRequest, ifMatchRequired } from "./errors";

export type IfMatch = { kind: "absent" } | { kind: "any" } | { kind: "scoped"; scope: string; rev: number };

// `<scope>:<rev>`, quoted or bare -- `scope` is a lowercase-alnum lineage
// name (`spark`, `mana2`, the test lineage `t`) or the literal `layout`.
const SCOPED_RE = /^"?([a-z][a-z0-9]*):(\d+)"?$/;

export function parseIfMatch(header: string | null): IfMatch {
  if (header === null) return { kind: "absent" };
  const trimmed = header.trim();
  if (trimmed === "*") return { kind: "any" };

  // A bare `"3"`/`3` (the OLD unscoped shape) must 400 here, not silently
  // parse as some scope -- `SCOPED_RE` already requires a `:`, so it does.
  const m = SCOPED_RE.exec(trimmed);
  if (m !== null) return { kind: "scoped", scope: m[1]!, rev: Number(m[2]) };

  throw badRequest(`invalid 'If-Match' header '${header}' (expected a scoped token like "layout:3" or "*")`, "If-Match");
}

// MF-11: a write accepts only its own scope's token (or `*`) -- a bare
// number, a malformed token, or a token naming a DIFFERENT scope than this
// write's own is `400 bad_request`, before any read. `expectedScope` is
// `"layout"` for a layout-scope write, or a lineage name for a format-scope
// write.
export type CheckedIfMatch = { any: true } | { rev: number };

export function requireScopedIfMatch(ifMatch: IfMatch, expectedScope: string): CheckedIfMatch {
  if (ifMatch.kind === "absent") throw ifMatchRequired();
  if (ifMatch.kind === "any") return { any: true };
  if (ifMatch.scope !== expectedScope) {
    throw badRequest(`'If-Match' names scope '${ifMatch.scope}', but this write is scoped to '${expectedScope}'`, "If-Match");
  }
  return { rev: ifMatch.rev };
}

// `restore`/`likes` take no `If-Match` at all (unchanged from phase 1);
// this stays for routes that only need "was one supplied at all" without a
// scope check yet to come (none currently -- kept for parity/clarity at
// call sites that used to call the old unscoped `requireIfMatch`).
export function requireIfMatchPresent(ifMatch: IfMatch): void {
  if (ifMatch.kind === "absent") throw ifMatchRequired();
}

// PUT's "add" mode (`If-None-Match: *`, 21-formats.md §2.4): only `*` is
// supported (there is no per-scope "none" token to name -- adding is
// unconditional on any EXISTING value, since by definition there isn't
// one yet).
export type IfNoneMatch = { kind: "absent" } | { kind: "any" };

export function parseIfNoneMatch(header: string | null): IfNoneMatch {
  if (header === null) return { kind: "absent" };
  if (header.trim() === "*") return { kind: "any" };
  throw badRequest(`invalid 'If-None-Match' header '${header}' (only '*' is supported)`, "If-None-Match");
}
