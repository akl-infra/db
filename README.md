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

## Changing the format or API

[emulayout](https://github.com/emulayout/emulayout.github.io), an external project, syncs the whole catalog
through a strict reader, so a new shape in `spark/1` or the API can stop its sync without anyone here noticing
(API 1.29's skip magic did, for three weeks). Before any change to a format, a payload shape or the `/v1` wire:

1. Run `npm run check:emulayout` (add `-- --live` to also read the live catalog). It runs emulayout's current
   `master` reader over `tests/emulayout/corpus/` and the frozen fixtures and lists what it accepts, drops or
   rejects. Needs [bun](https://bun.sh) and `git`.
2. Add a corpus record for every new shape (`tests/emulayout/corpus/NN-name.json`: a bare `spark/1` payload, or
   `{"name", "owner", "link", "likes", "payload"}`). `npm test` checks that akldb itself accepts every record
   and that the corpus still covers every feature.
3. If emulayout would reject the shape, write a heads-up note for its maintainer (what changes, the exact rules,
   what a reader must do, how to check their client, and that unknown values are to be dropped, never fatal) and
   hold the deploy until they ship. CI's `emulayout-compat` job blocks the deploy until the reader accepts the
   corpus. If emulayout's `master` is broken independently of the change, the job says so and fails; the repo
   variable `EMULAYOUT_KNOWN_BROKEN_SHA` (that exact emulayout commit) lets it pass, loudly, until they fix it.

## Further reading

- [API guide](docs/adoption.md): authentication, reads, writes, and endpoints.
- [Technical reference](docs/technical-reference.md): the previous README in full,
  including deployment, backups, and operations.
- [Spark format specification](docs/decisions/22-spark-spec.md).
- [Original Spark plan and ledger](docs/decisions/20-spark.md).
