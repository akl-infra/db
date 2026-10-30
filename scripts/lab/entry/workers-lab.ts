// The workerd lab entry (lane P): src/index.ts behind src/platform/lab-entry.ts. Run it with
// `wrangler dev --local` and `LAB_MODE` set in [vars] (or `--var LAB_MODE:1`); without it every request answers 503.
// Generalised from scripts/lab/p1-crawl-diff.mjs's inline entry and scripts/lab/fuzz/d1-lab-entry.ts, the fuzzer's oracle,
// whose two behaviours it keeps: `x-lab-now` / `x-lab-seed` determinism, and NO edge cache (see disableEdgeCache for why).
// Plus the oracle's lab-only POST /__lab/reset (rebuild D1 in place from the runner's statements, empty the dump bucket).
import app from "../../../src/index.ts";
import { createLabEntry } from "../../../src/platform/lab-entry.ts";

interface LabEnv {
  DB: D1Database;
  DUMPS?: R2Bucket;
}

export default createLabEntry<LabEnv>(app as never, {
  async control(req, env) {
    if (req.method !== "POST" || new URL(req.url).pathname !== "/__lab/reset") return null;
    const { statements } = (await req.json()) as { statements: string[] };
    await env.DB.batch(statements.map((s) => env.DB.prepare(s)));
    const r2 = env.DUMPS;
    if (r2 !== undefined) {
      for (let listed = await r2.list(); ; listed = await r2.list({ cursor: listed.truncated ? listed.cursor : undefined })) {
        if (listed.objects.length > 0) await r2.delete(listed.objects.map((o) => o.key));
        if (!listed.truncated) break;
      }
    }
    return Response.json({ ok: true });
  },
});
