// Records + events, the fold (21-formats.md §2.1/§2.2). `commitWrite` is the
// only code under `src/` that writes `layouts`/`layout_formats` (checked by
// tests/tools/onlywriter.test.ts); `records.ts` only reads. Every
// rev-bumping event has exactly one SCOPE (`format === null` = the layout;
// otherwise a lineage) and bumps exactly that scope's rev (MF-2); a write
// that changes both scopes (a create, some imports) appends one event per
// scope, in the same D1 batch, serialized by ONE shared per-layout counter
// `n` (`layout_revs`' PK `(layout_id, n)`, migrations/0009_formats.sql).
import type { Bindings } from "../env";
import { canonical } from "./canonical";
import type { FormatRow, LayoutRow, Source, Upstream } from "./records";
import { ulid } from "ulidx";
import type { Clock } from "./time";
import { legacyD1, toStore, type StoreArg } from "../store/arg";

// A write lost the rev race: another write to the SAME layout (either
// scope) committed the next `n` first (the `layout_revs` PK refused the
// loser's batch). The write pipeline (`core/write.ts`) turns this into a
// retry (own scope unchanged) or `409 stale` (own scope moved).
export class RevConflictError extends Error {
  constructor(readonly layoutId: string) {
    super(`layout '${layoutId}' was written concurrently`);
  }
}

export type WriteKind =
  | "created"
  | "format_added"
  | "updated"
  | "renamed"
  | "fingermap"
  | "transferred"
  | "deleted"
  | "restored"
  | "imported"
  | "upstream_deleted";

// "upstream_deleted" is deliberately in both WriteKind and InfoKind: a
// following layout's tombstoning is rev-bumping (layout scope), a
// non-following layout's is informational.
export type InfoKind =
  | "upstream_changed"
  | "import_conflict"
  // LDB-B5 (design/layout-db/review/audit-db.md B5): a non-conflict error
  // from one id's apply, recorded so the tick can keep going instead of
  // aborting -- `import/apply.ts`'s `recordImportError`.
  | "import_error"
  // design/layout-db/23-geometry.md §4.6 (LDB-F28): `fromCmini` relabelled
  // a `TB` finger, or an `LT`/`RT` thumb whose column disagreed with the
  // `col < 5 => LT else RT` rule -- `import/apply.ts` records one of these
  // per id whose `describeImportChanges(...).relabeled` is non-empty,
  // naming every relabelled key/free position in `detail`.
  | "import_relabel"
  | "upstream_deleted"
  | "admin.added"
  | "admin.removed"
  | "admin.import_paused"
  | "admin.import_resumed"
  | "admin.client_registered"
  | "admin.client_revoked"
  // saltorbit 2026-09-13 (rogue-trusted-client hardening): distinct from
  // client_revoked (terminal) -- a suspension is re-activatable by an
  // admin, whether it was tripped automatically (the destructive-write
  // budget, actor system:budget-guard) or triggered by hand (POST
  // /v1/admin/clients/{id}/suspend).
  | "admin.client_suspended"
  | "admin.client_reactivated"
  | "admin.import_ticked"
  | "admin.diff_ticked"
  | "admin.nightly_ticked"
  // LDB-I25 (saltorbit 2026-09-13, hostile/vanished-upstream recovery tooling):
  // `POST /v1/admin/import/unstall` -- clears `cmini.stalled` deliberately.
  // Documented as a MANUAL override, not a fix: the next tick re-plans
  // from scratch, so an upstream still short-listing or still mass-
  // deleting re-stalls immediately (`import/recovery.ts`).
  | "admin.import_unstalled"
  // L5 moderation (design/akldb-site/01-plan.md §4): bans are actor-scoped
  // (`layout_id` NULL, `appendAdmin`) -- author-rename/link are
  // layout-scoped (`appendModeration`/`appendLinkChange`, `layout_id` set,
  // `rev` NULL). The like-count override's own kind (admin dot likes_set)
  // was retired H24 (2026-09-13) -- see `foldLayout`'s comment for the
  // historical-event fallback.
  | "admin.user_banned"
  | "admin.user_unbanned"
  | "admin.author_renamed"
  | "link_submitted"
  | "link_approved"
  | "link_rejected"
  | "link_cleared"
  // docs/decisions/28-wpm-records.md: layout-scoped, never rev-bumping. The
  // feed is public, so `wpm_submitted` carries NO speed or proof while the
  // submission is pending (LDB-WPM7) -- only `wpm_approved` does.
  | "wpm_submitted"
  | "wpm_approved"
  | "wpm_rejected"
  | "wpm_reopened"
  // docs/decisions/29-layout-comments.md: layout-scoped, never rev-bumping.
  // NO comment event ever carries comment text or a reason (LDB-CMT7): the
  // feed is public and a deleted or removed text must be gone from it.
  | "comment_submitted"
  | "comment_approved"
  | "comment_rejected"
  | "comment_reopened"
  | "comment_removed"
  | "comment_deleted"
  // A like on an author's comment slot (LDB-CMT11): ids only, like `liked`.
  | "comment_liked"
  | "comment_unliked";

// 21-formats.md §2.2: what a rev-bumping event's `after` (and `before`)
// carry -- never a payload (that's `layout_revs`' job). A layout-scope
// event's snapshot is the layout's own fields; a format-scope event's is
// that format's row, PLUS `upstream` when THIS write forked/kept it (only
// ever true for lineage `spark` or a layout-scope write -- MF-12). Folding
// a layout's events in seq order, with payloads from `layout_revs`,
// reproduces both tables exactly (MF-3).
// Coordinator review (LOW, third batch): `like_count` is deliberately NOT
// part of a layout-scope event's own snapshot. A rev-bumping write's own
// `like_count` is whatever it read (or self-healed to, M1) at ITS commit
// time, which a feed/webhook reader taking straight off the event would
// see as a wrong, frozen count the moment a like/unlike lands after --
// likes are their own source of truth for counts (`liked`/`unliked`
// events), never a layout-scope event's `after`.
export interface LayoutSnapshot {
  scope: "layout";
  id: string;
  name: string;
  owner: string;
  layout_rev: number;
  created_at: string;
  modified_at: string;
  deleted: boolean;
  upstream: Upstream | null;
  source: Source | null;
}
export interface FormatSnapshot {
  scope: "format";
  layout_id: string;
  lineage: string;
  format: string;
  rev: number;
  created_at: string;
  modified_at: string;
  has_magic: boolean;
  // design/alts/07-format.md: beside `has_magic`, folded the same way --
  // OPTIONAL here (unlike `has_magic`, which existed since layout_formats'
  // own inception): a historical event's `after_json` predating this field
  // simply never had the key at all, so a replay must tolerate its
  // absence -- `foldLayout` below is the one place that defaults it
  // (`?? false`), same as `rowToLayout`'s own `?? null`/`?? "following"`
  // fallbacks for other retrofitted columns.
  has_alts?: boolean;
  has_combos?: boolean;
  source: Source | null;
  upstream?: Upstream | null;
}
// L5 moderation (§4.4, LDB-MD3): the `after` of a `link_approved` /
// `link_cleared` event -- never a full `LayoutSnapshot` (these are
// `rev: NULL` info events, no scope's rev bumps), just the one folded field
// it carries. `foldLayout` reads these by `kind`, not by `rev !== null`
// (the layout/format branch above), so there is no overlap.
export interface LinkSnapshot {
  scope: "link";
  link: string | null;
}
export type EventSnapshot = LayoutSnapshot | FormatSnapshot | LinkSnapshot;

// One scope-write, fully specified by the caller (`core/write.ts`'s verb
// functions each build this from a fresh read plus their own checks) --
// this module never defaults an "omitted" field from a prior read, so
// there is exactly one place (the verb function) that decides what a write
// keeps vs. changes.
export interface LayoutPart {
  kind: WriteKind;
  name: string;
  owner: string;
  created_at: string;
  deleted: boolean;
  detail?: object;
}
export interface FormatPart {
  kind: WriteKind;
  lineage: string;
  format: string; // full id, e.g. 'spark/1'
  payload: unknown;
  hasMagic: boolean;
  // design/alts/07-format.md: beside `hasMagic`, same convention (computed
  // by the caller from the payload actually being written -- never
  // trusted from a client). Optional, defaulting to `false` (unlike
  // `hasMagic`, required from day one) so the many direct `commitWrite`
  // callers across tests/ that predate this field don't all need touching
  // -- none of their payloads carry `alts`/`combos` anyway.
  hasAlts?: boolean;
  hasCombos?: boolean;
  detail?: object;
}

export interface CommitInput {
  layoutId: string; // minted by the caller (ulid()) when creating
  creating: boolean;
  currentN: number; // 0 when creating
  currentLayout: LayoutRow | null; // null when creating
  currentFormats: Map<string, FormatRow>; // every format the layout currently has (empty when creating)
  layout?: LayoutPart;
  format?: FormatPart;
  modified_at: string;
  actor: string;
  via: string;
  admin?: boolean;
  source: Source;
  // The FINAL upstream value this write leaves (already computed by the
  // caller via `core/upstream.ts`'s `nextUpstream`, from the SAME fresh
  // read `currentLayout` came from -- MF-12).
  upstream: Upstream | null;
  like_count?: number; // present only when a caller needs to seed a non-zero count at create (LDB-P9's tombstone-name inheritance runs a separate appendLike pass instead, so this is always omitted/0 in practice; kept for symmetry)
  // saltorbit 2026-09-13 ("rogue trusted client" hardening): set by
  // `core/write.ts`'s verb functions ONLY for a destructive write
  // (delete/rename/transfer/format-replace) made on the CLIENT lane --
  // `core/write.ts` decides destructiveness (only it knows add-vs-replace
  // for a format write), this module just folds one extra counting
  // statement into its own batch when asked. `clientId` is the bare
  // client id (never the `client:<id>` `via` string).
  destructiveBudget?: { clientId: string };
}

export interface CommitResult {
  layout: LayoutRow;
  formats: Map<string, FormatRow>;
  seqs: number[];
  // Present iff `input.destructiveBudget` was set -- `core/write.ts`'s
  // `commitWithRetry` reads this AFTER the batch commits to decide whether
  // to suspend the client (`core/clients.ts`'s `checkDestructiveBudget`),
  // kept out of this module to avoid a clients.ts <-> events.ts import
  // cycle (clients.ts already imports `appendAdmin` from here).
  budgetProbe?: { clientId: string; countInWindow: number; liveLayouts: number };
}

export function layoutSnapshot(l: {
  id: string;
  name: string;
  owner: string;
  layout_rev: number;
  created_at: string;
  modified_at: string;
  deleted: boolean;
  upstream: Upstream | null;
  source: Source | null;
}): LayoutSnapshot {
  return { scope: "layout", ...l };
}

export function formatSnapshot(f: {
  layout_id: string;
  lineage: string;
  format: string;
  rev: number;
  created_at: string;
  modified_at: string;
  has_magic: boolean;
  has_alts: boolean;
  has_combos: boolean;
  source: Source | null;
  upstream?: Upstream | null;
}): FormatSnapshot {
  return { scope: "format", ...f };
}

// One batch, one shared per-layout counter `n`: events (layout-scope first
// when both are present, then format-scope) -> layout_revs (event_seq =
// last_insert_rowid(), same connection) -> ONE `layouts` upsert reflecting
// every part's effect -> an optional `layout_formats` upsert. `n`'s PK on
// `layout_revs` is the concurrency guard for BOTH scopes at once (21-
// formats.md §2.1: "restores today's serialization while clients still see
// two revs") -- a loser's whole batch rolls back (events included, so
// `seq` stays gapless) and surfaces as `RevConflictError`.
export async function commitWrite(dbArg: StoreArg, now: Clock, input: CommitInput): Promise<CommitResult> {
  if (input.layout === undefined && input.format === undefined) {
    throw new Error("commitWrite: at least one of layout/format must be given");
  }
  return toStore(dbArg).events.commitWrite(now, input);
}

// Informational: `rev`/`format` NULL, `layouts`/`layout_formats` untouched.
export interface Info {
  kind: InfoKind;
  layoutId: string;
  actor: string;
  via: string;
  detail?: object;
  source: Source;
}

export async function appendInfo(dbArg: StoreArg, now: Clock, i: Info): Promise<{ seq: number }> {
  return toStore(dbArg).events.appendInfo(now, i);
}

// [LDB-MD7] `via`/`source` default to the pre-L5 hard-coded values so
// EVERY existing call site (admins.ts's add/remove/pause/resume/manual
// ticks) is byte-for-byte unchanged -- L5's own new callers (bans,
// author-rename) pass the actor's real lane explicitly (LDB-A5: every
// event carries the actor's own lane).
export async function appendAdmin(
  dbArg: StoreArg,
  now: Clock,
  a: { kind: InfoKind; actor: string; via?: string; source?: Source; detail?: object },
): Promise<{ seq: number }> {
  return toStore(dbArg).events.appendAdmin(now, a);
}

// [LDB-MD7] The layout-scoped sibling of `appendAdmin` (§4.4's reviewer
// note 6): an admin action against ONE layout that carries an `after`
// snapshot of its own. `rev` stays NULL (never rev-bumping); always
// `admin: 1` -- every caller of this function IS a moderation action by
// definition (`link_rejected` today).
export interface Moderation {
  kind: InfoKind;
  layoutId: string;
  actor: string;
  via: string;
  source: Source;
  detail?: object;
  after?: object;
}

// Rejection transactions use a conditional event insert directly after their
// pending-row claim. It is gated by that preceding statement's changes() so a
// losing concurrent decision cannot append an event.
export function rejectionModerationStatement(dbArg: StoreArg, at: string, m: Moderation): D1PreparedStatement {
  const db = legacyD1(dbArg);
  return db
    .prepare(
      `INSERT INTO events (at, kind, layout_id, name, owner, format, rev, actor, via, admin, detail_json, before_json, after_json, source_client, source_version)
       SELECT ?, ?, ?, (SELECT name FROM layouts WHERE id = ?), (SELECT owner FROM layouts WHERE id = ?),
              NULL, NULL, ?, ?, 1, ?, NULL, ?, ?, ?
       WHERE changes() = 1`,
    )
    .bind(
      at,
      m.kind,
      m.layoutId,
      m.layoutId,
      m.layoutId,
      m.actor,
      m.via,
      m.detail === undefined ? null : canonical(m.detail),
      m.after === undefined ? null : canonical(m.after),
      m.source.client,
      m.source.version,
    );
}

export async function appendModeration(dbArg: StoreArg, now: Clock, m: Moderation): Promise<{ seq: number }> {
  return toStore(dbArg).events.appendModeration(now, m);
}

// [LDB-MD3] [LDB-MD5] [LDB-MD7] §4.4: the ONLY writer of `layouts.link`
// (LDB-P1, `tests/tools/onlywriter.test.ts`'s allow-list names this
// function's home file, never `core/links.ts`). One batch: the `layouts`
// UPDATE, the `link_approved`/`link_cleared` event (`after.link` so
// `foldLayout` replays exactly), and -- always, not just on approve -- a
// sweep that supersedes every OTHER still-pending submission for this
// layout (covers both "approving supersedes any other pending submission"
// and "clearing supersedes the pending submission it had", with no
// separate event for that bookkeeping, same as a fresh owner submission
// superseding an older pending one).
export interface LinkChange {
  layoutId: string;
  kind: "link_approved" | "link_cleared";
  link: string | null;
  actor: string;
  via: string;
  admin: boolean;
  source: Source;
  submissionId?: string; // the submission THIS approval decides, if any
  detail?: object; // e.g. a bulk revert's {revert_of_seq, admin} attribution
  // saltorbit 2026-09-13 ("rogue trusted client" hardening): set only for a
  // `link_cleared` made on the client lane -- see `CommitInput`'s own
  // field (`commitWrite`, above) for the full rationale; same shape, same
  // "fold into this batch" mechanism, so a link removal costs zero extra
  // D1 round trips beyond what this function already pays.
  destructiveBudget?: { clientId: string };
}

export async function appendLinkChange(dbArg: StoreArg, now: Clock, l: LinkChange): Promise<{ seq: number; link: string | null; budgetProbe?: { clientId: string; countInWindow: number; liveLayouts: number } }> {
  return toStore(dbArg).events.appendLinkChange(now, l);
}

export interface Like {
  kind: "liked" | "unliked";
  layoutId: string;
  userId: string;
  via: string;
  detail?: object;
  source: Source;
  // LDB-L8b: when the caller already has a fresh `LayoutRow` for
  // `layoutId` in hand (`core/likes.ts`'s `loadForLike` reads it anyway,
  // to check `deleted`/the qwerty refusal before calling this), pass it
  // here so this function doesn't re-read the same row a second time.
  // Omitted, this reads it itself (every existing caller: the tombstone
  // name-inheritance loop in `core/write.ts`, `import/apply.ts`, and every
  // direct test call) -- behavior-identical either way, since `current` is
  // used only for its `name`/`owner` (denormalized onto the event row) and
  // the `like_count` fallback below.
  current?: LayoutRow;
}

// D13 L1/L2 (saltorbit, 2026-09-11): a like/unlike needs no version (L3), but
// it is no longer a silent no-op on repeat -- a repeat like fails with
// `409 already_liked`, a redundant unlike with `409 not_liked`, and either
// way NOTHING is written (no event, `like_count` untouched). Layout-level,
// same as ever -- no format is involved.
//
// LDB-L8b (review/LEDGER.md L8): no pre-batch "am I already liked?" read
// any more -- straight to the guarded batch below, whose own EXISTS/
// NOT EXISTS conditions already decide the exact same already_liked/
// not_liked outcome at commit time (`results[0].meta.changes === 0`
// below), race or no race. This is not a behavior change (every caller
// already tolerated this outcome, since a CONCURRENT request could always
// reach the batch's guard first); it's one fewer D1 round trip on every
// like/unlike, not just the racing ones.
export async function appendLike(dbArg: StoreArg, now: Clock, l: Like): Promise<{ seq: number; like_count: number }> {
  return toStore(dbArg).events.appendLike(now, l);
}

// LDB-L8c (review/LEDGER.md L8): `core/write.ts`'s `createLayout`, when a
// tombstoned name it's reclaiming (LDB-P9) had likes, used to copy them
// one `appendLike` call at a time -- a read, a pre-check and a batch EACH,
// so reclaiming a well-liked name cost 3x its liker count in D1 round
// trips. This is the same outcome (one `liked` event per former liker,
// `via`/`detail` shared, plus a real `likes` row copied for each) in ONE
// batch, however many likers -- `userIds` must be non-empty (callers
// already only reach this when it is, LDB-P9's own "nothing to inherit"
// case never calls it at all).
export async function appendInheritedLikes(
  dbArg: StoreArg,
  now: Clock,
  a: { layoutId: string; name: string; owner: string; userIds: string[]; via: string; detail: object; source: Source },
): Promise<{ like_count: number }> {
  return toStore(dbArg).events.appendInheritedLikes(now, a);
}

// A parsed `events` row (D1's 0/1 and JSON-string columns converted).
export interface Event {
  seq: number;
  at: string;
  kind: string;
  layout_id: string | null;
  name: string | null;
  owner: string | null;
  format: string | null;
  rev: number | null;
  actor: string;
  via: string;
  admin: boolean;
  detail: unknown;
  before: EventSnapshot | null;
  after: EventSnapshot | null;
  source: Source;
}

export interface EventDbRow {
  seq: number;
  at: string;
  kind: string;
  layout_id: string | null;
  name: string | null;
  owner: string | null;
  format: string | null;
  rev: number | null;
  actor: string;
  via: string;
  admin: number;
  detail_json: string | null;
  before_json: string | null;
  after_json: string | null;
  source_client: string | null;
  source_version: string | null;
}

export function sourceOfEvent(row: { source_client: string | null; source_version: string | null; via: string }): Source {
  if (row.source_client === null) return { client: `legacy:${row.via}`, version: null };
  return { client: row.source_client, version: row.source_version };
}

export function rowToEvent(row: EventDbRow): Event {
  return {
    seq: row.seq,
    at: row.at,
    kind: row.kind,
    layout_id: row.layout_id,
    name: row.name,
    owner: row.owner,
    format: row.format,
    rev: row.rev,
    actor: row.actor,
    via: row.via,
    admin: row.admin !== 0,
    detail: row.detail_json === null ? null : JSON.parse(row.detail_json),
    before: row.before_json === null ? null : (JSON.parse(row.before_json) as EventSnapshot),
    after: row.after_json === null ? null : (JSON.parse(row.after_json) as EventSnapshot),
    source: sourceOfEvent(row),
  };
}

// MF-3: folds one layout's events (seq order) plus its `layout_revs`
// payloads into its `layouts` row and every `layout_formats` row. `revs`
// keys on `(lineage-or-null, rev)`: null lineage for the layout scope.
// `n` (the internal write counter) is never carried on an event snapshot
// (§2.2's "after" is deliberately payload-and-`n`-free), so a fold can
// reconstruct every OTHER `layouts` column but not `n` itself -- callers
// that need `n` already have it from the row they read to get the events
// in the first place.
export interface FoldedLayout {
  layout: Omit<LayoutRow, "n">;
  formats: Map<string, FormatRow>;
}

// Function boundaries here (rather than inlining the spread in the loop)
// sidestep a TS control-flow-analysis quirk: narrowing a `let` through its
// own reassignment inside a loop resolves the spread's operand to `never`
// at the call site (`core/events.ts`'s `bumpLikeCount` hit the same thing
// before this rewrite).
function withUpstream(l: LayoutSnapshot, upstream: Upstream | null): LayoutSnapshot {
  return { ...l, upstream };
}

function revKey(lineage: string | null, rev: number): string {
  return `${lineage ?? ""} ${rev}`;
}

export function foldLayout(events: Event[], revs: Map<string, { format: string | null; payload: unknown }>): FoldedLayout | null {
  let layout: LayoutSnapshot | null = null;
  const formats = new Map<string, FormatSnapshot>();
  // Coordinator review (LOW, third batch): `like_count` no longer lives
  // on any event's own `after` snapshot at all (see LayoutSnapshot's own
  // comment) -- likes are their own source of truth for counts, so this
  // tracks the running tally independently of `layout`, purely from every
  // `liked`/`unliked` event actually replayed, and attaches it to the
  // fold's OUTPUT once at the end, never to an intermediate snapshot.
  let likeCount = 0;
  // [LDB-MD3] §4.4: `link` is a fold of the latest `link_approved` /
  // `link_cleared` event's `after` -- tracked the same way `likeCount` is,
  // independent of `layout`, and attached to the fold's output once at
  // the end.
  let link: string | null = null;

  for (const e of events) {
    if (e.rev !== null) {
      if (e.after === null) throw new Error(`foldLayout: rev-bumping event (seq ${e.seq}) has no 'after'`);
      if (e.after.scope === "layout") {
        layout = e.after;
      } else if (e.after.scope === "format") {
        const after = e.after;
        formats.set(after.lineage, after);
        if (after.upstream !== undefined && layout !== null) {
          layout = withUpstream(layout, after.upstream);
        }
      } else {
        throw new Error(`foldLayout: rev-bumping event (seq ${e.seq}) has an unexpected 'after' scope`);
      }
    } else if (e.kind === "liked" || e.kind === "unliked") {
      if (layout === null) throw new Error(`foldLayout: like event (seq ${e.seq}) precedes any write`);
      likeCount += e.kind === "liked" ? 1 : -1;
    } else if (e.kind === "admin.likes_set") {
      // Retired (H24, 2026-09-13): the admin like-count override is gone,
      // but a pre-existing event log (or a dump taken before this change)
      // may still carry this kind -- ignore it rather than throw.
    } else if (e.kind === "link_approved" || e.kind === "link_cleared") {
      if (e.after === null || e.after.scope !== "link") throw new Error(`foldLayout: ${e.kind} event (seq ${e.seq}) has no link 'after'`);
      link = e.after.link;
    }
  }

  if (layout === null) return null;
  const { scope: _s, ...layoutRow } = layout;
  const formatRows = new Map<string, FormatRow>();
  for (const [lin, snap] of formats) {
    const rev = revs.get(revKey(lin, snap.rev));
    if (rev === undefined) throw new Error(`foldLayout: no layout_revs entry for lineage '${lin}' rev ${snap.rev}`);
    const { scope: _s2, upstream: _u, ...rest } = snap;
    // design/alts/07-format.md: a historical event's `after_json` predating
    // has_alts/has_combos simply lacks the keys -- default false, same
    // fallback the stored-column read path (`rowToFormat`) never needs
    // (its column is backfilled) but a pure event replay does.
    formatRows.set(lin, { ...rest, has_alts: rest.has_alts ?? false, has_combos: rest.has_combos ?? false, payload: rev.payload });
  }
  return {
    layout: { ...layoutRow, like_count: Math.max(0, likeCount), link },
    formats: formatRows,
  };
}

export interface FeedFilter {
  layoutId?: string;
  actor?: string;
  format?: string; // 21-formats.md §2.4: `/history`'s optional filter -- absent means all, not a default
}

// [LDB-MD13] The feed is public and unauthenticated, and a mod-queue
// submission that is not approved is private to admins (saltorbit
// 2026-10-18): `link_submitted` was written with the pending `url` in its
// detail, and `link_rejected` carries the moderator's reason. Rows already
// stored that way (migrations are additive, nothing is rewritten) are
// redacted HERE, on read, to the submission id alone -- the queue
// (`GET /v1/admin/link-queue`) is where an admin reads the rest. Applied in
// `feed()`, the one reader behind `/v1/changes` and `/admin/changelog`.
const PRIVATE_DETAIL_KINDS = new Set(["link_submitted", "link_rejected", "wpm_submitted", "wpm_rejected", "comment_submitted", "comment_rejected", "comment_reopened", "wpm_reopened"]);

export function publicDetail(kind: string, detail: unknown): unknown {
  if (!PRIVATE_DETAIL_KINDS.has(kind)) return detail;
  const id = detail !== null && typeof detail === "object" ? (detail as { submission_id?: unknown }).submission_id : undefined;
  return typeof id === "string" ? { submission_id: id } : null;
}

// The same redaction for a raw `events` row, at DUMP-WRITE time
// (`dump/write.ts`, LDB-MD8): the dump is public, so a row stored before the
// feed fix (url / reason in `detail_json`) must not reach a new dump either.
export function redactEventRow(row: EventDbRow): EventDbRow {
  if (!PRIVATE_DETAIL_KINDS.has(row.kind) || row.detail_json === null) return row;
  const redacted = publicDetail(row.kind, JSON.parse(row.detail_json));
  return { ...row, detail_json: redacted === null ? null : canonical(redacted) };
}

export async function feed(dbArg: StoreArg, since: number, limit: number, kinds?: string[], filter?: FeedFilter): Promise<{ next: number; items: Event[] }> {
  return toStore(dbArg).events.feed(since, limit, kinds, filter);
}
