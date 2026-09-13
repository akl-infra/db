// "Analyze on akl.gg" link (design/akldb-site/01-plan.md §5, S4: the site
// does no analysis itself). akl.gg's shareable hash is msgpack + a
// HASH_DICT + base64url, behind a '.' sigil (web/src/core/codec.ts) -- a
// bare `#<name>` is NOT one of its two understood formats (packed, or
// legacy JSON) and would silently decode to nothing, so this builds a real
// packed hash instead: a one-key state object `{q: <name>}`, which pre-fills
// akl.gg's own explorer search box with the layout's name (`q` is
// HASH_DICT's own search-box key, `web/src/core/codec.ts`'s `HASH_DICT`).
//
// This is a small, hand-written, FROZEN subset of that encoder -- exactly
// enough to pack a one-entry string map -- not an import of web/src (the
// site has no dependency on ../../web, S9's spirit extended to the whole
// tree, not just db/src). `'q'`'s dictionary index below is copied from
// `web/src/core/codec.ts`'s `HASH_DICT` and must be kept in sync with it by
// hand if that array is ever reordered (append-only by its own contract, so
// this index does not move under normal edits -- `tests/src/aklgg.test.ts`
// pins the literal value and the byte-for-byte encoding of a known example).
const HASH_SIGIL = ".";
const Q_DICT_INDEX = 11; // web/src/core/codec.ts HASH_DICT: … 'thumb', 'magic', 'fmap', 'q' -> index 11

function encodeUtf8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

function writeMsgpackStr(out: number[], s: string): void {
  const bytes = encodeUtf8(s);
  const n = bytes.length;
  if (n < 32) out.push(0xa0 | n);
  else if (n < 256) out.push(0xd9, n);
  else if (n < 65536) out.push(0xda, n >> 8, n & 0xff);
  else out.push(0xdb, (n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff);
  for (const b of bytes) out.push(b);
}

/** Encodes `{q: value}` as msgpack: fixmap(1), positive-fixint key (the
 * dictionary index), then the value as a plain msgpack string (never
 * dictionary-compressed -- a layout name almost never matches a dictionary
 * word, and an uncompressed string always round-trips, just a few bytes
 * longer, per codec.ts's own "what stays safe" contract). */
export function encodeQState(value: string): Uint8Array {
  const out: number[] = [];
  out.push(0x81); // fixmap, 1 entry
  out.push(Q_DICT_INDEX & 0x7f); // positive fixint (index is well under 128)
  writeMsgpackStr(out, value);
  return Uint8Array.from(out);
}

export function b64urlEncode(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function aklggAnalyzeUrl(layoutName: string): string {
  const packed = encodeQState(layoutName);
  return `https://akl.gg/#${HASH_SIGIL}${b64urlEncode(packed)}`;
}
