// [LDB-P2] [MF-11 = LDB-P21] `If-Match` (21-formats.md §2.3): a token
// scoped to the write's own scope (`"spark:<rev>"` for a format write,
// `"layout:<rev>"` for a layout write) or `*` succeeds; absent is refused
// with `400 if_match_required`, checked before any read or mutation, never
// treated as a blind overwrite; a stale rev (too low or too high) is `409
// stale` with the current record and its `last_write`; a bare (unscoped)
// number, a token naming the WRONG scope, a weak ETag, or garbage is `400
// bad_request`, never a mismatch. The race: two writes at the same rev, run
// concurrently, land exactly one 200 and one 409 `stale` whose `record` is
// the winner's.
import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Bindings } from "../../src/env";
import { commitWrite, type CommitInput } from "../../src/core/events";
import { fixedClock } from "../../src/core/time";
import { ulid } from "ulidx";
import { AKL_PAYLOAD, actorFixture, register, uniqueName, writeFetch } from "./write-support";

const db = (env as unknown as Bindings).DB;
const clock = fixedClock("2026-07-06T00:00:00.000Z");
const OWNER = "owner-ifmatch-1";
const SOURCE = { client: "discord-app:test", version: null };

afterEach(() => {
  vi.unstubAllGlobals();
});

async function seed() {
  const input: CommitInput = {
    layoutId: ulid(),
    creating: true,
    currentN: 0,
    currentLayout: null,
    currentFormats: new Map(),
    layout: { kind: "created", name: uniqueName("ifmatch-seed"), owner: OWNER, created_at: clock(), deleted: false },
    format: { kind: "format_added", lineage: "spark", format: "spark/1", payload: AKL_PAYLOAD, hasMagic: false },
    modified_at: clock(),
    actor: OWNER,
    via: "discord",
    source: SOURCE,
    upstream: null,
  };
  const { layout, formats } = await commitWrite(db, clock, input);
  return { id: layout.id, layoutRev: layout.layout_rev, formatRev: formats.get("spark")!.rev };
}

function ownerHeaders(token: string) {
  const fake = actorFixture();
  return register(fake, token, OWNER);
}

describe("[MF-11] If-Match on PUT (format scope: spark)", () => {
  const cases: { label: string; header: (rev: number) => string | undefined; status: number; code?: string }[] = [
    { label: "absent", header: () => undefined, status: 400, code: "if_match_required" },
    { label: "*", header: () => "*", status: 200 },
    { label: '"spark:<rev>" (quoted, matching)', header: (rev) => `"spark:${rev}"`, status: 200 },
    { label: "spark:<rev> (bare, matching)", header: (rev) => `spark:${rev}`, status: 200 },
    { label: '"spark:<rev-1>" (stale)', header: (rev) => `"spark:${rev - 1}"`, status: 409 },
    { label: '"spark:<rev+1>" (ahead)', header: (rev) => `"spark:${rev + 1}"`, status: 409 },
    { label: 'W/"spark:<rev>" (weak, refused)', header: (rev) => `W/"spark:${rev}"`, status: 400, code: "bad_request" },
    { label: '"a" (garbage, refused)', header: () => `"a"`, status: 400, code: "bad_request" },
    { label: "<rev> (bare, UNSCOPED -- MF-11 refuses this now)", header: (rev) => `"${rev}"`, status: 400, code: "bad_request" },
    { label: '"layout:<rev>" (WRONG scope -- MF-11)', header: () => `"layout:1"`, status: 400, code: "bad_request" },
  ];

  for (const { label, header, status, code } of cases) {
    it(`PUT If-Match: ${label} -> ${status}`, async () => {
      const record = await seed();
      const headers = ownerHeaders(`tok-put-${uniqueName("t")}`);
      const ifMatch = header(record.formatRev);
      const res = await writeFetch(
        `/v1/layouts/${record.id}`,
        "PUT",
        { ...headers, ...(ifMatch !== undefined ? { "If-Match": ifMatch } : {}) },
        { format: "spark/1", payload: AKL_PAYLOAD },
      );
      expect(res.status, label).toBe(status);
      if (status === 409) {
        const body = await res.json<{ error: string; scope: string; rev: number; record: { formats: Record<string, { rev: number }> }; last_write: { kind: string } }>();
        expect(body.error).toBe("stale");
        expect(body.scope).toBe("spark");
        expect(body.rev).toBe(record.formatRev);
        expect(body.record.formats["spark/1"]!.rev).toBe(record.formatRev);
        expect(body.last_write.kind).toBe("format_added");
      }
      if (status === 400 && code === "bad_request") {
        await expect(res.json()).resolves.toMatchObject({ error: "bad_request", param: "If-Match" });
      }
      if (status === 400 && code === "if_match_required") {
        await expect(res.json()).resolves.toMatchObject({ error: "if_match_required" });
      }
    });
  }
});

describe("[MF-11] If-Match on DELETE (layout scope)", () => {
  const cases: { label: string; header: (rev: number) => string | undefined; status: number; code?: string }[] = [
    { label: "absent", header: () => undefined, status: 400, code: "if_match_required" },
    { label: "*", header: () => "*", status: 200 },
    { label: '"layout:<rev>" (quoted, matching)', header: (rev) => `"layout:${rev}"`, status: 200 },
    { label: '"layout:<rev-1>" (stale)', header: (rev) => `"layout:${rev - 1}"`, status: 409 },
    { label: '"spark:<rev>" (WRONG scope -- MF-11)', header: (rev) => `"spark:${rev}"`, status: 400, code: "bad_request" },
    { label: '"<rev>" (bare, unscoped)', header: (rev) => `"${rev}"`, status: 400, code: "bad_request" },
  ];

  for (const { label, header, status, code } of cases) {
    it(`DELETE If-Match: ${label} -> ${status}`, async () => {
      const record = await seed();
      const headers = ownerHeaders(`tok-del-${uniqueName("t")}`);
      const ifMatch = header(record.layoutRev);
      const res = await writeFetch(`/v1/layouts/${record.id}`, "DELETE", { ...headers, ...(ifMatch !== undefined ? { "If-Match": ifMatch } : {}) });
      expect(res.status, label).toBe(status);
      if (status === 400 && code === "if_match_required") {
        await expect(res.json()).resolves.toMatchObject({ error: "if_match_required" });
      }
      if (status === 400 && code === "bad_request") {
        await expect(res.json()).resolves.toMatchObject({ error: "bad_request", param: "If-Match" });
      }
    });
  }

  it("[LDB-P2] a mismatch writes nothing (layout and events unchanged)", async () => {
    const record = await seed();
    const headers = ownerHeaders("tok-noop");
    const res = await writeFetch(`/v1/layouts/${record.id}`, "PUT", { ...headers, "If-Match": `"spark:${record.formatRev + 5}"` }, { format: "spark/1", payload: AKL_PAYLOAD });
    expect(res.status).toBe(409);
    const row = await db.prepare("SELECT rev FROM layout_formats WHERE layout_id = ? AND lineage = 'spark'").bind(record.id).first<{ rev: number }>();
    expect(row?.rev).toBe(record.formatRev);
    const events = await db.prepare("SELECT COUNT(*) AS n FROM events WHERE layout_id = ?").bind(record.id).first<{ n: number }>();
    expect(events?.n).toBe(2); // just the seed's own created + format_added
  });

  it("[LDB-P2] race: two PUTs at the same rev -> exactly one 200, one 409 stale carrying the winner's record", async () => {
    const record = await seed();
    const fake = actorFixture();
    const headers = register(fake, "tok-race", OWNER);
    const put = (v: number) =>
      writeFetch(`/v1/layouts/${record.id}`, "PUT", { ...headers, "If-Match": `"spark:${record.formatRev}"` }, { format: "spark/1", payload: { ...AKL_PAYLOAD, magic: { notes: `v${v}` } } });

    const [a, b] = await Promise.all([put(1), put(2)]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([200, 409]);

    const winner = a.status === 200 ? a : b;
    const loser = a.status === 200 ? b : a;
    const winnerBody = await winner.json<{ formats: Record<string, { rev: number }>; payload: { magic?: { notes: string } } }>();
    const loserBody = await loser.json<{ record: { formats: Record<string, { rev: number }>; payload: { magic?: { notes: string } } } }>();
    expect(winnerBody.formats["spark/1"]!.rev).toBe(record.formatRev + 1);
    expect(loserBody.record.formats["spark/1"]!.rev).toBe(winnerBody.formats["spark/1"]!.rev);
    expect(loserBody.record.payload.magic?.notes).toBe(winnerBody.payload.magic?.notes);

    const events = await db.prepare("SELECT COUNT(*) AS n FROM events WHERE layout_id = ?").bind(record.id).first<{ n: number }>();
    expect(events?.n).toBe(3); // "created" + "format_added" + exactly one "updated"
  });
});
