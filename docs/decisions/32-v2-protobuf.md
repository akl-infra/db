# 32. `/v2`: protobuf

Status: design, for saltorbit's sign-off (2026-10-28). Not implemented. Draft schema:
`proto/akldb/v2/layout.proto`.

**Why.** API 1.29 added skip magic inside `spark/1` (a new magic default kind, array `after`,
chiral `skip: true`). Readers that validated the closed 1.28 shapes, as our spec told them to,
rejected it; emulayout's catalog has been stuck since 2026-10-21. JSON plus JSON Schema gave us
no tooling that sees a breaking change, and closed value sets that every addition breaks.
Protobuf brings rules that make the safe change the default, and `buf breaking` to enforce them.

## Decisions taken (saltorbit 2026-10-28)

- **`/v2` registers beside `/v1`.** `/v1` stays frozen at the 1.28 spark/1 shape and is kept
  indefinitely. New features land in `/v2` only. Skip magic is withheld from `/v1` reads unless
  the client sends `features=skip` (branch `feat/v1-withhold-skip`).
- **The schema is `.proto`,** in this repo under `proto/akldb/v2/`.
- **Two wire encodings, picked by `Accept`:** `application/x-protobuf` (binary) and
  `application/json` (protobuf's standard JSON mapping, the default). Writes take the same two by
  `Content-Type`.

## Design

**Storage doesn't change.** The stored spark rows already hold everything `/v2` carries,
skip magic included. `/v2` maps stored rows to messages on read and back on write, in the
Worker, the way `mana2/1` is derived today. A `/v1` read and a `/v2` read of the same layout come
from the same row.

**Evolution rules** (the header of `layout.proto`):
1. Never reuse or renumber a field; removed fields are `reserved`.
2. A new behaviour is a new field, oneof member or enum value, chosen so that a reader that
   doesn't know it still reads the rest of the layout correctly: it sees less, never something
   wrong.
3. A new meaning gets its own message, never a flag on an existing one. Skip chiral keys are
   `SkipChiralKey` in their own list, so an old reader sees no chiral key, not a wrong one.
4. When 3 is impossible, the layout lists the feature in `required_features`, and a reader that
   doesn't know it skips the layout.

**Reader obligations** (`/v2` docs and our generated readers):
- Unknown fields are ignored. Binary protobuf does this by itself. JSON parsers must be set to
  ignore unknown fields (`ignoreUnknownFields` in protobuf-es, `DiscardUnknown` in Go); most
  default to strict.
- An unknown enum value, or a oneof with no member the reader knows, drops the smallest item
  that holds it (that rule, that default, that key).
- A layout whose `required_features` includes one the reader doesn't know is skipped.
- A reader that dropped anything says so to its user, and changes the layout with `PATCH`, never
  `PUT`.

**Writer obligations (the server).** Writes stay strictly validated: unknown fields, unknown
enum values and unset required oneofs are refused, with the same error codes as `/v1`. Being
strict on writes and tolerant on reads is the point.

**Shape changes from spark/1** (all one-to-one with stored data):
- Tagged unions become `oneof`: `MagicDefault {repeat | char | skip_repeat}`,
  `ChiralValue {repeat | char}`, `MagicKeyRule.context {after | after_skip}`.
- `after: ["h", "e"]` (which means `"he"`) is always sent as `after: "he"`; `["h", null]` is
  `after_skip: "h"`.
- Chiral `skip: true` keys move to `Magic.skip_chiral_keys`.
- `alts[].{ngram, fingers}` parallel arrays become `positions[] {char?, finger}`.
- Fingers are an enum (`FINGER_LP` …). JSON field names stay snake_case (proto names, not
  lowerCamel), so the JSON looks like `/v1`'s.

**Routes.** `/v2` starts with layouts and meta: `GET /v2/layouts` (`ListLayoutsResponse`),
`GET /v2/layouts/{ref}`, `POST`/`PUT`/`PATCH /v2/layouts/{ref}`, `GET /v2/meta`, and `GET
/v2/schema` (the descriptor set). Everything else (likes, authors, comments, WPM, moderation,
dump, changes) stays on `/v1` and moves to `/v2` only when it next changes shape. ETag,
`If-Match`, auth and rate limits behave exactly as on `/v1`.

**Tooling.**
- `buf lint` and `buf breaking` in CI: against `origin/main` on every PR, and against the last
  released tag on deploy.
- Generated code: protobuf-es (TypeScript: akldb Worker, akl.gg, the bot) and prost (Rust: the
  engine, if it ever reads akldb directly). Generated code is checked in for now (no codegen step
  in the bot's image).
- Conformance: for every spark/1 fixture and parity vector, stored row → `/v2` message → stored
  row is the identity, and `/v2` JSON ↔ binary round-trips.
- The reader test from the `/v1` work carries over: drop every field and member a reader built
  from the previous release's `.proto` doesn't know; the compiled magic rows must be a subset of
  the full layout's.

## Order

1. Sign-off on this doc and `layout.proto`.
2. akldb serves `/v2` reads (conformance tests + buf in CI).
3. `/v2` writes.
4. akl.gg, the bot and the data pipeline move to `/v2`; the `features=skip` opt-in goes unused.
5. Tell emulayout and other `/v1` clients that `/v2` exists. `/v1` stays.

## Open questions

- **Route scope.** Only layouts and meta at first (above), or the whole `/v1` surface at once?
  Recommend layouts and meta.
- **Pagination.** `/v1`'s `full=1` list is one ~8 MB response. `/v2` could page it
  (`next_cursor`), but a client that wants everything then needs many requests. Recommend paging
  with a large page size, plus the dump for bulk.
- **mana2.** `/v2` carries the spark payload only; `mana2/1` stays a `/v1` derived format.
  Recommend yes.
