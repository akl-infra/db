// `If-Match` header parsing (09 §2.3, 03 §1). `"3"` (quoted, RFC 7232
// strong form -- what the site sends) and bare `3` both parse to `rev: 3`;
// `*` = any (overwrite on purpose, same as absent); `W/"3"`, a
// comma-separated list, or anything else that isn't one of the above is a
// malformed header, not a mismatch -- 400, not 409.
import { badRequest, ifMatchRequired } from "./errors";

export type IfMatch = { kind: "absent" } | { kind: "any" } | { kind: "rev"; rev: number };

export function parseIfMatch(header: string | null): IfMatch {
  if (header === null) return { kind: "absent" };
  const trimmed = header.trim();
  if (trimmed === "*") return { kind: "any" };

  const quoted = /^"(\d+)"$/.exec(trimmed);
  if (quoted !== null) return { kind: "rev", rev: Number(quoted[1]) };

  if (/^\d+$/.test(trimmed)) return { kind: "rev", rev: Number(trimmed) };

  throw badRequest(`invalid 'If-Match' header '${header}'`, "If-Match");
}

// saltorbit's rule (2026-09-09, LDB-P2): a write against an EXISTING record
// must name the version it saw -- `absent` is refused, not treated as a
// blind overwrite (`*` still means "overwrite on purpose", but the client
// must say so explicitly). Called first thing in each affected write
// pipeline function (`core/write.ts`), before `loadForWrite` touches D1:
// "refuse before any read or mutation". `POST /v1/layouts` (creation),
// likes, `restore` (no prior draft to be stale against) and the import
// path never call this.
export function requireIfMatch(ifMatch: IfMatch): void {
  if (ifMatch.kind === "absent") throw ifMatchRequired();
}
