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

function pointerSeg(raw: string): string {
  return raw.replace(/~/g, "~0").replace(/\//g, "~1");
}

function invalidPayload(message: string, path: string): { error: ErrBody } {
  return { error: { error: "invalid_payload", message, path } };
}

// char -> finger; a named char that isn't one of this layout's keys is
// refused (`invalid_payload`, path `/keys/<c>`) -- a bad FINGER WORD is
// left to the pipeline's validate() re-run (01 §2.1's finger enum), not
// checked here. Partial maps only change the named chars.
export function setFingermap(p: Payload, map: Record<string, string>): EditResult {
  for (const ch of Object.keys(map)) {
    if (!(ch in p.keys)) {
      return invalidPayload(`fingermap names a char not in this layout's keys: ${JSON.stringify(ch)}`, `/keys/${pointerSeg(ch)}`);
    }
  }
  const out: Payload = structuredClone(p);
  // `ch` was already confirmed present in `p.keys` above (`out` is its
  // clone) -- the `!` just tells `noUncheckedIndexedAccess` what the loop
  // already checked.
  for (const [ch, finger] of Object.entries(map)) out.keys[ch] = { ...out.keys[ch]!, finger };
  return out;
}

// The board vocabulary IS spark/1's own (01 §2) -- validated as a whole by
// the pipeline's validate() re-run (board.stagger length, board.cmini
// agreement), nothing extra checked here.
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
