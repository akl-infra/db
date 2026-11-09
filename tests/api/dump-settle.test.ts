// [LDB-ST2] A dump is validated against the event head: the head read after the tables must still equal the `meta.seq` read
// before them, else a write landed while they were read and the read starts over (DUMP_ATTEMPTS). Here a REAL write is
// interleaved between the table reads (a hook on the D1 binding fires it just before the `layout_formats` pager runs, after
// `meta` and possibly after `events`/`layout_revs`), with no timers: the hook is the interleaving. Runs on D1 (workers) and
// on the shim (the AWS replica's D1), the two backends `Store.dump.tables()` has.
import { env } from "../harness";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Bindings } from "../../src/env";
import { DUMP_ATTEMPTS, buildDumpChecked, readDumpState, writeDump } from "../../src/dump/write";
import { fixedClock } from "../../src/core/time";
import { actorFixture, register, uniqueName, writeFetch } from "./write-support";

const clock = fixedClock("2026-11-09T00:00:00.000Z");
type Stmt = { bind: (...a: unknown[]) => Stmt; all: (...a: unknown[]) => Promise<unknown> } & Record<string, unknown>;

function hookedEnv(trigger: (sql: string) => Promise<void>): Bindings {
  const wrap = (st: Stmt, sql: string): Stmt =>
    new Proxy(st, {
      get(t, k) {
        if (k === "bind") return (...a: unknown[]) => wrap(t.bind(...a), sql);
        if (k === "all") return async (...a: unknown[]) => { await trigger(sql); return t.all(...a); };
        const v = t[k as string];
        return typeof v === "function" ? (v as (...x: unknown[]) => unknown).bind(t) : v;
      },
    });
  const db = (env as unknown as { DB: Record<string, unknown> & { prepare: (s: string) => Stmt } }).DB;
  const hooked = new Proxy(db, {
    get(t, k) {
      if (k === "prepare") return (sql: string) => wrap(t.prepare(sql), sql);
      const v = t[k as string];
      return typeof v === "function" ? (v as (...x: unknown[]) => unknown).bind(t) : v;
    },
  });
  return new Proxy(env as unknown as Bindings, { get: (t, k) => (k === "DB" ? hooked : (t as unknown as Record<string | symbol, unknown>)[k]) });
}

async function setup() {
  const headers = register(actorFixture(), "settle-token", "settle-owner");
  const created = await writeFetch("/v1/layouts", "POST", headers, { name: uniqueName("settle"), format: "spark/1", payload: { keys: [{ char: "a", row: 0, col: 0, finger: "LI" }] } });
  const id = (await created.json<{ id: string }>()).id;
  let rev = 1;
  const write = async () => {
    const res = await writeFetch(`/v1/layouts/${id}`, "PUT", { ...headers, "If-Match": `"spark:${rev}"` }, { format: "spark/1", payload: { keys: [{ char: "a", row: 0, col: 0, finger: "LI" }, { char: String.fromCharCode(98 + rev), row: 0, col: 1, finger: "LM" }] } });
    expect(res.status).toBe(200);
    rev++;
  };
  return { id, write };
}

afterEach(() => vi.unstubAllGlobals());

describe("[LDB-ST2] dump validate-and-retry", () => {
  it("[LDB-ST2] a write landing between the table reads makes the dump re-read once, and the result is one consistent state", async () => {
    const { id, write } = await setup();
    let fired = 0;
    const e = hookedEnv(async (sql) => {
      if (fired === 0 && /FROM layout_formats/.test(sql)) { fired++; await write(); }
    });
    const built = await buildDumpChecked(e, clock);
    expect(fired).toBe(1);
    expect(built.attempts).toBe(2);
    expect(built.settled).toBe(true);
    const { dump } = built;
    const bumping = dump.events.filter((x) => x.rev !== null);
    expect(dump.layout_revs.length).toBe(bumping.length);
    expect(dump.meta.seq).toBe(dump.events.length);
    const fmt = dump.layout_formats.find((f) => f.layout_id === id)!;
    const hist = dump.layout_revs.filter((r) => r.layout_id === id && r.lineage === "spark");
    expect(fmt.rev).toBe(2); // the interleaved write is in, in every table
    expect(hist.length).toBe(2);
    expect(fmt.payload_json).toBe(hist[hist.length - 1]!.payload_json);
    expect(dump.records.find((l) => l.id === id)!.n).toBe(hist.length + 1); // layout create + 2 format revs
  });

  it("[LDB-ST2] a dump whose reads are disturbed on every attempt stops after DUMP_ATTEMPTS, is written, and is flagged", async () => {
    const { write } = await setup();
    let fired = 0, armed = true;
    const e = hookedEnv(async (sql) => {
      if (armed && /FROM layout_formats/.test(sql) && fired < 10) { armed = false; fired++; await write(); armed = true; }
    });
    const alarm = vi.spyOn(console, "error").mockImplementation(() => {});
    const built = await buildDumpChecked(e, clock);
    expect(built.attempts).toBe(DUMP_ATTEMPTS);
    expect(built.settled).toBe(false);
    const before = fired;
    await writeDump(e, clock);
    expect(fired).toBeGreaterThan(before);
    expect(alarm.mock.calls.some((c) => String(c[0]).startsWith("akldb-alarm: dump-unsettled:"))).toBe(true);
    expect((await readDumpState(e.DB))!.unsettled).toEqual({ attempts: DUMP_ATTEMPTS });
    alarm.mockRestore();
  });

  it("[LDB-ST2] an undisturbed dump settles on the first read and records no flag", async () => {
    await setup();
    const built = await buildDumpChecked(env as unknown as Bindings, clock);
    expect(built.attempts).toBe(1);
    expect(built.settled).toBe(true);
    await writeDump(env as unknown as Bindings, clock);
    expect((await readDumpState((env as unknown as Bindings).DB))!.unsettled).toBeUndefined();
  });
});
