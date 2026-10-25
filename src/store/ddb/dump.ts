// DynamoDB implementation of `DumpStore` (src/store/port.ts). Owner: P2 lane K
// (design/p2-p5-briefs.md). The tables come from lane N's consistent export
// (`exportRows`, read after the caller's meta read, so the MF-13 floor holds),
// as the exact D1 row shapes, so the dump bytes are the D1 dump's. A restore
// is lane N's `importRows` over the rows `dumpToRows` derives from the dump.
import type { Dump } from "../../dump/write";
import type { DumpStore } from "../port";
import * as realCodec from "./codec";
import type { D1Row, DdbContext } from "./contracts";

/** The three codec functions the dump needs; tests substitute them. */
export type DumpCodec = Pick<typeof realCodec, "exportRows" | "importRows" | "dumpToRows" | "scanItems" | "batchWrite">;

// Private receipt metadata (`source_message_url`) never enters a WPM snapshot: the D1 pager names these columns.
const WPM_COLUMNS = ["id", "layout_id", "user_id", "wpm", "proof", "submitted_by", "via", "submitted_at", "status", "decided_by", "decided_at", "reason", "notified_at", "review_version"] as const;

function project(rows: readonly D1Row[], columns: readonly string[]): D1Row[] {
  return rows.map((r) => Object.fromEntries(columns.map((c) => [c, r[c] === undefined ? null : r[c]])));
}

export function ddbDumpStore(ctx: DdbContext, codec: DumpCodec = realCodec): DumpStore {
  return {
    async tables() {
      const rows = await codec.exportRows(ctx);
      const t = <T>(name: keyof typeof rows): T[] => (rows[name] ?? []) as unknown as T[];
      return {
        records: t("layouts"),
        layout_formats: t("layout_formats"),
        layout_revs: t("layout_revs"),
        likes: t("likes"),
        authors: t("authors"),
        admins: t("admins"),
        events: t("events"),
        import_state: t("import_state"),
        import_map: t("import_map"),
        clients: t("clients"),
        bans: t("bans"),
        link_submissions: t("link_submissions"),
        wpm_submissions: project(rows.wpm_submissions ?? [], WPM_COLUMNS) as unknown as Dump["wpm_submissions"],
        layout_comments: t("layout_comments"),
        comment_likes: t("comment_likes"),
      };
    },

    // D1's restore deletes every table first (private Discord rows, auth cache and nonces included) and loads the
    // dump; the import below is for an empty store, so the same wipe comes first. Bookkeeping items (STATE/migrations,
    // STATE/cutover) are not rows and stay.
    async restore(dump: Dump) {
      await codec.importRows(ctx, codec.dumpToRows(dump), { replace: true }); // restoreSql replaces state: wipe, then insert
    },
  };
}
