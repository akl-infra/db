// [LDB-MIR21..] The mirror's pure checks and the replay allowlist (lane Z).
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ApiError } from "../../src/core/errors";
import { encodeTee } from "../../src/mirror/record";
import { canonical, compareClockReads, compareOutcome, compareSeqs, compareTables, isMirrorWrite, MIRROR_NEVER, MIRROR_WRITES, outcomeOfError, outcomeOfResult, seqsBetween } from "../../src/mirror/verify";

const PORT = fs.readFileSync(path.resolve(import.meta.dirname, "../../src/store/port.ts"), "utf8");

/** area -> methods whose first doc sentence does not say "read", from src/store/port.ts. */
function portWrites(): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const areaName: Record<string, string> = { Head: "head", State: "state", LayoutRead: "layouts", Event: "events", Hold: "holds", Cutover: "cutover", Auth: "auth", Admin: "admin", Link: "links", Wpm: "wpm", Comment: "comments", Review: "review", Modqueue: "modqueue", Discord: "discord", Outbox: "outbox", Dump: "dump" };
  let area: string | null = null;
  let doc: string | null = null;
  for (const line of PORT.split("\n")) {
    const a = /^export interface (\w+)Store \{/.exec(line);
    if (a) {
      area = areaName[a[1]!] ?? null;
      continue;
    }
    if (/^\}/.test(line)) area = null;
    if (area === null) continue;
    const d = /^\s*\/\*\*\s*(.*)/.exec(line);
    if (d) doc = d[1]!;
    const m = /^\s+(\w+)\??\(/.exec(line);
    if (m && doc !== null) {
      const first = doc.split(/\.\s/)[0]!;
      if (!/\bread\b/.test(first)) out.set(area, [...(out.get(area) ?? []), m[1]!]);
      doc = null;
    }
  }
  return out;
}

describe("mirror verify", () => {
  it("[LDB-MIR21] every non-read method of the port is either replayed or on the never list, and nothing else is replayed", () => {
    const writes = portWrites();
    const all = [...writes.entries()].flatMap(([a, ms]) => ms.map((m) => `${a}.${m}`)).sort();
    const known = [...Object.entries(MIRROR_WRITES).flatMap(([a, ms]) => ms.map((m) => `${a}.${m}`)), ...MIRROR_NEVER].sort();
    expect(known).toEqual(all);
    expect(isMirrorWrite("events.feed")).toBe(false);
    expect(isMirrorWrite("auth.hitWindow")).toBe(false);
    expect(isMirrorWrite("events.commitWrite")).toBe(true);
  });

  it("[LDB-MIR22] outcomes: results deep-equal, errors by class+status+body (message ignored), key order irrelevant", () => {
    expect(compareOutcome({ ok: { a: 1, b: [1, { c: 2 }] } }, { ok: { b: [1, { c: 2 }], a: 1 } })).toBeNull();
    expect(compareOutcome({ ok: { a: 1 } }, { ok: { a: 2 } })?.kind).toBe("outcome");
    expect(compareOutcome({ ok: encodeTee(new Map([["k", 1]])) }, outcomeOfResult(new Map([["k", 1]])))).toBeNull();
    const e1 = outcomeOfError(new ApiError(409, { error: "conflict", message: "one" }));
    const e2 = outcomeOfError(new ApiError(409, { error: "conflict", message: "one" }));
    expect(compareOutcome(e1, e2)).toBeNull();
    expect(compareOutcome(e1, outcomeOfError(new ApiError(404, { error: "not_found", message: "x" })))?.detail).toBe("errors differ");
    expect(compareOutcome(e1, { ok: null })?.detail).toBe("prod threw, mirror returned");
    expect(compareOutcome({ ok: null }, e1)?.detail).toBe("prod returned, mirror threw");
    expect((e1 as { error: { name: string } }).error.name).toBe("ApiError");
  });

  it("[LDB-MIR23] seqs and clock reads", () => {
    expect(seqsBetween(4, 7)).toEqual([5, 6, 7]);
    expect(seqsBetween(4, 4)).toEqual([]);
    expect(compareSeqs([5, 6], [5, 6])).toBeNull();
    expect(compareSeqs([5, 6], [5])?.kind).toBe("seqs");
    expect(compareClockReads([2, 1], [2, 1])).toBeNull();
    expect(compareClockReads([2], [3])?.kind).toBe("clock");
    expect(canonical({ b: undefined, a: [undefined, 1] })).toBe('{"a":[null,1]}');
  });

  it("[LDB-MIR24] compareTables: multiset per table, ephemeral tables ignored, differences sampled", () => {
    const a = { layouts: [{ id: "1", n: 1 }, { id: "2", n: 2 }], nonces: [{ k: "x" }] };
    expect(compareTables(a, { layouts: [{ n: 2, id: "2" }, { n: 1, id: "1" }], nonces: [] })).toEqual([]);
    const d = compareTables(a, { layouts: [{ id: "1", n: 1 }, { id: "2", n: 3 }] });
    expect(d).toHaveLength(1);
    expect(d[0]!.table).toBe("layouts");
    expect(d[0]!.rows).toEqual([2, 2]);
    expect(d[0]!.onlyLeft).toHaveLength(1);
    expect(compareTables({ t: [] }, { u: [{ a: 1 }] }).map((x) => x.table)).toEqual(["u"]);
  });
});
