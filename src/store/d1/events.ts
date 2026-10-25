// D1 implementation of `EventStore` (src/store/port.ts). Owner: P1 agent A
// (design/p1-briefs.md). The statements of core/events.ts (commitWrite,
// appendInfo/Admin/Moderation/LinkChange/Like/InheritedLikes, feed) and
// core/revert.ts's two event reads, moved verbatim, plus the
// destructive-budget statement (only commitWrite/appendLinkChange batch it).
import { canonical } from "../../core/canonical";
import { DESTRUCTIVE_WINDOW_SECONDS, destructiveBudgetKey, type DestructiveBudgetRow } from "../../core/destructive-budget";
import { alreadyLiked as alreadyLikedError, nameTaken, notFound, notLiked as notLikedError } from "../../core/errors";
import {
  RevConflictError,
  formatSnapshot,
  layoutSnapshot,
  publicDetail,
  rowToEvent,
  type CommitResult,
  type EventDbRow,
  type EventSnapshot,
  type FormatSnapshot,
  type LayoutSnapshot,
  type WriteKind,
} from "../../core/events";
import type { FormatRow, LayoutRow, Source } from "../../core/records";
import type { Clock } from "../../core/time";
import type { EventStore } from "../port";
import { readLayoutById } from "./layouts";

// One statement, meant to be pushed into a CALLER's OWN `db.batch()` array
// -- never run standalone. The fixed-window upsert+RETURNING shape
// `core/ratelimit.ts`'s `take()` proved race-safe under concurrency, keyed
// apart from the write-rate limiter's own rows (a distinct `key` prefix in
// the SAME `ratelimit` table). The `live_layouts` scalar subquery rides in
// the SAME statement so the caller never needs a second read to compute the
// percentage half of the threshold.
function destructiveBudgetStatement(db: D1Database, now: Clock, clientId: string, windowSeconds: number = DESTRUCTIVE_WINDOW_SECONDS): D1PreparedStatement {
  const nowSeconds = Math.floor(new Date(now()).getTime() / 1000);
  const windowStart = Math.floor(nowSeconds / windowSeconds) * windowSeconds;
  return db
    .prepare(
      `INSERT INTO ratelimit (key, window_start, n) VALUES (?1, ?2, 1)
       ON CONFLICT(key) DO UPDATE SET
         n = CASE WHEN window_start = excluded.window_start THEN n + 1 ELSE 1 END,
         window_start = excluded.window_start
       RETURNING n, window_start, (SELECT COUNT(*) FROM layouts WHERE deleted = 0) AS live_layouts`,
    )
    .bind(destructiveBudgetKey(clientId), windowStart);
}

// Decodes the `D1Result` at whatever index the caller pushed the
// statement above into its own batch.
function readDestructiveBudgetRow(result: { results?: unknown[] } | undefined): DestructiveBudgetRow | null {
  const row = result?.results?.[0] as DestructiveBudgetRow | undefined;
  return row ?? null;
}

function lineageOf(format: string): string {
  const i = format.lastIndexOf("/");
  return i === -1 ? format : format.slice(0, i);
}

export function d1EventStore(db: D1Database): EventStore {
  return {
    // One batch, one shared per-layout counter `n`: events (layout-scope first
    // when both are present, then format-scope) -> layout_revs (event_seq =
    // last_insert_rowid(), same connection) -> ONE `layouts` upsert reflecting
    // every part's effect -> an optional `layout_formats` upsert. `n`'s PK on
    // `layout_revs` is the concurrency guard for BOTH scopes at once (21-
    // formats.md §2.1) -- a loser's whole batch rolls back (events included, so
    // `seq` stays gapless) and surfaces as `RevConflictError`.
    async commitWrite(now, input) {
      const at = now();
      const id = input.layoutId;

      // LDB-L8a: no separate name-clash pre-read. `layouts_name_live` (a
      // partial UNIQUE index on `name WHERE deleted = 0`) is the ONLY
      // enforcement point -- a live layout-scope write that would clash fails
      // the batch below with `UNIQUE constraint failed: layouts.name`, caught
      // right after `db.batch()` and mapped to `nameTaken()`.
      const finalLayoutRev = input.layout !== undefined ? (input.creating ? 1 : input.currentLayout!.layout_rev + 1) : (input.currentLayout?.layout_rev ?? 0);
      const finalLikeCount = input.like_count ?? input.currentLayout?.like_count ?? 0;
      const finalName = input.layout?.name ?? input.currentLayout!.name;
      const finalOwner = input.layout?.owner ?? input.currentLayout!.owner;
      const finalCreatedAt = input.layout?.created_at ?? input.currentLayout!.created_at;
      const finalDeleted = input.layout?.deleted ?? input.currentLayout!.deleted;
      const finalModifiedAt = input.layout !== undefined ? input.modified_at : (input.currentLayout?.modified_at ?? input.modified_at);
      const finalLayoutSource: Source | null = input.layout !== undefined ? input.source : (input.currentLayout?.source ?? null);

      const existingFormat = input.format !== undefined ? input.currentFormats.get(input.format.lineage) ?? null : null;
      const finalFormatRev = input.format !== undefined ? (existingFormat?.rev ?? 0) + 1 : 0;
      const finalFormatCreatedAt = input.format !== undefined ? (existingFormat?.created_at ?? input.modified_at) : "";

      const beforeLayout: LayoutSnapshot | null = input.currentLayout === null ? null : layoutSnapshot(input.currentLayout);
      const beforeFormat: FormatSnapshot | null = existingFormat === null ? null : formatSnapshot(existingFormat);

      const afterLayout: LayoutSnapshot = layoutSnapshot({
        id,
        name: finalName,
        owner: finalOwner,
        layout_rev: finalLayoutRev,
        created_at: finalCreatedAt,
        modified_at: finalModifiedAt,
        deleted: finalDeleted,
        upstream: input.upstream,
        source: finalLayoutSource,
      });

      // The format-scope event's snapshot carries `upstream` too (MF-3, MF-12)
      // iff this format IS lineage `spark` -- the one lineage a format-scope
      // write is allowed to fork/carry upstream through. When a layout part is
      // ALSO present in the same batch, the layout event already carries the
      // same value; this is harmless, idempotent overlap for the fold.
      const formatTouchesUpstream = input.format !== undefined && input.format.lineage === "spark";
      const afterFormat: FormatSnapshot | undefined =
        input.format === undefined
          ? undefined
          : formatSnapshot({
              layout_id: id,
              lineage: input.format.lineage,
              format: input.format.format,
              rev: finalFormatRev,
              created_at: finalFormatCreatedAt,
              modified_at: input.modified_at,
              has_magic: input.format.hasMagic,
              has_alts: input.format.hasAlts ?? false,
              has_combos: input.format.hasCombos ?? false,
              source: input.source,
              ...(formatTouchesUpstream ? { upstream: input.upstream } : {}),
            });

      const stmts: D1PreparedStatement[] = [];
      const seqSlots: number[] = [];
      let nCursor = input.currentN;

      function pushEvent(kind: WriteKind, format: string | null, rev: number, before: EventSnapshot | null, after: EventSnapshot, detail: object | undefined) {
        stmts.push(
          db
            .prepare(
              `INSERT INTO events (at, kind, layout_id, name, owner, format, rev, actor, via, admin, detail_json, before_json, after_json, source_client, source_version)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .bind(
              at,
              kind,
              id,
              finalName,
              finalOwner,
              format,
              rev,
              input.actor,
              input.via,
              input.admin === true ? 1 : 0,
              detail === undefined ? null : canonical(detail),
              before === null ? null : canonical(before),
              canonical(after),
              input.source.client,
              input.source.version,
            ),
        );
        seqSlots.push(stmts.length - 1);
        nCursor += 1;
        stmts.push(
          db
            .prepare(
              `INSERT INTO layout_revs (layout_id, n, lineage, rev, event_seq, format, payload_json)
           VALUES (?, ?, ?, ?, last_insert_rowid(), ?, ?)`,
            )
            .bind(id, nCursor, format === null ? null : lineageOf(format), rev, format, format === null ? null : canonical(input.format!.payload)),
        );
      }

      if (input.layout !== undefined) {
        pushEvent(input.layout.kind, null, finalLayoutRev, beforeLayout, afterLayout, input.layout.detail);
      }
      if (input.format !== undefined) {
        pushEvent(input.format.kind, input.format.format, finalFormatRev, beforeFormat, afterFormat!, input.format.detail);
      }

      // ONE `layouts` upsert reflecting the final state after every part in
      // this batch (n bumped once per part, whatever else changed).
      // H24 (2026-09-13): `like_count` self-heals to `COUNT(DISTINCT user_id)
      // FROM likes` on every rev-bumping write, never the raw pre-read count --
      // `like_adjust` is a dead column (migrations/0015) that no code reads or
      // writes any more; a fresh create has no prior row to read, so its own
      // `VALUES` supplies the pre-read count directly. `link` is likewise never
      // touched by an ordinary write (only `appendLinkChange` may -- LDB-P1's
      // onlywriter test names both).
      stmts.push(
        db
          .prepare(
            `INSERT INTO layouts (id, name, owner, n, layout_rev, created_at, modified_at, deleted, like_count, link, upstream_source, upstream_id, upstream_state, source_client, source_version)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name, owner = excluded.owner, n = excluded.n, layout_rev = excluded.layout_rev,
           created_at = excluded.created_at, modified_at = excluded.modified_at, deleted = excluded.deleted,
           like_count = (SELECT COUNT(*) FROM likes WHERE layout_id = excluded.id),
           upstream_source = excluded.upstream_source, upstream_id = excluded.upstream_id, upstream_state = excluded.upstream_state,
           source_client = excluded.source_client, source_version = excluded.source_version`,
          )
          .bind(
            id,
            finalName,
            finalOwner,
            nCursor,
            finalLayoutRev,
            finalCreatedAt,
            finalModifiedAt,
            finalDeleted ? 1 : 0,
            finalLikeCount,
            input.upstream?.source ?? null,
            input.upstream?.id ?? null,
            input.upstream?.state ?? null,
            finalLayoutSource?.client ?? null,
            finalLayoutSource?.version ?? null,
          ),
      );

      if (input.format !== undefined) {
        stmts.push(
          db
            .prepare(
              `INSERT INTO layout_formats (layout_id, lineage, format, rev, created_at, modified_at, payload_json, has_magic, has_alts, has_combos, source_client, source_version)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(layout_id, lineage) DO UPDATE SET
             format = excluded.format, rev = excluded.rev, created_at = excluded.created_at, modified_at = excluded.modified_at,
             payload_json = excluded.payload_json, has_magic = excluded.has_magic, has_alts = excluded.has_alts, has_combos = excluded.has_combos,
             source_client = excluded.source_client, source_version = excluded.source_version`,
            )
            .bind(
              id,
              input.format.lineage,
              input.format.format,
              finalFormatRev,
              finalFormatCreatedAt,
              input.modified_at,
              canonical(input.format.payload),
              input.format.hasMagic ? 1 : 0,
              input.format.hasAlts ? 1 : 0,
              input.format.hasCombos ? 1 : 0,
              input.source.client,
              input.source.version,
            ),
        );
      }

      // M1: read `like_count`/`link` back in the SAME batch, after the
      // `layouts` upsert's own self-healing subquery has run, so the value
      // this call RETURNS to its own caller is the same live truth the row now
      // holds -- never `finalLikeCount`, which can be a stale pre-read.
      const likeCountStmtIdx = stmts.length;
      stmts.push(db.prepare(`SELECT like_count, link FROM layouts WHERE id = ?`).bind(id));

      // saltorbit 2026-09-13 ("rogue trusted client" hardening): folded into this
      // SAME batch -- LDB-L8 counts one `.batch()` call regardless of its
      // statement count, so this costs zero extra D1 round trips.
      let budgetStmtIdx: number | undefined;
      if (input.destructiveBudget !== undefined) {
        budgetStmtIdx = stmts.length;
        stmts.push(destructiveBudgetStatement(db, now, input.destructiveBudget.clientId));
      }

      let results;
      try {
        results = await db.batch(stmts);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (/UNIQUE constraint failed: layouts\.name/.test(msg)) throw nameTaken(finalName);
        if (/UNIQUE constraint failed: layout_revs\./.test(msg)) throw new RevConflictError(id);
        throw e;
      }

      const seqs = seqSlots.map((i) => {
        const seq = results[i]?.meta.last_row_id;
        if (seq === undefined) throw new Error("commitWrite: events insert returned no last_row_id");
        return seq;
      });

      const selfHealed = results[likeCountStmtIdx]?.results?.[0] as { like_count: number; link: string | null } | undefined;
      const trueLikeCount = selfHealed?.like_count ?? finalLikeCount;

      const layout: LayoutRow = {
        id,
        name: finalName,
        owner: finalOwner,
        n: nCursor,
        layout_rev: finalLayoutRev,
        created_at: finalCreatedAt,
        modified_at: finalModifiedAt,
        deleted: finalDeleted,
        like_count: trueLikeCount,
        link: selfHealed?.link ?? null,
        upstream: input.upstream,
        source: finalLayoutSource,
      };
      const formats = new Map<string, FormatRow>(input.currentFormats);
      if (input.format !== undefined) {
        formats.set(input.format.lineage, {
          layout_id: id,
          lineage: input.format.lineage,
          format: input.format.format,
          rev: finalFormatRev,
          created_at: finalFormatCreatedAt,
          modified_at: input.modified_at,
          payload: input.format.payload,
          has_magic: input.format.hasMagic,
          has_alts: input.format.hasAlts ?? false,
          has_combos: input.format.hasCombos ?? false,
          source: input.source,
        });
      }

      let budgetProbe: CommitResult["budgetProbe"];
      if (input.destructiveBudget !== undefined && budgetStmtIdx !== undefined) {
        const row: DestructiveBudgetRow | null = readDestructiveBudgetRow(results[budgetStmtIdx]);
        if (row !== null) {
          budgetProbe = { clientId: input.destructiveBudget.clientId, countInWindow: row.n, liveLayouts: row.live_layouts };
        }
      }

      return { layout, formats, seqs, budgetProbe };
    },

    async appendInfo(now, i) {
      const current = await readLayoutById(db, i.layoutId);
      if (current === null) throw new Error(`appendInfo: layoutId '${i.layoutId}' does not exist`);

      const result = await db
        .prepare(
          `INSERT INTO events (at, kind, layout_id, name, owner, format, rev, actor, via, admin, detail_json, before_json, after_json, source_client, source_version)
       VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, ?, 0, ?, NULL, NULL, ?, ?)`,
        )
        .bind(now(), i.kind, i.layoutId, current.name, current.owner, i.actor, i.via, i.detail === undefined ? null : canonical(i.detail), i.source.client, i.source.version)
        .run();

      const seq = result.meta.last_row_id;
      return { seq };
    },

    async appendAdmin(now, a) {
      const result = await db
        .prepare(
          `INSERT INTO events (at, kind, layout_id, name, owner, format, rev, actor, via, admin, detail_json, before_json, after_json, source_client, source_version)
       VALUES (?, ?, NULL, NULL, NULL, NULL, NULL, ?, ?, 1, ?, NULL, NULL, ?, ?)`,
        )
        .bind(now(), a.kind, a.actor, a.via ?? "discord", a.detail === undefined ? null : canonical(a.detail), a.source?.client ?? null, a.source?.version ?? null)
        .run();

      const seq = result.meta.last_row_id;
      if (seq === undefined) throw new Error("appendAdmin: events insert returned no last_row_id");
      return { seq };
    },

    async appendModeration(now, m) {
      const current = await readLayoutById(db, m.layoutId);
      if (current === null) throw new Error(`appendModeration: layoutId '${m.layoutId}' does not exist`);

      const result = await db
        .prepare(
          `INSERT INTO events (at, kind, layout_id, name, owner, format, rev, actor, via, admin, detail_json, before_json, after_json, source_client, source_version)
       VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, ?, 1, ?, NULL, ?, ?, ?)`,
        )
        .bind(
          now(),
          m.kind,
          m.layoutId,
          current.name,
          current.owner,
          m.actor,
          m.via,
          m.detail === undefined ? null : canonical(m.detail),
          m.after === undefined ? null : canonical(m.after),
          m.source.client,
          m.source.version,
        )
        .run();

      const seq = result.meta.last_row_id;
      if (seq === undefined) throw new Error("appendModeration: events insert returned no last_row_id");
      return { seq };
    },

    async appendLinkChange(now, l) {
      const current = await readLayoutById(db, l.layoutId);
      if (current === null) throw new Error(`appendLinkChange: layoutId '${l.layoutId}' does not exist`);

      const at = now();
      const eventInsert = (gate?: string): D1PreparedStatement => gate === undefined
        ? db.prepare(`INSERT INTO events (at, kind, layout_id, name, owner, format, rev, actor, via, admin, detail_json, before_json, after_json, source_client, source_version)
        VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?, NULL, ?, ?, ?)`)
          .bind(at, l.kind, l.layoutId, current.name, current.owner, l.actor, l.via, l.admin ? 1 : 0,
            l.detail === undefined ? null : canonical(l.detail), canonical({ scope: "link", link: l.link }), l.source.client, l.source.version)
        : db.prepare(`INSERT INTO events (at, kind, layout_id, name, owner, format, rev, actor, via, admin, detail_json, before_json, after_json, source_client, source_version)
        SELECT ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?, NULL, ?, ?, ? WHERE ${gate}`)
          .bind(at, l.kind, l.layoutId, current.name, current.owner, l.actor, l.via, l.admin ? 1 : 0,
            l.detail === undefined ? null : canonical(l.detail), canonical({ scope: "link", link: l.link }), l.source.client, l.source.version);

      let stmts: D1PreparedStatement[];
      let eventStmtIdx: number;
      let claimStmtIdx: number | undefined;
      if (l.submissionId !== undefined) {
        // D1 batch is transactional. The pending→approved CAS is deliberately
        // first; SQLite's changes() gates every side effect on that exact
        // statement. Competing admin/Discord decisions therefore cannot both
        // change layouts or append approval events.
        stmts = [
          db.prepare(`UPDATE link_submissions SET status = 'approved', decided_by = ?, decided_at = ?
        WHERE id = ? AND status = 'pending' AND EXISTS (SELECT 1 FROM layouts WHERE id = ? AND deleted = 0)`)
            .bind(l.actor, at, l.submissionId, l.layoutId),
          db.prepare("UPDATE layouts SET link = ? WHERE id = ? AND deleted = 0 AND changes() = 1").bind(l.link, l.layoutId),
          eventInsert("changes() = 1"),
          db.prepare(`UPDATE link_submissions SET status = 'superseded', decided_by = ?, decided_at = ?
        WHERE layout_id = ? AND status = 'pending' AND id != ? AND changes() = 1`)
            .bind(l.actor, at, l.layoutId, l.submissionId),
        ];
        eventStmtIdx = 2;
        claimStmtIdx = 0;
      } else {
        stmts = [
          db.prepare("UPDATE layouts SET link = ? WHERE id = ?").bind(l.link, l.layoutId),
          eventInsert(),
          db.prepare("UPDATE link_submissions SET status = 'superseded', decided_by = ?, decided_at = ? WHERE layout_id = ? AND status = 'pending' AND changes() = 1")
            .bind(l.actor, at, l.layoutId),
        ];
        eventStmtIdx = 1;
      }

      let budgetStmtIdx: number | undefined;
      if (l.destructiveBudget !== undefined) {
        budgetStmtIdx = stmts.length;
        stmts.push(destructiveBudgetStatement(db, now, l.destructiveBudget.clientId));
      }

      const results = await db.batch(stmts);
      if (claimStmtIdx !== undefined && (results[claimStmtIdx]?.meta.changes ?? 0) !== 1) {
        throw notFound(`link submission '${l.submissionId}' is not pending`, l.submissionId!);
      }
      const seq = results[eventStmtIdx]?.meta.last_row_id;
      if (seq === undefined) throw new Error("appendLinkChange: events insert returned no last_row_id");

      let budgetProbe: { clientId: string; countInWindow: number; liveLayouts: number } | undefined;
      if (l.destructiveBudget !== undefined && budgetStmtIdx !== undefined) {
        const row = readDestructiveBudgetRow(results[budgetStmtIdx]);
        if (row !== null) budgetProbe = { clientId: l.destructiveBudget.clientId, countInWindow: row.n, liveLayouts: row.live_layouts };
      }

      return { seq, link: l.link, budgetProbe };
    },

    async appendLike(now, l) {
      const current = l.current ?? (await readLayoutById(db, l.layoutId));
      if (current === null) throw new Error(`appendLike: layoutId '${l.layoutId}' does not exist`);

      const wantsLike = l.kind === "liked";
      const at = now();

      // Coordinator review (HIGH): two concurrent unlikes from the same user
      // could both DELETE (the loser's own DELETE just removes 0 rows, no
      // error) and both append an `unliked` event. Fixed by making the EVENT
      // insert itself conditional on the row it's about to react to STILL being
      // true AT BATCH-COMMIT TIME (D1 batches serialize like any other writer
      // transaction) -- 0 rows inserted means this call's own premise no longer
      // holds. The same EXISTS also folds in the fix for a like racing a delete:
      // a layout that's gone `deleted` by batch-commit time inserts nothing
      // either, so a post-batch fresh read tells the two cases apart.
      const eventInsertSql = `INSERT INTO events (at, kind, layout_id, name, owner, format, rev, actor, via, admin, detail_json, before_json, after_json, source_client, source_version)
    SELECT ?, ?, ?, ?, ?, NULL, NULL, ?, ?, 0, ?, NULL, NULL, ?, ?
    WHERE EXISTS (SELECT 1 FROM layouts WHERE id = ? AND deleted = 0)
      AND ${wantsLike ? "NOT EXISTS" : "EXISTS"} (SELECT 1 FROM likes WHERE layout_id = ? AND user_id = ?)`;

      let results;
      try {
        results = await db.batch([
          db
            .prepare(eventInsertSql)
            .bind(
              at,
              l.kind,
              l.layoutId,
              current.name,
              current.owner,
              l.userId,
              l.via,
              l.detail === undefined ? null : canonical(l.detail),
              l.source.client,
              l.source.version,
              l.layoutId,
              l.layoutId,
              l.userId,
            ),
          // Gated on the SAME live condition as the event insert, re-evaluated
          // at batch-commit time -- the whole batch is one transaction, so every
          // statement in it sees the same answer.
          wantsLike
            ? db
                // LDB-B1: `via` records where THIS like came from -- the same
                // vocabulary every other write already uses.
                .prepare("INSERT INTO likes (layout_id, user_id, at, via) SELECT ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM layouts WHERE id = ? AND deleted = 0)")
                .bind(l.layoutId, l.userId, at, l.via, l.layoutId)
            : db
                .prepare("DELETE FROM likes WHERE layout_id = ? AND user_id = ? AND EXISTS (SELECT 1 FROM layouts WHERE id = ? AND deleted = 0)")
                .bind(l.layoutId, l.userId, l.layoutId),
          // H24 (2026-09-13): `like_count` is exactly `COUNT(*) FROM likes` --
          // no adjustment, no admin override.
          db
            .prepare("UPDATE layouts SET like_count = (SELECT COUNT(*) FROM likes WHERE layout_id = ?) WHERE id = ?")
            .bind(l.layoutId, l.layoutId),
          db.prepare("SELECT like_count FROM layouts WHERE id = ?").bind(l.layoutId),
        ]);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        // L1: of two concurrent likes from the SAME user, exactly one succeeds
        // -- the `likes` table's own (layout_id, user_id) PK is what makes that
        // atomic; the loser gets the same `already_liked` a sequential repeat would.
        if (/UNIQUE constraint failed: likes\./.test(msg)) throw alreadyLikedError();
        throw e;
      }

      if (results[0]?.meta.changes === 0) {
        // The event insert's own WHERE clause didn't hold at batch-commit
        // time -- find out which of its two conditions failed (a fresh read
        // costs nothing extra on this rare, race-only path).
        const fresh = await readLayoutById(db, l.layoutId);
        if (fresh === null || fresh.deleted) throw notFound(`no layout '${current.name}'`, current.name);
        throw wantsLike ? alreadyLikedError() : notLikedError();
      }

      const seq = results[0]?.meta.last_row_id;
      if (seq === undefined) throw new Error("appendLike: events insert returned no last_row_id");
      const counted = (results[3]?.results?.[0] as { like_count: number } | undefined)?.like_count;
      return { seq, like_count: counted ?? current.like_count };
    },

    async appendInheritedLikes(now, a) {
      const at = now();
      const detailJson = canonical(a.detail);

      // One `liked` event per former liker -- same shape `appendLike`'s own
      // event insert would have written, same live-layout guard, and ALSO
      // guarded against a real, direct like from this exact user landing in the
      // tiny window between the create's own commit and this batch.
      const eventStmts = a.userIds.map((userId) =>
        db
          .prepare(
            `INSERT INTO events (at, kind, layout_id, name, owner, format, rev, actor, via, admin, detail_json, before_json, after_json, source_client, source_version)
         SELECT ?, 'liked', ?, ?, ?, NULL, NULL, ?, ?, 0, ?, NULL, NULL, ?, ?
         WHERE EXISTS (SELECT 1 FROM layouts WHERE id = ? AND deleted = 0)
           AND NOT EXISTS (SELECT 1 FROM likes WHERE layout_id = ? AND user_id = ?)`,
          )
          .bind(at, a.layoutId, a.name, a.owner, userId, a.via, detailJson, a.source.client, a.source.version, a.layoutId, a.layoutId, userId),
      );

      // The `likes` rows themselves, copied one INSERT per liker (same guard)
      // -- kept per-user so a like that lands mid-batch-window for ONE
      // specific user is skipped for that user alone.
      const likeStmts = a.userIds.map((userId) =>
        db
          .prepare(
            `INSERT INTO likes (layout_id, user_id, at, via)
         SELECT ?, ?, ?, ?
         WHERE EXISTS (SELECT 1 FROM layouts WHERE id = ? AND deleted = 0)
           AND NOT EXISTS (SELECT 1 FROM likes WHERE layout_id = ? AND user_id = ?)`,
          )
          .bind(a.layoutId, userId, at, a.via, a.layoutId, a.layoutId, userId),
      );

      const results = await db.batch([
        ...eventStmts,
        ...likeStmts,
        db.prepare("UPDATE layouts SET like_count = (SELECT COUNT(*) FROM likes WHERE layout_id = ?) WHERE id = ?").bind(a.layoutId, a.layoutId),
        db.prepare("SELECT like_count FROM layouts WHERE id = ?").bind(a.layoutId),
      ]);

      const last = results[results.length - 1];
      const counted = (last?.results?.[0] as { like_count: number } | undefined)?.like_count;
      return { like_count: counted ?? 0 };
    },

    async feed(since, limit, kinds, filter) {
      const cappedLimit = Math.min(limit, 1000);
      const params: unknown[] = [since];
      let sql = "SELECT * FROM events WHERE seq > ?";
      if (kinds !== undefined && kinds.length > 0) {
        sql += ` AND kind IN (${kinds.map(() => "?").join(",")})`;
        params.push(...kinds);
      }
      if (filter?.layoutId !== undefined) {
        sql += " AND layout_id = ?";
        params.push(filter.layoutId);
      }
      if (filter?.actor !== undefined) {
        sql += " AND actor = ?";
        params.push(filter.actor);
      }
      if (filter?.format !== undefined) {
        sql += " AND format = ?";
        params.push(filter.format);
      }
      sql += " ORDER BY seq ASC LIMIT ?";
      params.push(cappedLimit);

      const { results } = await db.prepare(sql).bind(...params).all<EventDbRow>();
      const items = results.map(rowToEvent).map((e) => ({ ...e, detail: publicDetail(e.kind, e.detail) }));
      const next = items.length > 0 ? items[items.length - 1]!.seq : since;
      return { next, items };
    },

    async revertCandidates(sourceClient, sinceAt, beforeSeq, limit) {
      const { results } = await db
        .prepare(
          `SELECT seq, at, kind, layout_id, format, rev, before_json, after_json FROM events
       WHERE source_client = ? AND at >= ? AND seq < ?
         AND ((rev IS NOT NULL AND (
                (format IS NULL AND kind IN ('deleted','renamed','transferred'))
             OR (format IS NOT NULL AND kind IN ('updated','fingermap'))
           )) OR kind = 'link_cleared')
       ORDER BY seq DESC
       LIMIT ?`,
        )
        .bind(sourceClient, sinceAt, beforeSeq, limit)
        .all<{ seq: number; at: string; kind: string; layout_id: string; format: string | null; rev: number | null; before_json: string | null; after_json: string | null }>();
      return results;
    },

    async latestLinkEvent(layoutId, beforeSeq) {
      const stmt =
        beforeSeq !== undefined
          ? db
              .prepare("SELECT seq, after_json, source_client FROM events WHERE layout_id = ? AND kind IN ('link_approved','link_cleared') AND seq < ? ORDER BY seq DESC LIMIT 1")
              .bind(layoutId, beforeSeq)
          : db
              .prepare("SELECT seq, after_json, source_client FROM events WHERE layout_id = ? AND kind IN ('link_approved','link_cleared') ORDER BY seq DESC LIMIT 1")
              .bind(layoutId);
      const { results } = await stmt.all<{ seq: number; after_json: string | null; source_client: string | null }>();
      return results[0] ?? null;
    },
  };
}
