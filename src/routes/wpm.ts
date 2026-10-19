// WPM records (docs/decisions/28-wpm-records.md): glue only -- no D1
// statement here (LDB-W1, `tests/tools/routes-noprepare.test.ts`); every
// verb lives in `core/wpm.ts`. `POST /v1/wpm` is gated by
// `requireActorOnWrites` like every non-GET route (a banned user is refused
// there); the GETs resolve their own actor where they need one, same
// pattern `routes/links.ts` uses. `Idempotency-Key` is scoped to
// `/v1/layouts*` (`auth/idempotency.ts`), so it is a no-op on these routes.
import { Hono } from "hono";
import type { ActorVariables } from "../auth/actor";
import { type AuthDeps, resolveActor } from "../auth/discord";
import type { Bindings } from "../env";
import { badRequest, notAdmin, notFound } from "../core/errors";
import { cachePut, conditional, etagFor, readHead } from "../core/etag";
import { notifyPending, updateQueueNotification } from "../core/modqueue";
import { readReviewHistory } from "../core/moderation-review";
import { dispatchRejectionDms } from "../core/rejection-dm";
import { byRef } from "../core/records";
import { systemClock, type Clock } from "../core/time";
import * as wpm from "../core/wpm";
import { parseLinkRejectBody, parseReviewApproveBody, parseReviewRejectBody, parseReviewReopenBody, parseWpmBody, parseWpmOnBehalfBody } from "./schemas";

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

// Optional body, same as `routes/links.ts`: `{reason?}` on reject may be
// omitted entirely.
async function readOptionalJson(req: { text(): Promise<string> }): Promise<unknown> {
  const text = await req.text();
  if (text.trim() === "") return {};
  try {
    return JSON.parse(text);
  } catch {
    throw badRequest("request body must be valid JSON", "/");
  }
}

const QUEUE_STATUSES = ["pending", "approved", "rejected", "superseded"] as const;

export function wpmRoute(authDeps: AuthDeps) {
  const route = new Hono<{ Bindings: Bindings; Variables: ActorVariables }>();

  // GET /v1/wpm?layout=&user= (public, no auth). The body is a function of
  // the approved rows, the layouts' names/tombstones and the authors' names:
  // every approval, rename, delete and restore appends an event (the seq),
  // and an author rename moves `authors_head` -- both are in the ETag.
  route.get("/v1/wpm", async (c) => {
    const db = c.env.DB;
    const layoutRaw = c.req.query("layout");
    const userRaw = c.req.query("user");
    let layoutId: string | undefined;
    if (layoutRaw !== undefined) {
      const layout = await byRef(db, layoutRaw);
      if (layout === null) throw notFound(`no layout '${layoutRaw}'`, layoutRaw);
      layoutId = layout.id;
    }
    const userId = userRaw === undefined ? undefined : wpm.validateUserId(userRaw, "user");

    const head = await readHead(db);
    const etag = await etagFor(head.seq, { wpm: { layout: layoutId ?? null, user: userId ?? null, authors: head.authors.version } });
    const short = await conditional(c, etag, CACHE_CONTROL);
    if (short) return short;

    const records = await wpm.listWpmRecords(db, { layoutId, userId });
    const res = c.json({ records });
    res.headers.set("ETag", etag);
    res.headers.set("Cache-Control", CACHE_CONTROL);
    await cachePut(c, res.clone());
    return res;
  });

  route.post("/v1/wpm", async (c) => {
    const actor = c.get("actor");
    const body = parseWpmBody(await readJson(c.req));
    const layout = await wpm.resolveWpmLayout(c.env.DB, body.layout);
    const submission = await wpm.submitWpm(c.env.DB, resolveNow(c.env), actor, c.get("sourceVersion"), layout.id, body.wpm, body.proof);
    // [LDB-WPM8] Every submission is pending, so every one is announced right
    // away rather than waiting for the next 5-minute cron tick, same as links
    // (`notifyPending` never throws and is free with the webhook unset).
    c.executionCtx.waitUntil(notifyPending(c.env.DB, c.env, resolveNow(c.env)));
    return c.json({ submission }, 202);
  });

  route.post("/v1/admin/wpm", async (c) => {
    const actor = c.get("actor");
    if (!actor.admin) throw notAdmin();
    const body = parseWpmOnBehalfBody(await readJson(c.req));
    const layout = await wpm.resolveWpmLayout(c.env.DB, body.layout);
    const submission = await wpm.submitWpmOnBehalf(c.env.DB, resolveNow(c.env), actor, c.get("sourceVersion"), layout.id, body.user_id, body.wpm, body.proof);
    return c.json({ submission }, 201);
  });

  route.get("/v1/admin/wpm-queue", async (c) => {
    const actor = await resolveActor(c.env, c.req, authDeps);
    if (!actor.admin) throw notAdmin();
    const raw = c.req.query("status") ?? "pending";
    if (!(QUEUE_STATUSES as readonly string[]).includes(raw)) {
      throw badRequest(`unknown 'status' value '${raw}' (expected one of ${QUEUE_STATUSES.join(", ")})`, "status");
    }
    return c.json({ submissions: await wpm.listWpmQueue(c.env.DB, raw as (typeof QUEUE_STATUSES)[number]) });
  });

  route.post("/v1/admin/wpm-queue/:id/approve", async (c) => {
    const actor = c.get("actor");
    if (!actor.admin) throw notAdmin();
    const body = parseReviewApproveBody(await readOptionalJson(c.req));
    const submission = await wpm.approveWpm(c.env.DB, resolveNow(c.env), actor, c.get("sourceVersion"), c.req.param("id"), body.review_version ?? 0);
    c.executionCtx.waitUntil(updateQueueNotification(c.env.DB, c.env, "wpm", submission.id));
    return c.json({ submission });
  });

  route.post("/v1/admin/wpm-queue/:id/reject", async (c) => {
    const actor = c.get("actor");
    if (!actor.admin) throw notAdmin();
    const body = parseReviewRejectBody(await readOptionalJson(c.req));
    const submission = await wpm.rejectWpm(c.env.DB, resolveNow(c.env), actor, c.get("sourceVersion"), c.req.param("id"), body.reason, { notifySubmitter: c.env.MODQUEUE_DISCORD_DMS === "true", reviewVersion: body.review_version });
    c.executionCtx.waitUntil(updateQueueNotification(c.env.DB, c.env, "wpm", submission.id));
    c.executionCtx.waitUntil(dispatchRejectionDms(c.env.DB, c.env, resolveNow(c.env)));
    return c.json({ submission });
  });

  route.get("/v1/admin/wpm-queue/:id/history", async (c) => {
    const actor = await resolveActor(c.env, c.req, authDeps);
    if (!actor.admin) throw notAdmin();
    c.header("Cache-Control", "private, no-store");
    return c.json({ history: await readReviewHistory(c.env.DB, "wpm", c.req.param("id")) });
  });

  route.post("/v1/admin/wpm-queue/:id/reopen", async (c) => {
    const actor = c.get("actor");
    if (!actor.admin) throw notAdmin();
    const body = parseReviewReopenBody(await readJson(c.req));
    const submission = await wpm.reopenWpm(c.env.DB, resolveNow(c.env), actor, c.get("sourceVersion"), c.req.param("id"), body);
    c.executionCtx.waitUntil(updateQueueNotification(c.env.DB, c.env, "wpm", submission.id));
    return c.json({ submission });
  });

  return route;
}
