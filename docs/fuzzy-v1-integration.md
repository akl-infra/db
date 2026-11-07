# Ordinary v1 fuzzy-fingermap extension

Branch `codex/akldb-v1-fuzzy`, based on `origin/main` `6e744bf`.
No protobuf dependency, `/v2`, query feature flag, schema migration, deployment
or production data rewrite. API minor/wire cache epoch becomes 1.36/36.

## Contract

`keys[].finger` is the default. Each unary `{ngram:[key],fingers:[finger]}`
adds one allowed finger. A key may appear multiple times with distinct fingers.
Both thumb codes and other-hand fingers are valid. Exact unary duplicates are
rejected. Multi-gram duplicate and wildcard rules stay unchanged.

Every v1 payload surface uses the existing serialization: paginated metadata,
full catalog, detail, historical revision, writes, stale409, change-feed flags,
and dump/backups. Nothing is hidden. No request/header/cache variants are added;
the normal wire-version bump invalidates pre-change cache bodies.

## Compatibility and client handoff

This expands the accepted language; it is not compatible with every strict old
validator. Readers must accept ngram length 1 and preserve distinct same-key
unary entries. Writers must not deduplicate by ngram alone, and must retain the
default key finger separately. Existing optimistic concurrency does not protect
against a writer deliberately replacing a payload after dropping unknown data.
PATCH of unrelated fields preserves alternatives; PUT retains replacement semantics.

The local aklgg integration already supports unary and repeated alternatives.
The parent task is auditing other first-party readers/writers and Sparkbot;
that work is a separate integration prerequisite before release. No deployment
is performed by this branch. Current public Emulayout master
`0290f702691cdca4dd5f8693a82ce4346914f029` accepts and preserves these fields
but does not analyze their alternative-finger semantics, according to the
separate executable validator/catalog/compiler probe. Its live deployed commit
was not verified. Mana2 projection continues to omit all alts as documented.

## Local verification

`npm run build:validators` regenerates the two Spark validators.
`npm run typecheck` checks the complete tree.
`npm test -- --project node tests/formats tests/contract/contract.test.ts`
`npm test -- --project shim tests/api/fuzzy.test.ts tests/api/alts-combos.test.ts tests/api/conformance.test.ts tests/api/write.test.ts tests/api/dump.test.ts`

The new API fixture writes and reads a default plus three alternatives, including
RT, through ordinary v1 requests, checks unrelated PATCH, stale409, PUT, catalog,
revision, schema, feed flags, stored backup and historical backup preservation.
Existing local DB4221 and all Claude preview servers are untouched. To integrate,
build/run this branch using the existing local DB launcher on an isolated port,
then point the local website proxy at it; no query-parameter changes are needed.

Worker-runtime verification also passed: `WRANGLER_LOG_PATH=/tmp/akldb-v1-fuzzy-wrangler.log npm test -- --project workers tests/api/fuzzy.test.ts`. Loopback binding requires the local test sandbox permission; no persistent service is started.
