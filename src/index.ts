import { Hono } from "hono";
import type { Bindings } from "./env";
import { ApiError, internal } from "./core/errors";
import { systemClock } from "./core/time";
import { list as listFormats } from "./formats/registry";
import { tick as cminiTick } from "./import/cmini";

const app = new Hono<{ Bindings: Bindings }>();

// GET /v1/meta -- the service's head: counts, the event cursor, and the
// registered formats. Every field comes from a real D1 query; a fresh
// database (no rows anywhere) answers the all-zero/null body below.
app.get("/v1/meta", async (c) => {
  const db = c.env.DB;
  const [layoutRow, authorRow, eventRow] = await Promise.all([
    db
      .prepare(
        "SELECT COUNT(*) AS n, MAX(modified_at) AS modified FROM layouts WHERE deleted = 0",
      )
      .first<{ n: number; modified: string | null }>(),
    db
      .prepare("SELECT COUNT(*) AS n, MAX(last_seen_at) AS modified FROM authors")
      .first<{ n: number; modified: string | null }>(),
    db.prepare("SELECT MAX(seq) AS seq, MAX(at) AS at FROM events").first<{
      seq: number | null;
      at: string | null;
    }>(),
  ]);

  return c.json({
    layout_count: layoutRow?.n ?? 0,
    author_count: authorRow?.n ?? 0,
    seq: eventRow?.seq ?? 0,
    revision: eventRow?.at ?? null,
    layouts_modified_at: layoutRow?.modified ?? null,
    authors_modified_at: authorRow?.modified ?? null,
    formats: listFormats().map((f) => f.id), // S3 adds akl/1 alongside cmini/1
  });
});

app.onError((err, c) => {
  if (err instanceof ApiError) {
    return c.json(err.body, err.status as 400 | 404 | 409 | 500);
  }
  const e = internal();
  console.error(err); // never in the response body -- see core/errors.ts
  return c.json(e.body, 500);
});

// The two crons from wrangler.toml's [triggers]. `ScheduledController` (not
// the legacy service-worker-format `ScheduledEvent`) is what a modules-
// format Worker's `scheduled` export actually receives -- S1's original
// annotation typechecked only because `@cloudflare/workers-types`'s stable
// index.d.ts doesn't carry `ScheduledController` at all, so nothing here
// caught the mismatch until S5 needed it (07 §6 S5's tick.test.ts drives
// this handler directly via pool-workers' `createScheduledController`).
async function scheduled(event: ScheduledController, env: Bindings, _ctx: ExecutionContext): Promise<void> {
  switch (event.cron) {
    case "*/5 * * * *":
      await cminiTick(env, systemClock);
      return;
    case "0 3 * * *":
      // TODO(S7): src/dump/write.ts
      return;
    default:
      throw new Error(`scheduled(): unrecognized cron '${event.cron}'`);
  }
}

export default {
  fetch: app.fetch,
  scheduled,
};
