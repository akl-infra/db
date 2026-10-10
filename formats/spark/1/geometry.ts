// spark/1's geometry (design/layout-db/23-geometry.md §3 minus the board,
// design/layout-db/26-no-board.md): the `Key` entry shape, and nothing else.
// There is no board word (26-no-board.md): a record says where its keys sit
// and which finger presses each; what physical board it is drawn or analysed
// on is the READER's choice, so the old `KINDS`/`Board`/`STAGGER_BY_KIND`/
// `coords` exports are gone with it. The hand split went on 2026-09-24 and
// the named-fingering classification (`classifyFingering`, `FINGERING_REFS`,
// `gridIndent`, the former LDB-F30/F32) on 2026-10-10 (saltorbit: "we don't
// need it then right? can we just delete it?"): nothing in akldb ever read
// them, no client consumed this package's export of them, and a fingermap
// is a derived read-time label each client classifies for itself
// (aklgg's scripts/build_web.py, web/src/state/boardVerbs.ts and
// bot/src/spark/format.ts, kept in step by aklgg's own tests).
//
// Self-contained like every other file in this format package (07 §5): no
// import of src/formats/registry.ts, explicit `.ts` extensions so
// scripts/goldens.mjs can resolve this with plain Node ESM. `Key` (the
// unified keys-array entry, char/row/col/finger) is declared structurally
// here rather than imported from `./index.ts` at runtime, so this module has
// zero runtime dependencies of its own -- index.ts imports VALUES from here,
// never the reverse.

// One entry per PHYSICAL position (design/layout-db/23-geometry.md's
// duplicate-characters follow-up, folded into this round rather than done
// as a separate pass): `char` absent means a free position (spark/1's old
// separate `free` array is gone -- one list). `char` present may repeat
// across entries (the same letter on two positions) -- callers that need
// "the" position for a character (magic lookups) work off a layout where
// every MAGIC-REFERENCED char is validated unique first (index.ts's
// `validateMagicKeysUnique`); a plain duplicate letter with no magic
// reference is fine and carries no such guarantee.
export interface Key {
  char?: string;
  row: number;
  col: number;
  finger: string;
}

// No hand split here: where a client draws the gap between the hands is
// that client's own drawing decision, made from the fingers every key
// already carries (2026-09-24 -- `handSplit`/`handSplitRows` were exported
// for the site and bot to mirror, but nothing in akldb itself ever called
// them; the minimum-over-rows rule they fixed drew a row with a hole next to
// the gap a column early).

// §4.3's four references, left hand only (cols 0-4) -- the right hand is
// always RI RI RM RR RP at a FIXED cols 5-9, exactly `scripts/build_web.py`'s
// `_build_fingermap_refs()` (`enumerate(right, start=5)`, never derived from
// a hand split) -- confirmed against the real Python source by the
// slice's own parity script (db/formats/spark/1's own writeup): an earlier
// draft of this port anchored the right hand at each row's OWN hand-split
// column instead, which reads as a reasonable generalization but is NOT
// what the site actually does, and measurably diverged on real catalog
// layouts whose left-hand extent falls short of col 4 on some row (`alpha`,
// e.g.) -- classify_fingermap has no such generalization; a 10-wide board
// is baked into the four reference tables.
