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

The API is a TypeScript Cloudflare Worker using D1 and R2. From the repository
root:

```sh
npm ci
npm run migrate
npm run dev
```

The local API runs at `http://localhost:8787`. Use `npm test` and
`npm run typecheck` to check changes. For website development, see
[site/README.md](site/README.md).

## Further reading

- [API guide](docs/adoption.md): authentication, reads, writes, and endpoints.
- [Technical reference](docs/technical-reference.md): the previous README in full,
  including deployment, backups, and operations.
- [Spark format specification](docs/decisions/22-spark-spec.md).
- [Original Spark plan and ledger](docs/decisions/20-spark.md).
