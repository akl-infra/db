# The fuzzer gate image (lane F): Node 24 + Java 21 + DynamoDB Local + the repo at the commit under test, installed for
# linux/arm64 so wrangler's workerd is the native binary. Built by scripts/lab/fuzz/aws-run.mjs from a staged context:
#   repo/  `git archive <commit>` of akldb
#   ddb/   DynamoDBLocal.jar + DynamoDBLocal_lib/ (copied from ~/git/akl/handoff/dynamodb-local; nothing is downloaded here)
# docker buildx build --platform linux/arm64 -f infra/fuzz.Dockerfile <context>
FROM --platform=linux/arm64 node:24-trixie-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends openjdk-21-jre-headless sqlite3 ca-certificates \
 && rm -rf /var/lib/apt/lists/*

COPY ddb/ /opt/dynamodb-local/

WORKDIR /app
COPY repo/package.json repo/package-lock.json ./
RUN npm ci --no-audit --no-fund
# only the container writes results to S3; the repo itself does not depend on the S3 client
RUN npm install --no-save --no-package-lock --no-audit --no-fund @aws-sdk/client-s3@3.1148.0
COPY repo/ ./

ARG COMMIT=unknown
ENV COMMIT=${COMMIT} DDB_LOCAL_DIR=/opt/dynamodb-local WRANGLER_SEND_METRICS=false CI=1 TMPDIR=/tmp

ENTRYPOINT ["node", "scripts/lab/fuzz/task.mjs"]
