// [LDB-F9] A held record keeps name/owner/layout_rev and reads as its own
// format (21-formats.md §2.4/§2.5). Under F2, `held` is reachable from a
// single-layout GET only WITHIN one lineage's own chain (an older major
// that can't show a payload the record's current major carries, LDB-F18) --
// asking for a DIFFERENT lineage entirely is simply `404 format_absent`
// now (D3: a layout's formats are independent; a stored-format request
// never tries to translate across lineages, §2.5 "stored formats are
// never derived"). Exercised through the test-only stub lineage
// (`t/1 -> t/2 -> t/3`, `tests/formats/stub-lineage.ts`) rather than a
// bespoke unregistered format, so the SAME chain machinery LDB-F18 already
// proves is under test here too.
import { SELF } from "cloudflare:test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { commitWrite, type CommitInput } from "../../src/core/events";
import { fixedClock } from "../../src/core/time";
import { ulid } from "ulidx";
import { registerForTest } from "../../formats/registry.ts";
import { T1, T2, T3 } from "../formats/stub-lineage.ts";
import { db } from "./support";

describe("[LDB-F9] a record stored at a lineage's latest major, read as an OLDER major", () => {
  let unregister: () => void;
  let recordId: string;

  beforeAll(async () => {
    const un1 = registerForTest(T1);
    const un2 = registerForTest(T2);
    const un3 = registerForTest(T3);
    unregister = () => {
      un3();
      un2();
      un1();
    };
    const input: CommitInput = {
      layoutId: ulid(),
      creating: true,
      currentN: 0,
      currentLayout: null,
      currentFormats: new Map(),
      layout: { kind: "created", name: "held-record", owner: "1", created_at: "2026-06-08T00:00:00.000Z", deleted: false },
      // c: true -> down(t/3 -> t/2) holds (LDB-F18's R3: "held whenever
      // anything would be lost"), so t/3 -> t/1 (two down-steps) holds too.
      format: { kind: "format_added", lineage: "t", format: "t/3", payload: { v: 3, a: 1, b: 2, c: true }, hasMagic: false },
      modified_at: "2026-06-08T00:00:00.000Z",
      actor: "1",
      via: "discord",
      source: { client: "discord-app:test", version: null },
      upstream: null,
    };
    const { layout } = await commitWrite(db, fixedClock("2026-06-08T00:00:00.000Z"), input);
    recordId = layout.id;
  });

  afterAll(() => {
    unregister();
  });

  it("[LDB-F9] lists among live records under its own lineage's format", async () => {
    const res = await SELF.fetch("https://example.com/v1/layouts?format=t/3");
    expect(res.status).toBe(200);
    const body = await res.json<{ items: { id: string; format: string }[] }>();
    const row = body.items.find((i) => i.id === recordId);
    expect(row).toBeDefined();
    expect(row?.format).toBe("t/3");
  });

  it("[LDB-F9] reads as its own (latest) format", async () => {
    const res = await SELF.fetch(`https://example.com/v1/layouts/${recordId}?format=t/3`);
    expect(res.status).toBe(200);
    const body = await res.json<{ payload: unknown; format: string }>();
    expect(body.format).toBe("t/3");
    expect(body.payload).toEqual({ v: 3, a: 1, b: 2, c: true });
  });

  it("[LDB-F9] 409s for the SAME lineage's older major (t/1) with see: 't/3', held: true", async () => {
    const res = await SELF.fetch(`https://example.com/v1/layouts/${recordId}?format=t/1`);
    expect(res.status).toBe(409);
    const body = await res.json<{ error: string; held: boolean; format: string; see?: string }>();
    expect(body.error).toBe("held");
    expect(body.held).toBe(true);
    expect(body.format).toBe("t/1");
    expect(body.see).toBe("t/3");
  });

  it("[MF-10] [LDB-F26] a DIFFERENT lineage entirely (spark/1, which this layout never stored) -> 404 format_absent, never held", async () => {
    const res = await SELF.fetch(`https://example.com/v1/layouts/${recordId}?format=spark/1`);
    expect(res.status).toBe(404);
    const body = await res.json<{ error: string }>();
    expect(body.error).toBe("format_absent");
  });
});
