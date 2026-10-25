// The counts-and-head half of `GET /v1/meta` (src/index.ts), shared with
// the nightly dump's own `meta` (src/dump/write.ts) so the two can't drift
// (they used to be two hand-kept copies of the same three queries).
//
// Every field is a function of what `readHead` (core/etag.ts) returns, so
// `/v1/meta`'s ETag -- computed from that head alone -- changes iff this
// body does (LDB-R9): `layout_count`/`layouts_modified_at`/`revision` move
// only with an event (LDB-P1: `layouts` is written only through the event
// fold), and `author_count`/`authors_version`/`authors_modified_at` only
// with `authors_head` (migrations/0007's triggers).
import type { Bindings } from "../env";
import type { Head } from "./etag";
import { list as listFormats } from "../formats/registry";
import { toStore, type StoreArg } from "../store/arg";

export interface MetaCore {
  layout_count: number;
  author_count: number;
  seq: number;
  revision: string | null;
  layouts_modified_at: string | null;
  authors_modified_at: string | null;
  // `authors_head.version` (LDB-R9): moves on every change to the author
  // set or to any author's name, and on nothing else. A consumer that
  // caches authors refetches them when this differs from what it holds.
  authors_version: number;
  formats: string[];
}

export function metaFormats(): string[] {
  return listFormats().map((f) => f.id); // registered ids only (20-spark.md S1: spark/1, mana2/1 -- aliases excluded)
}

export async function readMetaCore(dbArg: StoreArg, head: Head): Promise<MetaCore> {
  const counts = await toStore(dbArg).head.metaCounts();
  return {
    layout_count: counts.layoutCount,
    author_count: counts.authorCount,
    seq: head.seq,
    revision: counts.revisionAt,
    layouts_modified_at: counts.layoutsModifiedAt,
    authors_modified_at: head.authors.modifiedAt,
    authors_version: head.authors.version,
    formats: metaFormats(),
  };
}
