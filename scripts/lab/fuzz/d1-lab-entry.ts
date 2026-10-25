// The D1 Worker the fuzzer treats as the oracle (lane L): src/index.ts behind
// the same determinism overrides as scripts/lab/p1-crawl-diff.mjs's
// `.lab-entry.ts` (frozen `Date`, seeded `crypto`, both keyed on the
// `x-lab-now` / `x-lab-seed` request headers). Run by `wrangler dev --local`;
// scripts/lab/serve-ddb.mjs applies the same overrides on the DynamoDB side.
import app from "../../../src/index.ts";

const RealDate = Date;
let frozenMs = RealDate.parse("2026-10-25T12:00:00.000Z");
class LabDate extends RealDate {
  constructor(...args: any[]) {
    if (args.length === 0) super(frozenMs);
    else super(...(args as [any]));
  }
  static now() {
    return frozenMs;
  }
}
(globalThis as any).Date = LabDate;
let state = 1;
function next(): number {
  state = (state + 0x6d2b79f5) | 0;
  let t = Math.imul(state ^ (state >>> 15), 1 | state);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return (t ^ (t >>> 14)) >>> 0;
}
function fill(arr: ArrayBufferView): ArrayBufferView {
  const u8 = new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);
  for (let i = 0; i < u8.length; i++) u8[i] = next() & 0xff;
  return arr;
}
Object.defineProperty(crypto, "getRandomValues", { configurable: true, writable: true, value: fill });
Object.defineProperty(crypto, "randomUUID", {
  configurable: true,
  writable: true,
  value: () => {
    const b = new Uint8Array(16);
    fill(b);
    b[6] = (b[6]! & 0x0f) | 0x40;
    b[8] = (b[8]! & 0x3f) | 0x80;
    const h = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
    return h.slice(0, 8) + "-" + h.slice(8, 12) + "-" + h.slice(12, 16) + "-" + h.slice(16, 20) + "-" + h.slice(20);
  },
});
function arm(req: Request) {
  const n = req.headers.get("x-lab-now");
  if (n !== null) frozenMs = RealDate.parse(n);
  const s = req.headers.get("x-lab-seed");
  if (s !== null) state = Number(s) >>> 0;
}
export default {
  async fetch(req: Request, env: unknown, ctx: unknown) {
    // Lane F: rebuild the database in place from the runner's reset script (statements = one string each), so each fuzz
    // sequence starts from the seeded template without a wrangler restart. Lab only; never part of the app.
    if (req.method === "POST" && new URL(req.url).pathname === "/__lab/reset") {
      const db = (env as { DB: D1Database }).DB;
      const { statements } = (await req.json()) as { statements: string[] };
      await db.batch(statements.map((s) => db.prepare(s)));
      // the dump bucket is state too
      const r2 = (env as { DUMPS?: R2Bucket }).DUMPS;
      if (r2 !== undefined) {
        for (let listed = await r2.list(); ; listed = await r2.list({ cursor: listed.truncated ? listed.cursor : undefined })) {
          if (listed.objects.length > 0) await r2.delete(listed.objects.map((o) => o.key));
          if (!listed.truncated) break;
        }
      }
      return Response.json({ ok: true });
    }
    arm(req);
    return (app as any).fetch(req, env, ctx);
  },
  scheduled(ev: unknown, env: unknown, ctx: unknown) {
    return (app as any).scheduled(ev, env, ctx);
  },
};
