// Layout comments (docs/decisions/29-layout-comments.md): glue only -- no D1
// statement here (LDB-W1, `tests/tools/routes-noprepare.test.ts`); every
// verb lives in `core/comments.ts`. `PUT`/`DELETE` are gated by
// `requireActorOnWrites` like every non-GET route (a banned user is refused
// there and nothing is written); the GETs resolve their own actor where they
// need one, same pattern `routes/links.ts` and `routes/wpm.ts` use.
// `Idempotency-Key` applies, the routes sitting under `/v1/layouts*`.
import { Hono } from "hono";
import type { ActorVariables } from "../auth/actor";
import { type AuthDeps, resolveActor } from "../auth/discord";
import type { Bindings } from "../env";
import * as comments from "../core/comments";
import { badRequest, notAdmin, notFound } from "../core/errors";
import { cachePut, conditional, etagFor, readHead } from "../core/etag";
import { announceComment } from "../core/modqueue";
import { byRef } from "../core/records";
import { systemClock, type Clock } from "../core/time";
import { validateUserId } from "../core/wpm";
import { parseCommentBody, parseLinkRejectBody } from "./schemas";

const CACHE_CONTROL = "public, max-age=10";

function resolveNow(env: Bindings): Clock {
  return (env as unknown as { TEST_CLOCK?: Clock }).TEST_CLOCK ?? systemClock;
}

async function readJson(req: { json(): Promise<unknown> }): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    throw badRequest("request body must be valid JSON", "/");
  }
}

// Optional body, same as `routes/links.ts`: `{reason?}` may be omitted
// entirely.
async function readOptionalJson(req: { text(): Promise<string> }): Promise<unknown> {
  const text = await req.text();
  if (text.trim() === "") return {};
  try {
    return JSON.parse(text);
  } catch {
    throw badRequest("request body must be valid JSON", "/");
  }
}

const QUEUE_STATUSES = ["pending", "approved", "rejected", "superseded", "replaced", "deleted", "removed"] as const;

export function commentsRoute(authDeps: AuthDeps) {
  const route = new Hono<{ Bindings: Bindings; Variables: ActorVariables }>();

  // GET /v1/layouts/:ref/comments (public; credentials optional). The body is
  // a function of the approved rows, the likes, the layout's tombstone and the
  // authors' names: every approval, replacement, delete, removal, like, unlike,
  // rename, layout delete and restore appends an event (the seq), and an
  // author rename moves `authors_head` -- both are in the ETag. With NO
  // credentials the answer is the shared public one (ETag, 304, edge cache).
  // WITH credentials it also carries the caller's `liked` flags, so it is
  // per-viewer: `private, no-store`, no ETag, never read from or put into the
  // shared cache (there is no per-viewer precedent among the public reads --
  // layout likes list every liker publicly -- so this is the choice made here).
  route.get("/v1/layouts/:ref/comments", async (c) => {
    const db = c.env.DB;
    const ref = c.req.param("ref");
    const layout = await byRef(db, ref);
    if (layout === null) throw notFound(`no layout '${ref}'`, ref);
    const sortRaw = c.req.query("sort") ?? "likes";
    if (!(comments.COMMENT_SORTS as readonly string[]).includes(sortRaw)) {
      throw badRequest(`unknown 'sort' value '${sortRaw}' (expected one of ${comments.COMMENT_SORTS.join(", ")})`, "sort");
    }
    const sort = sortRaw as comments.CommentSort;

    if (c.req.header("Authorization") !== undefined || c.req.header("X-Akl-Client") !== undefined) {
      const actor = await resolveActor(c.env, c.req, authDeps);
      const res = c.json({ comments: await comments.listComments(db, layout, actor.user_id, sort) });
      res.headers.set("Cache-Control", "private, no-store");
      res.headers.set("Vary", "Authorization, X-Akl-Client");
      return res;
    }

    const head = await readHead(db);
    const etag = await etagFor(head.seq, { comments: { layout: layout.id, authors: head.authors.version, sort } });
    const short = await conditional(c, etag, CACHE_CONTROL);
    if (short) return short;

    const res = c.json({ comments: await comments.listComments(db, layout, undefined, sort) });
    res.headers.set("ETag", etag);
    res.headers.set("Cache-Control", CACHE_CONTROL);
    res.headers.set("Vary", "Authorization, X-Akl-Client");
    await cachePut(c, res.clone());
    return res;
  });

  // GET /v1/layouts/:ref/comment (the caller's own): their pending text and
  // any rejection reason are private, so this is never cached publicly.
  route.get("/v1/layouts/:ref/comment", async (c) => {
    const actor = await resolveActor(c.env, c.req, authDeps);
    const ref = c.req.param("ref");
    const layout = await byRef(c.env.DB, ref);
    if (layout === null) throw notFound(`no layout '${ref}'`, ref);
    const res = c.json(await comments.readOwnComment(c.env.DB, layout.id, actor.user_id));
    res.headers.set("Cache-Control", "private, no-store");
    return res;
  });

  // GET /v1/me/comments: everything the caller has written, one row per layout
  // (capped at the 500 most recently active). Private, never cached.
  route.get("/v1/me/comments", async (c) => {
    const actor = await resolveActor(c.env, c.req, authDeps);
    const res = c.json({ comments: await comments.listMyComments(c.env.DB, actor.user_id) });
    res.headers.set("Cache-Control", "private, no-store");
    return res;
  });

  route.put("/v1/layouts/:ref/comment", async (c) => {
    const actor = c.get("actor");
    const body = parseCommentBody(await readJson(c.req));
    const layout = await comments.resolveCommentLayout(c.env.DB, c.req.param("ref"));
    const result = await comments.submitComment(c.env.DB, resolveNow(c.env), actor, c.get("sourceVersion"), layout.id, body.body);
    // [LDB-CMT8] A freshly pending comment is announced once, best effort,
    // here and only here (no `notified_at`, no cron sweep, no retry);
    // `announceComment` never throws and is free with the webhook unset.
    if (result.kind === "queued") {
      c.executionCtx.waitUntil(announceComment(c.env.DB, c.env, result.submission.id));
    }
    return c.json({ submission: result.submission }, result.kind === "approved" ? 201 : 202);
  });

  route.delete("/v1/layouts/:ref/comment", async (c) => {
    const actor = c.get("actor");
    const ref = c.req.param("ref");
    const layout = await byRef(c.env.DB, ref);
    if (layout === null) throw notFound(`no layout '${ref}'`, ref);
    const deleted = await comments.deleteOwnComment(c.env.DB, resolveNow(c.env), actor, c.get("sourceVersion"), layout.id);
    if (!deleted) throw notFound(`no comment of yours on '${ref}'`, ref);
    return c.body(null, 204);
  });

  // PUT / DELETE /v1/layouts/:ref/comments/:author_id/like (LDB-CMT11): like
  // or unlike the author's comment slot; both idempotent, `204`.
  route.put("/v1/layouts/:ref/comments/:author_id/like", async (c) => {
    const layout = await comments.resolveCommentLayout(c.env.DB, c.req.param("ref"));
    const authorId = validateUserId(c.req.param("author_id"), "author_id");
    await comments.likeComment(c.env.DB, resolveNow(c.env), c.get("actor"), c.get("sourceVersion"), layout.id, authorId);
    return c.body(null, 204);
  });

  route.delete("/v1/layouts/:ref/comments/:author_id/like", async (c) => {
    const layout = await comments.resolveCommentLayout(c.env.DB, c.req.param("ref"));
    const authorId = validateUserId(c.req.param("author_id"), "author_id");
    await comments.unlikeComment(c.env.DB, resolveNow(c.env), c.get("actor"), c.get("sourceVersion"), layout.id, authorId);
    return c.body(null, 204);
  });

  route.get("/v1/admin/comment-queue", async (c) => {
    const actor = await resolveActor(c.env, c.req, authDeps);
    if (!actor.admin) throw notAdmin();
    const raw = c.req.query("status") ?? "pending";
    if (!(QUEUE_STATUSES as readonly string[]).includes(raw)) {
      throw badRequest(`unknown 'status' value '${raw}' (expected one of ${QUEUE_STATUSES.join(", ")})`, "status");
    }
    return c.json({ submissions: await comments.listCommentQueue(c.env.DB, raw as (typeof QUEUE_STATUSES)[number]) });
  });

  route.post("/v1/admin/comment-queue/:id/approve", async (c) => {
    const actor = c.get("actor");
    if (!actor.admin) throw notAdmin();
    const submission = await comments.approveComment(c.env.DB, resolveNow(c.env), actor, c.get("sourceVersion"), c.req.param("id"));
    return c.json({ submission });
  });

  route.post("/v1/admin/comment-queue/:id/reject", async (c) => {
    const actor = c.get("actor");
    if (!actor.admin) throw notAdmin();
    const body = parseLinkRejectBody(await readOptionalJson(c.req));
    const submission = await comments.rejectComment(c.env.DB, resolveNow(c.env), actor, c.get("sourceVersion"), c.req.param("id"), body.reason);
    return c.json({ submission });
  });

  route.post("/v1/admin/comments/:id/remove", async (c) => {
    const actor = c.get("actor");
    if (!actor.admin) throw notAdmin();
    const body = parseLinkRejectBody(await readOptionalJson(c.req));
    const comment = await comments.removeComment(c.env.DB, resolveNow(c.env), actor, c.get("sourceVersion"), c.req.param("id"), body.reason);
    return c.json({ submission: comment });
  });

  return route;
}
