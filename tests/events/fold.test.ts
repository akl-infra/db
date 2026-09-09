// [LDB-P1] Property: for random sequences of appendWrite/appendInfo/
// appendLike over up to 5 records (mixing every write kind, informational
// events and likes/unlikes incl. repeats), foldRecord(events for id, revs)
// deep-equals the actual `layouts` row; every write event's rev is
// previous+1; info/like events have rev NULL; `layout_revs` has exactly
// one row per write event; `seq` is gapless from 1.
import { env } from "cloudflare:test";
import type { Bindings } from "../../src/env";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { appendAdmin, appendInfo, appendLike, appendWrite, foldRecord, rowToEvent } from "../../src/core/events";
import type { EventDbRow, Write } from "../../src/core/events";
import { rowToRecord } from "../../src/core/records";
import type { LayoutDbRow } from "../../src/core/records";
import { steppingClock } from "../../src/core/time";

const db = (env as unknown as Bindings).DB;

// created/imported (both create-kind), the LIVE_ONLY kinds, the
// DELETED_ONLY kinds and the like kinds. Every raw pick below is coerced to
// whichever bucket is actually applicable given the slot's current state,
// so the sequence always replays validly regardless of what fast-check
// generates.
const RAW_KINDS = [
  "created",
  "updated",
  "renamed",
  "fingermap",
  "transferred",
  "deleted",
  "restored",
  "imported",
  "upstream_deleted",
  "liked",
  "unliked",
] as const;
type RawKind = (typeof RAW_KINDS)[number];

const CREATE_LIKE: RawKind[] = ["created", "imported"];
const LIVE_ONLY: RawKind[] = ["updated", "renamed", "fingermap", "transferred", "deleted", "upstream_deleted"];
const DELETED_ONLY: RawKind[] = ["restored", "imported", "upstream_deleted"];
const LIKE_KINDS: RawKind[] = ["liked", "unliked"];

interface SlotState {
  exists: boolean;
  deleted: boolean;
  id: string;
  name: string;
  owner: string;
  format: string;
}

function freshSlot(): SlotState {
  return { exists: false, deleted: false, id: "", name: "", owner: "", format: "" };
}

function resolveAction(slot: SlotState, raw: RawKind): RawKind {
  const idx = RAW_KINDS.indexOf(raw);
  if (!slot.exists) return CREATE_LIKE[idx % CREATE_LIKE.length]!;
  if (slot.deleted) return DELETED_ONLY[idx % DELETED_ONLY.length]!;
  const pool = [...LIVE_ONLY, ...LIKE_KINDS];
  return pool[idx % pool.length]!;
}

interface Op {
  slotIdx: number;
  rawKind: RawKind;
  userIdPick: number;
}

// Kept outside fc.assert's property function so every one of the 200 runs
// mints globally-unique names -- correctness never depends on this (each
// run's records are looked up by their own freshly-minted ids), but it
// keeps every run's `name_taken` collision-free without needing that path
// here (names.test.ts covers it).
let uniqueCounter = 0;
function unique(): string {
  return `u${uniqueCounter++}`;
}

async function applyOp(clock: () => string, slots: SlotState[], op: Op): Promise<void> {
  const slot = slots[op.slotIdx]!;
  const action = resolveAction(slot, op.rawKind);
  const owner = "owner-a";
  const otherOwner = "owner-b";

  switch (action) {
    case "created":
    case "imported": {
      if (!slot.exists) {
        const write: Write = {
          kind: action,
          name: `rec-${op.slotIdx}-${unique()}`,
          owner,
          modified_at: clock(),
          format: "cmini/1",
          payload: { v: unique() },
          actor: "tester",
          via: action === "imported" ? "import:cmini" : "discord",
          hasMagic: false,
        };
        const { record } = await appendWrite(db, clock, write);
        slot.exists = true;
        slot.deleted = false;
        slot.id = record.id;
        slot.name = record.name;
        slot.owner = record.owner;
        slot.format = record.format;
        return;
      }
      // slot exists and is deleted: "imported" revives it (07 §6 S5's
      // "a tombstoned record comes back").
      const write: Write = {
        kind: "imported",
        layoutId: slot.id,
        name: `rec-${op.slotIdx}-${unique()}`,
        owner: slot.owner,
        modified_at: clock(),
        format: slot.format,
        payload: { v: unique() },
        actor: "system:cmini-import",
        via: "import:cmini",
        deleted: false,
        hasMagic: false,
      };
      const { record } = await appendWrite(db, clock, write);
      slot.deleted = false;
      slot.name = record.name;
      return;
    }
    case "updated":
    case "fingermap": {
      const write: Write = {
        kind: action,
        layoutId: slot.id,
        name: slot.name,
        owner: slot.owner,
        modified_at: clock(),
        format: slot.format,
        payload: { v: unique() },
        actor: "tester",
        via: "discord",
      };
      await appendWrite(db, clock, write);
      return;
    }
    case "renamed": {
      const write: Write = {
        kind: "renamed",
        layoutId: slot.id,
        name: `rec-${op.slotIdx}-${unique()}`,
        owner: slot.owner,
        modified_at: clock(),
        format: slot.format,
        payload: { v: unique() },
        actor: "tester",
        via: "discord",
      };
      const { record } = await appendWrite(db, clock, write);
      slot.name = record.name;
      return;
    }
    case "transferred": {
      const newOwner = slot.owner === owner ? otherOwner : owner;
      const write: Write = {
        kind: "transferred",
        layoutId: slot.id,
        name: slot.name,
        owner: newOwner,
        modified_at: clock(),
        format: slot.format,
        payload: { v: unique() },
        actor: "tester",
        via: "discord",
      };
      const { record } = await appendWrite(db, clock, write);
      slot.owner = record.owner;
      return;
    }
    case "deleted":
    case "upstream_deleted": {
      const write: Write = {
        kind: action,
        layoutId: slot.id,
        name: slot.name,
        owner: slot.owner,
        modified_at: clock(),
        format: slot.format,
        payload: { v: unique() },
        actor: action === "upstream_deleted" ? "system:cmini-import" : "tester",
        via: action === "upstream_deleted" ? "import:cmini" : "discord",
        deleted: true,
      };
      const { record } = await appendWrite(db, clock, write);
      slot.deleted = true;
      slot.name = record.name; // tombstones keep their literal name (01 §1)
      return;
    }
    case "restored": {
      const write: Write = {
        kind: "restored",
        layoutId: slot.id,
        name: `rec-${op.slotIdx}-${unique()}`,
        owner: slot.owner,
        modified_at: clock(),
        format: slot.format,
        payload: { v: unique() },
        actor: "tester",
        via: "discord",
        deleted: false,
      };
      const { record } = await appendWrite(db, clock, write);
      slot.deleted = false;
      slot.name = record.name;
      return;
    }
    case "liked":
    case "unliked": {
      const userId = `u${op.userIdPick}`;
      await appendLike(db, clock, { kind: action, layoutId: slot.id, userId, via: "discord" });
      return;
    }
  }
}

describe("fold", () => {
  it("[LDB-P1] foldRecord replays every record's DB row from its own events", async () => {
    const clock = steppingClock("2026-01-01T00:00:00.000Z", 1000);

    const opArb = fc.record({
      slotIdx: fc.integer({ min: 0, max: 4 }),
      rawKind: fc.constantFrom(...RAW_KINDS),
      userIdPick: fc.integer({ min: 0, max: 2 }),
    });

    await fc.assert(
      fc.asyncProperty(fc.array(opArb, { minLength: 1, maxLength: 40 }), async (ops) => {
        const slots: SlotState[] = Array.from({ length: 5 }, freshSlot);
        for (const op of ops) {
          await applyOp(clock, slots, op);
        }

        for (const slot of slots) {
          if (!slot.exists) continue;
          const layoutId = slot.id;

          const eventRows = await db
            .prepare("SELECT * FROM events WHERE layout_id = ? ORDER BY seq ASC")
            .bind(layoutId)
            .all<EventDbRow>();
          const events = eventRows.results.map(rowToEvent);

          const revRows = await db
            .prepare("SELECT rev, format, payload_json FROM layout_revs WHERE layout_id = ?")
            .bind(layoutId)
            .all<{ rev: number; format: string; payload_json: string }>();
          const revs = new Map(
            revRows.results.map((r) => [r.rev, { format: r.format, payload: JSON.parse(r.payload_json) as unknown }]),
          );

          const folded = foldRecord(events, revs);

          const actualRow = await db.prepare("SELECT * FROM layouts WHERE id = ?").bind(layoutId).first<LayoutDbRow>();
          expect(actualRow).not.toBeNull();
          const actual = rowToRecord(actualRow!);

          expect(folded).toEqual(actual);

          const writeRevs = events.filter((e) => e.rev !== null).map((e) => e.rev);
          expect(writeRevs).toEqual(writeRevs.map((_, i) => i + 1));

          for (const e of events) {
            if (e.kind === "liked" || e.kind === "unliked" || e.kind === "upstream_changed" || e.kind === "import_conflict") {
              expect(e.rev).toBeNull();
            }
          }

          expect(revRows.results.length).toBe(writeRevs.length);
        }

        const seqRows = await db.prepare("SELECT seq FROM events ORDER BY seq ASC").all<{ seq: number }>();
        const seqs = seqRows.results.map((r) => r.seq);
        expect(seqs).toEqual(seqs.map((_, i) => i + 1));
      }),
      { numRuns: 200 },
    );
  });

  it("[LDB-P1] appendInfo/appendLike leave the layouts row alone but still land in the feed", async () => {
    const clock = steppingClock("2026-02-01T00:00:00.000Z", 1000);
    const { record } = await appendWrite(db, clock, {
      kind: "created",
      name: `alone-${unique()}`,
      owner: "owner-a",
      modified_at: clock(),
      format: "cmini/1",
      payload: { v: 1 },
      actor: "tester",
      via: "discord",
    });

    const before = await db.prepare("SELECT * FROM layouts WHERE id = ?").bind(record.id).first<LayoutDbRow>();
    await appendInfo(db, clock, {
      kind: "upstream_changed",
      layoutId: record.id,
      actor: "system:cmini-import",
      via: "import:cmini",
      detail: { note: "x" },
    });
    await appendLike(db, clock, { kind: "liked", layoutId: record.id, userId: "u1", via: "discord" });
    await appendLike(db, clock, { kind: "liked", layoutId: record.id, userId: "u1", via: "discord" }); // repeat: idempotent no-op

    const after = await db.prepare("SELECT * FROM layouts WHERE id = ?").bind(record.id).first<LayoutDbRow>();
    expect(after!.rev).toBe(before!.rev); // info + one real like + one no-op like: no rev bump
    expect(after!.like_count).toBe(before!.like_count + 1);
  });

  // [LDB-P1] (09 §3 T2, extended for phase 2): the same fold identity, but
  // now over a genuinely racing pair -- two `appendWrite`s on ONE slot fired
  // with `Promise.all` rather than awaited in sequence. Exactly one commits
  // (the `layout_revs` PK refuses the loser's whole batch, `core/write.ts`'s
  // `commitWrite` is what turns that into `409 stale` at the route layer --
  // this test stays at the pipeline level, like tests/events/races.test.ts),
  // and the fold still equals the row afterward.
  it("[LDB-P1] [LDB-P2] a racing Promise.all pair of writes on one slot still folds to the winner's row", async () => {
    const clock = steppingClock("2026-01-05T00:00:00.000Z", 1000);

    await fc.assert(
      fc.asyncProperty(fc.constant(null), async () => {
        const { record } = await appendWrite(db, clock, {
          kind: "created",
          name: `race-fold-${unique()}`,
          owner: "owner-a",
          modified_at: clock(),
          format: "cmini/1",
          payload: { v: unique() },
          actor: "tester",
          via: "discord",
        });

        const update = (v: string) =>
          appendWrite(db, clock, {
            kind: "updated",
            layoutId: record.id,
            name: record.name,
            owner: record.owner,
            modified_at: clock(),
            format: record.format,
            payload: { v },
            actor: "tester",
            via: "discord",
          });

        const outcomes = await Promise.allSettled([update("a"), update("b")]);
        expect(outcomes.filter((o) => o.status === "fulfilled")).toHaveLength(1);

        const eventRows = await db
          .prepare("SELECT * FROM events WHERE layout_id = ? ORDER BY seq ASC")
          .bind(record.id)
          .all<EventDbRow>();
        const events = eventRows.results.map(rowToEvent);
        const revRows = await db
          .prepare("SELECT rev, format, payload_json FROM layout_revs WHERE layout_id = ?")
          .bind(record.id)
          .all<{ rev: number; format: string; payload_json: string }>();
        const revs = new Map(
          revRows.results.map((r) => [r.rev, { format: r.format, payload: JSON.parse(r.payload_json) as unknown }]),
        );
        const folded = foldRecord(events, revs);

        const actualRow = await db.prepare("SELECT * FROM layouts WHERE id = ?").bind(record.id).first<LayoutDbRow>();
        expect(folded).toEqual(rowToRecord(actualRow!));
      }),
      { numRuns: 30 },
    );
  });

  // [LDB-P1] (09 §3 T3): `appendAdmin` events carry NULL `layout_id`, so
  // they never appear in any record's own `WHERE layout_id = ?` stream --
  // interleaving them among random record ops must leave every record's
  // fold exactly as it would be without them, and `seq` still gapless
  // across the whole table (admin rows included).
  it("[LDB-P1] appendAdmin events interleave with record ops without changing any record's fold", async () => {
    const clock = steppingClock("2026-01-10T00:00:00.000Z", 1000);
    const ADMIN_KINDS = ["admin.added", "admin.removed", "admin.import_paused", "admin.import_resumed"] as const;

    const opArb = fc.record({
      slotIdx: fc.integer({ min: 0, max: 2 }),
      rawKind: fc.constantFrom(...RAW_KINDS),
      userIdPick: fc.integer({ min: 0, max: 2 }),
    });
    const stepArb = fc.oneof(
      opArb.map((op) => ({ kind: "op" as const, op })),
      fc.constantFrom(...ADMIN_KINDS).map((adminKind) => ({ kind: "admin" as const, adminKind })),
    );

    await fc.assert(
      fc.asyncProperty(fc.array(stepArb, { minLength: 1, maxLength: 30 }), async (steps) => {
        const slots: SlotState[] = Array.from({ length: 3 }, freshSlot);
        for (const step of steps) {
          if (step.kind === "op") {
            await applyOp(clock, slots, step.op);
          } else {
            await appendAdmin(db, clock, { kind: step.adminKind, actor: "admin-tester" });
          }
        }

        for (const slot of slots) {
          if (!slot.exists) continue;

          const eventRows = await db
            .prepare("SELECT * FROM events WHERE layout_id = ? ORDER BY seq ASC")
            .bind(slot.id)
            .all<EventDbRow>();
          const events = eventRows.results.map(rowToEvent);
          expect(events.every((e) => !e.kind.startsWith("admin."))).toBe(true); // never leak into a record's own stream

          const revRows = await db
            .prepare("SELECT rev, format, payload_json FROM layout_revs WHERE layout_id = ?")
            .bind(slot.id)
            .all<{ rev: number; format: string; payload_json: string }>();
          const revs = new Map(
            revRows.results.map((r) => [r.rev, { format: r.format, payload: JSON.parse(r.payload_json) as unknown }]),
          );
          const folded = foldRecord(events, revs);

          const actualRow = await db.prepare("SELECT * FROM layouts WHERE id = ?").bind(slot.id).first<LayoutDbRow>();
          expect(folded).toEqual(rowToRecord(actualRow!));
        }

        const seqRows = await db.prepare("SELECT seq FROM events ORDER BY seq ASC").all<{ seq: number }>();
        const seqs = seqRows.results.map((r) => r.seq);
        expect(seqs).toEqual(seqs.map((_, i) => i + 1));
      }),
      { numRuns: 50 },
    );
  });
});
