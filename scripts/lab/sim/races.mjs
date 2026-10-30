// Lane Q: the race packs and their invariant checks (design/aws-port.md §5.1; §2 R1-R6 are what they exercise: claim
// items, set-version guards, counters, `changes() = 1` gates).
//
// Concurrent requests do not arrive in the same order on two backends, so a race pack is NOT judged by a byte diff of the
// racing responses. Each pack has:
//   - per-side invariants, checked on the oracle and on the AWS side alike (exactly one winner, no 5xx, a counter equal to
//     the number of winners, a feed with no gap, one decision event per decision);
//   - a cross-side check that is order-insensitive (the multiset of statuses, the multiset of feed events);
//   - `converges`: true when the end state is the same whoever wins (identical contenders, nothing minted, a feed that
//     reads the same in any order), so the pair diffs and the state diff after the pack stay meaningful. false when the
//     winner or the arrival order decides the end state (approve vs reject, two different PUTs, the feed order of N
//     distinct likers), and `mintsIds` packs (dup-create, comment-supersede): the lab entries seed ONE process-wide PRNG per
//     request (src/platform/lab-entry.ts), so ids drawn by overlapping requests depend on how they interleave, on the D1
//     oracle as much as on the AWS side, whatever lab seed the contenders carry. A pack that is not `converges` poisons
//     the lab for the rest of the day (the feed and lists differ by id/order from then on), so the driver runs those at the
//     END of the day, after the last state diff, and the lab is reloaded from a fresh export before the next day.
//     Invariants are checked either way.
//
// `run(env)` returns `Problem[]` = `{kind: "race", pack, detail}`. `env` (drive.mjs):
//   env.pair(step)            one step to both sides sequentially, diffed, recorded -> {a, b, ja, problems}
//   env.race(steps, opts)     steps sent CONCURRENTLY to each side (opts.sameSeed: all contenders share one lab seed) ->
//                             {a: Resp[], b: Resp[]}   (Resp = {status, headers, body, json})
//   env.readEach(step)        one step to each side, not diffed -> {a, b}
//   env.rng, env.corpus, env.seqHint()
import { ADMIN_ID } from "../fuzz/generator.mjs";

/** Race packs use their own typists: the organic mix bans and renames RACE_USERS, never these. */
export const RACE_USERS = ["100000000000000051", "100000000000000052", "100000000000000053", "100000000000000054", "100000000000000055"];

const J = (r) => r.json ?? null;
const sortedStatuses = (rs) => rs.map((r) => r.status).sort((x, y) => x - y);
const count = (rs, pred) => rs.filter((r) => pred(r.status)).length;
const is2xx = (s) => s >= 200 && s < 300;
const is5xx = (s) => s >= 500;
const problem = (pack, detail) => ({ kind: "race", pack, detail });

/** Apply `fn(resps, sideName)` to both sides and collect the problems. */
function bothSides(pack, sides, fn) {
  const out = [];
  for (const [name, rs] of [["oracle", sides.a], ["aws", sides.b]]) for (const d of fn(rs, name)) out.push(problem(pack, `${name}: ${d}`));
  return out;
}

function sameStatuses(pack, sides) {
  const a = sortedStatuses(sides.a).join(",");
  const b = sortedStatuses(sides.b).join(",");
  return a === b ? [] : [problem(pack, `status multiset differs: oracle [${a}] vs aws [${b}]`)];
}

function noServerErrors(rs) {
  return rs.some((r) => is5xx(r.status)) ? [`5xx among [${sortedStatuses(rs).join(",")}]`] : [];
}

/** The whole feed after `since` on one side. */
async function feedAfter(env, since) {
  const items = { a: [], b: [] };
  const next = { a: since, b: since };
  for (const side of ["a", "b"]) {
    for (let guard = 0; guard < 50; guard++) {
      const r = (await env.readEach({ label: "race: feed", method: "GET", path: `/v1/changes?since=${next[side]}&limit=1000` }))[side];
      const j = J(r);
      if (j === null || !Array.isArray(j.items)) break;
      items[side].push(...j.items);
      if (j.items.length === 0 || j.next <= next[side]) break;
      next[side] = j.next;
    }
  }
  return items;
}

const feedKey = (e) => `${e.kind}|${e.actor}|${e.layout_id ?? ""}`;

/** No gap and no repeat: seqs after `since` run since+1, since+2, ... */
function contiguous(items, since) {
  for (let i = 0; i < items.length; i++) if (items[i].seq !== since + 1 + i) return [`feed gap or reorder at index ${i}: seq ${items[i].seq}, expected ${since + 1 + i}`];
  return [];
}

async function headNow(env) {
  const f = await feedAfter(env, Math.max(0, env.seqHint() - 50));
  return { a: f.a.length > 0 ? f.a[f.a.length - 1].seq : Math.max(0, env.seqHint() - 50), b: f.b.length > 0 ? f.b[f.b.length - 1].seq : Math.max(0, env.seqHint() - 50) };
}

const sparkCreate = (env, name, user) => ({ label: `race setup: create ${name}`, method: "POST", path: "/v1/layouts", json: { name, format: "spark/1", payload: env.corpus[0] ?? { keys: [] } }, actor: user, user, stepMs: 1000 });
const tag = (env) => `${env.rng.int(0, 0xffffff).toString(16)}`;

// ---- the packs ---------------------------------------------------------------------------------------------------

/** K identical creates of one name (R3 claim item): exactly one wins; the losers are 4xx; the end state is the same. */
const dupCreate = {
  name: "dup-create",
  converges: false, // mintsIds: the winner's ULID depends on how the overlapping requests interleave
  mintsIds: true,
  async run(env) {
    const K = 4;
    const name = `race-dup-${tag(env)}`;
    const steps = Array.from({ length: K }, () => ({ ...sparkCreate(env, name, RACE_USERS[0]), label: "race: create" }));
    const sides = await env.race(steps, { sameSeed: true });
    return [
      ...bothSides("dup-create", sides, (rs) => [...noServerErrors(rs), ...(count(rs, is2xx) === 1 ? [] : [`${count(rs, is2xx)} creates won, expected exactly 1 of ${K} [${sortedStatuses(rs).join(",")}]`])]),
      ...sameStatuses("dup-create", sides),
      ...(await env.pair({ label: "race: list after dup-create", method: "GET", path: "/v1/layouts?sort=name&limit=100" })).problems.map((p) => problem("dup-create", `post-state differs: ${p.detail}`)),
    ];
  },
};

/** K identical likes by one user (R3 + R4): the like exists once, the counter says 1, the state is identical. */
const likeSame = {
  name: "like-same-user",
  converges: true,
  async run(env) {
    const out = [];
    const made = await env.pair(sparkCreate(env, `race-like1-${tag(env)}`, RACE_USERS[0]));
    const id = made.ja?.id;
    if (typeof id !== "string") return [problem("like-same-user", `setup: create answered ${made.a.status}`)];
    const u = RACE_USERS[1];
    const like = { label: "race: like", method: "PUT", path: `/v1/layouts/${id}/like`, actor: u, user: u };
    const sides = await env.race(Array.from({ length: 5 }, () => like), { sameSeed: true });
    out.push(...bothSides("like-same-user", sides, (rs) => noServerErrors(rs)), ...sameStatuses("like-same-user", sides));
    const after = await env.pair({ label: "race: likes after", method: "GET", path: `/v1/layouts/${id}/likes` });
    out.push(...after.problems.map((p) => problem("like-same-user", `post-state differs: ${p.detail}`)));
    const times = (after.b.body.toString("utf8").match(new RegExp(u, "g")) ?? []).length;
    if (times !== 1) out.push(problem("like-same-user", `aws likes body names ${u} ${times} times, expected 1`));
    return out;
  },
};

/** One like each from K users (R4 counter): like_count == K on both sides; the feed has K `liked` events and no gap. */
const likeDistinct = {
  name: "like-distinct-users",
  converges: false, // event seq order follows arrival
  async run(env) {
    const made = await env.pair(sparkCreate(env, `race-likeN-${tag(env)}`, RACE_USERS[0]));
    const id = made.ja?.id;
    if (typeof id !== "string") return [problem("like-distinct-users", `setup: create answered ${made.a.status}`)];
    const voters = RACE_USERS.slice(1);
    const before = await headNow(env);
    const sides = await env.race(voters.map((u) => ({ label: "race: like", method: "PUT", path: `/v1/layouts/${id}/like`, actor: u, user: u })), {});
    const out = [...bothSides("like-distinct-users", sides, (rs) => [...noServerErrors(rs), ...(count(rs, is2xx) === voters.length ? [] : [`${count(rs, is2xx)} of ${voters.length} likes succeeded [${sortedStatuses(rs).join(",")}]`])]), ...sameStatuses("like-distinct-users", sides)];
    const got = await env.readEach({ label: "race: layout", method: "GET", path: `/v1/layouts/${id}` });
    for (const side of ["a", "b"]) {
      const lc = J(got[side])?.like_count;
      if (lc !== voters.length) out.push(problem("like-distinct-users", `${side === "a" ? "oracle" : "aws"}: like_count ${lc}, expected ${voters.length}`));
    }
    const feed = await feedAfter(env, Math.min(before.a, before.b));
    out.push(...contiguous(feed.a, Math.min(before.a, before.b)).map((d) => problem("like-distinct-users", `oracle: ${d}`)), ...contiguous(feed.b, Math.min(before.a, before.b)).map((d) => problem("like-distinct-users", `aws: ${d}`)));
    const ka = feed.a.map(feedKey).sort().join("\n");
    const kb = feed.b.map(feedKey).sort().join("\n");
    if (ka !== kb) out.push(problem("like-distinct-users", "feed events after the race differ as multisets"));
    return out;
  },
};

/** The comment queue's pending item for a fresh comment, as {id}. */
async function pendingComment(env, layoutId, user, text) {
  const put = await env.pair({ label: "race setup: comment", method: "PUT", path: `/v1/layouts/${layoutId}/comment`, json: { body: text }, actor: user, user, stepMs: 1000 });
  const id = put.ja?.submission?.id ?? put.ja?.id;
  return typeof id === "string" ? id : null;
}

async function layoutForRace(env, label) {
  const made = await env.pair(sparkCreate(env, `race-${label}-${tag(env)}`, RACE_USERS[0]));
  return typeof made.ja?.id === "string" ? { id: made.ja.id, resp: made } : null;
}

/** K identical approvals of one comment (R6 gate): one decision event, never 5xx, identical end state. */
const approveSame = {
  name: "approve-same",
  converges: true,
  async run(env) {
    const l = await layoutForRace(env, "appr");
    if (l === null) return [problem("approve-same", "setup: layout create failed")];
    const sid = await pendingComment(env, l.id, RACE_USERS[2], "race comment");
    if (sid === null) return [problem("approve-same", "setup: comment submit failed")];
    const before = await headNow(env);
    const approve = { label: "race: approve", method: "POST", path: `/v1/admin/comment-queue/${sid}/approve`, json: { review_version: 0 }, actor: ADMIN_ID, user: ADMIN_ID };
    const sides = await env.race(Array.from({ length: 3 }, () => approve), { sameSeed: true });
    const out = [...bothSides("approve-same", sides, (rs) => noServerErrors(rs)), ...sameStatuses("approve-same", sides)];
    const feed = await feedAfter(env, Math.min(before.a, before.b));
    for (const side of ["a", "b"]) {
      const n = feed[side].filter((e) => e.kind === "comment_approved").length;
      if (n !== 1) out.push(problem("approve-same", `${side === "a" ? "oracle" : "aws"}: ${n} comment_approved events, expected exactly 1`));
    }
    out.push(...(await env.pair({ label: "race: comments after approve", method: "GET", path: `/v1/layouts/${l.id}/comments` })).problems.map((p) => problem("approve-same", `post-state differs: ${p.detail}`)));
    return out;
  },
};

/** Approve and reject of the same pending comment at once (R6): exactly one decision; the final status is the winner's. */
const approveVsReject = {
  name: "approve-vs-reject",
  converges: false, // the winner decides the end state
  async run(env) {
    const l = await layoutForRace(env, "decide");
    if (l === null) return [problem("approve-vs-reject", "setup: layout create failed")];
    const sid = await pendingComment(env, l.id, RACE_USERS[3], "race decide");
    if (sid === null) return [problem("approve-vs-reject", "setup: comment submit failed")];
    const before = await headNow(env);
    const sides = await env.race([
      { label: "race: approve", method: "POST", path: `/v1/admin/comment-queue/${sid}/approve`, json: { review_version: 0 }, actor: ADMIN_ID, user: ADMIN_ID },
      { label: "race: reject", method: "POST", path: `/v1/admin/comment-queue/${sid}/reject`, json: { review_version: 0, reason: "race" }, actor: ADMIN_ID, user: ADMIN_ID },
    ], {});
    const out = bothSides("approve-vs-reject", sides, (rs) => [...noServerErrors(rs), ...(count(rs, is2xx) === 1 ? [] : [`${count(rs, is2xx)} decisions succeeded, expected exactly 1 [${sortedStatuses(rs).join(",")}]`])]);
    const feed = await feedAfter(env, Math.min(before.a, before.b));
    for (const side of ["a", "b"]) {
      const decisions = feed[side].filter((e) => e.kind === "comment_approved" || e.kind === "comment_rejected");
      const name = side === "a" ? "oracle" : "aws";
      if (decisions.length !== 1) out.push(problem("approve-vs-reject", `${name}: ${decisions.length} decision events, expected exactly 1`));
      const winner = sides[side][0].status < 300 ? "comment_approved" : "comment_rejected";
      if (decisions.length === 1 && decisions[0].kind !== winner) out.push(problem("approve-vs-reject", `${name}: the 2xx was the ${winner === "comment_approved" ? "approve" : "reject"} but the event is ${decisions[0].kind}`));
    }
    return out;
  },
};

/** Two PUTs on one If-Match (R5 version guard): one 200, one 412, and the stored payload is the winner's. */
const putCas = {
  name: "put-cas",
  converges: false,
  async run(env) {
    const l = await layoutForRace(env, "cas");
    if (l === null) return [problem("put-cas", "setup: layout create failed")];
    const token = l.resp.a.headers.etag; // the format scope ("spark:N") guards a PUT
    const base = env.corpus[0] ?? { keys: [] };
    const alt = env.corpus[1] ?? env.corpus[0] ?? { keys: [] };
    const alt2 = JSON.parse(JSON.stringify(alt));
    if (Array.isArray(alt2.keys) && alt2.keys.length > 1) [alt2.keys[0].char, alt2.keys[1].char] = [alt2.keys[1].char, alt2.keys[0].char];
    const payloads = [alt2, base === alt2 ? alt : base];
    const sides = await env.race(payloads.map((p, i) => ({ label: `race: put ${i}`, method: "PUT", path: `/v1/layouts/${l.id}`, json: { format: "spark/1", payload: p }, headers: { "If-Match": token }, actor: RACE_USERS[0], user: RACE_USERS[0] })), {});
    return [
      ...bothSides("put-cas", sides, (rs) => {
        const bad = [...noServerErrors(rs)];
        const wins = count(rs, is2xx);
        // identical payloads would be a no-op for both; the two differ, so one must lose
        if (wins !== 1) bad.push(`${wins} PUTs won on one If-Match, expected exactly 1 [${sortedStatuses(rs).join(",")}]`);
        else if (!rs.some((r) => r.status === 412 || r.status === 409)) bad.push(`the loser was not a 409/412 [${sortedStatuses(rs).join(",")}]`);
        return bad;
      }),
      ...sameStatuses("put-cas", { a: sides.a.map((r) => ({ status: is2xx(r.status) ? 200 : r.status })), b: sides.b.map((r) => ({ status: is2xx(r.status) ? 200 : r.status })) }),
    ];
  },
};

/** Two layouts renamed to one name at once (R3 claim item): one 200, one name conflict, the name belongs to one layout. */
const renameCollide = {
  name: "rename-collide",
  converges: false,
  async run(env) {
    const a = await layoutForRace(env, "rn1");
    const b = await layoutForRace(env, "rn2");
    if (a === null || b === null) return [problem("rename-collide", "setup: layout create failed")];
    const target = `race-name-${tag(env)}`;
    const mk = (l) => ({ label: "race: rename", method: "PATCH", path: `/v1/layouts/${l.id}`, json: { name: target }, headers: { "If-Match": `"layout:${l.resp.ja?.layout_rev ?? 1}"` }, actor: RACE_USERS[0], user: RACE_USERS[0] });
    const sides = await env.race([mk(a), mk(b)], {});
    const out = bothSides("rename-collide", sides, (rs) => [...noServerErrors(rs), ...(count(rs, is2xx) === 1 ? [] : [`${count(rs, is2xx)} renames won, expected exactly 1 [${sortedStatuses(rs).join(",")}]`])]);
    const reads = await Promise.all([a, b].map((l) => env.readEach({ label: "race: layout", method: "GET", path: `/v1/layouts/${l.id}` })));
    for (const side of ["a", "b"]) {
      const holders = reads.filter((r) => J(r[side])?.name === target).length;
      if (holders !== 1) out.push(problem("rename-collide", `${side === "a" ? "oracle" : "aws"}: ${holders} layouts hold the name, expected 1`));
    }
    return out;
  },
};

/** Concurrent comments by one user (supersede): never 5xx, and at most one stays pending for (layout, user). */
const commentSupersede = {
  name: "comment-supersede",
  converges: false,
  mintsIds: true,
  async run(env) {
    const l = await layoutForRace(env, "sup");
    if (l === null) return [problem("comment-supersede", "setup: layout create failed")];
    const u = RACE_USERS[4];
    const sides = await env.race([1, 2, 3].map((n) => ({ label: "race: comment", method: "PUT", path: `/v1/layouts/${l.id}/comment`, json: { body: `race comment ${n}` }, actor: u, user: u })), {});
    const out = bothSides("comment-supersede", sides, (rs) => noServerErrors(rs));
    const queue = await env.readEach({ label: "race: comment queue", method: "GET", path: "/v1/admin/comment-queue?status=pending", actor: ADMIN_ID, user: ADMIN_ID });
    for (const side of ["a", "b"]) {
      const subs = J(queue[side])?.submissions;
      if (!Array.isArray(subs)) continue;
      const mine = subs.filter((s) => JSON.stringify(s).includes(l.id) && JSON.stringify(s).includes(u)).length;
      if (mine > 1) out.push(problem("comment-supersede", `${side === "a" ? "oracle" : "aws"}: ${mine} pending comments for one (layout, user), supersede should leave 1`));
    }
    return out;
  },
};

/** The discord-message bind (R3 claim): K identical binds all succeed; two different binds -> exactly one wins. */
const wpmBind = {
  name: "wpm-bind",
  converges: false,
  async run(env) {
    const l = await layoutForRace(env, "bind");
    if (l === null) return [problem("wpm-bind", "setup: layout create failed")];
    const u = RACE_USERS[1];
    const body = { json: { layout: l.id, wpm: 120, proof: "https://youtu.be/raceAAAAAAA" } };
    const sub = await env.pair({ label: "race setup: wpm submit", method: "POST", path: "/v1/wpm", json: body.json, actor: u, user: u, stepMs: 1000 });
    const sid = sub.ja?.submission?.id;
    if (typeof sid !== "string") return [problem("wpm-bind", `setup: wpm submit answered ${sub.a.status}`)];
    const triple = (m) => ({ guild_id: "300000000000000001", channel_id: "300000000000000002", message_id: m });
    const bind = (m) => ({ label: "race: bind", method: "PUT", path: `/v1/wpm/submissions/${sid}/discord-message`, json: triple(m), actor: u, user: u });
    const same = await env.race(Array.from({ length: 3 }, () => bind("300000000000000010")), { sameSeed: true });
    const out = [...bothSides("wpm-bind", same, (rs) => [...noServerErrors(rs), ...(count(rs, is2xx) === rs.length ? [] : [`identical binds: [${sortedStatuses(rs).join(",")}], expected all 2xx`])]), ...sameStatuses("wpm-bind", same)];
    // two different binds after the first: the first bind stands, so at most one of them may succeed (none, when refused)
    const diff = await env.race([bind("300000000000000011"), bind("300000000000000012")], {});
    out.push(...bothSides("wpm-bind", diff, (rs) => [...noServerErrors(rs), ...(count(rs, is2xx) <= 1 ? [] : [`both conflicting binds succeeded [${sortedStatuses(rs).join(",")}]`])]));
    return out;
  },
};

/** A held long-poll and a write that should wake it: the poll's items are contiguous and, if any, include the write. */
const longpollWake = {
  name: "longpoll-wake",
  converges: true,
  async run(env) {
    const l = await layoutForRace(env, "wake");
    if (l === null) return [problem("longpoll-wake", "setup: layout create failed")];
    const head = await headNow(env);
    const since = Math.min(head.a, head.b);
    const u = RACE_USERS[2];
    const poll = { label: "race: long-poll", method: "GET", path: `/v1/changes?since=${since}&wait=30`, actor: RACE_USERS[0], user: RACE_USERS[0] };
    const write = { label: "race: waking like", method: "PUT", path: `/v1/layouts/${l.id}/like`, actor: u, user: u, delayMs: 100 };
    const sides = await env.race([poll, write], { delays: true });
    const out = bothSides("longpoll-wake", sides, (rs) => {
      const bad = [...noServerErrors(rs)];
      const j = J(rs[0]);
      if (rs[0].status === 200 && j !== null && Array.isArray(j.items)) {
        bad.push(...contiguous(j.items, since));
        if (j.items.length > 0 && j.next < j.items[j.items.length - 1].seq) bad.push("next is behind the last item");
      }
      return bad;
    });
    // soft observation, not a failure: a wake on one side and a timeout on the other
    const woke = (rs) => rs[0].status === 200 && Array.isArray(J(rs[0])?.items) && J(rs[0]).items.length > 0;
    if (woke(sides.a) !== woke(sides.b)) env.observe?.(`longpoll-wake: oracle woke=${woke(sides.a)}, aws woke=${woke(sides.b)} (a timeout inside the lab's short hold cap is legitimate; a persistent split is a lost wake)`);
    return out;
  },
};

export const RACE_PACKS = [dupCreate, likeSame, likeDistinct, approveSame, approveVsReject, putCas, renameCollide, commentSupersede, wpmBind, longpollWake];

/**
 * @param {"all"|"converge"|"none"} which   "converge": only the packs that leave the lab comparable (safe all day);
 *   "all": every pack (the others belong at the end of the day, see Driver.runDay)
 */
export function selectPacks(which = "all", packs = RACE_PACKS) {
  if (which === "none") return [];
  return which === "converge" ? packs.filter((p) => p.converges && !p.mintsIds) : packs;
}

/** Run packs one after another (never two at once: a pack owns its own layouts, but the feed checks assume quiet). */
export async function runRacePacks(env, packs = RACE_PACKS) {
  const problems = [];
  const ran = [];
  for (const pack of packs) {
    let ps;
    try {
      ps = await pack.run(env);
    } catch (e) {
      ps = [problem(pack.name, `pack threw: ${e instanceof Error ? e.message : String(e)}`)];
    }
    ran.push({ name: pack.name, converges: pack.converges, problems: ps.length });
    problems.push(...ps);
  }
  return { ran, problems };
}
