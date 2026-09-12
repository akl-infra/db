// [LDB-P1] [MF-1 = LDB-P16] [MF-2 = LDB-P17] [MF-3 = LDB-P18] [MF-5 = LDB-P19]
// [MF-12 = LDB-I18] THE shared write model (21-formats.md §4): random
// sequences of every §2.2 write kind -- user and import, both scopes (the
// layout and two lineages, `spark` and the test-only stub `t/1`). Coordinator
// review (M3): every USER-lane op is driven through the REAL verb functions
// in `core/write.ts` (`createLayout`, `putFormat` -- both the replace AND
// the `If-None-Match: *` add path, `patchFormat` including a real
// `fingermap` edit, `renameLayout`, `transferLayout`, `deleteLayout`,
// `restoreLayout`), against a synthetic actor, `If-Match: *` throughout
// (concurrency/If-Match-matching itself is `tests/events/races.test.ts`'s
// [MF-6] and `tests/api/ifmatch.test.ts`'s [MF-11] job, not this file's) --
// this exercises the verbs' own validation/chaining/edits/upstream logic,
// not just `commitWrite`'s. Only the IMPORT-lane ops call `commitWrite`
// directly, matching `import/apply.ts`'s own real code path (a system
// writer, never routed through the HTTP verb functions). After each
// sequence, for every touched layout:
//   MF-1  every OTHER format's row is byte-equal before/after each step
//         that didn't name it, a layout-scope step changes no format row,
//         AND no step ever creates a stray row in a lineage it didn't name
//         (checked over the full row set, not just rows that pre-existed)
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
import type { Actor } from "../../src/auth/actor";
import type { IfMatch, IfNoneMatch } from "../../src/core/ifmatch";
import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { commitWrite, foldLayout, rowToEvent, type CommitInput, type Event } from "../../src/core/events";
import { formatsForLayout, readById, rowToFormat, rowToLayout, type FormatDbRow, type FormatRow, type LayoutDbRow, type LayoutRow, type Upstream } from "../../src/core/records";
import { createLayout, deleteLayout, patchFormat, putFormat, renameLayout, restoreLayout, transferLayout } from "../../src/core/write";
import { nextUpstream } from "../../src/core/upstream";
import { steppingClock } from "../../src/core/time";
import { registerForTest } from "../../formats/registry.ts";
import { T1 } from "../formats/stub-lineage.ts";
import { ulid } from "ulidx";

const db = (env as unknown as Bindings).DB;
const bindings = env as unknown as Bindings;

const unregister = registerForTest(T1); // the test-only SECOND stored lineage (21-formats.md §3 F2)
afterAll(unregister);

const USER_SOURCE = { client: "discord-app:test", version: null };
const IMPORT_SOURCE = { client: "system:cmini-import", version: null };

let uniqueCounter = 0;
function unique(): string {
  return `u${uniqueCounter++}`;
}

// -- The model's own state, kept in lockstep with what the real verbs are
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
  // D13 L1/L2: appendLike no longer silently no-ops a repeat like/
  // redundant unlike -- it throws -- so the model tracks who currently
  // likes this slot, per user, to know which transition is valid.
  likedBy: Set<string>;
}

function freshSlot(): Slot {
  return { exists: false, deleted: false, id: "", name: "", owner: "", n: 0, layoutRev: 0, upstream: null, formats: new Map(), likedBy: new Set() };
}

// Snowflake-SHAPED (transferLayout's own TRANSFER_USER_ID_RE, now
// actually exercised since this model drives the real verb).
const OWNER_A = "800000000000000101";
const OWNER_B = "800000000000000102";
const STAR: IfMatch = { kind: "any" };
const NO_IF_MATCH: IfMatch = { kind: "absent" };
const ADD: IfNoneMatch = { kind: "any" };
const NO_IF_NONE_MATCH: IfNoneMatch = { kind: "absent" };

function actorFor(userId: string): Actor {
  return { user_id: userId, name: `user-${userId}`, via: "discord", admin: false, source_client: "discord-app:test" };
}

// Coordinator review (M3): fingermap edits need an existing key to
// retarget, so every spark payload the model ever creates keeps this ONE
// key throughout -- unlike the old model's empty `{keys: {}}` seed, which
// could never exercise a real `patchFormat` fingermap edit at all.
const SPARK_SEED_PAYLOAD = { keys: { a: { row: 0, col: 0, finger: "LP" as const } } };

beforeAll(async () => {
  // transferLayout's own build() requires `to` to be a known author.
  const now = new Date().toISOString();
  await db.prepare("INSERT OR IGNORE INTO authors (user_id, name, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?)").bind(OWNER_A, "owner-a", now, now).run();
  await db.prepare("INSERT OR IGNORE INTO authors (user_id, name, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?)").bind(OWNER_B, "owner-b", now, now).run();
});

type RawOp =
  | "create_user"
  | "create_import"
  | "add_t"
  | "replace_spark"
  | "replace_t"
  | "patch_fingermap_spark"
  | "rename"
  | "transfer"
  | "delete"
  | "restore"
  | "import_update_layout"
  | "import_update_spark"
  | "import_update_both"
  | "import_delete"
  | "liked"
  | "unliked"
  | "concurrent_pair";

const ALL_OPS: RawOp[] = [
  "create_user",
  "create_import",
  "add_t",
  "replace_spark",
  "replace_t",
  "patch_fingermap_spark",
  "rename",
  "transfer",
  "delete",
  "restore",
  "import_update_layout",
  "import_update_spark",
  "import_update_both",
  "import_delete",
  "liked",
  "unliked",
  "concurrent_pair",
];

// Coerces a raw pick into one that's actually applicable given the slot's
// current state, so every generated sequence replays validly.
function resolveOp(slot: Slot, raw: RawOp): RawOp | null {
  if (!slot.exists) return raw.startsWith("create_") ? raw : "create_user";
  if (slot.deleted) {
    if (raw === "restore") return "restore";
    return "restore"; // no writes to a tombstone's formats/layout other than restore
  }
  if (raw === "create_user" || raw === "create_import" || raw === "restore") return null; // already live
  if (raw === "add_t" && slot.formats.has("t")) return "replace_t"; // already has it -- replace instead
  if (raw === "replace_t" && !slot.formats.has("t")) return "add_t";
  if (raw === "patch_fingermap_spark" && !slot.formats.has("spark")) return "replace_spark"; // unreachable in practice (every slot gets spark at create) but keep resolveOp total
  if (
    (raw === "import_update_layout" || raw === "import_update_spark" || raw === "import_update_both" || raw === "import_delete") &&
    slot.upstream?.state !== "following"
  ) {
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
    const userId = `u${op.userIdPick}`;
    // D13 L1/L2: a repeat like or a redundant unlike now throws instead
    // of silently no-opping, so -- same coercion resolveOp already does
    // for every other op -- always toggle to whichever transition is
    // actually valid for THIS user's current state, regardless of which
    // of "liked"/"unliked" the raw pick landed on.
    const alreadyLiked = slot.likedBy.has(userId);
    const kind = alreadyLiked ? "unliked" : "liked";
    const { appendLike } = await import("../../src/core/events");
    await appendLike(db, clock, { kind, layoutId: slot.id, userId, via: "discord", source: USER_SOURCE });
    if (kind === "liked") slot.likedBy.add(userId);
    else slot.likedBy.delete(userId);
    return;
  }

  if (action === "create_user") {
    const name = `wm-${op.slotIdx}-${unique()}`;
    const result = await createLayout(bindings, clock, actorFor(OWNER_A), { name, format: "spark/1", payload: SPARK_SEED_PAYLOAD }, null);
    slot.exists = true;
    slot.deleted = false;
    slot.id = result.layout.id;
    slot.name = result.layout.name;
    slot.owner = result.layout.owner;
    slot.n = result.layout.n;
    slot.layoutRev = result.layout.layout_rev;
    slot.upstream = result.layout.upstream;
    const f = result.formats.get("spark")!;
    slot.formats = new Map([["spark", { lineage: "spark", format: f.format, rev: f.rev, payload: f.payload }]]);
    return;
  }

  if (action === "create_import") {
    // The importer's own real code path never goes through the HTTP verb
    // functions (`import/apply.ts` calls `commitWrite` directly, built
    // from its own fresh read) -- matched here, not routed through
    // `createLayout`.
    const name = `wm-${op.slotIdx}-${unique()}`;
    const owner = OWNER_A;
    const modified_at = clock();
    const upstream: Upstream = { source: "cmini", id: `up-${op.slotIdx}-${unique()}`, state: "following" };
    const input: CommitInput = {
      layoutId: ulid(),
      creating: true,
      currentN: 0,
      currentLayout: null,
      currentFormats: new Map(),
      layout: { kind: "imported", name, owner, created_at: modified_at, deleted: false },
      format: { kind: "imported", lineage: "spark", format: "spark/1", payload: SPARK_SEED_PAYLOAD, hasMagic: false },
      modified_at,
      actor: "system:cmini-import",
      via: "import:cmini",
      source: IMPORT_SOURCE,
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
    const f = result.formats.get("spark")!;
    slot.formats = new Map([["spark", { lineage: "spark", format: f.format, rev: f.rev, payload: f.payload }]]);
    return;
  }

  // Coordinator review (mutation check, M3): MF-12 must be checked against
  // an INDEPENDENT oracle, not against whatever the verb itself returned
  // -- copying `result.layout.upstream` straight into the model would make
  // the later `live!.upstream === slot.upstream` check a tautology (it
  // would pass even if the real `touches` logic were broken, since both
  // sides trace back to the same call). `expectUpstream` computes the
  // SAME `nextUpstream` the pipeline calls, but from the model's own
  // independent `via`/`touches` determination, and asserts the verb's own
  // result matches it immediately (tight locality) as well as feeding
  // `slot.upstream` from now on. Confirmed sensitive by temporarily
  // hard-coding `touches = false` in both `putFormat` and `patchFormat`
  // (core/write.ts) and re-running this file: the mutation goes red here
  // (MF-12), reverted after -- see the F2 report for this session's note.
  function expectUpstream(via: string, touches: boolean, result: { layout: { upstream: Upstream | null } }): Upstream | null {
    const expected = nextUpstream(slot.upstream, via, touches);
    expect(result.layout.upstream, `MF-12: nextUpstream(prior, '${via}', ${touches})`).toEqual(expected);
    return expected;
  }

  if (action === "add_t") {
    const result = await putFormat(bindings, clock, actorFor(slot.owner), slot.id, { format: "t/1", payload: { a: uniqueCounter++ } }, NO_IF_MATCH, ADD, null);
    slot.n = result.layout.n;
    slot.upstream = expectUpstream("discord", false, result);
    const f = result.formats.get("t")!;
    slot.formats.set("t", { lineage: "t", format: f.format, rev: f.rev, payload: f.payload });
    return;
  }

  if (action === "replace_spark" || action === "replace_t") {
    const lineage = action === "replace_spark" ? "spark" : "t";
    const format = lineage === "spark" ? "spark/1" : "t/1";
    const payload = lineage === "spark" ? { ...SPARK_SEED_PAYLOAD, magic: { notes: unique() } } : { a: uniqueCounter++ };
    const result = await putFormat(bindings, clock, actorFor(slot.owner), slot.id, { format, payload }, STAR, NO_IF_NONE_MATCH, null);
    slot.n = result.layout.n;
    slot.upstream = expectUpstream("discord", lineage === "spark", result);
    const f = result.formats.get(lineage)!;
    slot.formats.set(lineage, { lineage, format: f.format, rev: f.rev, payload: f.payload });
    return;
  }

  if (action === "patch_fingermap_spark") {
    // Coordinator review (M3): a real `patchFormat` fingermap edit, not
    // just `putFormat`'s whole-payload replace -- exercises the edits
    // pipeline (`module.edits.setFingermap`) through the real verb.
    const finger = (["LP", "LR", "LM", "LI"] as const)[uniqueCounter++ % 4]!;
    const result = await patchFormat(bindings, clock, actorFor(slot.owner), slot.id, "spark/1", { fingermap: { a: finger } }, STAR, null);
    slot.n = result.layout.n;
    slot.upstream = expectUpstream("discord", true, result);
    const f = result.formats.get("spark")!;
    slot.formats.set("spark", { lineage: "spark", format: f.format, rev: f.rev, payload: f.payload });
    return;
  }

  if (action === "rename") {
    const name = `wm-${op.slotIdx}-${unique()}`;
    const result = await renameLayout(bindings, clock, actorFor(slot.owner), slot.id, name, STAR, null);
    slot.n = result.layout.n;
    slot.layoutRev = result.layout.layout_rev;
    slot.name = result.layout.name;
    slot.owner = result.layout.owner;
    slot.deleted = result.layout.deleted;
    slot.upstream = expectUpstream("discord", true, result);
    return;
  }

  // Coordinator review (M3, UN-HOLD): a real CONCURRENT pair on the SAME
  // slot, driven through `Promise.all` so both build()s race for real --
  // the same shape as [MF-6]'s own HTTP-level races
  // (tests/api/mf6-http-races.test.ts case (a)), but exercised here as
  // one step of the shared write model so per-step invariants (MF-1
  // through MF-5, MF-12, LDB-L4) are checked after a pair too, not just
  // after single ops. Picks a rename (layout scope) and a t-lineage
  // replace (format scope, never touching upstream): both use
  // If-Match:any, so the race is purely over the shared `layout_revs
  // (layout_id, n)` PK -- one of them collides and commitWithRetry's own
  // retry re-reads and re-lands it (real E3: "an edit based on its part's
  // current version succeeds ... even when another part of the same
  // layout is written in between"). Neither can fail on merits here (both
  // If-Match:any), so both MUST land 200 -- if either doesn't, that's a
  // real regression in the retry path, not a flaky test.
  if (action === "concurrent_pair") {
    const name = `wm-${op.slotIdx}-${unique()}`;
    const tPayload = { a: uniqueCounter++ };
    // `t` may or may not exist on this slot yet -- add (If-None-Match:*)
    // when it doesn't, replace (If-Match:any) when it does, same coercion
    // resolveOp already does for the sequential "add_t"/"replace_t" pair.
    const tHasFormat = slot.formats.has("t");
    const [renameResult, replaceResult] = await Promise.all([
      renameLayout(bindings, clock, actorFor(slot.owner), slot.id, name, STAR, null),
      putFormat(
        bindings,
        clock,
        actorFor(slot.owner),
        slot.id,
        { format: "t/1", payload: tPayload },
        tHasFormat ? STAR : NO_IF_MATCH,
        tHasFormat ? NO_IF_NONE_MATCH : ADD,
        null,
      ),
    ]);
    // The shared `n` counter advances once per write regardless of scope
    // -- whichever of the two committed SECOND (real order is
    // nondeterministic; If-Match:any means it never matters which) holds
    // the higher `n`.
    slot.n = Math.max(renameResult.layout.n, replaceResult.layout.n);
    slot.layoutRev = renameResult.layout.layout_rev;
    slot.name = renameResult.layout.name;
    slot.owner = renameResult.layout.owner;
    slot.deleted = renameResult.layout.deleted;
    // Only the rename touches upstream (layout scope); the t-lineage
    // write's own `touches` is false, a no-op on upstream regardless of
    // which of the two actually committed first (nextUpstream(_, _,
    // false) === prior) -- so applying just the rename's own transition
    // to the model's PRIOR upstream is correct independent of real order.
    slot.upstream = expectUpstream("discord", true, renameResult);
    const f = replaceResult.formats.get("t")!;
    slot.formats.set("t", { lineage: "t", format: f.format, rev: f.rev, payload: f.payload });
    return;
  }

  if (action === "transfer") {
    const to = slot.owner === OWNER_A ? OWNER_B : OWNER_A;
    const result = await transferLayout(bindings, clock, actorFor(slot.owner), slot.id, { to }, STAR, null);
    slot.n = result.layout.n;
    slot.layoutRev = result.layout.layout_rev;
    slot.name = result.layout.name;
    slot.owner = result.layout.owner;
    slot.deleted = result.layout.deleted;
    slot.upstream = expectUpstream("discord", true, result);
    return;
  }

  if (action === "delete") {
    const result = await deleteLayout(bindings, clock, actorFor(slot.owner), slot.id, STAR, null);
    slot.n = result.layout.n;
    slot.layoutRev = result.layout.layout_rev;
    slot.name = result.layout.name;
    slot.owner = result.layout.owner;
    slot.deleted = result.layout.deleted;
    slot.upstream = expectUpstream("discord", true, result);
    return;
  }

  if (action === "restore") {
    const result = await restoreLayout(bindings, clock, actorFor(slot.owner), slot.id, {}, null);
    slot.n = result.layout.n;
    slot.layoutRev = result.layout.layout_rev;
    slot.name = result.layout.name;
    slot.owner = result.layout.owner;
    slot.deleted = result.layout.deleted;
    slot.upstream = expectUpstream("discord", true, result);
    return;
  }

  // -- Import-lane ops below: real `commitWrite` calls, matching
  // `import/apply.ts`'s own code path (never the HTTP verb functions). --
  const current = (await readById(db, slot.id))!;
  const currentFormats = await formatsForLayout(db, slot.id);

  if (action === "import_update_layout" || action === "import_update_spark" || action === "import_update_both" || action === "import_delete") {
    const upstream = nextUpstream(current.upstream, "import:cmini", true);
    const layoutPart = { kind: "imported" as const, name: `wm-${op.slotIdx}-${unique()}`, owner: current.owner, created_at: current.created_at, deleted: false };
    const formatPart = { kind: "imported" as const, lineage: "spark", format: "spark/1", payload: { ...SPARK_SEED_PAYLOAD, magic: { notes: unique() } }, hasMagic: false };
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
              layout: layoutPart,
              modified_at: clock(),
              actor: "system:cmini-import",
              via: "import:cmini",
              source: IMPORT_SOURCE,
              upstream,
            }
          : action === "import_update_spark"
            ? {
                layoutId: slot.id,
                creating: false,
                currentN: current.n,
                currentLayout: current,
                currentFormats,
                format: formatPart,
                modified_at: clock(),
                actor: "system:cmini-import",
                via: "import:cmini",
                source: IMPORT_SOURCE,
                upstream,
              }
            : {
                // Coordinator review (M3): "an import update that changes
                // BOTH scopes in one batch" -- mirrors `import/apply.ts`'s
                // own `applyMapped` case (a name change AND a payload
                // change in the SAME upstream tick), one event per scope,
                // one batch.
                layoutId: slot.id,
                creating: false,
                currentN: current.n,
                currentLayout: current,
                currentFormats,
                layout: layoutPart,
                format: formatPart,
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
    if (action === "import_update_spark" || action === "import_update_both") {
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

  // D13 L4: like_count always equals the number of distinct users in
  // `likes` for the layout -- checked after every step, likes included,
  // not just the ones this step's own op happened to touch.
  const likeRows = await db.prepare("SELECT COUNT(DISTINCT user_id) AS n FROM likes WHERE layout_id = ?").bind(layoutId).first<{ n: number }>();
  expect(actualLayout.like_count, "LDB-L4: like_count === COUNT(DISTINCT likes.user_id)").toBe(likeRows?.n ?? 0);

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
  it("[LDB-P16] [LDB-P17] [LDB-P18] [LDB-P19] [LDB-I18] random write sequences over the layout scope and two lineages fold correctly, one format never touching another (not even a stray new row), and upstream forking exactly per lineage", async () => {
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
          // MF-1: snapshot EVERY format row before the op, verify after
          // that (a) every row untouched by this op is byte-equal, and
          // (b) no NEW row appeared in a lineage this op didn't name --
          // run inline (not a separate pass) so it covers every step, not
          // just the final state.
          const existedBefore = slot.exists;
          const before = existedBefore ? await formatsForLayout(db, slot.id) : new Map<string, FormatRow>();
          const resolved = resolveOp(slot, op.raw);
          await applyOp(clock, slots, op);
          // A create (`resolved` starts with "create_") populates the
          // layout's very first format row(s) from nothing -- there is no
          // "before" to compare against and no "touched lineage" concept
          // that applies to it, so the untouched/stray-row checks below
          // only make sense for a slot that already existed.
          if (existedBefore && resolved !== null) {
            const after = await formatsForLayout(db, slot.id);
            const touchedLineages =
              resolved === "add_t" || resolved === "replace_t" || resolved === "concurrent_pair"
                ? ["t"]
                : resolved === "replace_spark" || resolved === "patch_fingermap_spark" || resolved === "import_update_spark"
                  ? ["spark"]
                  : resolved === "import_update_both"
                    ? ["spark"]
                    : [];
            for (const [lin, row] of before) {
              if (touchedLineages.includes(lin)) continue;
              expect(after.get(lin), `lineage '${lin}' untouched by a '${resolved}' on slot ${op.slotIdx}`).toEqual(row);
            }
            // MF-1, the "stray row" half: `after` must never gain a
            // lineage `before` didn't have, other than the one(s) this
            // step actually named (add_t and concurrent_pair -- which may
            // ADD `t` the same way add_t does -- are the only steps
            // allowed to grow the set at all).
            const beforeLineages = new Set(before.keys());
            const allowedNew = resolved === "add_t" || resolved === "concurrent_pair" ? new Set(["t"]) : new Set<string>();
            for (const lin of after.keys()) {
              if (beforeLineages.has(lin)) continue;
              expect(allowedNew.has(lin), `a '${resolved}' on slot ${op.slotIdx} created a STRAY new row in lineage '${lin}'`).toBe(true);
            }
            // A pure layout-scope write changes NO format row at all.
            if (touchedLineages.length === 0 && ["rename", "transfer", "delete", "restore", "import_update_layout", "import_delete"].includes(resolved)) {
              expect(after).toEqual(before);
            }
          }
        }

        for (const slot of slots) {
          if (!slot.exists) continue;
          await checkLayoutInvariants(slot.id);

          // MF-12: the model's own `upstream` bookkeeping (tracked off
          // each verb/commitWrite call's own returned layout) must equal
          // the live row -- in particular, every `t`-lineage write left
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
    const id = ulid();
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
    const { ApiError } = await import("../../src/core/errors");
    await appendInfo(db, clock, { kind: "upstream_changed", layoutId: layout.id, actor: "system:cmini-import", via: "import:cmini", source: IMPORT_SOURCE, detail: { note: "x" } });
    await appendLike(db, clock, { kind: "liked", layoutId: layout.id, userId: "u1", via: "discord", source: USER_SOURCE });
    // D13 L1: a repeat like now throws 409 already_liked instead of a
    // silent no-op -- it still changes nothing.
    let repeatErr: unknown;
    try {
      await appendLike(db, clock, { kind: "liked", layoutId: layout.id, userId: "u1", via: "discord", source: USER_SOURCE });
    } catch (e) {
      repeatErr = e;
    }
    expect(repeatErr).toBeInstanceOf(ApiError);
    expect((repeatErr as InstanceType<typeof ApiError>).body).toMatchObject({ error: "already_liked" });

    const after = await db.prepare("SELECT * FROM layouts WHERE id = ?").bind(layout.id).first<LayoutDbRow>();
    expect(after!.layout_rev).toBe(before!.layout_rev);
    expect(after!.n).toBe(before!.n);
    expect(after!.like_count).toBe(before!.like_count + 1);
  });
});
