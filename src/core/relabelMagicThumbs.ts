// [LDB-I28] (saltorbit, docs/decisions/23-geometry.md §4.6a): a one-off
// admin data fix for 18 catalog layouts imported from cmini before this
// rule existed. cmini stores a layout's magic key(s) (`@`, and `*` when
// there's a second one) on row >= 3 under a PLACEHOLDER non-thumb finger
// (typically `LP` at col 6, `magikarp`'s `@` also has `RP` at col 7) --
// cmini's own schema has nowhere else to put a key that isn't really on
// the alpha block. They ARE thumb keys: every reader used to draw row >= 3
// as the thumb row regardless of finger, which is what let this ride --
// #398 (aklgg, "the number row is row -1") started drawing row >= 3 BY
// FINGER instead, exposing it.
//
// The rule: a key at row >= 3 whose finger is not already a thumb label
// (`LT`/`RT`/`TB`) AND whose char is one of cmini's magic chars (`@`/`*`)
// is relabelled to the thumb it actually is, by the same `col < 5 => LT,
// else RT` column rule §4.6 already uses for a mislabelled THUMB. A
// genuine extra finger row that doesn't use `@`/`*` as its char (horifreq's
// digit row, scuare's 8-key row 3, whirl-30's `k`) is untouched -- this
// rule keys off the CHAR, never the row alone. A `free` position (no char)
// can never match, by construction.
//
// This file is deliberately standalone: it does NOT touch
// `formats/adapters/cmini/translate.ts`'s own (frozen, LDB-F23/F28/F31)
// `fromCmini`/`relabelFinger` -- the cmini importer that ever called
// `fromCmini` is gone for good (LDB-X2) and nothing imports through it any
// more, so there is no live import path left for a matching import-time
// rule to protect; touching that file's pinned behaviour would risk its
// own frozen invariants for no operational benefit. This is purely a
// one-off correction over an ALREADY-STORED spark/1 `keys` array, run once
// by `POST /v1/admin/relabel-magic-thumbs` (`routes/admin.ts`, the only
// caller). Also deliberately outside `src/import/`: that directory must
// not exist any more (LDB-X1) and this pass has nothing to do with the
// deleted cmini import pipeline -- it is a plain system write, same shape
// `core/write.ts`'s `seedMagic` uses for its own one-off system fix.
//
// Idempotent (a record already corrected has nothing left to relabel) and
// paginates the whole corpus to completion within one call -- the corpus
// this pass will ever touch is small (18 layouts today), so there is no
// reason to make an operator call it more than once. A record that has
// stopped following upstream is left untouched: its fingers are the
// owner's now (17-magic-ownership.md §3's own rule, the same guard the
// retired M1 strip pass used).
import type { Bindings } from "../env";
import type { Key } from "../../formats/spark/1/geometry";
import { hasMagic, hasAlts, hasCombos, type Payload } from "../../formats/spark/1/index";
import { commitWrite, type CommitInput } from "./events";
import { decodeCursor, list, type ListCursor } from "./records";
import { readByIdWithFormats } from "./records";
import type { Clock } from "./time";

const SPARK_LINEAGE = "spark";
// Same D1-statement-budget reasoning as the deleted importer's own
// per-page sizes: comfortably inside one Worker invocation, however many
// pages the live corpus needs (18 layouts today).
const PAGE_SIZE = 500;
const THUMB_FINGERS = new Set(["LT", "RT", "TB"]);
const MAGIC_CHARS = new Set(["@", "*"]);

const ACTOR = "system:relabel-magic-thumbs";
const VIA = "admin:relabel-magic-thumbs";
const SOURCE = { client: ACTOR, version: null };

export interface RelabeledKey {
  key: string;
  row: number;
  col: number;
  from: string;
  to: string;
}

export interface RelabelPlanItem {
  layout_id: string;
  name: string;
  keys: RelabeledKey[];
}

export interface RelabelMagicThumbsResult {
  dry_run: boolean;
  relabeled_layouts: number;
  relabeled_keys: number;
  layouts: RelabelPlanItem[];
}

// Pure over one `keys` array -- exported for direct unit testing of the
// rule itself, independent of D1/commitWrite. Order-preserving; an entry
// the rule doesn't touch is returned identical (`===`).
export function relabelMagicThumbKeys(keys: Key[]): { keys: Key[]; relabeled: RelabeledKey[] } {
  const relabeled: RelabeledKey[] = [];
  const out = keys.map((k) => {
    if (k.row < 3) return k; // rows 0-2 are the alpha block (#398) -- never this rule's to touch
    if (THUMB_FINGERS.has(k.finger)) return k; // already a thumb label -- nothing to correct
    if (k.char === undefined || !MAGIC_CHARS.has(k.char)) return k; // a genuine extra finger row (horifreq/scuare/whirl-30) -- keyed off the CHAR, never the row alone
    const to = k.col < 5 ? "LT" : "RT";
    relabeled.push({ key: k.char, row: k.row, col: k.col, from: k.finger, to });
    return { ...k, finger: to };
  });
  return { keys: out, relabeled };
}

export async function relabelMagicThumbs(db: Bindings["DB"], now: Clock, dryRun: boolean): Promise<RelabelMagicThumbsResult> {
  let relabeled_layouts = 0;
  let relabeled_keys = 0;
  const layouts: RelabelPlanItem[] = [];
  let cursor: ListCursor | undefined;

  for (;;) {
    const page = await list(db, { sourceLineage: SPARK_LINEAGE, sort: "name", limit: PAGE_SIZE, cursor, withPayload: false });

    for (const { layout } of page.items) {
      // Only a record still following its cmini upstream is this pass's to
      // touch -- a fork means an owner's own edit is the source of truth
      // now, whatever fingers it currently holds (17-magic-ownership.md
      // §3, the same guard the retired M1 strip pass used).
      if (layout.upstream === null || layout.upstream.state !== "following") continue;

      // Fresh read, immune to `list()`'s row shape drifting independently
      // of this loop, and gives `currentN`/`currentFormats` in the same
      // shot `commitWrite` needs.
      const fresh = await readByIdWithFormats(db, layout.id);
      if (fresh === null) continue; // raced away (e.g. deleted) between the scan and here
      const upstream = fresh.layout.upstream;
      if (upstream === null || upstream.state !== "following") continue; // re-checked live, same reasoning
      const sparkRow = fresh.formats.get(SPARK_LINEAGE);
      if (sparkRow === undefined) continue; // raced away (format removed) between the scan and here

      const payload = sparkRow.payload as Payload;
      const { keys, relabeled } = relabelMagicThumbKeys(payload.keys);
      if (relabeled.length === 0) continue; // nothing this pass needs to fix -- already correct, or never affected

      relabeled_layouts++;
      relabeled_keys += relabeled.length;
      layouts.push({ layout_id: fresh.layout.id, name: fresh.layout.name, keys: relabeled });
      if (dryRun) continue;

      const newPayload: Payload = { ...payload, keys };
      const input: CommitInput = {
        layoutId: fresh.layout.id,
        creating: false,
        currentN: fresh.layout.n,
        currentLayout: fresh.layout,
        currentFormats: fresh.formats,
        format: {
          kind: "imported",
          lineage: SPARK_LINEAGE,
          format: sparkRow.format,
          payload: newPayload,
          hasMagic: hasMagic(newPayload),
          // design/alts/07-format.md: this pass only ever touches `keys`'
          // fingers -- `alts`/`combos` are untouched, but recomputed fresh
          // from the payload anyway (never carried over from the stale
          // row), same posture `hasMagic` above already has.
          hasAlts: hasAlts(newPayload),
          hasCombos: hasCombos(newPayload),
          detail: { reason: "magic_thumb_relabeled", relabeled },
        },
        modified_at: now(),
        actor: ACTOR,
        via: VIA,
        source: SOURCE,
        // A system correction, never a fork -- same posture as
        // `seedMagic`'s own direct assignment (core/write.ts), not routed
        // through `core/upstream.ts`'s `nextUpstream` (whose only
        // "never forks" case is keyed to the now-deleted importer's own
        // `via`).
        upstream: { ...upstream, state: "following" },
      };
      await commitWrite(db, now, input);
    }

    if (page.nextCursor === null) break;
    const decoded = decodeCursor(page.nextCursor);
    if (decoded === null) break;
    cursor = decoded;
  }

  return { dry_run: dryRun, relabeled_layouts, relabeled_keys, layouts };
}
