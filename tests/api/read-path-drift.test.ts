// [LDB-CV25] What a safe-method request writes. During the cutover freeze (cutover.mode=read_only) writes are refused and the jobs are stopped, but
// a GET still bookkeeps: a signed client's GET inserts a nonce and upserts its author, a Discord-bearer GET fills auth_cache and upserts the author
// (moving authors_head), and so on. The live D1 therefore drifts between `export` and `verify` while Spark polls. This test runs anonymous, signed
// and bearer GETs (and an admin of each lane) over EVERY GET route, snapshots every table before and after, and pins the tables and columns that
// changed: the DRIFT SET scripts/cutover/drift.mjs tolerates. A read-path write that is not in the set fails here, so it cannot reach a cutover.
import { SELF, env, testStore, type Row, type TableName } from "../harness";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { app } from "../../src/index";
import { seedUpstream100 } from "./support";
import { generateKeyPair, seedClient, signHeaders } from "../auth/client-support";
import { FakeDiscord } from "../auth/fake-discord";
import { fixedClock } from "../../src/core/time";
// @ts-expect-error -- plain script, no declaration file
import { DRIFT_SET, describeDrift, mergeSummaries, summarizeDrift } from "../../scripts/cutover/drift.mjs";

const TABLES: TableName[] = [
  "layouts", "layout_formats", "layout_revs", "likes", "events", "authors", "authors_head", "discord_users", "discord_users_head", "layouts_head", "admins", "bans", "clients",
  "nonces", "auth_cache", "ratelimit", "idempotency", "import_state", "import_map", "link_submissions", "wpm_submissions", "layout_comments", "comment_likes",
  "moderation_review_history", "modqueue_notifications", "modqueue_delivery_gate", "discord_pending_actions", "discord_reopen_actions", "discord_deny_modals",
  "discord_reopen_confirmations", "discord_rejection_dm_outbox",
];

type Snapshot = Record<string, Row[]>;
async function snapshot(): Promise<Snapshot> {
  const out: Snapshot = {};
  for (const t of TABLES) out[t] = await testStore.rows(t);
  return out;
}

const ADMIN = "184412255822020608"; // migrations/0001's bootstrap admin
const NOW = fixedClock("2026-11-04T09:00:00.000Z");

/** Every GET route the app mounts, as templates; the test below fires each with sample parameters and fails when one is not listed here. */
function getTemplates(): string[] {
  return [...new Set(app.routes.filter((r: { method: string }) => r.method === "GET").map((r: { path: string }) => r.path))].sort() as string[];
}

describe("what safe-method requests write (CV25)", () => {
  let layoutId = "";
  let layoutName = "";
  let authorId = "";
  const fake = new FakeDiscord();
  let signer: { privateKey: CryptoKey; clientId: string };

  beforeAll(async () => {
    await seedUpstream100();
    const layout = (await testStore.rows("layouts"))[0]!;
    layoutId = String(layout.id);
    layoutName = String(layout.name);
    authorId = String((await testStore.rows("authors"))[0]!.user_id);
    const kp = await generateKeyPair();
    await seedClient(NOW, { id: "drift-client", pubkeyB64url: kp.pubkeyB64url, ownerUserId: authorId, caps: "act-as-user,feed:wait" });
    await seedClient(NOW, { id: "drift-admin-client", pubkeyB64url: kp.pubkeyB64url, ownerUserId: ADMIN, caps: "act-as-user" });
    signer = { privateKey: kp.privateKey, clientId: "drift-client" };
  });

  afterEach(() => vi.unstubAllGlobals());

  /** Sample paths for every GET template (query strings included where a route needs one). */
  function samples(): Record<string, string> {
    return {
      "/v1/meta": "/v1/meta",
      "/v1/me": "/v1/me",
      "/v1/layouts": "/v1/layouts?format=spark/1&limit=5",
      "/v1/layouts/:ref": `/v1/layouts/${layoutId}?format=spark/1`,
      "/v1/layouts/:ref/likes": `/v1/layouts/${layoutId}/likes`,
      "/v1/layouts/:ref/history": `/v1/layouts/${layoutId}/history`,
      "/v1/layouts/:ref/rev/:n": `/v1/layouts/${layoutId}/rev/1?format=spark/1`,
      "/v1/layouts/:ref/link": `/v1/layouts/${layoutId}/link`,
      "/v1/layouts/:ref/comments": `/v1/layouts/${layoutId}/comments`,
      "/v1/layouts/:ref/comment": `/v1/layouts/${layoutId}/comment`,
      "/v1/comment-counts": "/v1/comment-counts",
      "/v1/comments": `/v1/comments?ids=${layoutId}`,
      "/v1/me/comments": "/v1/me/comments",
      "/v1/me/comment-likes": "/v1/me/comment-likes",
      "/v1/wpm": "/v1/wpm",
      "/v1/wpm/submissions/:id": "/v1/wpm/submissions/1",
      "/v1/authors": "/v1/authors",
      "/v1/authors/:user_id": `/v1/authors/${authorId}`,
      "/v1/formats": "/v1/formats",
      "/v1/formats/:name/:major/schema.json": "/v1/formats/spark/1/schema.json",
      "/v1/changes": "/v1/changes?since=0&limit=5",
      "/admin/changelog": "/admin/changelog",
      "/v1/dump": "/v1/dump",
      "/v1/dump/latest.json": "/v1/dump/latest.json",
      "/v1/dump/monthly/:key": "/v1/dump/monthly/dump-2026-10.json.gz",
      "/v1/dump/:key": "/v1/dump/dump-2026-11-01.json.gz",
      "/v1/admin/admins": "/v1/admin/admins",
      "/v1/admin/clients": "/v1/admin/clients",
      "/v1/admin/bans": "/v1/admin/bans",
      "/v1/admin/link-queue": "/v1/admin/link-queue",
      "/v1/admin/wpm-queue": "/v1/admin/wpm-queue",
      "/v1/admin/wpm-queue/:id/history": "/v1/admin/wpm-queue/1/history",
      "/v1/admin/comment-queue": "/v1/admin/comment-queue",
      "/v1/admin/comment-queue/:id/history": "/v1/admin/comment-queue/1/history",
    };
  }

  it("[LDB-CV25] every GET route the app mounts is exercised here (a new route must be added, so its writes are looked at)", () => {
    expect(getTemplates()).toEqual(Object.keys(samples()).sort());
  });

  it("[LDB-CV25] the tables and columns that anonymous, signed-client and Discord-bearer GETs change are exactly the pinned drift set", async () => {
    const paths = Object.values(samples());
    const before = await snapshot();
    const bearers: [string, string][] = [["drift-bearer-1", authorId], ["drift-bearer-admin", ADMIN], ["drift-bearer-new", "999000111222333444"]];
    vi.stubGlobal("fetch", fake.fetchImpl);
    for (const [token, id] of bearers) fake.setAnswer(token, { kind: "ok", id, username: `name-of-${id}`, global_name: `Display ${id}` });
    const statuses: Record<string, number[]> = {};
    const note = (p: string, s: number) => (statuses[p] ??= []).push(s);
    for (const p of paths) {
      // anonymous
      note(p, (await SELF.fetch(`https://example.com${p}`)).status);
      // signed client (twice: the first call may refresh last_seen_at, the second must not), as the owner and as an admin's client
      for (const [clientId, actor] of [["drift-client", authorId], ["drift-admin-client", ADMIN]] as const) {
        for (let i = 0; i < 2; i++) {
          const headers = await signHeaders({ privateKey: signer.privateKey, clientId, actor, method: "GET", pathWithQuery: p });
          note(p, (await SELF.fetch(`https://example.com${p}`, { headers })).status);
        }
      }
      // Discord bearers: a known author, the admin, a user the database has never seen
      for (const [token] of bearers) note(p, (await SELF.fetch(`https://example.com${p}`, { headers: { Authorization: `Bearer ${token}` } })).status);
    }
    const phase1 = describeDrift(before, await snapshot());
    // an hour on, the cached bearer answers have expired (the auth clock is the real one, so age the rows instead): the next bearer GET asks Discord
    // again and UPSERTs the cache row and the author
    await testStore.patch("auth_cache", {}, { expires_at: "2000-01-01T00:00:00.000Z" });
    const middle = await snapshot();
    for (const p of paths) for (const [token] of bearers) note(p, (await SELF.fetch(`https://example.com${p}`, { headers: { Authorization: `Bearer ${token}` } })).status);
    const drift = mergeSummaries(summarizeDrift(phase1), summarizeDrift(describeDrift(middle, await snapshot())));
    // sanity: the routes did answer (a wall of 401/404 would make the snapshot meaningless)
    const ok = Object.values(statuses).flat().filter((s) => s === 200).length;
    expect(ok).toBeGreaterThan(paths.length * 3);
    expect(drift).toEqual(DRIFT_SET);
    void statuses;
  }, 120_000);
});
