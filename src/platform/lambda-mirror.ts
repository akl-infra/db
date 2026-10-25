// The seam between the Lambda entry and lane Z's mirror modules (design/aws-port.md section 5.2). Until Z lands, both
// functions refuse with a clear error; when it does, only these two bodies change, the handler names stay fixed.
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import type { DdbTables } from "../store/ddb/contracts";
import type { Store } from "../store/port";
import type { BlobStore } from "./port";

export class MirrorNotImplemented extends Error {
  constructor(what: string) {
    super(`mirror ${what} is not implemented yet (lane Z's modules have not landed)`);
    this.name = "MirrorNotImplemented";
  }
}

export type MirrorDirection = "d1->ddb" | "ddb->d1";

export interface IngestRequest {
  /** Case-insensitive header lookup (lane Z's handleIngest takes this shape). */
  header(name: string): string | null;
  body: string;
}
export interface IngestDeps {
  doc: DynamoDBDocumentClient;
  tables: Pick<DdbTables, "ephemeral">;
  /** The S3 BlobStore (data bucket): records over 250 KB spill to mirror/queue/. */
  blobs: BlobStore;
  direction: MirrorDirection;
  secret: string;
  nowMs(): number;
  /** Async-invokes mirror-apply. */
  wake(): Promise<void>;
  log(line: Record<string, unknown>): void;
}
export interface ApplyContext {
  store: Store;
  doc: DynamoDBDocumentClient;
  tables: DdbTables;
  blobs: BlobStore;
  direction: MirrorDirection;
  nowMs(): number;
}
/** Lane Z's ApplyReport, the fields this entry reads. A halt is a return value, never a throw; the applier also logs {"code":"MIRROR_*"} (the template's metric filter alarms on it). */
export interface ApplyResult {
  busy: boolean;
  applied: number;
  halted: { code: string; reason: string } | null;
  [k: string]: unknown;
}

// When lane Z merges, these two bodies become:
//   ingestBatch: handleIngest(req, { secret, nowMs, wake, log, queue: createKvQueue(ddbKv({ doc, table: tables.ephemeral, direction, blobs }), direction) })
//   runApplier:  runApplier({ store, queue: createKvQueue(ddbKv({ doc, table: tables.ephemeral, direction, blobs }), direction), nowMs, metrics: emfMetrics(direction) })
export async function ingestBatch(_req: IngestRequest, _deps: IngestDeps): Promise<{ status: number; body: Record<string, unknown> }> {
  throw new MirrorNotImplemented("ingest");
}

export async function runApplier(_ctx: ApplyContext): Promise<ApplyResult> {
  throw new MirrorNotImplemented("applier");
}
