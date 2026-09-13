// spark/1's PATCH edits (09-implementation-phase2.md §2.6, §3 T4): the
// `FormatEdits` registry.ts's optional slot reserves, one pure function per
// verb `patchLayout` (src/core/write.ts) may apply. Self-contained like
// index.ts (07 §5): no import of src/formats/registry.ts (only `import
// type` from ./index.ts, which is erased at compile time -- no runtime
// cycle with index.ts's own `export { edits } from "./edits.ts"`).
// Never mutates `p` -- structured-clones first; the pipeline re-runs
// validate() on the result afterward, so an edit only needs to apply the
// change, not duplicate the format's own rules.
import type { Payload, Board, MagicIntent, ErrBody } from "./index.ts";

export type EditResult = Payload | { error: ErrBody };

function invalidPayload(message: string, path: string): { error: ErrBody } {
  return { error: { error: "invalid_payload", message, path } };
}

// char -> finger; a named char that isn't one of this layout's keys is
// refused (`invalid_payload`, path `/keys`) -- a bad FINGER WORD is left to
// the pipeline's validate() re-run (01 §2.1's finger enum), not checked
// here. Partial maps only change the named chars. `Payload.keys` is an
// ARRAY now (design/layout-db/23-geometry.md's duplicate-characters
// follow-up, 24-spark-wire-review.md finding 5): a named char that matches
// MORE than one entry is refused too -- there is no way to know which
// occurrence a bare char->finger map means, so this edit can't silently
// pick one (a layout with a genuine duplicate needs `setBoard`/a direct
// payload write instead, which addresses entries by position, not char).
export function setFingermap(p: Payload, map: Record<string, string>): EditResult {
  for (const ch of Object.keys(map)) {
    const matches = p.keys.filter((k) => k.char === ch).length;
    if (matches === 0) {
      return invalidPayload(`fingermap names a char not in this layout's keys: ${JSON.stringify(ch)}`, "/keys");
    }
    if (matches > 1) {
      return invalidPayload(`fingermap names ${JSON.stringify(ch)}, which appears on more than one position -- setFingermap can't tell which one you mean`, "/keys");
    }
  }
  const out: Payload = structuredClone(p);
  out.keys = out.keys.map((k) => (k.char !== undefined && k.char in map ? { ...k, finger: map[k.char]! } : k));
  return out;
}

// The board vocabulary IS spark/1's own (design/layout-db/23-geometry.md
// §4.1, one word) -- validated as a whole by the pipeline's validate()
// re-run (the four-word enum, the iso width rule, the ansi-only fingering
// rule), nothing extra checked here.
export function setBoard(p: Payload, board: unknown): EditResult {
  const out: Payload = structuredClone(p);
  out.board = structuredClone(board) as Board;
  return out;
}

// The magic vocabulary IS spark/1's own (01 §2) -- same reasoning as
// setBoard.
export function setMagic(p: Payload, magic: unknown): EditResult {
  const out: Payload = structuredClone(p);
  out.magic = structuredClone(magic) as MagicIntent;
  return out;
}

export const edits = { setFingermap, setBoard, setMagic };
