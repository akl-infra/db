// Key builders for the DynamoDB model (design/aws-port.md §2.3). Lane G owns
// the core namespaces (META, STATE, CAT, NAME#, L#, U#, EV, EVL#, EVK#, EVA#,
// IMPORTMAP); the other lanes build their own keys inside their own prefixes.
// Numbers in sort keys are zero-padded so byte order is numeric order.

export interface Key {
  pk: string;
  sk: string;
}

/** `seq` sorts as 12 digits (design §2.1). */
export function padSeq(seq: number): string {
  return pad(seq, 12);
}

/** Revs sort as 8 digits. */
export function padRev(rev: number): string {
  return pad(rev, 8);
}

/** Per-submission history ordinals sort as 6 digits. */
export function padOrdinal(n: number): string {
  return pad(n, 6);
}

function pad(n: number, width: number): string {
  if (!Number.isInteger(n) || n < 0) throw new RangeError(`cannot pad ${n} into a sort key`);
  const s = String(n);
  if (s.length > width) throw new RangeError(`${n} does not fit ${width} digits`);
  return s.padStart(width, "0");
}

/** ASCII-only lowercasing (`A-Z` -> `a-z`): exactly SQLite NOCASE. Unicode folding would change which names collide. */
export function fold(name: string): string {
  return name.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32));
}

export const HEAD_KEY: Key = { pk: "META", sk: "HEAD" };

export function stateKey(key: string): Key {
  return { pk: "STATE", sk: key };
}

export function catKey(layoutId: string): Key {
  return { pk: "CAT", sk: layoutId };
}

/** The live-name claim (replaces the partial unique index `layouts_name_live`). */
export function nameKey(name: string): Key {
  return { pk: `NAME#${fold(name)}`, sk: "LIVE" };
}

/** `layout_revs`: lineage is null for the layout scope (written `-`). */
export function revKey(layoutId: string, lineage: string | null, rev: number): Key {
  return { pk: `L#${layoutId}`, sk: `V#${lineage ?? "-"}#${padRev(rev)}` };
}

export function revPrefix(layoutId: string): Key {
  return { pk: `L#${layoutId}`, sk: "V#" };
}

export function likeKey(layoutId: string, userId: string): Key {
  return { pk: `L#${layoutId}`, sk: `LK#${userId}` };
}

export function likesPrefix(layoutId: string): Key {
  return { pk: `L#${layoutId}`, sk: "LK#" };
}

/** The user-side like item (serves `liked_by` and per-user counts). */
export function userLikeKey(userId: string, layoutId: string): Key {
  return { pk: `U#${userId}`, sk: `LK#${layoutId}` };
}

export function userLikesPrefix(userId: string): Key {
  return { pk: `U#${userId}`, sk: "LK#" };
}

export function eventKey(seq: number): Key {
  return { pk: "EV", sk: padSeq(seq) };
}

export function eventLayoutKey(layoutId: string, seq: number): Key {
  return { pk: `EVL#${layoutId}`, sk: padSeq(seq) };
}

export function eventKindKey(kind: string, seq: number): Key {
  return { pk: `EVK#${kind}`, sk: padSeq(seq) };
}

export function eventActorKey(actor: string, seq: number): Key {
  return { pk: `EVA#${actor}`, sk: padSeq(seq) };
}

export function importMapKey(id: string): Key {
  return { pk: "IMPORTMAP", sk: id };
}
