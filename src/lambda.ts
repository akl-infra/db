// The Lambda entry (bundled by scripts/deploy-aws.sh into lambda.mjs; infra/akldb.yaml's Handler is lambda.handler).
// Everything here runs at module load, which is the point: the replica boot is a promise started now, so it overlaps
// the rest of init instead of waiting for the first request.
import { createDdbLog, createDdbSnapshotState } from "./replica/log-ddb";
import { createS3Objects } from "./replica/s3";
import { createAws, type AwsCredentials } from "./platform/lambda-aws";
import { createLambdaHandler, defaultMigrationsDir } from "./platform/lambda";

const env = process.env as Record<string, string | undefined>;
const need = (k: string): string => {
  const v = env[k];
  if (v === undefined || v === "") throw new Error(`missing environment variable ${k}`);
  return v;
};

const region = env.AWS_REGION ?? "us-east-2";
// The execution role's credentials, read from the environment at call time (never cached by us).
const credentials = (): AwsCredentials => ({
  accessKeyId: need("AWS_ACCESS_KEY_ID"),
  secretAccessKey: need("AWS_SECRET_ACCESS_KEY"),
  ...(env.AWS_SESSION_TOKEN !== undefined ? { sessionToken: env.AWS_SESSION_TOKEN } : {}),
});

// The replica layer's whole AWS surface (RP6): DynamoDB GetItem, Query, TransactWriteItems and S3 GetObject, PutObject.
const objects = createS3Objects({ bucket: need("DATA_BUCKET"), region, credentials });
const table = need("LOG_TABLE");

export const handler = createLambdaHandler({
  env,
  log: createDdbLog({ table, region, credentials: credentials(), blobs: objects }),
  snapshots: { state: createDdbSnapshotState({ table, region, credentials: credentials() }), objects },
  aws: createAws({
    region,
    bucket: need("DATA_BUCKET"),
    functionName: need("AWS_LAMBDA_FUNCTION_NAME"),
    ssmPrefix: env.SSM_PREFIX ?? `/akldb/${need("STAGE")}/`,
    credentials,
  }),
  migrationsDir: defaultMigrationsDir(env),
});
