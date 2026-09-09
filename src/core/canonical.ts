// canonical(v): a byte-stable JSON serialization -- object keys sorted in
// code-unit order (recursively), arrays left in place, no whitespace,
// scalars formatted exactly as JSON.stringify would. Used for
// payload_json, ETags, the D12 diff and every byte-identity test.
//
// This is NOT RFC 8785 (JCS): upstream carries only strings/ints/bools/
// null, so the two agree on every value we actually see, and the simpler
// rule is what's documented here so nobody "upgrades" it expecting more
// (numeric formatting edge cases, etc.) to matter.
export function canonical(v: unknown): string {
  return stringify(v);
}

function stringify(v: unknown): string {
  if (v === undefined) return "null"; // only reachable via a bare top-level call; object/array cases below strip/replace undefined explicitly
  if (v === null || typeof v !== "object") {
    return JSON.stringify(v);
  }
  if (Array.isArray(v)) {
    return "[" + v.map((item) => (item === undefined ? "null" : stringify(item))).join(",") + "]";
  }
  const obj = v as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort(); // default comparator: UTF-16 code-unit order
  const parts = keys.map((k) => JSON.stringify(k) + ":" + stringify(obj[k]));
  return "{" + parts.join(",") + "}";
}
