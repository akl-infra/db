// The seeded organic request generator (design/aws-port.md §5.1 item 2; lane
// L): several actors on both auth lanes, odd names, cursors, filters and
// moderation flows over every route, plus restarts. It is a small state
// machine: `next()` returns the next step, `observe(step, res)` feeds back the
// oracle's response (ids, ETags, queue contents, cursors), so later steps
// reference what really exists. Both backends receive the identical step.
//
// A step: { label, method, path, json?, rawBody?, headers?, actor?, bearer?,
//           stepMs, conditional?, restart? }
//  - actor: a client-lane request signed for that user id; bearer: the fake
//    Discord bearer lane for that user id; neither: anonymous.
//  - restart: not a request; the runner restarts the DynamoDB server's store
//    and catalog (a cold container).
import { makeRng } from "./rng.mjs";

export const ADMIN_ID = "100000000000000001";
export const USER_IDS = ["100000000000000002", "100000000000000003", "100000000000000004", "100000000000000005", "100000000000000006"];
const ALL_USERS = [ADMIN_ID, ...USER_IDS];
const UNKNOWN_USER = "199999999999999999";

const ODD_NAMES = [
  "Colemak-DH", "colemak-dh", "COLEMAK-DH", "  padded  ", "ünïcode-ключ", "emoji-🙂-name", "tab\tname", "dot.", "a/b", "100%", "q?x=1", "hash#tag",
  "x".repeat(64), "x".repeat(65), "x".repeat(200), "Ünï", "ünï", "İstanbul", "MiXeD-CaSe", "dvorak", "workman", "norman", "-leading", "trailing-",
];

const FORMATS = ["spark/1", "mana2/1"];
const SORTS = ["name", "modified_at", "created_at", "like_count"];
const KINDS = ["created", "liked", "unliked", "liked,unliked", "admin.added", "link_approved", "wpm_approved", "comment_approved", "renamed", "deleted", "restored"];

function ids(json, key = "id") {
  const out = [];
  const walk = (v) => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (v !== null && typeof v === "object") {
      if (typeof v[key] === "string") out.push(v[key]);
      for (const x of Object.values(v)) if (typeof x === "object") walk(x);
    }
  };
  walk(json);
  return out;
}

export class Generator {
  /** @param {{ seed: number, corpus: object[], restartEvery?: number }} o */
  constructor({ seed, corpus, restartEvery = 60 }) {
    this.rng = makeRng(seed);
    this.corpus = corpus.length > 0 ? corpus : [{ keys: [] }];
    this.restartEvery = restartEvery;
    this.n = 0;
    this.layouts = new Map(); // id -> { id, name, owner, deleted, layoutRev, sparkRev, ... }
    this.pending = { link: [], wpm: [], comment: [] };
    this.cursors = new Map(); // list signature -> last next_cursor
    this.lastSeq = 0;
    this.created = 0;
    this.names = [];
    this.queue = [];
  }

  // ---- model helpers ----------------------------------------------------

  user() {
    return this.rng.pick(USER_IDS);
  }
  anyUser() {
    return this.rng.weighted([[8, this.rng.pick(ALL_USERS)], [1, UNKNOWN_USER], [1, "not-a-snowflake"]]);
  }
  /** Mostly an existing layout; sometimes a stale or invented reference. */
  layoutRef(opts = {}) {
    const rng = this.rng;
    const live = [...this.layouts.values()].filter((l) => (opts.deleted === undefined ? true : l.deleted === opts.deleted));
    if (live.length === 0 || rng.chance(0.06)) return { id: rng.pick(["no-such-layout", "01JAB0000000000000000NONE0", "x"]), l: null, byName: false };
    const l = rng.pick(live);
    if (rng.chance(0.2) && !l.deleted) return { id: encodeURIComponent(rng.chance(0.5) ? l.name.toUpperCase() : l.name), l, byName: true };
    return { id: l.id, l, byName: false };
  }
  ownerOf(l) {
    return l === null ? this.user() : this.rng.chance(0.85) ? l.owner : this.user();
  }
  payload() {
    const rng = this.rng;
    const base = JSON.parse(JSON.stringify(rng.pick(this.corpus)));
    const m = rng.weighted([[6, "same"], [3, "swap"], [1, "empty"], [1, "invalid"]]);
    if (m === "empty") return { keys: [] };
    if (m === "invalid") return rng.pick([{ keys: "no" }, { keys: [{ char: 1 }] }, {}, { keys: [], extra: 1 }]);
    if (m === "swap" && Array.isArray(base.keys) && base.keys.length > 2) {
      const i = rng.int(0, base.keys.length - 1);
      const j = rng.int(0, base.keys.length - 1);
      const t = base.keys[i].char;
      base.keys[i].char = base.keys[j].char;
      base.keys[j].char = t;
    }
    return base;
  }
  name() {
    const rng = this.rng;
    return rng.weighted([
      [5, () => `fz-${this.created++}-${rng.int(0, 999)}`],
      [3, () => rng.pick(ODD_NAMES)],
      [2, () => (this.names.length > 0 ? rng.pick(this.names) : "fz-seed")],
      [1, () => ""],
    ])();
  }
  ifMatch(l, scope = "layout") {
    const rng = this.rng;
    if (l === null || rng.chance(0.05)) return rng.pick(['"layout:1"', '"spark:1"', "garbage", '"layout:99"']);
    const rev = scope === "layout" ? l.layoutRev : l.sparkRev;
    if (rng.chance(0.12)) return `"${scope}:${Math.max(1, rev - 1)}"`;
    return `"${scope}:${rev}"`;
  }
  lane(user) {
    return this.rng.chance(0.6) ? { actor: user } : { bearer: user };
  }

  // ---- steps ------------------------------------------------------------

  next() {
    this.n++;
    if (this.n % this.restartEvery === 0) return { label: "restart", restart: true, method: "RESTART", path: "-", stepMs: 0 };
    const step = this.rng.weighted(this.table())();
    step.stepMs ??= this.rng.chance(0.7) ? 1000 : this.rng.pick([0, 60_000, 3_600_000]);
    return step;
  }

  table() {
    const g = this;
    const rng = this.rng;
    const hasLayouts = this.layouts.size > 0;
    const w = (base, always = true) => (always ? base : 0);
    const T = [
      [w(10), () => g.stepCreate()],
      [w(14, hasLayouts), () => g.stepLike()],
      [w(5, hasLayouts), () => g.stepPut()],
      [w(5, hasLayouts), () => g.stepPatch()],
      [w(3, hasLayouts), () => g.stepDelete()],
      [w(2, hasLayouts), () => g.stepRestore()],
      [w(2, hasLayouts), () => g.stepTransfer()],
      [w(4, hasLayouts), () => g.stepLink()],
      [w(3, hasLayouts), () => g.stepWpm()],
      [w(4, hasLayouts), () => g.stepComment()],
      [w(4), () => g.stepAdminQueueRead()],
      [w(5), () => g.stepModerate()],
      [w(3), () => g.stepAdmin()],
      [w(1), () => g.stepDumpOrTick()],
      [w(14), () => g.stepList()],
      [w(10), () => g.stepChanges()],
      [w(10, hasLayouts), () => g.stepLayoutRead()],
      [w(5), () => g.stepMisc()],
      [w(2), () => g.stepAuthFailure()],
    ].filter(([wt]) => wt > 0);
    void rng;
    return T;
  }

  stepCreate() {
    const u = this.user();
    const name = this.name();
    this.names.push(name);
    const fmt = this.rng.weighted([[12, "spark/1"], [1, "mana2/1"], [1, "bogus/9"]]);
    const headers = this.rng.chance(0.15) ? { "Idempotency-Key": `fz-idem-${this.rng.int(1, 6)}` } : undefined;
    return { label: "create", method: "POST", path: "/v1/layouts", json: { name, format: fmt, payload: this.payload() }, headers, ...this.lane(u), user: u };
  }
  stepLike() {
    const r = this.layoutRef();
    const u = this.rng.chance(0.9) ? this.user() : ADMIN_ID;
    const verb = this.rng.weighted([[5, "PUT"], [3, "DELETE"]]);
    return { label: verb === "PUT" ? "like" : "unlike", method: verb, path: `/v1/layouts/${r.id}/like`, ...this.lane(u), user: u };
  }
  stepPut() {
    const r = this.layoutRef({ deleted: false });
    const u = this.ownerOf(r.l);
    const withMatch = this.rng.chance(0.85);
    return { label: "put", method: "PUT", path: `/v1/layouts/${r.id}`, json: { format: "spark/1", payload: this.payload() }, headers: withMatch ? { "If-Match": this.ifMatch(r.l, "spark") } : this.rng.chance(0.3) ? { "If-None-Match": "*" } : undefined, ...this.lane(u), user: u };
  }
  stepPatch() {
    const rng = this.rng;
    const r = this.layoutRef({ deleted: false });
    const u = this.ownerOf(r.l);
    const kind = rng.weighted([[5, "rename"], [3, "fingermap"], [1, "mixed"], [1, "empty"], [1, "alts"]]);
    let json;
    let scope = "layout";
    if (kind === "rename") json = { name: this.name() };
    else if (kind === "fingermap") (json = { format: "spark/1", fingermap: rng.chance(0.5) ? {} : { a: "LP" } }), (scope = "spark");
    else if (kind === "mixed") json = { name: this.name(), format: "spark/1", fingermap: {} };
    else if (kind === "alts") (json = { format: "spark/1", alts: [] }), (scope = "spark");
    else json = {};
    if (kind === "rename") this.names.push(json.name);
    return { label: `patch ${kind}`, method: "PATCH", path: `/v1/layouts/${r.id}`, json, headers: { "If-Match": this.ifMatch(r.l, scope) }, ...this.lane(u), user: u };
  }
  stepDelete() {
    const r = this.layoutRef();
    const u = this.rng.chance(0.15) ? ADMIN_ID : this.ownerOf(r.l);
    return { label: "delete", method: "DELETE", path: `/v1/layouts/${r.id}`, headers: { "If-Match": this.ifMatch(r.l) }, ...this.lane(u), user: u };
  }
  stepRestore() {
    const r = this.layoutRef({ deleted: true });
    const u = this.ownerOf(r.l);
    const json = this.rng.weighted([[5, undefined], [2, {}], [2, { name: this.name() }], [1, { bad: 1 }]]);
    return { label: "restore", method: "POST", path: `/v1/layouts/${r.id}/restore`, json, ...this.lane(u), user: u };
  }
  stepTransfer() {
    const r = this.layoutRef({ deleted: false });
    const u = this.ownerOf(r.l);
    return { label: "transfer", method: "POST", path: `/v1/layouts/${r.id}/transfer`, json: { to: this.anyUser() }, headers: { "If-Match": this.ifMatch(r.l) }, ...this.lane(u), user: u };
  }
  stepLink() {
    const rng = this.rng;
    const r = this.layoutRef();
    const u = this.user();
    const verb = rng.weighted([[6, "PUT"], [2, "GET"], [2, "DELETE"]]);
    const url = rng.pick(["https://example.com/fz", "https://example.com/fz2?x=1", "http://insecure.example.com", "https://user:pw@example.com", "ftp://x", "not a url", "https://example.com/" + "p".repeat(rng.pick([10, 3000]))]);
    return { label: `link ${verb}`, method: verb, path: `/v1/layouts/${r.id}/link`, json: verb === "PUT" ? { url } : undefined, ...this.lane(u), user: u };
  }
  stepWpm() {
    const rng = this.rng;
    const u = this.user();
    const kind = rng.weighted([[6, "submit"], [2, "receipt"], [2, "onbehalf"], [1, "read"]]);
    if (kind === "receipt") return { label: "wpm receipt", method: "GET", path: `/v1/wpm/submissions/${this.pending.wpm.length > 0 ? rng.pick(this.pending.wpm) : "nope"}`, ...this.lane(rng.chance(0.7) ? u : this.user()), user: u };
    if (kind === "read") {
      const r = this.layoutRef();
      return { label: "wpm read", method: "GET", path: rng.pick([`/v1/wpm?layout=${r.id}`, `/v1/wpm?user=${u}`, "/v1/wpm"]), conditional: true };
    }
    const r = this.layoutRef({ deleted: false });
    const wpm = rng.weighted([[8, rng.int(20, 220)], [1, 0], [1, 5000], [1, "fast"]]);
    const proof = rng.pick(["https://www.youtube.com/watch?v=fz1", "https://youtu.be/fz2", "not a url", "https://example.com/x.png"]);
    if (kind === "onbehalf") return { label: "wpm on behalf", method: "POST", path: "/v1/admin/wpm", json: { user_id: u, layout: r.id, wpm, proof }, ...this.lane(ADMIN_ID), user: ADMIN_ID };
    return { label: "wpm submit", method: "POST", path: "/v1/wpm", json: { layout: r.id, wpm, proof }, ...this.lane(u), user: u };
  }
  stepComment() {
    const rng = this.rng;
    const r = this.layoutRef();
    const u = this.user();
    const kind = rng.weighted([[5, "put"], [2, "like"], [1, "unlike"], [1, "delete"], [2, "read"], [1, "mine"]]);
    const body = rng.pick(["nice layout", "ünïcode ✓ comment", "x".repeat(2000), "x".repeat(2001), "  ", "line1\nline2", "<b>html</b>"]);
    if (kind === "put") return { label: "comment put", method: "PUT", path: `/v1/layouts/${r.id}/comment`, json: rng.chance(0.95) ? { body } : { body: 5 }, ...this.lane(u), user: u };
    if (kind === "delete") return { label: "comment delete", method: "DELETE", path: `/v1/layouts/${r.id}/comment`, ...this.lane(u), user: u };
    if (kind === "like" || kind === "unlike") return { label: `comment ${kind}`, method: kind === "like" ? "PUT" : "DELETE", path: `/v1/layouts/${r.id}/comments/${this.anyUser()}/like`, ...this.lane(u), user: u };
    if (kind === "mine") return { label: "my comments", method: "GET", path: "/v1/me/comments", ...this.lane(u), user: u };
    return { label: "comments read", method: "GET", path: rng.pick([`/v1/layouts/${r.id}/comments`, `/v1/layouts/${r.id}/comments?sort=newest`, `/v1/layouts/${r.id}/comment`, "/v1/comment-counts"]), ...(rng.chance(0.5) ? this.lane(u) : {}), conditional: true };
  }
  stepAdminQueueRead() {
    const kind = this.rng.pick(["link", "wpm", "comment"]);
    return { label: `${kind} queue`, method: "GET", path: `/v1/admin/${kind}-queue`, ...this.lane(ADMIN_ID), user: ADMIN_ID, observe: `queue:${kind}` };
  }
  stepModerate() {
    const rng = this.rng;
    const kind = rng.pick(["link", "wpm", "comment"]);
    const pool = this.pending[kind];
    const id = pool.length > 0 && rng.chance(0.9) ? rng.pick(pool) : "01JAB0000000000000000NONE0";
    const verb = rng.weighted(kind === "link" ? [[5, "approve"], [4, "reject"]] : kind === "wpm" ? [[4, "approve"], [3, "reject"], [2, "reopen"], [2, "history"]] : [[4, "approve"], [3, "reject"], [2, "reopen"], [2, "history"], [2, "remove"]]);
    const u = rng.chance(0.9) ? ADMIN_ID : this.user();
    const reviewVersion = rng.weighted([[6, 0], [3, 1], [1, 7]]);
    let json = {};
    let method = "POST";
    let path = `/v1/admin/${kind}-queue/${id}/${verb}`;
    if (verb === "reject") json = kind === "link" ? { reason: "fz" } : { reason: "fz", review_version: reviewVersion };
    else if (verb === "approve") json = kind === "link" ? {} : { review_version: reviewVersion };
    else if (verb === "reopen") json = { status: rng.pick(["approved", "rejected", "pending"]), review_version: reviewVersion };
    else if (verb === "remove") (path = `/v1/admin/comments/${id}/remove`), (json = { reason: "fz" });
    else if (verb === "history") (method = "GET"), (json = undefined);
    return { label: `${kind} ${verb}`, method, path, json, ...this.lane(u), user: u };
  }
  stepAdmin() {
    const rng = this.rng;
    const kind = rng.weighted([[3, "ban"], [3, "unban"], [1, "bans"], [3, "rename"], [2, "admin add"], [2, "admin remove"], [1, "admins"], [1, "clients"]]);
    const t = this.anyUser();
    const u = rng.chance(0.92) ? ADMIN_ID : this.user();
    const lane = this.lane(u);
    switch (kind) {
      case "ban": return { label: kind, method: "PUT", path: `/v1/admin/bans/${t}`, json: rng.chance(0.8) ? { reason: "fz" } : {}, ...lane, user: u };
      case "unban": return { label: kind, method: "DELETE", path: `/v1/admin/bans/${t}`, ...lane, user: u };
      case "bans": return { label: kind, method: "GET", path: "/v1/admin/bans", ...lane, user: u };
      case "rename": return { label: "author rename", method: "PUT", path: `/v1/admin/authors/${t}`, json: { name: rng.pick(["fz-author", "ünï-author", "", "x".repeat(70), "Same"]) }, ...lane, user: u };
      case "admin add": return { label: kind, method: "POST", path: "/v1/admin/admins", json: { user_id: t, note: "fz" }, ...lane, user: u };
      case "admin remove": return { label: kind, method: "DELETE", path: `/v1/admin/admins/${rng.chance(0.9) ? t : ADMIN_ID}`, ...lane, user: u };
      case "admins": return { label: kind, method: "GET", path: "/v1/admin/admins", ...lane, user: u };
      default: return { label: kind, method: "GET", path: "/v1/admin/clients", ...lane, user: u };
    }
  }
  stepDumpOrTick() {
    const rng = this.rng;
    if (rng.chance(0.5)) return { label: "dump write", method: "POST", path: "/v1/admin/dump", json: {}, ...this.lane(ADMIN_ID), user: ADMIN_ID };
    if (rng.chance(0.5)) return { label: "nightly tick", method: "POST", path: "/v1/admin/nightly/tick", json: {}, ...this.lane(ADMIN_ID), user: ADMIN_ID };
    return { label: "dump read", method: "GET", path: rng.pick(["/v1/dump", "/v1/dump/latest.json", "/v1/dump/dump-2026-10-25.json.gz", "/v1/dump/nope"]), conditional: true };
  }
  stepList() {
    const rng = this.rng;
    const sort = rng.pick(SORTS);
    const fmt = rng.weighted([[8, "spark/1"], [3, "mana2/1"], [1, "bogus/9"]]);
    const parts = [`format=${encodeURIComponent(fmt)}`, `sort=${sort}`, `limit=${rng.pick([1, 2, 3, 5, 10, 50, 97, 1000])}`];
    if (rng.chance(0.15)) parts.push(`has_magic=${rng.pick(["true", "false", "maybe"])}`);
    if (rng.chance(0.1)) parts.push("has_alts=true");
    if (rng.chance(0.1)) parts.push("has_combos=true");
    if (rng.chance(0.15)) parts.push(`owner=${this.anyUser()}`);
    if (rng.chance(0.12)) parts.push(`liked_by=${this.anyUser()}`);
    if (rng.chance(0.08)) parts.push("since=2026-10-25T12:00:00.000Z");
    if (rng.chance(0.06)) parts.push("full=1");
    const sig = parts.join("&");
    const cur = this.cursors.get(sig);
    const useCursor = cur !== undefined && rng.chance(0.85);
    const path = `/v1/layouts?${sig}${useCursor ? `&cursor=${encodeURIComponent(cur)}` : rng.chance(0.03) ? "&cursor=%25%25" : ""}`;
    return { label: "list", method: "GET", path, conditional: true, observe: `list:${sig}` };
  }
  stepChanges() {
    const rng = this.rng;
    const since = rng.weighted([[5, this.lastSeq], [2, 0], [2, Math.max(0, this.lastSeq - rng.int(1, 30))], [1, this.lastSeq + 5]]);
    const parts = [`since=${since}`, `limit=${rng.pick([1, 3, 10, 100, 1000])}`];
    if (rng.chance(0.2)) parts.push(`kinds=${encodeURIComponent(rng.pick(KINDS))}`);
    if (rng.chance(0.15) && this.layouts.size > 0) parts.push(`layout=${rng.pick([...this.layouts.keys()])}`);
    if (rng.chance(0.1)) parts.push(`actor=${this.anyUser()}`);
    if (rng.chance(0.02)) parts.push("wait=1");
    if (rng.chance(0.03)) parts.push("kinds=bogus");
    return { label: "changes", method: "GET", path: `/v1/changes?${parts.join("&")}`, conditional: true, observe: "changes" };
  }
  stepLayoutRead() {
    const rng = this.rng;
    const r = this.layoutRef();
    const fmt = rng.pick(["spark%2F1", "mana2%2F1", "bogus%2F9"]);
    const path = rng.weighted([
      [6, `/v1/layouts/${r.id}?format=${fmt}`],
      [2, `/v1/layouts/${r.id}`],
      [3, `/v1/layouts/${r.id}/history`],
      [1, `/v1/layouts/${r.id}/history?format=spark%2F1`],
      [3, `/v1/layouts/${r.id}/likes`],
      [3, `/v1/layouts/${r.id}/rev/${rng.int(1, 4)}?format=${fmt}`],
      [1, `/v1/layouts/${r.id}/link`],
    ]);
    return { label: "layout read", method: "GET", path, conditional: true };
  }
  stepMisc() {
    const rng = this.rng;
    const u = this.user();
    return rng.weighted([
      [3, { label: "meta", method: "GET", path: "/v1/meta", conditional: true }],
      [1, { label: "formats", method: "GET", path: "/v1/formats", conditional: true }],
      [1, { label: "schema", method: "GET", path: rng.pick(["/v1/formats/spark/1/schema.json", "/v1/formats/mana2/1/schema.json", "/v1/formats/nope/1/schema.json"]) }],
      [3, { label: "authors", method: "GET", path: rng.pick(["/v1/authors", "/v1/authors?by=name", `/v1/authors/${this.anyUser()}`]), conditional: true }],
      [3, { label: "me", method: "GET", path: "/v1/me", ...this.lane(u), user: u }],
      [1, { label: "changelog", method: "GET", path: rng.pick(["/admin/changelog", "/admin/changelog?kinds=created"]) }],
    ]);
  }
  stepAuthFailure() {
    const rng = this.rng;
    return rng.weighted([
      [3, { label: "unsigned write", method: "POST", path: "/v1/layouts", json: { name: "fz-nope", format: "spark/1", payload: { keys: [] } } }],
      [2, { label: "bad bearer", method: "GET", path: "/v1/me", headers: { Authorization: "Bearer nope" } }],
      [2, { label: "not admin", method: "GET", path: "/v1/admin/clients", ...this.lane(this.user()) }],
      [1, { label: "bad signature", method: "POST", path: "/v1/layouts", json: { name: "fz-nope", format: "spark/1", payload: { keys: [] } }, badSignature: true, actor: this.user() }],
    ]);
  }

  // ---- feedback -----------------------------------------------------------

  /** @param {object} step @param {{status:number, json:any, etag?:string}} res */
  observe(step, res) {
    const ok = res.status >= 200 && res.status < 300;
    const json = res.json;
    const layoutTok = (etag) => {
      const m = /^"(layout|spark|mana2|akl):(\d+)"$/.exec(etag ?? "");
      return m === null ? null : { scope: m[1], rev: Number(m[2]) };
    };
    if (ok && json !== null && typeof json === "object") {
      if (typeof json.id === "string" && typeof json.name === "string" && (step.path.startsWith("/v1/layouts") || step.label === "create")) {
        const prev = this.layouts.get(json.id) ?? { id: json.id, layoutRev: 1, sparkRev: 1 };
        const l = { ...prev, id: json.id, name: json.name, owner: json.owner ?? prev.owner ?? step.user, deleted: json.deleted === true || (json.deleted === 1) };
        if (typeof json.layout_rev === "number") l.layoutRev = json.layout_rev;
        const t = layoutTok(res.etag);
        if (t !== null) {
          if (t.scope === "layout") l.layoutRev = t.rev;
          else l.sparkRev = t.rev;
        }
        if (step.method === "DELETE") l.deleted = true;
        if (step.label === "restore") l.deleted = false;
        this.layouts.set(l.id, l);
        if (typeof l.name === "string") this.names.push(l.name);
      }
    }
    if (step.method === "DELETE" && ok && /^\/v1\/layouts\/[^/]+$/.test(step.path)) {
      const l = this.layouts.get(decodeURIComponent(step.path.split("/")[3]));
      if (l) l.deleted = true;
    }
    if (ok && step.observe?.startsWith("queue:")) {
      const kind = step.observe.slice(6);
      this.pending[kind] = ids(json).slice(0, 12);
    }
    if (ok && (step.label === "wpm submit" || step.label === "wpm on behalf") && json) this.pending.wpm.push(...ids(json).slice(0, 2));
    if (ok && step.label === "comment put" && json) this.pending.comment.push(...ids(json).slice(0, 2));
    if (ok && step.label === "link PUT" && json) this.pending.link.push(...ids(json).slice(0, 2));
    for (const k of Object.keys(this.pending)) this.pending[k] = this.pending[k].slice(-24);
    if (step.observe?.startsWith("list:")) {
      const sig = step.observe.slice(5);
      if (ok && typeof json?.next_cursor === "string") this.cursors.set(sig, json.next_cursor);
      else this.cursors.delete(sig);
    }
    if (step.observe === "changes" && ok && typeof json?.next === "number") this.lastSeq = Math.max(this.lastSeq, json.next);
    if (this.names.length > 40) this.names = this.names.slice(-40);
  }
}
