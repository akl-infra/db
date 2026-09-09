// GET /v1/authors, /v1/authors/{user_id} (03 §2, 07 §6 S6).
import { Hono } from "hono";
import type { Bindings } from "../env";
import { notFound } from "../core/errors";
import { cachePut, conditional, etagFor, headSeq } from "../core/etag";

const CACHE_CONTROL = "public, max-age=10";

export const authorsRoute = new Hono<{ Bindings: Bindings }>();

// `{ "<name>": "<user_id>" }`, name-sorted -- cmini's own shape (0.1: the
// list `/authors` endpoint the import pipeline already reads).
authorsRoute.get("/v1/authors", async (c) => {
  const db = c.env.DB;
  const seq = await headSeq(db);
  const etag = await etagFor(seq, {});
  const short = await conditional(c, etag, CACHE_CONTROL);
  if (short) return short;

  const { results } = await db
    .prepare("SELECT user_id, name FROM authors ORDER BY name")
    .all<{ user_id: string; name: string }>();
  const body: Record<string, string> = {};
  for (const row of results) body[row.name] = row.user_id;

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
