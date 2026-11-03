// zstd through node:zlib (Node 24; no dependency, and nothing a Worker bundle imports). Snapshots use level 19: the
// jobs tick pays for it, a cold boot only decompresses (measured: smaller object, faster unzstd than level 3).
import zlib from "node:zlib";

/** Snapshot compression level (the jobs tick writes them, off the request path). */
export const SNAPSHOT_LEVEL = 19;
/** Spill compression level (on the append path of a rare, large unit: fast beats small). */
export const SPILL_LEVEL = 3;

export function zstdCompress(bytes: Uint8Array, level: number): Uint8Array {
  return zlib.zstdCompressSync(bytes, { params: { [zlib.constants.ZSTD_c_compressionLevel]: level } });
}

export function zstdDecompress(bytes: Uint8Array): Uint8Array {
  return zlib.zstdDecompressSync(bytes);
}
