# akldb

A community database of alternative keyboard layouts. Browse layouts, download
layout data, or build an app with the public API. Layouts have owners and an
edit history.

[Browse layouts](https://akldb.org) · [API documentation](https://akldb.org/docs)

## Download layouts

Reads are public; no account or API key is needed.

Download a layout by name or ID:

```sh
curl --fail --output io.json \
  "https://api.akldb.org/v1/layouts/io?format=spark/1"
```

Download the whole collection, including layout payloads:

```sh
curl --fail --output layouts.json \
  "https://api.akldb.org/v1/layouts?format=spark/1&full=1"
```

These files contain layout records and their `payload` data. Always specify a
format: `spark/1` is the native JSON format describing key positions, finger
assignments, and optional keyboard behavior. `mana2/1` is available for export to
[Mana2](https://codeberg.org/Zakkkk/mana2), whose layout files use JSONC (JSON with
comments). The API returns plain JSON.

### Download a user's layouts

Set `OWNER_ID` to the user's Discord ID, shown in the `owner` field of their
layout records. This example uses `jq` to keep only their layouts from the full
collection, including layout payloads. You need `curl` and `jq` installed.

```sh
OWNER_ID='discord-user-id'
curl --fail "https://api.akldb.org/v1/layouts?format=spark/1&full=1" \
  | jq --arg owner "$OWNER_ID" '.items |= map(select(.owner == $owner))' \
  > user-layouts.json
```

## Edit through the API

Writes need a Discord access token or a registered client. To edit a layout you
own, read it first, then send your change with its current revision in
`If-Match`. See the [API quickstart](docs/adoption.md#0-quickstart) for examples
and authentication details.

## Run locally

Requires Node.js 22+ and npm. CI uses Node.js 24.

The API is a TypeScript service. Locally it runs on DynamoDB Local; no AWS
account or credentials are needed. From the repository root:

```sh
npm ci
npm run dev
```

`npm run dev` starts DynamoDB Local (the `amazon/dynamodb-local` Docker image if
Docker is running, else the jar with Java 21 from `.dev/dynamodb-local`), creates
the tables, seeds them and serves the API at `http://127.0.0.1:18501`. It
registers a dev client whose key is kept in `.dev/client.json`; `.dev/dev.json`
names the running server, client and key (sign requests with
`scripts/client-sign.mjs`). Blobs (dumps) are files under `.dev/blobs`, and a
tick runs every 5 minutes as the Cron Trigger does in production.

Options: `--seed empty` (default) | `fixture` (the 100-layout test seed) | a dump
file; `--port`, `--ddb-port` (0 picks a free port), `--ddb <url>` to use a
DynamoDB Local that is already running, `--dir`, `--tick-ms`.

The Cloudflare path is still there: `npm run migrate` and `npm run dev:d1` run
the Worker on D1 under `wrangler dev` at `http://localhost:8787`. Use `npm test`
and `npm run typecheck` to check changes. For website development, see
[site/README.md](site/README.md).

## Further reading

- [API guide](docs/adoption.md): authentication, reads, writes, and endpoints.
- [Technical reference](docs/technical-reference.md): the previous README in full,
  including deployment, backups, and operations.
- [Spark format specification](docs/decisions/22-spark-spec.md).
- [Original Spark plan and ledger](docs/decisions/20-spark.md).
