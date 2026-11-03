// The cutover image (phase E, LDB-CV10): append D1's whole database to an EMPTY log as its first entry.
//
//   1. the zstd image goes to the object store as `log/<unitId>.image.zst` (BEFORE the append, like a spilled body);
//   2. the log item (kind "image") carries a small body: the image's sha256 (`hash`), sizes, the D1 export's per-table
//      counts and checksums, provenance;
//   3. the append is the ordinary conditional one with expectedHead = 0, so a log that already holds anything refuses it.
//
// Idempotent for the cutover's resume: a log whose seq 1 is already THIS image answers "already"; any other content is
// refused loudly. Backends refuse an image at any other seq on their own (assertImageAppend), so this helper is the
// convenience, not the guard.
import { ulid as newUlid } from "ulidx";
import { createHash } from "node:crypto";
import { AmbiguousAppendError, ImageEntryRefusedError, LogThrottledError, type CommitLog, type ImageRef, type NewLogEntry } from "./log";
import type { BodySpiller } from "./spill";
import { sleep } from "./timers";

/** A log backend that can also upload the image (the DynamoDB and memory logs both expose their spiller). */
export type ImageLog = CommitLog & { readonly spiller: BodySpiller };

export interface AppendImageOptions {
  log: ImageLog;
  /** The raw SQLite image (`DatabaseSync.serialize()` or the file's bytes). */
  raw: Uint8Array;
  tables: ImageRef["tables"];
  source?: ImageRef["source"];
  ulid?: () => string;
  /** zstd level (default: the snapshot level). */
  level?: number;
  sleep?: (ms: number) => Promise<void>;
  /** Append tries around throttling and ambiguous outcomes. Default 6. */
  maxTries?: number;
}

export interface AppendImageResult {
  outcome: "appended" | "already";
  seq: 1;
  unitId: string;
  /** sha256 of the raw image (the entry's hash). */
  hash: string;
  image: ImageRef;
}

export async function appendImage(opts: AppendImageOptions): Promise<AppendImageResult> {
  const { log, raw } = opts;
  const hash = createHash("sha256").update(raw).digest("hex");
  const wait = opts.sleep ?? sleep;
  const head = await log.head();
  if (head !== 0) {
    const first = await log.get(1);
    if (first?.kind === "image" && first.hash === hash && first.image !== undefined) return { outcome: "already", seq: 1, unitId: first.unitId, hash, image: first.image };
    throw new ImageEntryRefusedError(`the log is not empty (head ${head}${first === null ? "" : `, seq 1 is a ${first.kind}${first.kind === "image" ? " with a different image" : ""}`}): the image must be the first entry`);
  }
  const unitId = (opts.ulid ?? newUlid)();
  const { image } = await log.spiller.storeImage(unitId, raw, { tables: opts.tables, ...(opts.source !== undefined ? { source: opts.source } : {}) }, opts.level);
  const entry: NewLogEntry = { unitId, kind: "image", stmts: [], hash, image };
  const tries = opts.maxTries ?? 6;
  for (let n = 1; ; n++) {
    try {
      const r = await log.append(0, entry);
      if (r === "ok") break;
      throw new ImageEntryRefusedError("someone else appended seq 1 first: the log is no longer empty");
    } catch (e) {
      if (e instanceof AmbiguousAppendError) {
        const got = await log.get(1); // resolve by reading seq 1 back (SH6)
        if (got?.unitId === unitId) break;
        if (got !== null) throw new ImageEntryRefusedError("an ambiguous image append lost to another entry at seq 1");
      } else if (!(e instanceof LogThrottledError)) throw e;
      if (n >= tries) throw new Error(`the image append stayed unresolved after ${n} tries: ${e instanceof Error ? e.message : String(e)}`);
      await wait(20 * n);
    }
  }
  return { outcome: "appended", seq: 1, unitId, hash, image };
}
