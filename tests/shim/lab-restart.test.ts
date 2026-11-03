// POST /__lab/restart on the Node lab server (src/platform/node-lab-server.ts): every mode builds the new replica with the real
// bootReplica over the same log and object store, and the answer says which boot path actually ran. One test per mode, on a
// memory log; the same on DynamoDB Local (snapshot state in the log table) when it is available.
import net from "node:net";
import { afterAll, describe, expect, it } from "vitest";
import { startLabServer, type RestartMode } from "../../src/platform/node-lab-server";
import { startDdbLocal, ENDPOINT } from "./ddb-local";

const ddb = await startDdbLocal();
afterAll(() => ddb.stop());
if (!ddb.available) console.warn(`[lab-restart.test.ts] ddb pass SKIPPED: ${ddb.reason}`);

const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address() as net.AddressInfo;
      s.close(() => resolve(port));
    });
    s.on("error", reject);
  });

interface RestartAnswer {
  ok: boolean;
  match: boolean;
  problems: string[];
  requested: RestartMode;
  path: RestartMode;
  snapshot: string | null;
  snapshotSeq: number | null;
  seq: number;
  alarms: string[];
}

const RESET = ["CREATE TABLE t (id INTEGER PRIMARY KEY AUTOINCREMENT, v TEXT NOT NULL)", "INSERT INTO t (v) VALUES ('a'), ('b')"];

async function lab<T>(base: string, method: string, p: string, body?: unknown): Promise<T> {
  const r = await fetch(base + p, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: body === undefined ? {} : { "content-type": "application/json" } });
  const text = await r.text();
  if (!r.ok) throw new Error(`${method} ${p} -> ${r.status} ${text.slice(0, 300)}`);
  return JSON.parse(text) as T;
}

function suite(kind: "memory" | "ddb"): void {
  const start = async () => {
    const port = await freePort();
    const srv = await startLabServer({ port, repoRoot: process.cwd(), log: kind === "memory" ? "memory" : { ddb: ENDPOINT, tablePrefix: `akldb-labrestart-${process.pid}` } });
    await lab(srv.url, "POST", "/__lab/reset", { statements: RESET, snapshots: true });
    return srv;
  };
  const write = async (srv: Awaited<ReturnType<typeof start>>, v: string) => void (await srv.db().prepare("INSERT INTO t (v) VALUES (?)").bind(v).run());
  const exportOf = (srv: Awaited<ReturnType<typeof start>>) => lab<Record<string, unknown[]>>(srv.url, "GET", "/__lab/export");

  async function once(srv: Awaited<ReturnType<typeof start>>, mode: RestartMode, extra: { fresh?: boolean; variant?: number } = {}): Promise<RestartAnswer> {
    await write(srv, `before-${mode}`);
    const before = await exportOf(srv);
    const a = await lab<RestartAnswer>(srv.url, "POST", "/__lab/restart", { mode, ...extra });
    expect(a.problems).toEqual([]);
    expect(a.match).toBe(true);
    expect(a.path).toBe(mode); // the boot path actually taken is the one asked for
    expect(await exportOf(srv)).toEqual(before); // the state is the same before and after
    expect((await lab<{ ok: boolean; problems: string[] }>(srv.url, "GET", "/__lab/check")).problems).toEqual([]);
    await write(srv, `after-${mode}`); // the server keeps serving with the new replica
    expect(JSON.stringify((await exportOf(srv)).t)).toContain(`after-${mode}`);
    return a;
  }

  describe(`lab restart on a ${kind} log`, () => {
    it("pointer: boots from POINTER, no alarm line; fresh:false replays a tail", async () => {
      const srv = await start();
      try {
        const fresh = await once(srv, "pointer");
        expect(fresh.alarms).toEqual([]);
        expect(fresh.snapshot).toMatch(/^snap\/slot-\d\.sqlite\.zst$/);
        expect(fresh.snapshotSeq).toBe(fresh.seq);
        const tail = await once(srv, "pointer", { fresh: false });
        expect(tail.alarms).toEqual([]);
        expect(tail.snapshotSeq).toBeLessThan(tail.seq);
      } finally {
        await srv.close();
      }
    });

    it("prev: POINTER damaged (every kind of damage), boot takes PREV with exactly one alarm line", async () => {
      const srv = await start();
      try {
        for (const variant of [0, 1, 2, 3]) {
          const a = await once(srv, "prev", { variant });
          expect(a.alarms).toHaveLength(1);
          expect(a.alarms[0]).toMatch(/^akldb-alarm: boot: fallback: pointer unusable: /);
          expect(a.snapshot).toMatch(/^snap\/slot-\d\.sqlite\.zst$/);
          // the damage was undone: POINTER boots again, quietly
          expect((await once(srv, "pointer", { fresh: false })).alarms).toEqual([]);
        }
      } finally {
        await srv.close();
      }
    });

    it("daily: POINTER and PREV damaged, boot takes the newest verified daily (one alarm line per unusable snapshot)", async () => {
      const srv = await start();
      try {
        for (const variant of [0, 5, 10, 15]) {
          const a = await once(srv, "daily", { variant });
          expect(a.snapshot).toMatch(/^snap\/daily\/\d\d\.sqlite\.zst$/);
          expect(a.alarms).toHaveLength(2);
          expect(a.alarms[0]).toMatch(/^akldb-alarm: boot: fallback: pointer unusable: /);
          expect(a.alarms[1]).toMatch(/^akldb-alarm: boot: fallback: prev unusable: /);
          expect((await once(srv, "pointer", { fresh: false })).alarms).toEqual([]);
        }
      } finally {
        await srv.close();
      }
    });

    it("replay: no snapshot, replays from seq 0, no alarm line; a restart without a body is the same", async () => {
      const srv = await start();
      try {
        const a = await once(srv, "replay");
        expect(a.alarms).toEqual([]);
        expect(a.snapshot).toBeNull();
        const b = await lab<RestartAnswer>(srv.url, "POST", "/__lab/restart");
        expect(b.path).toBe("replay");
        const stats = await lab<{ restarts: { requested: Record<string, number>; path: Record<string, number>; mismatches: number } }>(srv.url, "GET", "/__lab/stats");
        expect(stats.restarts.requested).toEqual(stats.restarts.path); // every restart took the path it asked for
        expect(stats.restarts.mismatches).toBe(0);
      } finally {
        await srv.close();
      }
    });

    it("a snapshot mode needs a world reset with snapshots", async () => {
      const port = await freePort();
      const srv = await startLabServer({ port, repoRoot: process.cwd(), log: kind === "memory" ? "memory" : { ddb: ENDPOINT, tablePrefix: `akldb-labrestart-${process.pid}` } });
      try {
        await lab(srv.url, "POST", "/__lab/reset", { statements: RESET });
        const r = await fetch(`${srv.url}/__lab/restart`, { method: "POST", body: JSON.stringify({ mode: "pointer" }) });
        expect(r.status).toBe(409);
      } finally {
        await srv.close();
      }
    });
  });
}

suite("memory");
if (ddb.available) suite("ddb");
