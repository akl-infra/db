// cmini/1's PATCH edits (09-implementation-phase2.md §2.6, §3 T4):
// fingermap and board only. No `setMagic` -- cmini/1 has no magic idiom of
// its own (03 §3: an owner moves to akl/1 with a PUT before they can PATCH
// magic), so a `magic` PATCH on a cmini/1 record is refused with
// `unsupported_for_format` by the pipeline before this module is even
// asked (registry.ts's FormatEdits: an absent entry IS the refusal).
// Self-contained like index.ts (07 §5): no import of src/formats/
// registry.ts (only `import type` from ./index.ts and akl/1/index.ts,
// erased at compile time).
import type { Payload, ErrBody } from "./index.ts";
import type { Board as AklBoard } from "../../akl/1/index.ts";

export type EditResult = Payload | { error: ErrBody };

function pointerSeg(raw: string): string {
  return raw.replace(/~/g, "~0").replace(/\//g, "~1");
}

function invalidPayload(message: string, path: string): { error: ErrBody } {
  return { error: { error: "invalid_payload", message, path } };
}

// char -> finger; same rule as akl/1's own setFingermap (a named char must
// be one of this layout's keys, else `invalid_payload` at `/keys/<c>`) --
// cmini/1's `Position` shape is identical.
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

// `board` arrives shaped as akl/1's board object (01 §2, the API's one
// board vocabulary) even though this record is cmini/1: `board.cmini` wins
// when present (the same rule `to["cmini/1"]` uses, 01 §6.2); otherwise a
// rowstag board derives "stagger", an ortho board derives "ortho". UNLIKE
// `to["cmini/1"]` -- which defaults a hint-less colstag board to "ortho"
// and accepts the lost stagger amounts as a documented translation loss
// (01 §6.2) -- an explicit board PATCH on a cmini/1 record REFUSES a
// hint-less colstag board outright (09 §3 T4): a write is not a read, and
// silently dropping the geometry the caller just sent is worse than
// saying no.
export function setBoard(p: Payload, board: unknown): EditResult {
  if (board !== null && typeof board !== "object") {
    return invalidPayload("board must be an object", "/board");
  }
  const word = deriveWord(board as AklBoard | null | undefined);
  if (word === null) {
    return {
      error: {
        error: "unsupported_for_format",
        message: "a colstag board needs an explicit board.cmini word to be stored as cmini/1",
        format: "cmini/1",
        verb: "board",
      },
    };
  }
  const out: Payload = structuredClone(p);
  out.board = word;
  return out;
}

function deriveWord(board: AklBoard | null | undefined): Payload["board"] | null {
  if (board?.cmini) return board.cmini;
  if (board === undefined || board === null || board.kind === "ortho") return "ortho";
  if (board.kind === "rowstag") return "stagger";
  return null; // colstag, no hint -- refused (see setBoard's comment)
}

export const edits = { setFingermap, setBoard };
