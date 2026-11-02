// [LDB-J1] The five-minute tick's one-statement probe (store/d1/cron.ts):
// a false flag must prove its job has nothing to do. For seeded random mixes
// of rows in every table the tick touches, each flag is compared with what
// the job's OWN statements find (or change) right after: flag false => the
// job found nothing. An idle database answers all false, and scheduled() on
// it then issues no job statement at all.
// D1-only (raw SQL fixtures; design/p1-briefs.md E).
import { describe, expect, it } from "vitest";
import { createScheduledController, env, store } from "../harness";
import worker from "../../src/index";

const db = (env as unknown as { DB: D1Database }).DB;
const NOW = "2026-11-02T12:00:00.000Z";
const T = (minutes: number) => new Date(Date.parse(NOW) + minutes * 60_000).toISOString();
const ACTION_TABLES = ["discord_pending_actions", "discord_reopen_actions"] as const;
const TABLES = ["link_submissions", "wpm_submissions", "layout_comments", "modqueue_notifications", "discord_reopen_confirmations", "discord_deny_modals", ...ACTION_TABLES, "discord_rejection_dm_outbox"];

function rng(seed: number): () => number {
  let x = seed >>> 0;
  return () => { x = (x * 1664525 + 1013904223) >>> 0; return x / 2 ** 32; };
}

async function clear(): Promise<void> {
  await db.batch(TABLES.map((t) => db.prepare(`DELETE FROM ${t}`)));
}

async function layoutId(): Promise<string> {
  const row = await db.prepare("SELECT id FROM layouts LIMIT 1").first<{ id: string }>();
  if (row !== null) return row.id;
  await db.prepare("INSERT INTO layouts (id, name, owner, n, layout_rev, created_at, modified_at, deleted) VALUES ('01CRONPROBE000000000000000', 'cron-probe', '1', 1, 1, ?1, ?1, 0)").bind(NOW).run();
  return "01CRONPROBE000000000000000";
}

// One random mix: each table gets 0-3 rows in a random state around NOW.
async function seed(seedN: number, layout: string): Promise<void> {
  const r = rng(seedN);
  const pick = <V>(xs: readonly V[]): V => xs[Math.floor(r() * xs.length)]!;
  const when = () => T(pick([-90, -5, -1, 1, 5, 90]));
  const n = () => Math.floor(r() * 4);
  const stmts: D1PreparedStatement[] = [];
  const subs: { kind: "link" | "wpm" | "comment"; id: string; status: string; rv: number; url: string | null }[] = [];
  for (let i = 0; i < n(); i++) {
    const id = `ls${seedN}-${i}`, status = pick(["pending", "approved", "rejected"]);
    stmts.push(db.prepare("INSERT INTO link_submissions (id, layout_id, url, submitted_by, submitted_at, status, notified_at) VALUES (?, ?, 'https://x.test', '2', ?, ?, ?)").bind(id, layout, NOW, status, r() < 0.5 ? null : NOW));
    subs.push({ kind: "link", id, status, rv: 0, url: null });
  }
  for (let i = 0; i < n(); i++) {
    const id = `ws${seedN}-${i}`, status = pick(["pending", "approved", "rejected", "superseded"]), rv = Math.floor(r() * 2), url = r() < 0.5 ? null : "https://discord.com/x";
    stmts.push(db.prepare("INSERT INTO wpm_submissions (id, layout_id, user_id, wpm, proof, submitted_by, via, submitted_at, status, notified_at, review_version, source_message_url) VALUES (?, ?, '3', 100, 'https://p.test', '3', 'discord', ?, ?, ?, ?, ?)").bind(id, layout, NOW, status, r() < 0.5 ? null : NOW, rv, url));
    subs.push({ kind: "wpm", id, status, rv, url });
  }
  for (let i = 0; i < n(); i++) {
    const id = `cs${seedN}-${i}`, status = pick(["pending", "approved", "rejected"]), rv = Math.floor(r() * 2);
    stmts.push(db.prepare("INSERT INTO layout_comments (id, layout_id, user_id, body, via, submitted_at, status, review_version) VALUES (?, ?, ?, 'b', 'discord', ?, ?, ?)").bind(id, layout, `4${seedN}${i}`, NOW, status, rv));
    subs.push({ kind: "comment", id, status, rv, url: null });
  }
  for (const s of subs) {
    if (r() < 0.5) continue; // not every submission has a card
    const inSync = r() < 0.5;
    stmts.push(db.prepare("INSERT INTO modqueue_notifications (kind, submission_id, message_id, shown_status, shown_review_version, shown_source_message_url) VALUES (?, ?, 'm', ?, ?, ?)").bind(s.kind, s.id, inSync ? s.status : pick(["pending", "approved", "rejected"]), inSync ? s.rv : s.rv + 1, inSync ? s.url : "https://other"));
  }
  for (let i = 0; i < n(); i++) {
    stmts.push(db.prepare("INSERT INTO discord_reopen_confirmations (confirmation_id, initial_interaction_id, actor_id, kind, submission_id, channel_id, message_id, guild_id, expected_status, expected_review_version, created_at, expires_at) VALUES (?, ?, '5', 'wpm', 's', 'c', 'm', 'g', 'approved', 0, ?, ?)").bind(`rc${seedN}-${i}`, `ri${seedN}-${i}`, NOW, when()));
    stmts.push(db.prepare("INSERT INTO discord_deny_modals (modal_id, initial_interaction_id, actor_id, kind, submission_id, channel_id, message_id, guild_id, created_at, expires_at) VALUES (?, ?, '5', 'wpm', 's', 'c', 'm', 'g', ?, ?)").bind(`dm${seedN}-${i}`, `di${seedN}-${i}`, NOW, when()));
  }
  for (const table of ACTION_TABLES) {
    for (let i = 0; i < n(); i++) {
      const state = pick(["pending", "working", "complete", "expired"]);
      const extra = table === "discord_reopen_actions" ? ["reopen", ", expected_status", ", 'approved'"] : [pick(["approve", "deny"]), "", ""];
      stmts.push(db.prepare(`INSERT INTO ${table} (interaction_id, application_id, token, actor_id, actor_name, kind, action, submission_id, channel_id, message_id, guild_id, created_at, expires_at, state, lease_until${extra[1]}) VALUES (?, 'app', ?, '5', 'mod', 'wpm', ?, 's', 'c', 'm', 'g', ?, ?, ?, ?${extra[2]})`)
        .bind(`${table}-${seedN}-${i}`, r() < 0.5 ? "" : "tok", extra[0], NOW, when(), state, state === "working" ? when() : null));
    }
  }
  for (let i = 0; i < n(); i++) {
    const status = pick(["pending", "leased", "sent", "blocked"]);
    stmts.push(db.prepare("INSERT INTO discord_rejection_dm_outbox (delivery_key, event_seq, kind, submission_id, layout_id, recipient_id, nonce, status, next_attempt_at, lease_until, created_at, updated_at) VALUES (?, ?, 'wpm', 's', ?, '6', ?, ?, ?, ?, ?, ?)")
      .bind(`ob${seedN}-${i}`, seedN * 10 + i + 1_000_000, layout, `n${seedN}x${i}`, status, when(), status === "leased" ? when() : null, NOW, NOW));
  }
  if (stmts.length > 0) await db.batch(stmts);
}

async function snapshot(): Promise<string> {
  const parts: string[] = [];
  for (const t of ["discord_reopen_confirmations", "discord_deny_modals", ...ACTION_TABLES]) {
    parts.push(JSON.stringify((await db.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all()).results));
  }
  return parts.join("|");
}

describe("[LDB-J1] the tick's work probe", () => {
  it("[LDB-J1] for 60 seeded random mixes, a false flag means that job's own statements find and change nothing", async () => {
    const layout = await layoutId();
    let falses = 0, trues = 0;
    for (let s = 1; s <= 60; s++) {
      await clear();
      await seed(s, layout);
      const work = await store.cron.work(NOW);
      const announce = (await store.modqueue.linkCandidates(1000)).length + (await store.modqueue.wpmCandidates(1000)).length;
      const reconcile = (await store.modqueue.staleNotifications(1000)).length;
      const dms = (await store.outbox.due(NOW, 1000)).length;
      const callbacks = (await Promise.all(ACTION_TABLES.map((t) => store.discord.pendingCallbacks(t, NOW, 1000)))).flat().length;
      const before = await snapshot();
      await store.discord.deleteExpiredConfirmations(NOW);
      for (const t of ACTION_TABLES) await store.discord.expireActions(t, NOW);
      const claimed = (await Promise.all(ACTION_TABLES.map((t) => store.discord.claimAction(t, NOW, T(5), "lease")))).filter((x) => x !== null).length;
      const changed = (await snapshot()) !== before;
      const discord = callbacks > 0 || changed || claimed > 0;
      expect(work.announce || announce === 0, `seed ${s}: announce`).toBe(true);
      expect(work.reconcile || reconcile === 0, `seed ${s}: reconcile`).toBe(true);
      expect(work.dms || dms === 0, `seed ${s}: dms`).toBe(true);
      expect(work.discord || !discord, `seed ${s}: discord`).toBe(true);
      for (const f of [work.announce, work.reconcile, work.dms, work.discord]) f ? trues++ : falses++;
    }
    expect(falses).toBeGreaterThan(20); // the mixes exercise both answers
    expect(trues).toBeGreaterThan(20);
  });

  it("[LDB-J1] an idle database answers all false with the dump state, and a tick on it issues no job statement", async () => {
    await clear();
    const state = JSON.stringify({ at: new Date().toISOString(), key: "dump-x.json.gz", seq: 1 });
    await db.prepare("INSERT INTO import_state (key, value) VALUES ('dump.last_at', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(state).run();
    expect(await store.cron.work(new Date().toISOString())).toEqual({ announce: false, reconcile: false, discord: false, dms: false, dumpState: state });

    const seen: string[] = [];
    const recording = new Proxy(db, {
      get(target, prop) {
        if (prop === "prepare") return (sql: string) => { seen.push(sql); return target.prepare(sql); };
        if (prop === "batch") return (list: D1PreparedStatement[]) => target.batch(list);
        const v = Reflect.get(target, prop);
        return typeof v === "function" ? v.bind(target) : v;
      },
    });
    const live = { ...(env as object), DB: recording, MODQUEUE_DISCORD_CARDS: "true", MODQUEUE_DISCORD_BOT_TOKEN: "t", MODQUEUE_DISCORD_CHANNEL_ID: "1", MODQUEUE_DISCORD_ACTIONS: "true", MODQUEUE_DISCORD_DMS: "true" };
    const at = Date.parse("2026-11-02T10:05:00.000Z");
    await worker.scheduled(createScheduledController({ scheduledTime: new Date(at), cron: "*/5 * * * *" }), live as never, { waitUntil() {}, passThroughOnException() {} } as never);
    expect(seen.length, seen.join("\n")).toBe(1);
    expect(seen[0]).toContain("AS dump_state");

    // and a tick with work runs exactly the job that has it: an unannounced link submission
    await db.prepare("INSERT INTO link_submissions (id, layout_id, url, submitted_by, submitted_at, status) VALUES ('ls-idle-1', ?, 'https://x.test', '2', ?, 'pending')").bind(await layoutId(), NOW).run();
    seen.length = 0;
    await worker.scheduled(createScheduledController({ scheduledTime: new Date(at), cron: "*/5 * * * *" }), live as never, { waitUntil() {}, passThroughOnException() {} } as never);
    expect(seen.some((q) => /FROM link_submissions s/.test(q)), seen.join("\n")).toBe(true);
    expect(seen.some((q) => /discord_pending_actions|discord_rejection_dm_outbox WHERE \(status/.test(q) && !/AS dump_state/.test(q))).toBe(false);
  });
});
