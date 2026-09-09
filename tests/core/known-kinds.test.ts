// KNOWN_KINDS (src/routes/changes.ts) once went stale: `InfoKind` gained
// `admin.client_registered`/`admin.client_revoked` (10 C1) without ever
// being added to the hand-typed literal array webhook/stream `kinds=`
// validation reads, so a caller subscribed to either one got a spurious
// "unknown kind" 400. KNOWN_KINDS is now DERIVED from an exhaustive
// `Record<WriteKind, true>` / `Record<InfoKind, true>` pair, which fails to
// *compile* if either type gains or loses a member -- that structural fix
// lives in changes.ts itself. This file is the independent, source-text
// regression check for the specific incident: it re-parses `WriteKind`'s
// and `InfoKind`'s own union literals straight out of core/events.ts (never
// re-deriving them from the same types changes.ts already trusts) and
// cross-checks against the live KNOWN_KINDS export, so a future rewrite
// that quietly reverts to a hand-typed list is caught here too, not just by
// the type system.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { KNOWN_KINDS } from "../../src/routes/changes";

const EVENTS_SRC_PATH = path.join(import.meta.dirname, "..", "..", "src", "core", "events.ts");
const eventsSrc = fs.readFileSync(EVENTS_SRC_PATH, "utf8");

function extractUnionMembers(typeName: string): string[] {
  const re = new RegExp(`export type ${typeName} =([\\s\\S]*?);`);
  const m = re.exec(eventsSrc);
  if (m === null) throw new Error(`could not find 'export type ${typeName}' in ${EVENTS_SRC_PATH}`);
  return [...m[1]!.matchAll(/"([^"]+)"/g)].map((mm) => mm[1]!);
}

describe("KNOWN_KINDS is exhaustive over WriteKind | InfoKind | 'liked' | 'unliked'", () => {
  it("every WriteKind member (core/events.ts) appears in KNOWN_KINDS", () => {
    const members = extractUnionMembers("WriteKind");
    expect(members.length).toBeGreaterThan(0); // sanity: the regex actually matched something
    for (const m of members) expect(KNOWN_KINDS, `WriteKind member '${m}' is missing from KNOWN_KINDS`).toContain(m);
  });

  it("every InfoKind member (core/events.ts) appears in KNOWN_KINDS -- incl. admin.client_registered/admin.client_revoked", () => {
    const members = extractUnionMembers("InfoKind");
    expect(members.length).toBeGreaterThan(0);
    for (const m of members) expect(KNOWN_KINDS, `InfoKind member '${m}' is missing from KNOWN_KINDS`).toContain(m);
    expect(members).toContain("admin.client_registered");
    expect(members).toContain("admin.client_revoked");
  });

  it("'liked' and 'unliked' are present (never rev-bumping, not part of either union)", () => {
    expect(KNOWN_KINDS).toContain("liked");
    expect(KNOWN_KINDS).toContain("unliked");
  });

  it("KNOWN_KINDS has no member outside WriteKind ∪ InfoKind ∪ {liked, unliked}", () => {
    const allowed = new Set([...extractUnionMembers("WriteKind"), ...extractUnionMembers("InfoKind"), "liked", "unliked"]);
    for (const k of KNOWN_KINDS) expect(allowed, `KNOWN_KINDS has an unexpected member '${k}'`).toContain(k);
  });

  it("KNOWN_KINDS has no duplicate entries", () => {
    expect(new Set(KNOWN_KINDS).size).toBe(KNOWN_KINDS.length);
  });
});
