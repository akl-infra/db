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

export interface IngestInput {
  headers: Record<string, string>;
  body: string;
  nowMs: number;
}
export interface IngestDeps {
  doc: DynamoDBDocumentClient;
  tables: Pick<DdbTables, "ephemeral">;
  secret: string;
  /** Async-invokes mirror-apply. */
  wake(): Promise<void>;
}
export interface ApplyContext {
  store: Store;
  doc: DynamoDBDocumentClient;
  tables: DdbTables;
  blobs: BlobStore;
  now(): number;
}
export interface ApplyResult {
  applied: number;
  halted: boolean;
  diverged?: boolean;
}

export async function ingestBatch(_input: IngestInput, _deps: IngestDeps): Promise<{ status: number; body: unknown }> {
  throw new MirrorNotImplemented("ingest");
}

export async function runApplier(_ctx: ApplyContext, _opts: { mode: "apply" }): Promise<ApplyResult> {
  throw new MirrorNotImplemented("applier");
}
