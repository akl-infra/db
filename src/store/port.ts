// The storage port (design/aws-port.md §4.1). FROZEN at P1 start: agents
// implement it, they do not change it. A change goes through the main
// session and lands as its own commit before anyone relies on it.
//
// Every method is ONE operation-level unit of today's D1 code: one statement,
// or one `db.batch()`. Its contract names two things:
//
// Consistency:
//   strong        reflects every write acknowledged before the call.
//   snapshot      strong, and every value returned comes from ONE instant.
//   auth-eventual may lag acknowledged writes by up to ~1 s (saltorbit
//                 2026-10-25: clients, authors-for-actor, roles). D1 is
//                 strong here anyway; DynamoDB uses eventual reads.
// Atomicity:
//   read          no writes.
//   single        one conditional write: it applies or it does not.
//   atomic        all-or-nothing (D1: one batch; DynamoDB: one
//                 TransactWriteItems). The listed effects happen together
//                 or not at all.
//   sequence      several independent writes in the listed order, exactly as
//                 today; a crash between them leaves the prefix. Kept as is
//                 because today's code is that way (no behaviour change in P1).
//
// "D1:" names the code a D1 implementation moves verbatim. A method that
// appends events (anything on `EventStore`, and every `...WithEvent`/decision
// method) assigns `seq` gap-free: the D1 AUTOINCREMENT, or DynamoDB's
// `META/HEAD` protocol (design §2.4).
//
// Row shapes are the D1 rows the code reads today (0/1 for booleans where
// today's SQL returns them, JSON columns as strings), so the domain code
// above the port does not change in P1.
import type { Actor } from "../auth/actor";
import type { AdminRow } from "../core/admins";
import type { ClientRow, ClientStatus } from "../core/clients";
import type { CommentQueueRow, CommentRow, CommentSort, CommentStatus, PublicCommentCount } from "../core/comments";
import type { AuthorsHead, Head } from "../core/etag";
import type { CommitInput, CommitResult, Event, EventDbRow, FeedFilter, Info, InfoKind, Like, LinkChange, Moderation, LinkSnapshot, EventSnapshot } from "../core/events";
import type { IdempotencyRow } from "../core/idempotency";
import type { LinkQueueRow, LinkSubmissionRow, QueueStatus as LinkQueueStatus } from "../core/links";
import type { BanRow } from "../core/moderation";
import type { ReviewExpectation, ReviewHistoryRow, ReviewKind } from "../core/moderation-review";
import type { QueueKind } from "../core/modqueue";
import type { FormatRow, LayoutRow, LayoutWithFormats, ListPage, ListParams, Source } from "../core/records";
import type { RejectionOutboxRow } from "../core/rejection-dm";
import type { Clock } from "../core/time";
import type { WpmQueueRow, WpmRecord, WpmStatus, WpmSubmissionRow } from "../core/wpm";
import type { Dump } from "../dump/write";

// ---------------------------------------------------------------------------
// Shared value types
// ---------------------------------------------------------------------------

/** A moderation event appended inside a decision's atomic unit, only if the decision's claim won. */
export type GatedEvent = Moderation;

/** A DM outbox row inserted inside a decision's atomic unit (rejection-dm.ts computes key and nonce). */
export interface OutboxIntent {
  decision: "rejection" | "approval";
  deliveryKey: string;
  nonce: string;
  kind: QueueKind;
  submissionId: string;
  layoutId: string;
  recipientId: string;
  at: string;
  reviewVersion: number;
}

/** A `moderation_review_history` row inserted inside a decision's atomic unit, only if its claim won. */
export interface HistoryIntent {
  kind: ReviewKind;
  submissionId: string;
  action: "approved" | "rejected" | "reopened";
  actor: string;
  at: string;
  reason: string | null;
  reviewVersion: number;
}

/** Outcome of a claim-gated decision: `claimed` is the CAS on the row; `eventAppended` the gated event. */
export interface DecisionOutcome {
  claimed: boolean;
  eventAppended: boolean;
}

// ---------------------------------------------------------------------------
// Agent A: head, state, layouts, events, holds, cutover
// ---------------------------------------------------------------------------

export interface HeadStore {
  /** strong, read. The `/v1/meta` validator (seq, authors head, the named `import_state` values, the rolling upstream-delete count). D1: core/etag.ts readHead. */
  readHead(stateKeys?: readonly string[], deletesSinceIso?: string): Promise<Head>;
  /** strong, read. `MAX(seq)` or 0. D1: core/etag.ts headSeq. */
  headSeq(): Promise<number>;
  /** strong, read. `authors_head` (version, modified_at). D1: core/etag.ts authorsHead. */
  authorsHead(): Promise<AuthorsHead>;
  /** strong, read. Live layout count, max live `modified_at`, author count, `MAX(at)` of events. D1: core/meta.ts readMetaCore's three queries. */
  metaCounts(): Promise<{ layoutCount: number; layoutsModifiedAt: string | null; authorCount: number; revisionAt: string | null }>;
}

export interface StateStore {
  /** strong, read. One `import_state` value, or null. */
  get(key: string): Promise<string | null>;
  /** strong, read. Values for the keys that exist (absent keys omitted). D1: clients.ts clientsHealth's IN query. */
  getMany(keys: readonly string[]): Promise<Map<string, string>>;
  /** single. Upsert. D1: dump/write.ts writeDumpState, clients.ts suspend upsert (when used alone). */
  put(key: string, value: string): Promise<void>;
  /** single. Delete if present. */
  delete(key: string): Promise<void>;
}

export interface LayoutReadStore {
  /** strong, read. Tombstones included. D1: records.ts readById. */
  byId(id: string): Promise<LayoutRow | null>;
  /** strong, read. The LIVE layout with this name, ASCII case-insensitive (NOCASE). D1: records.ts readByName. */
  byName(name: string): Promise<LayoutRow | null>;
  /** strong, read. ULID-shaped ref tries the id first, then the live name. D1: records.ts byRef. */
  byRef(ref: string): Promise<LayoutRow | null>;
  /** snapshot, read. Layout and every format row in one instant (LDB-B65). D1: records.ts readByIdWithFormats. */
  byIdWithFormats(id: string): Promise<LayoutWithFormats | null>;
  /** snapshot, read. D1: records.ts readByNameWithFormats. */
  byNameWithFormats(name: string): Promise<LayoutWithFormats | null>;
  /** snapshot, read. D1: records.ts byRefWithFormats. */
  byRefWithFormats(ref: string): Promise<LayoutWithFormats | null>;
  /** strong, read. D1: records.ts formatsForLayout. */
  formatsForLayout(layoutId: string): Promise<Map<string, FormatRow>>;
  /** strong, read. Every id in `layoutIds` is a key (empty map if none). D1: records.ts formatsForLayouts. */
  formatsForLayouts(layoutIds: readonly string[]): Promise<Map<string, Map<string, FormatRow>>>;
  /** strong, read. D1: records.ts readFormat. */
  readFormat(layoutId: string, lineage: string): Promise<FormatRow | null>;
  /** snapshot, read. Filtered, sorted, keyset-paginated live layouts (NOCASE byte order for `name`). D1: records.ts list. */
  list(params: ListParams): Promise<ListPage>;
  /** strong, read. Liker user ids per layout, ascending; every id is a key. D1: routes/layouts.ts likesByLayout. */
  likers(layoutIds: readonly string[]): Promise<Map<string, string[]>>;
  /** strong, read. The layout's events, seq ascending, optionally one full format id. D1: routes/layouts.ts /history. */
  history(layoutId: string, format?: string): Promise<Event[]>;
  /** strong, read. A stored rev of one lineage plus the event that produced it; null if either is missing. D1: routes/layouts.ts /rev/:n (two queries). */
  revision(layoutId: string, lineage: string, rev: number): Promise<{ format: string; payloadJson: string; eventSeq: number; afterJson: string; via: string; sourceClient: string | null; sourceVersion: string | null } | null>;
  /** strong, read. Payload of one stored rev (revert). D1: revert.ts revertFormatScope. */
  revisionPayload(layoutId: string, lineage: string, rev: number): Promise<{ format: string; payloadJson: string } | null>;
  /** strong, read. Latest rev-bumping event of one scope (`format` null = layout scope). D1: write.ts latestRevBumpingEvent. */
  latestRevBumpingEvent(layoutId: string, format: string | null): Promise<Event | null>;
  /** strong, read. Latest tombstone holding `name` (NOCASE) and its likers, ascending. D1: write.ts tombstoneLikers. */
  tombstoneLikers(name: string): Promise<{ tombstoneId: string | null; userIds: string[] }>;
  /** strong, read. Whether an `authors` row exists (transfer target check). D1: write.ts transferLayout. */
  authorExists(userId: string): Promise<boolean>;
  /** strong, read. `exists` = row present; `live` = present and not deleted. D1: the `SELECT id FROM layouts WHERE id = ? [AND deleted = 0]` checks in links/wpm/comments. */
  layoutPresence(id: string): Promise<{ exists: boolean; live: boolean }>;
  /** strong, read. Approved link, or null when the layout does not exist. D1: links.ts getLink. */
  approvedLink(layoutId: string): Promise<{ link: string | null } | null>;
  /** strong, read. Live layouts owned by `owner`. D1: routes/authors.ts. */
  liveCountByOwner(owner: string): Promise<number>;
  /** strong, read. Likes given by `userId`. D1: routes/authors.ts. */
  likeCountByUser(userId: string): Promise<number>;
}

export interface EventStore {
  /** atomic, strong. The write commit: events (+ layout_revs), the layouts upsert, the format upsert, the optional destructive-budget count. Throws `nameTaken(name)` on a live-name clash and `RevConflictError` when another write took `n`. D1: events.ts commitWrite. */
  commitWrite(now: Clock, input: CommitInput): Promise<CommitResult>;
  /** single, strong. An informational event naming the layout (reads its name/owner first). D1: events.ts appendInfo. */
  appendInfo(now: Clock, info: Info): Promise<{ seq: number }>;
  /** single, strong. An actor-scoped admin event. D1: events.ts appendAdmin. */
  appendAdmin(now: Clock, a: { kind: InfoKind; actor: string; via?: string; source?: Source; detail?: object }): Promise<{ seq: number }>;
  /** single, strong. A layout-scoped admin event with an `after`. D1: events.ts appendModeration. */
  appendModeration(now: Clock, m: Moderation): Promise<{ seq: number }>;
  /** atomic. Approve (claim-gated on the pending submission) or clear the link: layouts.link, the event, the supersede sweep, the optional budget count. Throws notFound when the claim fails. D1: events.ts appendLinkChange. */
  appendLinkChange(now: Clock, l: LinkChange): Promise<{ seq: number; link: string | null; budgetProbe?: { clientId: string; countInWindow: number; liveLayouts: number } }>;
  /** atomic. Like or unlike, gated on the layout being live and the like's presence. Throws alreadyLiked / notLiked / notFound. D1: events.ts appendLike. */
  appendLike(now: Clock, l: Like): Promise<{ seq: number; like_count: number }>;
  /** atomic. One `liked` event + likes row per former liker (per-user guards). DynamoDB may chunk it (design §2.4). D1: events.ts appendInheritedLikes. */
  appendInheritedLikes(now: Clock, a: { layoutId: string; name: string; owner: string; userIds: string[]; via: string; detail: object; source: Source }): Promise<{ like_count: number }>;
  /** strong, read, gap-free. Events with seq > since, ascending, at most min(limit, 1000), filtered; `detail` is the public (redacted) one. D1: events.ts feed. */
  feed(since: number, limit: number, kinds?: string[], filter?: FeedFilter): Promise<{ next: number; items: Event[] }>;
  /** strong, read. Revert candidates of one source client since `sinceAt` and below `beforeSeq`, seq ascending. D1: revert.ts revertClientWrites. */
  revertCandidates(sourceClient: string, sinceAt: string, beforeSeq: number): Promise<{ seq: number; at: string; kind: string; layout_id: string | null; format: string | null; rev: number | null; before_json: string | null; after_json: string | null }[]>;
  /** strong, read. The latest link_approved/link_cleared event of a layout, optionally below `beforeSeq`. D1: revert.ts revertLinkCleared. */
  latestLinkEvent(layoutId: string, beforeSeq?: number): Promise<{ seq: number; after_json: string | null; source_client: string | null } | null>;
}

/** Long-poll hold budget (design §3; decided 2026-10-24). */
export interface HoldStore {
  /** single. Take the per-client hold lease and `seconds` from the UTC-day budget; false = decline (`X-Wait-Ignored: budget`). D1 (P1): always true, no SQL; P2 makes it real on both backends. */
  takeHold(clientId: string, seconds: number, now: Clock): Promise<boolean>;
  /** single. Release the client's hold lease. D1 (P1): no-op. */
  releaseHold(clientId: string): Promise<void>;
}

/** The cutover flag (design §5.2). */
export interface CutoverStore {
  /** auth-eventual (cached ≤ 1 s), read. `null` = normal. D1 (P1): always null; P6 implements it. */
  mode(): Promise<"read_only" | "proxy" | null>;
}

// ---------------------------------------------------------------------------
// Agent B: auth, admin
// ---------------------------------------------------------------------------

export interface AuthCacheRow {
  user_id: string | null;
  name: string | null;
  app_id: string | null;
  ok: number;
  expires_at: string;
}

export interface AuthStore {
  /** auth-eventual, read. The signing client. D1: auth/client.ts verifyClientRequest. */
  client(id: string): Promise<Pick<ClientRow, "id" | "pubkey" | "owner_user_id" | "caps" | "status"> | null>;
  /** single, strong. Record a nonce; false = already seen (replay). D1: auth/client.ts nonce insert. */
  insertNonce(clientId: string, nonce: string, at: string): Promise<boolean>;
  /** single. D1: auth/client.ts pruneNonces. */
  pruneNonces(beforeIso: string): Promise<void>;
  /** sequence. The client-lane author touch: read the author (auth-eventual), upsert `last_seen_at` only when stale (single, conditional), fall back to a read; returns the stored name or null. D1: auth/client.ts verifyClientRequest's author block. */
  touchClientAuthor(userId: string, at: string, staleBefore: string): Promise<string | null>;
  /** auth-eventual, read. D1: auth/discord.ts resolveBearer. */
  authCache(tokenHash: string): Promise<AuthCacheRow | null>;
  /** single. Cache a Discord refusal until `expiresAt`. D1: auth/discord.ts (both failure upserts). */
  cacheAuthFailure(tokenHash: string, expiresAt: string): Promise<void>;
  /** atomic. Cache a Discord success and upsert the author (name unless admin-set; `last_seen_at` always). D1: auth/discord.ts resolveBearer's batch. */
  cacheAuthSuccess(r: { tokenHash: string; userId: string; name: string; appId: string | null; expiresAt: string; at: string }): Promise<void>;
  /** single. D1: auth/discord.ts pruneAuthCache. */
  pruneAuthCache(nowIso: string): Promise<void>;
  /** auth-eventual, read. Raw presence in `admins` and `bans` (core/roles.ts derives `banned && !admin`). D1: auth/roles.ts roleOf. */
  rolesOf(userId: string): Promise<{ admin: boolean; banned: boolean }>;
  /** auth-eventual, read. An author's name, for actors and display. D1: the `SELECT name FROM authors WHERE user_id = ?` reads. */
  authorName(userId: string): Promise<string | null>;
  /** strong, read. Every author, by `user_id` or by `name` (BINARY order). D1: routes/authors.ts. */
  authors(order: "user_id" | "name"): Promise<{ user_id: string; name: string }[]>;
  /** strong, read. D1: routes/authors.ts. */
  author(userId: string): Promise<{ user_id: string; name: string } | null>;
  /** single, strong. Count one hit in a fixed window; returns the window's count after it. D1: core/ratelimit.ts take. */
  hitWindow(key: string, windowStart: number): Promise<{ n: number; window_start: number }>;
  /** single. D1: core/ratelimit.ts pruneRateLimits. */
  pruneRateLimits(beforeWindowStart: number): Promise<void>;
  /** strong, read. D1: core/idempotency.ts getIdempotency. */
  getIdempotency(scope: string, key: string): Promise<IdempotencyRow | null>;
  /** single. Reserve a fresh key (status 0); false if anything is stored. D1: core/idempotency.ts reserveIdempotency. */
  reserveIdempotency(row: { scope: string; key: string; method: string; path: string; request_hash: string; at: string }): Promise<boolean>;
  /** single. Take over an abandoned row, CAS on `expectedAt`. D1: core/idempotency.ts takeOverIdempotency. */
  takeOverIdempotency(row: { scope: string; key: string; method: string; path: string; request_hash: string; at: string; expectedAt: string }): Promise<boolean>;
  /** single. D1: core/idempotency.ts completeIdempotency. */
  completeIdempotency(scope: string, key: string, status: number, responseBody: string, at: string): Promise<void>;
  /** single. D1: core/idempotency.ts deleteIdempotency. */
  deleteIdempotency(scope: string, key: string): Promise<void>;
  /** single. D1: core/idempotency.ts pruneIdempotency. */
  pruneIdempotency(beforeIso: string): Promise<void>;
}

export interface AdminStore {
  /** auth-eventual, read. D1: core/admins.ts isAdmin. */
  isAdmin(userId: string): Promise<boolean>;
  /** strong, read. Ordered by added_at, user_id. D1: core/admins.ts list. */
  listAdmins(): Promise<AdminRow[]>;
  /** strong, read. D1: core/admins.ts add's read. */
  getAdmin(userId: string): Promise<AdminRow | null>;
  /** single. D1: core/admins.ts add's insert (the event is a separate appendAdmin). */
  insertAdmin(row: AdminRow): Promise<void>;
  /** single (+ reads on refusal). Delete only while more than two admins remain. D1: core/admins.ts remove. */
  removeAdmin(userId: string): Promise<{ removed: true } | { removed: false; exists: boolean; count: number }>;
  /** strong, read. With author names. D1: core/moderation.ts listBans. */
  listBans(): Promise<BanRow[]>;
  /** strong, read. D1: core/moderation.ts ban's existence read. */
  banExists(userId: string): Promise<boolean>;
  /** single. Upsert. D1: core/moderation.ts ban. */
  upsertBan(row: { user_id: string; by: string; at: string; reason: string | null }): Promise<void>;
  /** single. false = there was no ban. D1: core/moderation.ts unban. */
  deleteBan(userId: string): Promise<boolean>;
  /** single. Set an admin-chosen name (name_source 'admin', last_seen_at). D1: core/moderation.ts renameAuthor. */
  setAuthorNameByAdmin(userId: string, name: string, at: string): Promise<void>;
  /** single. D1: core/clients.ts registerClient. */
  insertClient(row: ClientRow): Promise<void>;
  /** strong, read. D1: core/clients.ts revoke/suspend/reactivate reads. */
  clientStatus(id: string): Promise<{ status: ClientStatus; revoked_at: string | null } | null>;
  /** single. D1: core/clients.ts revokeClient. */
  revokeClient(id: string, at: string): Promise<void>;
  /** strong, read. D1: core/clients.ts listClients. */
  listClients(): Promise<ClientRow[]>;
  /** atomic. Status 'suspended' + the suspend-state value. D1: core/clients.ts suspendClient's batch. */
  suspendClient(id: string, stateKey: string, stateValue: string): Promise<void>;
  /** atomic. Status 'active', delete the suspend state and the destructive-budget window. D1: core/clients.ts reactivateClient's batch. */
  reactivateClient(id: string, stateKey: string, budgetKey: string): Promise<void>;
  /** strong, read. Suspended clients by id. D1: core/clients.ts clientsHealth. */
  suspendedClients(): Promise<{ id: string; name: string }[]>;
}

// ---------------------------------------------------------------------------
// Agent C: links, WPM, comments, review history
// ---------------------------------------------------------------------------

export interface LinkStore {
  /** strong, read. Newest pending submission of a layout. D1: links.ts pendingSubmission. */
  pending(layoutId: string): Promise<LinkSubmissionRow | null>;
  /** strong, read. D1: links.ts loadSubmission. */
  get(id: string): Promise<LinkSubmissionRow | null>;
  /** sequence. Supersede `supersedeId` (if given), then insert the new pending row. D1: links.ts submitLink's two statements. */
  submit(r: { supersedeId: string | null; by: string; at: string; row: { id: string; layout_id: string; url: string; submitted_by: string; submitted_at: string } }): Promise<void>;
  /** strong, read. Queue by status on live layouts, with names. D1: links.ts listQueue. */
  queue(status: LinkQueueStatus): Promise<LinkQueueRow[]>;
  /** atomic. Reject (claim on pending) + gated event + optional outbox. D1: links.ts rejectSubmission's batch. */
  reject(r: { id: string; by: string; at: string; reason: string | null; event: GatedEvent; outbox?: OutboxIntent }): Promise<DecisionOutcome>;
}

export interface WpmStore {
  /** strong, read. Without notified_at. D1: wpm.ts loadSubmission. */
  get(id: string): Promise<WpmSubmissionRow | null>;
  /** single. Bind the Discord receipt URL once (submitter or admin). D1: wpm.ts bindWpmDiscordMessage's UPDATE. */
  bindSourceMessage(r: { id: string; url: string; actorId: string; admin: boolean }): Promise<boolean>;
  /** strong, read. The bound URL if the actor may see it; null = no such visible submission. D1: wpm.ts bindWpmDiscordMessage's read. */
  sourceMessage(r: { id: string; actorId: string; admin: boolean }): Promise<{ source_message_url: string | null } | null>;
  /** atomic. Insert an admin-entered approved row + its event + history. D1: wpm.ts insertApproved's batch. */
  insertApproved(r: { row: Omit<WpmSubmissionRow, "status" | "decided_by" | "decided_at" | "reason" | "review_version"> & { decided_by: string; decided_at: string }; event: GatedEvent; history: HistoryIntent }): Promise<void>;
  /** atomic. Supersede the pair's pending rows, insert the new pending row. D1: wpm.ts submitWpm's batch. */
  submit(r: { by: string; at: string; row: Omit<WpmSubmissionRow, "status" | "decided_by" | "decided_at" | "reason" | "review_version"> }): Promise<void>;
  /** strong, read. D1: wpm.ts listWpmQueue. */
  queue(status: WpmStatus): Promise<WpmQueueRow[]>;
  /** atomic. Approve (claim on pending + review_version + live layout) + gated event + optional outbox + history. D1: wpm.ts approveWpm's batch. */
  approve(r: { id: string; by: string; at: string; reviewVersion: number; event: GatedEvent; outbox?: OutboxIntent; history: HistoryIntent }): Promise<DecisionOutcome>;
  /** atomic. Reject (claim) + gated event + optional outbox + history. D1: wpm.ts rejectWpm's batch. */
  reject(r: { id: string; by: string; at: string; reason: string | null; reviewVersion: number; event: GatedEvent; outbox?: OutboxIntent; history: HistoryIntent }): Promise<DecisionOutcome>;
  /** snapshot, read. Best approved record per (layout, user) on live layouts. D1: wpm.ts listWpmRecords. */
  records(filter: { layoutId?: string; userId?: string }): Promise<WpmRecord[]>;
}

/** `listComments`' raw row (flags as 0/1). */
export interface PublicCommentDbRow {
  id: string;
  user_id: string;
  name: string | null;
  body: string;
  approved_at: string;
  edited: number;
  likes: number;
  liked: number;
  is_author: number;
}

export interface CommentStore {
  /** strong, read. Without notified_at. D1: comments.ts loadComment. */
  get(id: string): Promise<CommentRow | null>;
  /** atomic. Supersede the pair's pending rows, insert the new pending row. D1: comments.ts submitComment's batch. */
  submit(r: { by: string; at: string; row: { id: string; layout_id: string; user_id: string; body: string; via: string; submitted_at: string } }): Promise<void>;
  /** strong, read. Whether the user has any row with a body on the layout. D1: comments.ts deleteOwnComment's read. */
  hasBody(layoutId: string, userId: string): Promise<boolean>;
  /** atomic. Delete the user's text on the layout and clear likes of the emptied slot. D1: comments.ts deleteOwnComment's batch. */
  deleteOwn(r: { layoutId: string; userId: string; at: string }): Promise<void>;
  /** strong, read. D1: comments.ts listCommentQueue. */
  queue(status: CommentStatus): Promise<CommentQueueRow[]>;
  /** atomic. Replace the prior approved text, approve (claim), gated event, optional outbox, history. `claimed` is the approve CAS. D1: comments.ts approveComment's batch. */
  approve(r: { id: string; layoutId: string; userId: string; by: string; at: string; reviewVersion: number; event: GatedEvent; outbox?: OutboxIntent; history: HistoryIntent }): Promise<DecisionOutcome>;
  /** atomic. Reject (claim) + gated event + optional outbox + history. D1: comments.ts rejectComment's batch. */
  reject(r: { id: string; by: string; at: string; reason: string | null; reviewVersion: number; event: GatedEvent; outbox?: OutboxIntent; history: HistoryIntent }): Promise<DecisionOutcome>;
  /** atomic. Remove an approved comment (claim) and, if won, clear likes of the emptied slot. D1: comments.ts removeComment's batch. */
  remove(r: { id: string; layoutId: string; userId: string; by: string; at: string; reason: string | null; reviewVersion: number }): Promise<{ claimed: boolean }>;
  /** strong, read. D1: comments.ts listCommentCounts. */
  counts(): Promise<PublicCommentCount[]>;
  /** strong, read. D1: comments.ts listComments' query. */
  list(r: { layoutId: string; owner: string; viewer: string; sort: CommentSort }): Promise<PublicCommentDbRow[]>;
  /** single. Like an approved slot; false = not inserted (already liked, or no slot). D1: comments.ts likeComment's insert. */
  like(r: { layoutId: string; authorId: string; userId: string; via: string; at: string }): Promise<boolean>;
  /** strong, read. D1: comments.ts likeComment's slot read. */
  approvedSlotExists(layoutId: string, authorId: string): Promise<boolean>;
  /** single. false = there was no like. D1: comments.ts unlikeComment. */
  unlike(layoutId: string, authorId: string, userId: string): Promise<boolean>;
  /** strong, read. Every row of one (layout, user), submitted_at then id. D1: comments.ts readOwnComment. */
  pairRows(layoutId: string, userId: string): Promise<CommentRow[]>;
  /** strong, read. The user's rows on live layouts with layout name/owner, plus like counts per layout. D1: comments.ts listMyComments' two queries. */
  mine(userId: string): Promise<{ rows: (CommentRow & { layout_name: string; layout_owner: string })[]; likeCounts: Map<string, number> }>;
}

export interface ReviewStore {
  /** strong, read. Decision columns of a submission. D1: moderation-review.ts readReviewHistory's first read. */
  decisionState(kind: ReviewKind, id: string): Promise<{ status: string; decided_by: string | null; decided_at: string | null; reason: string | null; review_version: number } | null>;
  /** strong, read. History rows in insertion order. D1: moderation-review.ts readReviewHistory. */
  history(kind: ReviewKind, id: string): Promise<ReviewHistoryRow[]>;
  /** strong, read. D1: moderation-review.ts reopenReview's read. */
  submissionLayout(kind: ReviewKind, id: string): Promise<string | null>;
  /** atomic. Back-fill the decided row into history, reopen (claim), gated event, reopened history row, expire the pending DM. D1: moderation-review.ts reopenReview's batch. */
  reopen(r: { kind: ReviewKind; id: string; expected: ReviewExpectation; at: string; event: GatedEvent; history: HistoryIntent }): Promise<DecisionOutcome>;
  /** strong, read. Whether `actor` already recorded the reopen of `reviewVersion`. D1: discord-interactions.ts performDecision. */
  reopenRecorded(r: { kind: QueueKind; id: string; reviewVersion: number; actor: string }): Promise<boolean>;
  /** strong, read. Status, decider and review version of any queue kind (links report 0). D1: discord-interactions.ts submissionDecision. */
  submissionDecision(kind: QueueKind, id: string): Promise<{ status: string; decided_by: string | null; review_version: number } | null>;
}

// ---------------------------------------------------------------------------
// Agent D: modqueue, Discord interactions, DM outbox, dump
// ---------------------------------------------------------------------------

export type MessageFormat = "text" | "components_v2";
export type MessageTransport = "legacy_webhook" | "bot";

export interface NotificationDbRow {
  message_id: string;
  shown_status: string;
  shown_review_version: number;
  shown_source_message_url: string | null;
  message_format: MessageFormat;
  transport: MessageTransport;
  channel_id: string | null;
}

export interface QueueSourceStatusRow {
  status: string;
  submitter_id: string;
  source_message_url: string | null;
  reason: string | null;
  review_version: number;
  decider_name: string | null;
}

export interface LinkCandidateRow { id: string; layout_id: string; url: string; submitted_by: string; layout_name: string; submitter_name: string | null }
export interface WpmCandidateRow { id: string; review_version: number; source_message_url: string | null; layout_id: string; user_id: string; wpm: number; proof: string; layout_name: string; user_name: string | null }
export interface CommentCandidateRow { id: string; review_version: number; layout_id: string; user_id: string; body: string; layout_name: string; layout_owner: string; user_name: string | null; has_live: number; live_body: string | null }

export interface ModqueueStore {
  /** strong, read. The source submission's current state for the card. D1: modqueue.ts sourceStatus. */
  sourceStatus(kind: QueueKind, id: string): Promise<QueueSourceStatusRow | null>;
  /** single. D1: modqueue.ts failedStatusEdit. */
  bumpFailedAttempts(kind: QueueKind, id: string): Promise<void>;
  /** single. Take the reconcile lease if free or expired. D1: modqueue.ts reconcileOne's lease. */
  leaseNotification(kind: QueueKind, id: string, token: string, until: string, nowIso: string): Promise<boolean>;
  /** strong, read. D1: modqueue.ts reconcileOne. */
  notification(kind: QueueKind, id: string): Promise<NotificationDbRow | null>;
  /** single. D1: modqueue.ts (Discord 404). */
  deleteNotification(kind: QueueKind, id: string): Promise<void>;
  /** single. Record what the card shows, under the lease. D1: modqueue.ts reconcileOne. */
  markShown(r: { kind: QueueKind; id: string; status: string; reviewVersion: number; sourceMessageUrl: string | null; leaseToken: string }): Promise<void>;
  /** single. D1: modqueue.ts reconcileOne's finally. */
  releaseNotificationLease(kind: QueueKind, id: string, leaseToken: string): Promise<void>;
  /** single. Insert if absent. D1: modqueue.ts savePostedMessage. */
  insertNotification(r: { kind: QueueKind; id: string; messageId: string; format: MessageFormat; transport: MessageTransport; channelId: string | null; reviewVersion: number; sourceMessageUrl: string | null }): Promise<void>;
  /** strong, read. Notifications whose card disagrees with the source, fewest failures first. D1: modqueue.ts retryStatusEdits. */
  staleNotifications(limit: number): Promise<{ kind: QueueKind; submission_id: string }[]>;
  /** strong, read. Pending, never-announced link submissions. D1: modqueue.ts LINK_QUEUE.candidateSql. */
  linkCandidates(limit: number): Promise<LinkCandidateRow[]>;
  /** strong, read. D1: modqueue.ts WPM_QUEUE.candidateSql. */
  wpmCandidates(limit: number): Promise<WpmCandidateRow[]>;
  /** strong, read. One pending comment with its context. D1: modqueue.ts announceComment. */
  commentCandidate(id: string): Promise<CommentCandidateRow | null>;
  /** single. Claim the at-most-once announce. D1: modqueue.ts claim. */
  claimAnnounce(kind: "link" | "wpm" | "comment", id: string, at: string): Promise<boolean>;
  /** single. D1: modqueue.ts release. */
  releaseAnnounce(kind: "link" | "wpm" | "comment", id: string, claimedAt: string): Promise<void>;
  /** single. The global Discord delivery gate. D1: modqueue-delivery.ts deliver's claim. */
  claimDeliveryGate(token: string, untilMs: number, nowMs: number): Promise<boolean>;
  /** single. Push `retry_at` forward under the lease. D1: modqueue-delivery.ts deliver. */
  deferDeliveryGate(token: string, retryAtMs: number): Promise<void>;
  /** single. D1: modqueue-delivery.ts deliver's finally. */
  releaseDeliveryGate(token: string): Promise<void>;
}

export type ActionTable = "discord_pending_actions" | "discord_reopen_actions";

export interface DiscordActionRow {
  kind: QueueKind;
  submission_id: string;
  interaction_id: string;
  application_id: string;
  token: string;
  actor_id: string;
  actor_name: string;
  action: "approve" | "deny" | "reopen";
  reason: string | null;
  expected_review_version: number;
  expected_status?: "approved" | "rejected";
  channel_id: string;
  message_id: string;
  guild_id: string;
  created_at: string;
  expires_at: string;
  state: string;
  lease_until: string | null;
  lease_token: string | null;
  result?: string | null;
  response_mode: "reply" | "update";
}

export interface ReopenConfirmationRow {
  confirmation_id: string;
  initial_interaction_id: string;
  actor_id: string;
  kind: "comment" | "wpm";
  submission_id: string;
  channel_id: string;
  message_id: string;
  guild_id: string;
  expected_status: "approved";
  expected_review_version: number;
  expires_at: string;
  consumed_at: string | null;
}

export interface DenyModalRow {
  actor_id: string;
  kind: QueueKind;
  submission_id: string;
  channel_id: string;
  message_id: string;
  guild_id: string;
  expires_at: string;
  consumed_at: string | null;
  expected_review_version: number;
}

/** Thrown by the interaction inserts when the interaction id (or modal) already exists. */
export class DuplicateInteractionError extends Error {}

export interface DiscordStore {
  /** strong, read. A bot-tracked card shows exactly this target, and the submission still has that status/version. D1: discord-interactions.ts trackedTarget (two reads). */
  trackedTarget(t: { kind: QueueKind; id: string; status: string; reviewVersion: number }, channelId: string, messageId: string): Promise<boolean>;
  /** strong, read. Any of the four interaction tables already holds this interaction id. D1: discord-interactions.ts hasReceipt. */
  hasReceipt(interactionId: string): Promise<boolean>;
  /** sequence. Oldest claimable action, then its lease CAS; null if none or lost. D1: discord-interactions.ts claimAction. */
  claimAction(table: ActionTable, at: string, until: string, leaseToken: string): Promise<DiscordActionRow | null>;
  /** sequence. Expire overdue actions, delete expired modals, delete finished expired actions. D1: drainActionTable's first three statements. */
  expireActions(table: ActionTable, nowIso: string): Promise<void>;
  /** sequence. Actions disabled: expire every open action, clear completed tokens. D1: drainActionTable's disabled branch. */
  disableActions(table: ActionTable): Promise<void>;
  /** single. Expire one action under its lease with `result`. D1: drainActionTable (configuration changed). */
  expireLeasedAction(table: ActionTable, interactionId: string, leaseToken: string, result: string): Promise<void>;
  /** single. Back to pending under the lease. D1: drainActionTable's catch. */
  releaseAction(table: ActionTable, interactionId: string, leaseToken: string): Promise<void>;
  /** single. Complete under the lease, keeping `token` for a callback retry or clearing it. D1: drainActionTable. */
  completeAction(table: ActionTable, interactionId: string, leaseToken: string, result: string | null, token: string): Promise<void>;
  /** strong, read. Completed actions still owing a callback. D1: drainActionTable. */
  pendingCallbacks(table: ActionTable, nowIso: string, limit: number): Promise<DiscordActionRow[]>;
  /** single. D1: drainActionTable. */
  clearCallbackToken(table: ActionTable, interactionId: string, token: string): Promise<void>;
  /** single. D1: drainActionTable. */
  bumpCallbackAttempts(table: ActionTable, interactionId: string, token: string): Promise<void>;
  /** single. D1: drainDiscordActions. */
  deleteExpiredConfirmations(nowIso: string): Promise<void>;
  /** strong, read. D1: handleReopenConfirmation. */
  reopenConfirmation(id: string): Promise<ReopenConfirmationRow | null>;
  /** single. Consume a confirmation (cancel). D1: handleReopenConfirmation. */
  consumeConfirmation(id: string, at: string, interactionId: string): Promise<boolean>;
  /** atomic. Consume an unexpired confirmation and queue the reopen action it authorizes; false = already used. Throws DuplicateInteractionError on an id clash. D1: handleReopenConfirmation's batch. */
  consumeConfirmationAndQueueReopen(r: { confirmationId: string; at: string; action: Omit<DiscordActionRow, "state" | "lease_until" | "lease_token" | "result" | "reason" | "response_mode"> & { expected_status: "approved" | "rejected" } }): Promise<boolean>;
  /** single. Throws DuplicateInteractionError on an id clash. D1: handleDiscordInteraction (deny). */
  insertDenyModal(r: { modalId: string; initialInteractionId: string; actorId: string; kind: QueueKind; submissionId: string; channelId: string; messageId: string; guildId: string; createdAt: string; expiresAt: string; expectedReviewVersion: number }): Promise<void>;
  /** strong, read. D1: handleDiscordInteraction (modal submit). */
  denyModal(modalId: string): Promise<DenyModalRow | null>;
  /** atomic. Consume the modal and queue its deny action; false = already submitted. Throws DuplicateInteractionError. D1: handleDiscordInteraction's modal batch. */
  consumeModalAndQueueDeny(r: { modalId: string; actorId: string; at: string; action: Omit<DiscordActionRow, "state" | "lease_until" | "lease_token" | "result" | "response_mode" | "expected_status"> }): Promise<boolean>;
  /** single. Queue an approve/reopen action (response_mode 'update'). Throws DuplicateInteractionError. D1: handleDiscordInteraction (component). */
  insertAction(table: ActionTable, action: Omit<DiscordActionRow, "state" | "lease_until" | "lease_token" | "result" | "response_mode" | "reason">): Promise<void>;
}

export interface OutboxContentRow {
  recipient_id: string;
  reason: string | null;
  layout_name: string;
  deleted: number;
  comment_body: string | null;
  wpm: number | null;
  proof: string | null;
  link_url: string | null;
  eligible: number;
}

export interface OutboxStore {
  /** strong, read. Due rows (pending past next_attempt_at, or expired leases), at most `limit`. D1: rejection-dm.ts dispatchRejectionDms. */
  due(nowIso: string, limit: number): Promise<RejectionOutboxRow[]>;
  /** single. Lease a due row. D1: dispatchRejectionDms' claim. */
  lease(deliveryKey: string, token: string, until: string, at: string): Promise<boolean>;
  /** strong, read. The submission + layout facts the DM needs. D1: rejection-dm.ts readEligibleContent. */
  content(row: RejectionOutboxRow): Promise<OutboxContentRow | null>;
  /** single. Mark the message attempt begun under a live lease. D1: dispatchRejectionDms' begin. */
  beginMessage(r: { deliveryKey: string; token: string; at: string; channelId: string }): Promise<boolean>;
  /** single. D1: dispatchRejectionDms (sent). */
  markSent(r: { deliveryKey: string; token: string; messageId: string; at: string }): Promise<void>;
  /** single. D1: handleFailure (clear the ambiguous mark). */
  clearAmbiguous(r: { deliveryKey: string; token: string; at: string }): Promise<void>;
  /** single. Back to pending at `nextAttemptAt`. D1: rejection-dm.ts retry. */
  retry(r: { deliveryKey: string; token: string; at: string; nextAttemptAt: string; error: string }): Promise<void>;
  /** single. Push every pending row to at least `until` (global rate limit). D1: rejection-dm.ts retry. */
  deferAllPending(until: string, at: string): Promise<void>;
  /** single. Terminal status under the lease. D1: rejection-dm.ts terminal. */
  terminal(r: { deliveryKey: string; token: string; at: string; status: "blocked" | "uncertain" | "failed" | "expired"; error: string }): Promise<void>;
}

export interface DumpStore {
  /** strong, read. Every dumped table's raw rows, all read AFTER the caller's meta read (MF-13 floor); unfiltered (the caller redacts and filters). D1: dump/write.ts buildDump's pagers. */
  tables(): Promise<Omit<Dump, "version" | "date" | "meta" | "auth_cache">>;
  /** sequence (chunked). Load a dump into an EMPTY database (rehost, tests). D1: dump/restore.ts restoreInto. */
  restore(dump: Dump): Promise<void>;
}

// ---------------------------------------------------------------------------
// The whole port
// ---------------------------------------------------------------------------

export interface Store {
  readonly head: HeadStore;
  readonly state: StateStore;
  readonly layouts: LayoutReadStore;
  readonly events: EventStore;
  readonly holds: HoldStore;
  readonly cutover: CutoverStore;
  readonly auth: AuthStore;
  readonly admin: AdminStore;
  readonly links: LinkStore;
  readonly wpm: WpmStore;
  readonly comments: CommentStore;
  readonly review: ReviewStore;
  readonly modqueue: ModqueueStore;
  readonly discord: DiscordStore;
  readonly outbox: OutboxStore;
  readonly dump: DumpStore;
}

// Re-exported so implementations import every type from one place.
export type { Actor, EventDbRow, EventSnapshot, LinkSnapshot };
