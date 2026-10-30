// [LDB-DDB100]..[LDB-DDB106] The DynamoDB DiscordUserStore reproduces src/store/d1/discord-users.ts:
// version bumps (migrations/0036's triggers), missingWpmUsers, and the name resolution of the WPM reads.
import { describe, expect, it } from "vitest";
import { ddbDiscordUserStore, resolveTypistName, trimSpaces } from "../../src/store/ddb/discord-users";
import { authSchema } from "../../src/store/ddb/schema/auth";
import { ddbModqueueStore } from "../../src/store/ddb/modqueue";
import { exportRows } from "../../src/store/ddb/codec";
import { AT, ctx, id, putItems, seedLayout, seedRows, wpm } from "./community-support";

const du = ddbDiscordUserStore(ctx);
const T1 = "2026-10-26T00:00:00.000Z";
const T2 = "2026-10-26T01:00:00.000Z";

const sub = (layoutId: string, userId: string, status: string, over: Record<string, unknown> = {}) => ({
  id: id(), layout_id: layoutId, user_id: userId, wpm: 100, proof: "https://example.org/p", submitted_by: userId, via: "discord", submitted_at: AT,
  status, decided_by: null, decided_at: status === "approved" ? AT : null, reason: null, notified_at: null, review_version: 0, source_message_url: null, ...over,
});
const putAuthor = (user_id: string, name: string) =>
  putItems(authSchema.toItems({ authors: [{ user_id, name, first_seen_at: AT, last_seen_at: AT, name_source: "user" }] }).main);

describe("[LDB-DDB100] discord users", () => {
  it("[LDB-DDB100] version is 0 with no head item, get is null for an unknown id", async () => {
    expect(await du.version()).toBe(0);
    expect(await du.get("nobody")).toBeNull();
  });

  it("[LDB-DDB101] the version moves on insert and on a real change only; updated_at always moves; null <-> value counts", async () => {
    await du.upsert({ id: "u1", username: "alice", globalName: null, at: T1 });
    expect(await du.version()).toBe(1);
    expect(await du.get("u1")).toEqual({ id: "u1", username: "alice", global_name: null, updated_at: T1 });
    await du.upsert({ id: "u1", username: "alice", globalName: null, at: T2 }); // same names: freshness only
    expect(await du.version()).toBe(1);
    expect(await du.get("u1")).toMatchObject({ updated_at: T2 });
    await du.upsert({ id: "u1", username: "alice", globalName: "Alice", at: T2 }); // null -> value
    expect(await du.version()).toBe(2);
    await du.upsert({ id: "u1", username: "alice", globalName: "Alice", at: T1 }); // same again
    expect(await du.version()).toBe(2);
    await du.upsert({ id: "u1", username: "alicia", globalName: "Alice", at: T2 }); // username
    expect(await du.version()).toBe(3);
    await du.upsert({ id: "u1", username: "alicia", globalName: null, at: T2 }); // value -> null
    expect(await du.version()).toBe(4);
    expect(await du.get("u1")).toEqual({ id: "u1", username: "alicia", global_name: null, updated_at: T2 });
    await du.upsert({ id: "u2", username: "bob", globalName: "Bob", at: T1 }); // another insert
    expect(await du.version()).toBe(5);
  });

  it("[LDB-DDB102] concurrent identical upserts bump the version once per real change", async () => {
    await Promise.all([1, 2, 3, 4].map(() => du.upsert({ id: "race", username: "r", globalName: "R", at: T1 })));
    expect(await du.get("race")).toMatchObject({ username: "r", global_name: "R" });
    const v = await du.version();
    await Promise.all([1, 2, 3].map(() => du.upsert({ id: "race", username: "r", globalName: "R", at: T2 })));
    expect(await du.version()).toBe(v);
  });

  it("[LDB-DDB103] missingWpmUsers: pending/approved/rejected typists with no row and no usable author name, by id, limit and total", async () => {
    const l = await seedLayout();
    const ids = ["m5", "m1", "m3", "m2", "m4", "m6", "m7", "m8", "mZ", "mé"];
    // m1 blank author name, m2 author name == id, m3 real author name, m4 a discord row, m5 no author,
    // m6 only a superseded row, m7 spaces-only name, m8 tab-only name (SQLite TRIM keeps tabs: usable), mZ rejected
    await seedRows({
      wpm_submissions: [
        sub(l.id, "m5", "pending"), sub(l.id, "m1", "approved"), sub(l.id, "m3", "pending"), sub(l.id, "m2", "rejected"), sub(l.id, "m4", "pending"),
        sub(l.id, "m6", "superseded"), sub(l.id, "m7", "pending"), sub(l.id, "m8", "pending"), sub(l.id, "mZ", "rejected"), sub(l.id, "mé", "approved"),
      ],
    });
    await putAuthor("m1", "");
    await putAuthor("m2", "m2");
    await putAuthor("m3", "Real Name");
    await putAuthor("m7", "   ");
    await putAuthor("m8", "\t");
    await du.upsert({ id: "m4", username: "m4user", globalName: null, at: T1 });
    expect(await du.missingWpmUsers(50)).toEqual({ ids: ["m1", "m2", "m5", "m7", "mZ", "mé"], total: 6 });
    expect(await du.missingWpmUsers(2)).toEqual({ ids: ["m1", "m2"], total: 6 });
    expect(await du.missingWpmUsers(0)).toEqual({ ids: [], total: 6 });
    await du.upsert({ id: "m1", username: "m1user", globalName: null, at: T1 });
    expect((await du.missingWpmUsers(3)).ids).toEqual(["m2", "m5", "m7"]);
  });

  it("[LDB-DDB104] name resolution: authors.name unless blank/id, then trimmed global_name, then trimmed username, else null", () => {
    expect(trimSpaces("  x \t")).toBe("x \t");
    expect(resolveTypistName("u", " Real ", { username: "n", global_name: "g" })).toBe(" Real ");
    expect(resolveTypistName("u", "u", { username: "n", global_name: " G " })).toBe("G");
    expect(resolveTypistName("u", "   ", { username: " n ", global_name: "  " })).toBe("n");
    expect(resolveTypistName("u", null, { username: "n", global_name: null })).toBe("n");
    expect(resolveTypistName("u", "", { username: "   ", global_name: "" })).toBeNull();
    expect(resolveTypistName("u", "u", undefined)).toBeNull();
    expect(resolveTypistName("u", "\t", undefined)).toBe("\t");
  });

  it("[LDB-DDB105] the WPM queue, records and mod-queue candidates read the resolved name", async () => {
    const l = await seedLayout({ name: "Resolved Names" });
    const mk = (user: string, status: string) => sub(l.id, user, status);
    const rows = [mk("r1", "approved"), mk("r2", "approved"), mk("r3", "approved"), mk("r4", "approved"), mk("r5", "approved")];
    await seedRows({ wpm_submissions: rows });
    await putAuthor("r1", "Author One");
    await putAuthor("r2", "r2"); // id-equal: falls through
    await putAuthor("r3", "   "); // blank: falls through
    await du.upsert({ id: "r1", username: "u1", globalName: "G1", at: T1 });
    await du.upsert({ id: "r2", username: "u2", globalName: " G2 ", at: T1 });
    await du.upsert({ id: "r3", username: " u3 ", globalName: null, at: T1 });
    const got = new Map((await wpm.records({ layoutId: l.id })).map((r) => [r.user_id, r.user_name]));
    expect(got).toEqual(new Map([["r1", "Author One"], ["r2", "G2"], ["r3", "u3"], ["r4", null], ["r5", null]]));
    const q = new Map((await wpm.queue("approved")).filter((r) => r.layout_id === l.id).map((r) => [r.user_id, r.user_name]));
    expect(q).toEqual(got);
    const pend = sub(l.id, "r2", "pending", { submitted_at: "2026-10-26T02:00:00.000Z" });
    await seedRows({ wpm_submissions: [pend] });
    const cands = await ddbModqueueStore(ctx).wpmCandidates(50);
    expect(cands.find((c) => c.id === pend.id)?.user_name).toBe("G2");
  });

  it("[LDB-DDB106] the two tables round-trip through export and import, and an empty store reads the seeded head", async () => {
    const rows = await exportRows(ctx);
    expect(rows.discord_users_head).toEqual([{ id: 1, version: await du.version() }]);
    expect(rows.discord_users!.map((r) => r.id)).toContain("u1");
    expect(rows.discord_users!.find((r) => r.id === "r3")).toEqual({ id: "r3", username: " u3 ", global_name: null, updated_at: T1 });
  });
});
