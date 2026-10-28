// LDB-V9 (API 1.32, docs/decisions/22-spark-spec.md §9): `/v1` spark/1 reads
// are frozen at the 1.28 shape; newer constructs are served only to a client
// that names them in `?features=a,b` (any `/v1` route). Today the one name is
// `skip` (skip magic, API 1.29). Unknown names are ignored, never an error: a
// client may send a name from a newer akldb than the one answering.
import type { Context } from "hono";
import { withholdSkip } from "../../formats/spark/1/withhold.ts";

export interface Features {
  skip: boolean;
}

// What a request that names no feature gets: everything withheld. Also the
// default of every function below that takes a `Features`, so a call site
// that forgets to pass one withholds rather than leaks.
export const NO_FEATURES: Features = { skip: false };

export function parseFeatures(values: readonly string[] | undefined): Features {
  const names = new Set((values ?? []).flatMap((v) => v.split(",")).map((s) => s.trim()));
  return { skip: names.has("skip") };
}

export function featuresOf(c: Context): Features {
  return parseFeatures(c.req.queries("features"));
}

// The ETag-query fragment: empty when nothing is opted in, so a default
// request's ETag depends on the wire version alone.
export function featuresEtagKey(f: Features): { features?: string[] } {
  return f.skip ? { features: ["skip"] } : {};
}

// A spark/1 payload as `/v1` serves it to `f`.
export function payloadFor<T>(format: string, payload: T, f: Features): { payload: T; withheld: boolean } {
  if (f.skip || !format.startsWith("spark/")) return { payload, withheld: false };
  return withholdSkip(payload);
}
