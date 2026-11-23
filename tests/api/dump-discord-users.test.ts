// [LDB-D10] `discord_users` (migrations/0036) is in the public dump and its
// restore with the least exposure: rows of typists with an approved WPM record
// and a display name, `id`/`global_name` only (never `username`, never
// `updated_at`). A restore writes `username` '' and `updated_at` the epoch (due
// a refresh, LDB-WPM18), so `/v1/wpm` shows the same display names after a
// rehost; a typist with no display name has no row and stays "missing" for the
// admin backfill (LDB-WPM20).
import { env, store, testStore } from "../harness";
import { describe, expect, it } from "vitest";
import { ulid } from "ulidx";
import type { Bindings } from "../../src/env";
import { commitWrite, type CommitInput } from "../../src/core/events";
import { fixedClock } from "../../src/core/time";
import { buildDumpChecked, type Dump } from "../../src/dump/write";
import { restoreInto, restoreSql } from "../../src/dump/restore";
import { RESTORED_NAME_AT, RESTORED_USERNAME } from "../../src/store/d1/dump";
import { AKL_PAYLOAD, pinTestClock, uniqueName, writeFetch } from "./write-support";

const bindings = env as unknown as Bindings;
const clock = fixedClock("2026-11-23T00:00:00.000Z");
pinTestClock(env as unknown as { TEST_CLOCK?: typeof clock }, clock);

const APPROVED = "35000000000000000001"; // approved record, no authors row: /v1/wpm names them from discord_users
const APPROVED_PLAIN = "35000000000000000002"; // approved record, no display name: the username is the shown name
const PENDING = "35000000000000000003"; // only a pending submission: not public
const STRANGER = "35000000000000000004"; // no WPM submission at all

async function createLayout(owner: string): Promise<string> {
  const input: CommitInput = {
    layoutId: ulid(), creating: true, currentN: 0, currentLayout: null, currentFormats: new Map(),
    layout: { kind: "created", name: uniqueName("dump-discord-users"), owner, created_at: clock(), deleted: false },
    format: { kind: "format_added", lineage: "spark", format: "spark/1", payload: AKL_PAYLOAD, hasMagic: false },
    modified_at: clock(), actor: owner, via: "discord", source: { client: "discord-app:test", version: null }, upstream: null,
  };
  return (await commitWrite(store, clock, input)).layout.id;
}

async function plant(): Promise<string> {
  const layoutId = await createLayout("35000000000000000009");
  const sub = (user: string, status: string, wpm: number) =>
    testStore.insert("wpm_submissions", { id: ulid(), layout_id: layoutId, user_id: user, wpm, proof: `https://example.org/d10-${user}`, submitted_by: user, via: "discord", submitted_at: clock(), status, decided_by: status === "pending" ? null : "800000000000000001", decided_at: status === "pending" ? null : clock(), reason: null, notified_at: null });
  await sub(APPROVED, "approved", 120);
  await sub(APPROVED_PLAIN, "approved", 95);
  await sub(PENDING, "pending", 140);
  const user = (id: string, username: string, global_name: string | null) =>
    testStore.insert("discord_users", { id, username, global_name, updated_at: "2026-11-20T10:00:00.000Z" });
  await user(APPROVED, "d10approved", "D10 Approved");
  await user(APPROVED_PLAIN, "d10plain", null);
  await user(PENDING, "d10pending", "D10 Pending");
  await user(STRANGER, "d10stranger", null);
  return layoutId;
}

async function wpmNames(layoutId: string): Promise<Record<string, string | null>> {
  const res = await writeFetch(`/v1/wpm?layout=${layoutId}`, "GET");
  expect(res.status).toBe(200);
  const { records } = (await res.json()) as { records: { user_id: string; user_name: string | null }[] };
  return Object.fromEntries(records.map((r) => [r.user_id, r.user_name]));
}

describe("[LDB-D10] discord_users in the public dump and its restore", () => {
  it("[LDB-D10] dumps only approved typists' display names (no username), restores them, and /v1/wpm shows the same display names", async () => {
    const layoutId = await plant();
    const before = await wpmNames(layoutId);
    expect(before).toEqual({ [APPROVED]: "D10 Approved", [APPROVED_PLAIN]: "d10plain" });

    const { dump } = await buildDumpChecked(bindings, clock, store);
    const mine = dump.discord_users.filter((u) => u.id.startsWith("3500000000000000000"));
    expect(mine).toEqual([{ id: APPROVED, global_name: "D10 Approved" }]); // APPROVED_PLAIN has no display name: no row
    const text = JSON.stringify(dump);
    for (const secret of ["d10approved", "d10plain", "d10pending", "D10 Pending", "d10stranger", PENDING, STRANGER, "2026-11-20T10:00:00.000Z", '"username"']) expect(text.includes(secret), secret).toBe(false);
    // every dumped row belongs to a dumped (approved) typist
    const typists = new Set(dump.wpm_submissions.map((s) => s.user_id));
    expect(dump.discord_users.every((u) => typists.has(u.id))).toBe(true);

    await restoreInto(store, dump);
    const rows = await testStore.rows<{ id: string; username: string; global_name: string | null; updated_at: string }>("discord_users", {}, ["id"]);
    expect(rows.map((r) => ({ id: r.id, global_name: r.global_name }))).toEqual(dump.discord_users);
    expect(rows.every((r) => r.username === RESTORED_USERNAME && r.updated_at === RESTORED_NAME_AT)).toBe(true);
    // the display name is back; a typist named only by their username is unnamed until their next submit or the backfill
    expect(await wpmNames(layoutId)).toEqual({ [APPROVED]: "D10 Approved", [APPROVED_PLAIN]: null });

    const missing = await store.discordUsers.missingWpmUsers(50);
    expect(missing.ids).toContain(APPROVED_PLAIN); // the backfill can still find them
    expect(missing.ids).not.toContain(APPROVED);

    // restore -> dump is a fixed point over the dumped set
    const { dump: again } = await buildDumpChecked(bindings, clock, store);
    expect(again.discord_users).toEqual(dump.discord_users);
  });

  it("[LDB-D10] a dump from before this change (no discord_users key) restores with the table cleared, nothing inserted", () => {
    const sample: Dump["discord_users"] = [{ id: APPROVED, global_name: "G'q" }];
    const full = { meta: { authors_version: 0, authors_modified_at: null }, records: [], layout_formats: [], layout_revs: [], likes: [], authors: [], admins: [], events: [], import_state: [], import_map: [], clients: [], bans: [], link_submissions: [], wpm_submissions: [], layout_comments: [], comment_likes: [], discord_users: sample } as unknown as Dump;
    const { discord_users: _gone, ...older } = full;
    const oldStatements = restoreSql(older as unknown as Dump);
    expect(oldStatements).toContain("DELETE FROM discord_users");
    expect(oldStatements.some((q) => q.startsWith("INSERT INTO discord_users"))).toBe(false);
    const newStatements = restoreSql(full);
    expect(newStatements.filter((q) => q.startsWith("INSERT INTO discord_users"))).toEqual([
      `INSERT INTO discord_users (id, username, global_name, updated_at) VALUES ('${APPROVED}','','G''q','${RESTORED_NAME_AT}')`,
    ]);
  });
});
