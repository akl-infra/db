// A structural fingerprint of a JSON value -- field NAMES and TYPES, never
// values. Two responses with the same shape but different literal content
// (a different `layout_count`, a different id) fingerprint identically;
// adding, removing or retyping a field changes the shape. This is the
// primitive `tests/contract/contract.test.ts`'s [LDB-V4] golden diff is
// built on: a value-only fixture update (routine, happens constantly) is
// invisible to it; a real wire-shape change is not.

export type Shape =
  | { type: "null" }
  | { type: "string" }
  | { type: "number" }
  | { type: "boolean" }
  | { type: "array"; item: Shape | null } // null = an empty array (unknown item shape)
  | { type: "object"; fields: Record<string, Shape> };

export function shapeOf(value: unknown): Shape {
  if (value === null || value === undefined) return { type: "null" };
  if (Array.isArray(value)) return { type: "array", item: value.length > 0 ? shapeOf(value[0]) : null };
  switch (typeof value) {
    case "string":
      return { type: "string" };
    case "number":
      return { type: "number" };
    case "boolean":
      return { type: "boolean" };
    case "object": {
      const fields: Record<string, Shape> = {};
      for (const key of Object.keys(value as Record<string, unknown>).sort()) {
        fields[key] = shapeOf((value as Record<string, unknown>)[key]);
      }
      return { type: "object", fields };
    }
    default:
      return { type: "null" };
  }
}

export interface ShapeDiff {
  added: string[]; // field paths present in `next`, absent in `prev`
  removed: string[]; // field paths present in `prev`, absent in `next`
  changed: string[]; // field paths present in both, with a different type
}

export function diffShapes(prev: Shape, next: Shape, pathPrefix = "$"): ShapeDiff {
  const added: string[] = [];
  const removed: string[] = [];
  const changed: string[] = [];

  function walk(a: Shape, b: Shape, p: string): void {
    if (a.type !== b.type) {
      changed.push(`${p}: ${a.type} -> ${b.type}`);
      return;
    }
    if (a.type === "object" && b.type === "object") {
      const aKeys = new Set(Object.keys(a.fields));
      const bKeys = new Set(Object.keys(b.fields));
      for (const k of bKeys) if (!aKeys.has(k)) added.push(`${p}.${k}`);
      for (const k of aKeys) if (!bKeys.has(k)) removed.push(`${p}.${k}`);
      for (const k of aKeys) if (bKeys.has(k)) walk(a.fields[k]!, b.fields[k]!, `${p}.${k}`);
    } else if (a.type === "array" && b.type === "array") {
      if (a.item !== null && b.item !== null) walk(a.item, b.item, `${p}[]`);
      // one or both sides an empty array: nothing more to compare there
    }
  }

  walk(prev, next, pathPrefix);
  return { added, removed, changed };
}

export function shapeDiffIsEmpty(d: ShapeDiff): boolean {
  return d.added.length === 0 && d.removed.length === 0 && d.changed.length === 0;
}
