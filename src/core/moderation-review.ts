// [LDB-MD20] Review cycles are append-only moderation history. D1 batch()
// keeps each winning transition, its public event and private history atomic.
import type { Actor } from "../auth/actor";
import { notFound, reviewConflict } from "./errors";
import type { Clock } from "./time";
import { toStore, type StoreArg } from "../store/arg";

export type ReviewKind = "comment" | "wpm";
export interface ReviewExpectation { status: "approved" | "rejected"; review_version: number }
export interface ReviewHistoryRow {
  action: "approved" | "rejected" | "reopened";
  actor: string;
  at: string;
  reason: string | null;
  review_version: number;
}

export async function layoutPresent(dbArg: StoreArg, id: string, liveOnly: boolean): Promise<boolean> {
  const p = await toStore(dbArg).layouts.layoutPresence(id);
  return liveOnly ? p.live : p.exists;
}

export async function approvedLinkOf(dbArg: StoreArg, id: string): Promise<{ link: string | null } | null> {
  return toStore(dbArg).layouts.approvedLink(id);
}

export async function readReviewHistory(dbArg: StoreArg, kind: ReviewKind, id: string): Promise<ReviewHistoryRow[]> {
  const store = toStore(dbArg);
  const row = await store.review.decisionState(kind, id);
  if (row === null) throw notFound(`no ${kind} submission '${id}'`, id);
  const results = await store.review.history(kind, id);
  // Existing decisions (and public snapshot restores) predate private history.
  if ((row.status === "approved" || row.status === "rejected") && row.decided_by !== null && row.decided_at !== null
    && !results.some((h) => h.review_version === row.review_version && h.action === row.status)) {
    results.push({ action: row.status, actor: row.decided_by, at: row.decided_at, reason: row.reason, review_version: row.review_version });
  }
  return results;
}

export async function reopenReview(dbArg: StoreArg, now: Clock, actor: Actor, version: string | null, kind: ReviewKind, id: string, expected: ReviewExpectation): Promise<void> {
  const store = toStore(dbArg);
  const layoutId = await store.review.submissionLayout(kind, id);
  if (layoutId === null) throw notFound(`no ${kind} submission '${id}'`, id);
  const at = now();
  const outcome = await store.review.reopen({
    kind, id, expected, at,
    event: { kind: kind === "comment" ? "comment_reopened" : "wpm_reopened", layoutId,
      actor: actor.user_id, via: actor.via, source: { client: actor.source_client, version }, detail: { submission_id: id } },
    history: { kind, submissionId: id, action: "reopened", actor: actor.user_id, at, reason: null, reviewVersion: expected.review_version + 1 },
  });
  if (!outcome.claimed || !outcome.eventAppended) throw reviewConflict(id);
}
