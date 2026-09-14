// mana2/1's PATCH edits (09-implementation-phase2.md §2.6, §3 T4;
// 12-implementation-phase5.md §2.5's decision #9): `setFingermap` only.
// `setMagic` has no entry here at all -- registry.ts's FormatEdits: an
// absent entry IS the refusal (`unsupported_for_format`) -- a mana user
// edits the `.jsonc` file directly for that, this format never invents a
// second write path for it. (There is no `setBoard` verb anywhere any more:
// spark/1 has no board field, design/layout-db/26-no-board.md.)
//
// mana2/1 has no `keys` map (spark/1's `setFingermap` doc comment: "every
// named char must already be one of p.keys" does not apply verbatim
// here) -- a char names a FINGERS-ROW cell; mana2's own thumbs carry no
// fingermap entry at all (thumb finger is hardcoded 4/5 by which string a
// key sits in, core/load_layout.go's addThumbsToLayout), so a thumb key
// is refused the same way an absent char is. Self-contained like index.ts
// (07 §5): no import of src/formats/registry.ts (only `import type` from
// ./index.ts, erased at compile time).
import type { Payload, ErrBody } from "./index.ts";
import { parseRow, DIGIT_BY_FINGER } from "./translate.ts";

export type EditResult = Payload | { error: ErrBody };

function invalidPayload(message: string, path: string): { error: ErrBody } {
  return { error: { error: "invalid_payload", message, path } };
}

function rowTokens(row: string | undefined): string[] {
  return (row ?? "").trim().split(/\s+/).filter((t) => t.length > 0);
}

// char -> finger letter (spark/1 vocabulary, e.g. "LP"); a char not found
// among `layout.fingers`' own resolved keys (including a valid-but-held
// row, e.g. a tap-hold cell's tap character) is refused at
// `/layout/fingers` -- a bad finger WORD is left to the pipeline's
// validate() re-run, not checked here (matching spark/1/edits.ts's own
// convention).
export function setFingermap(p: Payload, map: Record<string, string>): EditResult {
  const out: Payload = structuredClone(p);
  for (const [ch, fingerLetter] of Object.entries(map)) {
    let found = false;
    for (let y = 0; y < out.layout.fingers.length && !found; y++) {
      const parsed = parseRow(out.layout.fingers[y]!);
      if ("message" in parsed) continue; // an invalid row is the pipeline's re-run's problem, not this edit's
      for (const { index, resolution } of parsed) {
        if (resolution.tap !== ch) continue;
        const digit = DIGIT_BY_FINGER[fingerLetter];
        if (digit === undefined) return invalidPayload(`unknown finger ${JSON.stringify(fingerLetter)}`, `/layout/fingers/${y}`);
        const digits = rowTokens(out.fingermap[y]);
        while (digits.length <= index) digits.push("0"); // fingermap is already validated >= cell count; defensive only
        digits[index] = String(digit);
        out.fingermap[y] = digits.join(" ");
        found = true;
        break;
      }
    }
    if (!found) return invalidPayload(`fingermap names a char not in this layout's fingers rows: ${JSON.stringify(ch)}`, "/layout/fingers");
  }
  return out;
}

export const edits = { setFingermap };
