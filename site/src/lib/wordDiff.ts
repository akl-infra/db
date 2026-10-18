// Word-level diff for the Inbox's comment edits (`pages/admin/CommentDetails
// .tsx`): the live text against the pending one, so a moderator sees what
// changed instead of rereading both. Pure: no DOM, no fetch.

export type DiffOp = "eq" | "del" | "ins";
export interface DiffPart {
  op: DiffOp;
  text: string;
}

/** Splits into alternating word and whitespace tokens, whitespace kept, so
 * joining the tokens reproduces the input exactly (newlines included). */
export function tokenize(s: string): string[] {
  return s.length === 0 ? [] : (s.match(/\s+|\S+/g) ?? []);
}

// A longest-common-subsequence table is |a| x |b| cells. A comment is at most
// 2000 characters (about 1000 tokens), so this is a million cells at the very
// worst; past the cap (a defensive bound, not a reachable case) the diff
// falls back to "everything removed, everything added".
const MAX_CELLS = 4_000_000;

/** Word-level diff of `before` to `after`: consecutive tokens of the same op
 * are merged into one part, deletions come before insertions within a
 * changed run, and concatenating the `eq` + `del` parts gives `before`
 * while `eq` + `ins` gives `after`. */
export function diffWords(before: string, after: string): DiffPart[] {
  const a = tokenize(before);
  const b = tokenize(after);
  const parts: DiffPart[] = [];
  const push = (op: DiffOp, text: string): void => {
    const last = parts[parts.length - 1];
    if (last !== undefined && last.op === op) last.text += text;
    else parts.push({ op, text });
  };

  if (a.length * b.length > MAX_CELLS) {
    if (before !== "") push("del", before);
    if (after !== "") push("ins", after);
    return parts;
  }

  // lcs[i][j] = length of the LCS of a[i..] and b[j..]
  const lcs: Uint32Array[] = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }

  let i = 0;
  let j = 0;
  const dels: string[] = [];
  const inss: string[] = [];
  const flush = (): void => {
    if (dels.length > 0) push("del", dels.join(""));
    if (inss.length > 0) push("ins", inss.join(""));
    dels.length = 0;
    inss.length = 0;
  };
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      flush();
      push("eq", a[i]!);
      i++;
      j++;
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) {
      dels.push(a[i]!);
      i++;
    } else {
      inss.push(b[j]!);
      j++;
    }
  }
  while (i < a.length) dels.push(a[i++]!);
  while (j < b.length) inss.push(b[j++]!);
  flush();
  return parts;
}

/** A long comment is shown collapsed behind "Read all": the first
 * `COLLAPSE_AT` characters (code points, so a cut never splits an emoji),
 * `null` when the text is short enough to show whole. */
export const COLLAPSE_AT = 400;

export function collapsedPreview(text: string, limit: number = COLLAPSE_AT): string | null {
  const chars = [...text];
  return chars.length > limit ? chars.slice(0, limit).join("") : null;
}

/** One side of an edit, for the stacked "Current" / "Proposed" blocks: the
 * whole text with only that side's marks. Current keeps the unchanged and
 * deleted parts (the old text), Proposed the unchanged and inserted parts
 * (the new text); each is a complete text, never one interleaved string. */
export function sideOf(parts: DiffPart[], side: "current" | "proposed"): DiffPart[] {
  return parts.filter((p) => p.op === "eq" || p.op === (side === "current" ? "del" : "ins"));
}

function codePoints(s: string): number {
  return [...s].length;
}

/** Clamps parts to `limit` code points for the "Read all" collapse, but never
 * hides a mark: the cut is at least as far as the end of the last changed
 * part, so only trailing unchanged text can be folded away. `null` when
 * nothing would be hidden. */
export function clampParts(parts: DiffPart[], limit: number = COLLAPSE_AT): DiffPart[] | null {
  let total = 0;
  let lastChangeEnd = 0;
  for (const p of parts) {
    total += codePoints(p.text);
    if (p.op !== "eq") lastChangeEnd = total;
  }
  const cut = Math.max(limit, lastChangeEnd);
  if (total <= cut) return null;
  const out: DiffPart[] = [];
  let left = cut;
  for (const p of parts) {
    if (left <= 0) break;
    const chars = [...p.text];
    out.push(chars.length <= left ? p : { op: p.op, text: chars.slice(0, left).join("") });
    left -= chars.length;
  }
  return out;
}
