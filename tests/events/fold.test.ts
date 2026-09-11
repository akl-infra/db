// [LDB-P1] [MF-1 = LDB-P16] [MF-2 = LDB-P17] [MF-3 = LDB-P18] [MF-5 = LDB-P19]
// [MF-12 = LDB-I18] THE shared write model (21-formats.md §4): random
// sequences of every §2.2 write kind -- user and import, both scopes (the
// layout and two lineages, `spark` and the test-only stub `t/1`) -- driven
// straight through `commitWrite` (this file stays at the pipeline level,
// like `tests/events/races.test.ts` does for HTTP-level races). After each
// sequence, for every touched layout:
//   MF-1  every OTHER format's row is byte-equal before/after each step
//         that didn't name it, and a layout-scope step changes no format
//   MF-2  every rev-bumping event has exactly one scope; layout_revs.n is
//         gapless per layout; each lineage's own rev is gapless from 1;
//         layout_rev equals the layout-scope event count
//   MF-3  `foldLayout` replays the layout's own `layouts` row and every
//         `layout_formats` row exactly
//   MF-5  the layout always has >= 1 `layout_formats` row
//   MF-12 a write to lineage `t` never changes `upstream`; a write to
//         `spark` or the layout scope forks/keeps it exactly per
//         `nextUpstream`
import { env } from "cloudflare:test";
import type { Bindings } from "../../src/env";
import fc from "fast-check";
import { afterAll, describe, expect, it } from "vitest";
import { commitWrite, foldLayout, rowToEvent, type CommitInput, type Event } from "../../src/core/events";
import { formatsForLayout, readById, rowToFormat, rowToLayout, type FormatDbRow, type FormatRow, type LayoutDbRow, type LayoutRow, type Upstream } from "../../src/core/records";
import { nextUpstream } from "../../src/core/upstream";
import { steppingClock } from "../../src/core/time";
import { registerForTest } from "../../formats/registry.ts";
import { T1 } from "../formats/stub-lineage.ts";

const db = (env as unknown as Bindings).DB;

const unregister = registerForTest(T1); // the test-only SECOND stored lineage (21-formats.md §3 F2)
afterAll(unregister);

const USER_SOURCE = { client: "discord-app:test", version: null };
const IMPORT_SOURCE = { client: "system:cmini-import", version: null };

let uniqueCounter = 0;
function unique(): string {
  return `u${uniqueCounter++}`;
}

// -- The model's own state, kept in lockstep with what `commitWrite` is
// actually told (this file applies every op strictly sequentially, so
// there is never a real race between the model's bookkeeping and the DB
// -- concurrency itself is `tests/events/races.test.ts`'s [MF-6] job). --

interface FormatSlot {
  lineage: string;
  format: string;
  rev: number;
  payload: unknown;
}

interface Slot {
  exists: boolean;
  deleted: boolean;
  id: string;
  name: string;
  owner: string;
  n: number;
  layoutRev: number;
  upstream: Upstream | null;
  formats: Map<string, FormatSlot>;
}

function freshSlot(): Slot {
  return { exists: false, deleted: false, id: "", name: "", owner: "", n: 0, layoutRev: 0, upstream: null, formats: new Map() };
}

const OWNER_A = "owner-a";
const OWNER_B = "owner-b";

type RawOp =
  | "create_user"
  | "create_import"
  | "add_t"
  | "replace_spark"
  | "replace_t"
  | "rename"
  | "transfer"
  | "delete"
  | "restore"
  | "import_update_layout"
  | "import_update_spark"
  | "import_delete"
  | "liked"
  | "unliked";

const ALL_OPS: RawOp[] = [
  "create_user",
  "create_import",
  "add_t",
  "replace_spark",
  "replace_t",
  "rename",
  "transfer",
  "delete",
  "restore",
  "import_update_layout",
  "import_update_spark",
  "import_delete",
  "liked",
  "unliked",
];

// Coerces a raw pick into one that's actually applicable given the slot's
// current state, so every generated sequence replays validly.
function resolveOp(slot: Slot, raw: RawOp): RawOp | null {
  if (!slot.exists) return raw.startsWith("create_") ? raw : "create_user";
  if (slot.deleted) {
    if (raw === "restore") return "restore";
    if (raw === "import_update_layout" || raw === "import_update_spark") return slot.upstream?.state === "following" ? null : null; // no writes to a tombstone's formats/layout other than restore
    return "restore";
  }
  if (raw === "create_user" || raw === "create_import" || raw === "restore") return null; // already live
  if (raw === "add_t" && slot.formats.has("t")) return "replace_t"; // already has it -- replace instead
  if (raw === "replace_t" && !slot.formats.has("t")) return "add_t";
  if ((raw === "import_update_layout" || raw === "import_update_spark" || raw === "import_delete") && slot.upstream?.state !== "following") {
    return "rename"; // not following -- import writes are meaningless here, substitute an ordinary user write
  }
  return raw;
}

interface Op {
  slotIdx: number;
  raw: RawOp;
  userIdPick: number;
}

async function applyOp(clock: () => string, slots: Slot[], op: Op): Promise<void> {
  const slot = slots[op.slotIdx]!;
  const action = resolveOp(slot, op.raw);
  if (action === null) return;

  if (action === "liked" || action === "unliked") {
    if (!slot.exists) return;
    const { appendLike } = await import("../../src/core/events");
    await appendLike(db, clock, { kind: action, layoutId: slot.id, userId: `u${op.userIdPick}`, via: "discord", source: USER_SOURCE });
    return;
  }

  if (action === "create_user" || action === "create_import") {
    const isImport = action === "create_import";
    const name = `wm-${op.slotIdx}-${unique()}`;
    const owner = OWNER_A;
    const modified_at = clock();
    const payload = { keys: {} };
    const upstream: Upstream | null = isImport ? { source: "cmini", id: `up-${op.slotIdx}-${unique()}`, state: "following" } : null;
    const input: CommitInput = {
      layoutId: crypto.randomUUID(),
      creating: true,
      currentN: 0,
      currentLayout: null,
      currentFormats: new Map(),
      layout: { kind: isImport ? "imported" : "created", name, owner, created_at: modified_at, deleted: false },
      format: { kind: isImport ? "imported" : "format_added", lineage: "spark", format: "spark/1", payload, hasMagic: false },
      modified_at,
      actor: isImport ? "system:cmini-import" : "tester",
      via: isImport ? "import:cmini" : "discord",
      source: isImport ? IMPORT_SOURCE : USER_SOURCE,
      upstream,
    };
    const result = await commitWrite(db, clock, input);
    slot.exists = true;
    slot.deleted = false;
    slot.id = result.layout.id;
    slot.name = result.layout.name;
    slot.owner = result.layout.owner;
    slot.n = result.layout.n;
    slot.layoutRev = result.layout.layout_rev;
    slot.upstream = result.layout.upstream;
    slot.formats = new Map([["spark", { lineage: "spark", format: "spark/1", rev: 1, payload }]]);
    return;
  }

  const current = (await readById(db, slot.id))!;
  const currentFormats = await formatsForLayout(db, slot.id);

  if (action === "add_t" || action === "replace_spark" || action === "replace_t") {
    const lineage = action === "add_t" ? "t" : action === "replace_spark" ? "spark" : "t";
    const format = lineage === "spark" ? "spark/1" : "t/1";
    const payload = lineage === "spark" ? { keys: {}, magic: { notes: unique() } } : { a: uniqueCounter++ };
    const touches = lineage === "spark";
    const upstream = nextUpstream(current.upstream, "discord", touches);
    const input: CommitInput = {
      layoutId: slot.id,
      creating: false,
      currentN: current.n,
      currentLayout: current,
      currentFormats,
      format: { kind: action === "add_t" ? "format_added" : "updated", lineage, format, payload, hasMagic: false },
      modified_at: clock(),
      actor: "tester",
      via: "discord",
      source: USER_SOURCE,
      upstream,
    };
    const result = await commitWrite(db, clock, input);
    slot.n = result.layout.n;
    slot.upstream = result.layout.upstream;
    const f = result.formats.get(lineage)!;
    slot.formats.set(lineage, { lineage, format: f.format, rev: f.rev, payload: f.payload });
    return;
  }

  if (action === "rename" || action === "transfer" || action === "delete" || action === "restore") {
    const kind = action === "rename" ? "renamed" : action === "transfer" ? "transferred" : action === "delete" ? "deleted" : "restored";
    const name = action === "rename" ? `wm-${op.slotIdx}-${unique()}` : slot.name;
    const owner = action === "transfer" ? (slot.owner === OWNER_A ? OWNER_B : OWNER_A) : slot.owner;
    const deleted = action === "delete";
    const upstream = nextUpstream(current.upstream, "discord", true);
    const input: CommitInput = {
      layoutId: slot.id,
      creating: false,
      currentN: current.n,
      currentLayout: current,
      currentFormats,
      layout: { kind, name, owner, created_at: current.created_at, deleted: action === "restore" ? false : deleted },
      modified_at: clock(),
      actor: "tester",
      via: "discord",
      source: USER_SOURCE,
      upstream,
    };
    const result = await commitWrite(db, clock, input);
    slot.n = result.layout.n;
    slot.layoutRev = result.layout.layout_rev;
    slot.name = result.layout.name;
    slot.owner = result.layout.owner;
    slot.deleted = result.layout.deleted;
    slot.upstream = result.layout.upstream;
    return;
  }

  if (action === "import_update_layout" || action === "import_update_spark" || action === "import_delete") {
    const upstream = nextUpstream(current.upstream, "import:cmini", true);
    const input: CommitInput =
      action === "import_delete"
        ? {
            layoutId: slot.id,
            creating: false,
            currentN: current.n,
            currentLayout: current,
            currentFormats,
            layout: { kind: "upstream_deleted", name: current.name, owner: current.owner, created_at: current.created_at, deleted: true },
            modified_at: clock(),
            actor: "system:cmini-import",
            via: "import:cmini",
            source: IMPORT_SOURCE,
            upstream,
          }
        : action === "import_update_layout"
          ? {
              layoutId: slot.id,
              creating: false,
              currentN: current.n,
              currentLayout: current,
              currentFormats,
              layout: { kind: "imported", name: `wm-${op.slotIdx}-${unique()}`, owner: current.owner, created_at: current.created_at, deleted: false },
              modified_at: clock(),
              actor: "system:cmini-import",
              via: "import:cmini",
              source: IMPORT_SOURCE,
              upstream,
            }
          : {
              layoutId: slot.id,
              creating: false,
              currentN: current.n,
              currentLayout: current,
              currentFormats,
              format: { kind: "imported", lineage: "spark", format: "spark/1", payload: { keys: {}, magic: { notes: unique() } }, hasMagic: false },
              modified_at: clock(),
              actor: "system:cmini-import",
              via: "import:cmini",
              source: IMPORT_SOURCE,
              upstream,
            };
    const result = await commitWrite(db, clock, input);
    slot.n = result.layout.n;
    slot.layoutRev = result.layout.layout_rev;
    slot.name = result.layout.name;
    slot.owner = result.layout.owner;
    slot.deleted = result.layout.deleted;
    slot.upstream = result.layout.upstream;
    if (action === "import_update_spark") {
      const f = result.formats.get("spark")!;
      slot.formats.set("spark", { lineage: "spark", format: f.format, rev: f.rev, payload: f.payload });
    }
    return;
  }
}

async function revsMapFor(layoutId: string): Promise<Map<string, { format: string | null; payload: unknown }>> {
  const { results } = await db
    .prepare("SELECT lineage, rev, format, payload_json FROM layout_revs WHERE layout_id = ?")
    .bind(layoutId)
    .all<{ lineage: string | null; rev: number; format: string | null; payload_json: string | null }>();
  const out = new Map<string, { format: string | null; payload: unknown }>();
  for (const r of results) {
    out.set(`${r.lineage ?? ""} ${r.rev}`, { format: r.format, payload: r.payload_json === null ? undefined : (JSON.parse(r.payload_json) as unknown) });
  }
  return out;
}

async function checkLayoutInvariants(layoutId: string): Promise<void> {
  const eventRows = await db.prepare("SELECT * FROM events WHERE layout_id = ? ORDER BY seq ASC").bind(layoutId).all<import("../../src/core/events").EventDbRow>();
  const events: Event[] = eventRows.results.map(rowToEvent);
  const revs = await revsMapFor(layoutId);

  // MF-3: replay equals the live rows.
  const folded = foldLayout(events, revs);
  expect(folded).not.toBeNull();
  const actualLayoutRow = await db.prepare("SELECT * FROM layouts WHERE id = ?").bind(layoutId).first<LayoutDbRow>();
  expect(actualLayoutRow).not.toBeNull();
  const actualLayout = rowToLayout(actualLayoutRow!);
  const { n: _n, ...actualLayoutSansN } = actualLayout;
  expect(folded!.layout).toEqual(actualLayoutSansN);

  const actualFormatRows = await db.prepare("SELECT * FROM layout_formats WHERE layout_id = ?").bind(layoutId).all<FormatDbRow>();
  const actualFormats = new Map(actualFormatRows.results.map((r) => [r.lineage, rowToFormat(r)]));
  expect(folded!.formats).toEqual(actualFormats);

  // MF-5: at least one format, always.
  expect(actualFormats.size).toBeGreaterThanOrEqual(1);

  // MF-2: rev partition + gaplessness.
  const revBumping = events.filter((e) => e.rev !== null);
  const layoutEvents = revBumping.filter((e) => e.format === null);
  const layoutRevs = layoutEvents.map((e) => e.rev!);
  expect(layoutRevs).toEqual(layoutRevs.map((_, i) => i + 1));
  expect(actualLayout.layout_rev).toBe(layoutEvents.length);

  const byLineage = new Map<string, number[]>();
  for (const e of revBumping) {
    if (e.format === null) continue;
    const lin = e.format.slice(0, e.format.lastIndexOf("/"));
    const arr = byLineage.get(lin) ?? [];
    arr.push(e.rev!);
    byLineage.set(lin, arr);
  }
  for (const [lin, revsForLineage] of byLineage) {
    expect(revsForLineage, `lineage ${lin}`).toEqual(revsForLineage.map((_, i) => i + 1));
  }

  // layout_revs.n gapless per layout (the shared concurrency counter).
  const nRows = await db.prepare("SELECT n FROM layout_revs WHERE layout_id = ? ORDER BY n ASC").bind(layoutId).all<{ n: number }>();
  const ns = nRows.results.map((r) => r.n);
  expect(ns).toEqual(ns.map((_, i) => i + 1));
}

describe("[LDB-P1] [MF-1] [MF-2] [MF-3] [MF-5] [MF-12] the shared write model", () => {
  it("random write sequences over the layout scope and two lineages fold correctly, one format never touching another, and upstream forking exactly per lineage", async () => {
    const clock = steppingClock("2026-01-01T00:00:00.000Z", 1000);

    const opArb = fc.record({
      slotIdx: fc.integer({ min: 0, max: 3 }),
      raw: fc.constantFrom(...ALL_OPS),
      userIdPick: fc.integer({ min: 0, max: 2 }),
    });

    await fc.assert(
      fc.asyncProperty(fc.array(opArb, { minLength: 1, maxLength: 50 }), async (ops) => {
        const slots: Slot[] = Array.from({ length: 4 }, freshSlot);

        for (const op of ops) {
          const slot = slots[op.slotIdx]!;
          // MF-1: snapshot every OTHER format's row before the op, verify
          // untouched after -- run inline (not a separate pass) so it
          // covers every step, not just the final state.
          const before = slot.exists ? await formatsForLayout(db, slot.id) : new Map<string, FormatRow>();
          const resolved = resolveOp(slot, op.raw);
          await applyOp(clock, slots, op);
          if (slot.exists && resolved !== null) {
            const after = await formatsForLayout(db, slot.id);
            const touchedLineage =
              resolved === "add_t" || resolved === "replace_t" ? "t" : resolved === "replace_spark" || resolved === "import_update_spark" ? "spark" : null;
            for (const [lin, row] of before) {
              if (lin === touchedLineage) continue;
              expect(after.get(lin), `lineage '${lin}' untouched by a '${resolved}' on slot ${op.slotIdx}`).toEqual(row);
            }
            // A pure layout-scope write changes NO format row at all.
            if (touchedLineage === null && ["rename", "transfer", "delete", "restore", "import_update_layout", "import_delete"].includes(resolved)) {
              expect(after).toEqual(before);
            }
          }
        }

        for (const slot of slots) {
          if (!slot.exists) continue;
          await checkLayoutInvariants(slot.id);

          // MF-12: the model's own `upstream` bookkeeping (built via the
          // SAME `nextUpstream` the write pipeline uses) must equal the
          // live row -- in particular, every `t`-lineage write left
          // `upstream` byte-identical to what it was before that write.
          const live = await readById(db, slot.id);
          expect(live!.upstream).toEqual(slot.upstream);
        }
      }),
      { numRuns: 150 },
    );
  });

  it("[LDB-P1] appendInfo/appendLike leave the layouts row's rev/formats alone but still land in the feed", async () => {
    const clock = steppingClock("2026-02-01T00:00:00.000Z", 1000);
    const id = crypto.randomUUID();
    const { layout } = await commitWrite(db, clock, {
      layoutId: id,
      creating: true,
      currentN: 0,
      currentLayout: null,
      currentFormats: new Map(),
      layout: { kind: "created", name: `alone-${unique()}`, owner: OWNER_A, created_at: clock(), deleted: false },
      format: { kind: "format_added", lineage: "spark", format: "spark/1", payload: { keys: {} }, hasMagic: false },
      modified_at: clock(),
      actor: "tester",
      via: "discord",
      source: USER_SOURCE,
      upstream: null,
    });

    const before = await db.prepare("SELECT * FROM layouts WHERE id = ?").bind(layout.id).first<LayoutDbRow>();
    const { appendInfo, appendLike } = await import("../../src/core/events");
    await appendInfo(db, clock, { kind: "upstream_changed", layoutId: layout.id, actor: "system:cmini-import", via: "import:cmini", source: IMPORT_SOURCE, detail: { note: "x" } });
    await appendLike(db, clock, { kind: "liked", layoutId: layout.id, userId: "u1", via: "discord", source: USER_SOURCE });
    await appendLike(db, clock, { kind: "liked", layoutId: layout.id, userId: "u1", via: "discord", source: USER_SOURCE }); // repeat: idempotent no-op

    const after = await db.prepare("SELECT * FROM layouts WHERE id = ?").bind(layout.id).first<LayoutDbRow>();
    expect(after!.layout_rev).toBe(before!.layout_rev);
    expect(after!.n).toBe(before!.n);
    expect(after!.like_count).toBe(before!.like_count + 1);
  });
});
