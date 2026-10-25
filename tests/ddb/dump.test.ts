// [LDB-DDB64..DDB65] The DynamoDB DumpStore (lane K): the dump's tables are the consistent export in the exact D1 row
// shapes (private WPM columns left out), and a restore is lane N's bulk import of the rows the dump implies.
// The first block runs on a stand-in codec and needs nothing of lane N; the second round-trips a real dump through
// lane N's codec and is skipped, with its reason, until that is merged (the main session removes the skip then).
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { Dump } from "../../src/dump/write";
import * as realCodec from "../../src/store/ddb/codec";
import type { D1Row, RowsByTable } from "../../src/store/ddb/contracts";
import { ddbDumpStore, type DumpCodec } from "../../src/store/ddb/dump";
import { SCHEMAS } from "../../src/store/ddb/schema";
import { ddbHarness } from "../harness/ddb";

const ctx = { ...ddbHarness.ctxBase, catalog: undefined as never };

describe("dump tables and restore (stand-in codec)", () => {
  const rows: RowsByTable = {
    layouts: [{ id: "L1", name: "one" }],
    layout_formats: [{ layout_id: "L1", lineage: "spark/1" }],
    layout_revs: [{ layout_id: "L1", n: 1 }],
    likes: [{ layout_id: "L1", user_id: "u" }],
    authors: [{ user_id: "u", name: "U" }],
    admins: [{ user_id: "u" }],
    events: [{ seq: 1 }],
    import_state: [{ key: "k", value: "v" }],
    import_map: [{ upstream_id: "x", layout_id: "L1" }],
    clients: [{ id: "c" }],
    bans: [{ user_id: "b" }],
    link_submissions: [{ id: "k1", notified_at: "2026-10-25T00:00:00.000Z" }],
    wpm_submissions: [
      { id: "w1", layout_id: "L1", user_id: "u", wpm: 80, proof: "p", submitted_by: "u", via: "discord", submitted_at: "t", status: "approved", decided_by: null, decided_at: null, reason: null, notified_at: null, review_version: 1, source_message_url: "https://discord.com/private" },
    ],
    layout_comments: [{ id: "c1" }],
    comment_likes: [{ layout_id: "L1", author_id: "a", user_id: "u" }],
    modqueue_notifications: [{ kind: "link", submission_id: "x" }], // private: never in a dump
    layouts_head: [{ id: 1, live: 1 }],
  };
  const calls: string[] = [];
  const stand: DumpCodec = {
    async exportRows() {
      calls.push("export");
      return rows;
    },
    async importRows(_ctx, r) {
      calls.push("import");
      imported = r;
    },
    async scanItems() {
      calls.push("scan");
      return { main: [{ pk: "OLD", sk: "x" }], ephemeral: [] };
    },
    async batchWrite(_ctx, table, requests) {
      calls.push(`wipe ${table.length > 0 ? requests.length : 0}`);
    },
    dumpToRows(d) {
      calls.push("dumpToRows");
      return { layouts: d.records as unknown as D1Row[] };
    },
  };
  let imported: RowsByTable | undefined;

  it("[LDB-DDB64] tables() hands back exactly the dumped tables, WPM without its private receipt column", async () => {
    const t = await ddbDumpStore(ctx, stand).tables();
    expect(Object.keys(t).sort()).toEqual(
      ["admins", "authors", "bans", "clients", "comment_likes", "events", "import_map", "import_state", "layout_comments", "layout_formats", "layout_revs", "layout_comments", "likes", "link_submissions", "records", "wpm_submissions"].filter((k, i, a) => a.indexOf(k) === i).sort(),
    );
    expect(t.records).toEqual(rows.layouts);
    expect(t.link_submissions).toEqual(rows.link_submissions);
    expect(t.wpm_submissions).toEqual([
      { id: "w1", layout_id: "L1", user_id: "u", wpm: 80, proof: "p", submitted_by: "u", via: "discord", submitted_at: "t", status: "approved", decided_by: null, decided_at: null, reason: null, notified_at: null, review_version: 1 },
    ]);
    expect(JSON.stringify(t)).not.toContain("discord.com/private");
    expect(calls).toEqual(["export"]);
  });

  it("[LDB-DDB64] restore wipes the store and imports the rows the dump implies", async () => {
    calls.length = 0;
    await ddbDumpStore(ctx, stand).restore({ records: [{ id: "L9" }] } as unknown as Dump);
    expect(calls).toEqual(["dumpToRows", "scan", "wipe 1", "wipe 0", "import"]);
    expect(imported).toEqual({ layouts: [{ id: "L9" }] });
  });
});

// Ready once lane N's codec and all four lanes' schemas exist: the stub, and a schema still throwing "not implemented yet", mean not.
const codecReady = await Promise.resolve()
  .then(async () => {
    await realCodec.exportRows(ctx);
    for (const schema of SCHEMAS) schema.toItems({});
  })
  .then(() => true, () => false);

describe.skipIf(!codecReady)(`dump round trip through lane N's codec${codecReady ? "" : ": skipped, lane N's codec or another lane's schema is not merged"}`, () => {
  it("[LDB-DDB65] restoring a dump and dumping again returns the same tables", async () => {
    const dump = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "..", "fixtures", "seed-upstream-100.dump.json"), "utf8")) as Dump;
    const store = ddbDumpStore(ctx);
    await store.restore(dump);
    const got = await store.tables();
    const { version: _v, date: _d, meta: _m, auth_cache: _a, ...want } = dump;
    void _v; void _d; void _m; void _a;
    for (const key of Object.keys(want) as (keyof typeof want)[]) expect(got[key], key).toEqual(want[key] ?? []);
  });
});
