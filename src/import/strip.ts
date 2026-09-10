// M1 (LDB-I10, design/layout-db/17-magic-ownership.md §4): a one-time admin
// pass that drops the cmini magic already sitting in records imported
// before LDB-I10/I11 landed -- for every LIVE, upstream-FOLLOWING record
// whose payload still carries magic, writes the payload without it as an
// `imported` rev bump (`detail.reason: "magic_stripped"`), so `/v1/changes`
// consumers (the bot, the site sync) refold. `POST /v1/admin/import/
// strip-cmini-magic` (routes/admin.ts) is the only caller.
//
// A record that has stopped following upstream keeps whatever magic it
// holds untouched: a human edit already took it off cmini's mirror (17
// -magic-ownership.md §3's own rule -- the same one `import/apply.ts`'s
// `applyMapped` applies to a not-following record's content generally),
// so its magic is the owner's now, never this route's to touch.
import type { Bindings } from "../env";
import * as cmini1 from "../../formats/adapters/cmini/index";
import { appendWrite } from "../core/events";
import { nextUpstream, upstreamOf } from "../core/upstream";
import { list, readById } from "../core/records";
import type { Clock } from "../core/time";

const CMINI_FORMAT = "cmini/1";
// Same order as `import/cmini.ts`'s own default `IMPORT_MAX_WRITES_PER_TICK`
// -- one D1 write per stripped record, so a batch this size stays well
// inside a single Worker invocation's budget. A corpus with more than this
// many still-magic-carrying records needs the route called more than
// once (idempotent: a record this call stripped no longer matches the
// `has_magic = 1` filter on the next call).
const BATCH_LIMIT = 500;

async function upstreamIdForLayout(db: Bindings["DB"], layoutId: string): Promise<string | null> {
  const row = await db
    .prepare("SELECT upstream_id FROM import_map WHERE layout_id = ?")
    .bind(layoutId)
    .first<{ upstream_id: string }>();
  return row?.upstream_id ?? null;
}

export interface StripResult {
  stripped: number;
}

// Idempotent: `list()`'s `hasMagic: true` filter only ever matches a record
// this pass hasn't stripped yet -- once every eligible record has been
// (across however many calls the corpus's size needs), a further call
// finds none and answers `{ stripped: 0 }`.
export async function stripCminiMagic(db: Bindings["DB"], now: Clock): Promise<StripResult> {
  const page = await list(db, { format: CMINI_FORMAT, hasMagic: true, sort: "name", limit: BATCH_LIMIT });

  let stripped = 0;
  for (const row of page.items) {
    const record = await readById(db, row.id); // fresh read -- immune to `list()`'s row shape changing independently of this
    if (record === null) continue; // raced away (e.g. deleted) between the scan and here

    // Re-checked per record, live: this scan's `has_magic = 1` filter says
    // nothing about follow status, and a record a human edit has already
    // taken off upstream must be skipped (see header). 20-spark.md S3a:
    // reads the field (else the legacy fallback), not `followsUpstream`.
    const prior = await upstreamOf(db, record);
    if (prior?.state !== "following") continue;

    const payload = record.payload as cmini1.Payload;
    if (!cmini1.hasMagic(payload)) continue; // defensive: has_magic and hasMagic(payload) should never disagree

    const { magic: _magic, ...withoutMagic } = payload;
    const upstreamId = await upstreamIdForLayout(db, row.id);
    await appendWrite(db, now, {
      kind: "imported",
      layoutId: row.id,
      name: record.name,
      owner: record.owner,
      modified_at: record.modified_at,
      format: CMINI_FORMAT,
      payload: withoutMagic,
      actor: "system:cmini-import",
      via: "import:cmini",
      detail: { source: "cmini", upstream_id: upstreamId, reason: "magic_stripped" },
      hasMagic: false,
      upstream: nextUpstream(prior, "imported", "import:cmini"),
      expectRev: record.rev,
    });
    stripped++;
  }

  return { stripped };
}
