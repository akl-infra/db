// The DynamoDB document client (design/aws-port.md §6). Locally it points at
// DynamoDB Local with fake credentials; it refuses every other endpoint
// unless AKLDB_DDB_ALLOW_REMOTE=1, which only P4 deploys set.
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";

export interface DocClientOptions {
  /** Absent means the real regional endpoint, which needs AKLDB_DDB_ALLOW_REMOTE=1. */
  endpoint?: string;
  region: string;
}

function remoteAllowed(): boolean {
  return typeof process !== "undefined" && process.env?.AKLDB_DDB_ALLOW_REMOTE === "1";
}

function isLoopback(endpoint: string): boolean {
  try {
    return new URL(endpoint).hostname === "127.0.0.1";
  } catch {
    return false;
  }
}

export function createDocClient(opts: DocClientOptions): DynamoDBDocumentClient {
  const local = opts.endpoint !== undefined && isLoopback(opts.endpoint);
  if (!local && !remoteAllowed()) {
    throw new Error(
      `refusing DynamoDB endpoint ${opts.endpoint ?? "(AWS default)"}: only http://127.0.0.1:<port> is allowed unless AKLDB_DDB_ALLOW_REMOTE=1`,
    );
  }
  const raw = new DynamoDBClient({
    region: opts.region,
    ...(opts.endpoint === undefined ? {} : { endpoint: opts.endpoint }),
    ...(local ? { credentials: { accessKeyId: "local", secretAccessKey: "local" } } : {}),
  });
  return DynamoDBDocumentClient.from(raw, {
    marshallOptions: { removeUndefinedValues: true, convertEmptyValues: false },
  });
}
