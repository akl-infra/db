// PUT/DELETE /v1/layouts/{ref}/like (09 §3 T5). Any actor, own layout
// included (02 §4 -- parity with cmini); no `If-Match` (likes have no
// draft to be stale against, 03 §1); refused on the record named `qwerty`
// case-insensitively, the bot's own refusal (0.1). `appendLike` (core/
// events.ts) is the only writer -- this module's job is resolve -> check,
// same spine as `core/write.ts`, just without the ownership half (LDB-W1:
// `src/routes/likes.ts` stays glue only).
import type { Actor } from "../auth/actor";
import type { Bindings } from "../env";
import { badRequest, notFound } from "./errors";
import { appendLike } from "./events";
import { byRef, type LayoutRow } from "./records";
import type { Clock } from "./time";

const QWERTY_MESSAGE = "You can't like Qwerty :yellow_circle:";

async function loadForLike(db: Bindings["DB"], ref: string): Promise<LayoutRow> {
  const record = await byRef(db, ref);
  // A tombstone is reachable only by id (byRef's name path already excludes
  // it); either way it's not something you can like.
  if (record === null || record.deleted) throw notFound(`no layout '${ref}'`, ref);
  if (record.name.toLowerCase() === "qwerty") throw badRequest(QWERTY_MESSAGE, "/ref");
  return record;
}

export async function likeLayout(
  env: Bindings,
  now: Clock,
  actor: Actor,
  ref: string,
  version: string | null,
): Promise<{ like_count: number }> {
  const record = await loadForLike(env.DB, ref);
  const { like_count } = await appendLike(env.DB, now, {
    kind: "liked",
    layoutId: record.id,
    userId: actor.user_id,
    via: actor.via,
    // 20-spark.md S3s: carried on the event, never folded onto `layouts`
    // (a like never moves `source_client`/`source_version`).
    source: { client: actor.source_client, version },
    // LDB-L8b: `loadForLike` just read this row (to check `deleted`/the
    // qwerty refusal) -- hand it straight to `appendLike` so a like/unlike
    // costs exactly ONE read (this one) plus its own commit batch, never
    // two reads of the same row.
    current: record,
  });
  return { like_count };
}

export async function unlikeLayout(
  env: Bindings,
  now: Clock,
  actor: Actor,
  ref: string,
  version: string | null,
): Promise<{ like_count: number }> {
  const record = await loadForLike(env.DB, ref);
  const { like_count } = await appendLike(env.DB, now, {
    kind: "unliked",
    layoutId: record.id,
    userId: actor.user_id,
    via: actor.via,
    source: { client: actor.source_client, version },
    current: record,
  });
  return { like_count };
}
