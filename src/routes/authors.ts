// GET /v1/authors, /v1/authors/{user_id} (03 §2, 07 §6 S6).
import { Hono } from "hono";
import type { Bindings } from "../env";
import { badRequest, notFound } from "../core/errors";
import { authorsHead, cachePut, conditional, etagFor } from "../core/etag";

const CACHE_CONTROL = "public, max-age=10";

export const authorsRoute = new Hono<{ Bindings: Bindings }>();

type AuthorsKey = "name" | "id";

function parseBy(raw: string | undefined): AuthorsKey {
  if (raw === undefined || raw === "name") return "name";
  if (raw === "id") return "id";
  throw badRequest("invalid 'by' (expected 'name' or 'id')", "by");
}

// Default: `{ "<name>": "<user_id>" }`, name-sorted -- cmini's own shape
// (0.1: the list `/authors` endpoint the import pipeline already reads).
// Two ids that share a name collapse to one entry there, so `?by=id`
// answers the lossless `{ "<user_id>": "<name>" }`, id-sorted -- what a
// cache of every author's name (the spark bot's, LDB-B76) needs.
//
// LDB-R9/R10/R11: the ETag keys on `authors_head.version` (migrations/
// 0007), NOT the event seq -- the body is a function of the `authors` rows
// alone, which no event moves and every author insert/delete/rename moves
// (by trigger). So a like never costs a poller a 200 here, an author-only
// change is never answered 304 (or from `caches.default`, which
// `conditional()` re-validates against this same tag), and `last_seen_at`
// bookkeeping never moves it. A conditional request costs one primary-key
// read.
authorsRoute.get("/v1/authors", async (c) => {
  const db = c.env.DB;
  const by = parseBy(c.req.query("by"));
  const head = await authorsHead(db);
  const etag = await etagFor(head.version, { authors: by });
  const short = await conditional(c, etag, CACHE_CONTROL);
  if (short) return short;

  const body: Record<string, string> = {};
  if (by === "id") {
    const { results } = await db
      .prepare("SELECT user_id, name FROM authors ORDER BY user_id")
      .all<{ user_id: string; name: string }>();
    for (const row of results) body[row.user_id] = row.name;
  } else {
    const { results } = await db
      .prepare("SELECT user_id, name FROM authors ORDER BY name")
      .all<{ user_id: string; name: string }>();
    for (const row of results) body[row.name] = row.user_id;
  }

  const res = c.json(body);
  res.headers.set("ETag", etag);
  res.headers.set("Cache-Control", CACHE_CONTROL);
  await cachePut(c, res.clone());
  return res;
});

authorsRoute.get("/v1/authors/:user_id", async (c) => {
  const db = c.env.DB;
  const userId = c.req.param("user_id");

  const author = await db
    .prepare("SELECT user_id, name FROM authors WHERE user_id = ?")
    .bind(userId)
    .first<{ user_id: string; name: string }>();
  if (author === null) throw notFound(`no author '${userId}'`, userId);

  const [layoutRow, likedRow] = await Promise.all([
    db
      .prepare("SELECT COUNT(*) AS n FROM layouts WHERE owner = ? AND deleted = 0")
      .bind(userId)
      .first<{ n: number }>(),
    db.prepare("SELECT COUNT(*) AS n FROM likes WHERE user_id = ?").bind(userId).first<{ n: number }>(),
  ]);

  return c.json({
    user_id: author.user_id,
    name: author.name,
    layout_count: layoutRow?.n ?? 0,
    liked_count: likedRow?.n ?? 0,
  });
});
