// zstd through node:zlib (Node 24; no dependency, and nothing a Worker bundle imports). Snapshots default to level 12: the
// snapshot writer pays for it, a cold boot only decompresses.
import zlib from "node:zlib";

/**
 * Snapshot compression level. Level 12 is the default because level 19 took 24.5 s for 45 MB (a ninth of the time at 12 for
 * 14% more bytes, scripts/lab/boot-bench.mjs); SNAPSHOT_ZSTD_LEVEL raises or lowers it. Decompression cost, which a cold start
 * pays, is the same order at every level.
 */
export const SNAPSHOT_LEVEL = 12;
/** Spill compression level (on the append path of a rare, large unit: fast beats small). */
export const SPILL_LEVEL = 3;

export function zstdCompress(bytes: Uint8Array, level: number): Uint8Array {
  return zlib.zstdCompressSync(bytes, { params: { [zlib.constants.ZSTD_c_compressionLevel]: level } });
}

export function zstdDecompress(bytes: Uint8Array): Uint8Array {
  return zlib.zstdDecompressSync(bytes);
}
