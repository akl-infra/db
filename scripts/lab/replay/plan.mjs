// Lane R: from Logpush requests + the before/after exports to a replay plan (design/aws-port.md §5.1).
// Logpush has no headers and no bodies, so for every request the plan decides: the actor (actors), the body (rebuilt
// from the window's events, the review history and the after-window export, matched by submission id), or a skip
// with a reason. The plan is pure data; run.mjs sends it.
import crypto from "node:crypto";
import { LAB_ADMIN, LAB_USER } from "./sign.mjs";

const ULID_RE = /^[0-9A-HJKMNP-TV-Za-hjkmnp-tv-z]{26}$/;
const lower = (s) => String(s).toLowerCase();
const ok2xx = (s) => s >= 200 && s < 300;
const json = (o) => Buffer.from(JSON.stringify(o));

/** A deterministic comment body of exactly `len` characters (letters and single spaces, no edge spaces). */
export function generatedBody(seed, len) {
  const n = Math.max(1, len);
  let out = "";
  let block = 0;
  while (out.length < n) {
    const h = crypto.createHash("sha256").update(`${seed}:${block++}`).digest();
    for (const b of h) {
      out += b % 7 === 0 ? " " : String.fromCharCode(97 + (b % 26));
      if (out.length >= n) break;
    }
  }
  out = out.slice(0, n);
  if (out.startsWith(" ")) out = `x${out.slice(1)}`;
  if (out.endsWith(" ")) out = `${out.slice(0, -1)}x`;
  return out.replace(/ {2,}/g, (m) => `${"y".repeat(m.length - 1)} `).slice(0, n);
}

/** `https://discord.com/channels/<guild|@me>/<channel>/<message>` -> the bind body, or null. */
export function parseMessageUrl(u) {
  const m = /\/channels\/(@me|\d{17,20})\/(\d{17,20})\/(\d{17,20})/.exec(String(u ?? ""));
  return m === null ? null : { guild_id: m[1] === "@me" ? null : m[1], channel_id: m[2], message_id: m[3] };
}

export class Planner {
  /**
   * @param {{before?: import("./exports.mjs").Export, after: import("./exports.mjs").Export}} ex
   * @param {{slackBeforeMs?: number, slackAfterMs?: number}} [opts]
   */
  constructor(ex, opts = {}) {
    this.before = ex.before ?? null;
    this.after = ex.after;
    this.slackBefore = opts.slackBeforeMs ?? 1500;
    this.slackAfter = opts.slackAfterMs ?? 3000;
    const floor = this.before?.maxSeq ?? 0;
    // The window's events: everything the after export holds past the before export's head.
    this.window = this.after.events.filter((e) => e.seq > floor);
    this.byKind = new Map();
    for (const e of this.window) (this.byKind.get(e.kind) ?? this.byKind.set(e.kind, []).get(e.kind)).push(e);
    this.consumed = new Set();
    // Full history (review counts need events from before the window too).
    const all = new Map();
    for (const e of [...(this.before?.events ?? []), ...this.after.events]) all.set(e.seq, e);
    this.history = [...all.values()].sort((a, b) => a.seq - b.seq);
    this.admins = [...new Set([...(this.before?.admins ?? []), ...this.after.admins])].sort();
    // name -> layout id as of the cursor, advanced in request order.
    this.names = new Map();
    this.idName = new Map();
    for (const l of (this.before ?? this.after).layouts.values()) if (!l.deleted) this.#claim(l.name, l.id);
    this.cursor = 0;
    this.cursorSeq = 0;
  }

  #claim(name, id) {
    const old = this.idName.get(id);
    if (old !== undefined && this.names.get(old) === id) this.names.delete(old);
    if (name === null || name === undefined) return;
    this.names.set(lower(name), id);
    this.idName.set(id, lower(name));
  }

  #advance(ts) {
    while (this.cursor < this.window.length && this.window[this.cursor].atMs <= ts) {
      const e = this.window[this.cursor++];
      if (["created", "renamed", "restored", "imported"].includes(e.kind) && e.layout_id) this.#claim(e.name ?? e.after?.name, e.layout_id);
      else if (e.kind === "deleted" && e.layout_id) {
        const n = this.idName.get(e.layout_id);
        if (n !== undefined && this.names.get(n) === e.layout_id) this.names.delete(n);
      }
    }
  }

  resolveRef(ref, ts) {
    this.#advance(ts);
    let r = ref;
    try {
      r = decodeURIComponent(ref);
    } catch {
      /* keep raw */
    }
    if (ULID_RE.test(r)) return r.toUpperCase();
    return this.names.get(lower(r)) ?? null;
  }

  /** The earliest unconsumed window event of `kinds` near the request, optionally for one layout. */
  take(kinds, req, { layoutId, pred, consume = true } = {}) {
    const lo = req.ts - this.slackBefore;
    const hi = req.ts + Math.max(req.wallMs, 0) + this.slackAfter;
    let best = null;
    for (const k of kinds) {
      for (const e of this.byKind.get(k) ?? []) {
        if (e.atMs < lo || this.consumed.has(e.seq)) continue;
        if (e.atMs > hi) break;
        if (layoutId !== undefined && layoutId !== null && e.layout_id !== layoutId) continue;
        if (pred !== undefined && !pred(e)) continue;
        if (best === null || e.seq < best.seq) best = e;
        break;
      }
    }
    if (best !== null && consume) this.consumed.add(best.seq);
    return best;
  }

  primaryAdmin() {
    return this.admins[0] ?? LAB_ADMIN;
  }

  revFor(e) {
    return this.after.revsByEventSeq.get(e.seq) ?? this.before?.revsByEventSeq.get(e.seq) ?? null;
  }

  /** Number of `<kind>_reopened` events for a submission before `seq` (the review_version a decision carried). */
  reviewVersion(family, id, seq) {
    let n = 0;
    for (const e of this.history) {
      if (e.seq >= seq) break;
      if (e.kind === `${family}_reopened` && e.detail?.submission_id === id) n++;
    }
    return n;
  }

  /** The status a reopen undid: the last approve/reject decision on the submission before `seq`. */
  statusBefore(family, id, seq) {
    let s = null;
    for (const e of this.history) {
      if (e.seq >= seq) break;
      if (e.detail?.submission_id !== id) continue;
      if (e.kind === `${family}_approved`) s = "approved";
      else if (e.kind === `${family}_rejected`) s = "rejected";
    }
    return s;
  }

  row(family, id) {
    const table = family === "wpm" ? "wpm" : family === "link" ? "links" : "comments";
    return this.after[table].get(id) ?? this.before?.[table].get(id) ?? null;
  }

  /**
   * Classify one logged request. Returns `{skip: reason}`, `{ignored: true}` or a spec
   * `{kind, method, path, query, body, headers, actor, mint, logged, notes}`.
   */
  plan(req) {
    const spec = this.#plan(req);
    if (spec.skip !== undefined || spec.ignored) return spec;
    return { notes: [], headers: {}, actor: null, body: null, mint: null, ...spec, method: req.method, path: req.path, query: req.query, logged: req };
  }

  #plan(req) {
    const p = req.path;
    if (!p.startsWith("/v1/") && !p.startsWith("/discord/")) return { ignored: true };
    if (p.startsWith("/discord/")) return { skip: "discord-interaction" };
    if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") return this.#read(req);
    if (req.outcome !== "" && req.outcome !== "ok") return { skip: "write-infra-error" };
    if (req.status === 0 || req.status >= 500) return { skip: "write-infra-error" };
    return this.#write(req);
  }

  // ---- reads ----------------------------------------------------------------------------------------------------

  #read(req) {
    const p = req.path;
    const spec = { kind: "read", actor: null };
    const waitMatch = /(?:^|[?&])wait=([^&]*)/.exec(req.query);
    if (p === "/v1/changes" && waitMatch !== null) {
      spec.kind = "longpoll";
      spec.actor = LAB_USER; // the wait gate needs a registered client; the lab client is one
      spec.notes = ["actor:lab (long-poll)"];
    } else if (p === "/v1/me" || p === "/v1/me/comments") {
      spec.actor = LAB_USER;
      spec.notes = ["actor:lab"];
    } else if (p.startsWith("/v1/admin/")) {
      spec.actor = this.primaryAdmin();
      spec.notes = ["actor:admin"];
    } else {
      let m = /^\/v1\/wpm\/submissions\/([^/]+)$/.exec(p);
      if (m !== null) {
        const row = this.row("wpm", m[1]);
        const ev = row === null ? this.history.find((e) => e.kind === "wpm_submitted" && e.detail?.submission_id === m[1]) : null;
        spec.actor = row?.submitted_by ?? ev?.actor ?? LAB_USER;
        spec.notes = [row !== null || ev ? "actor:submitter" : "actor:lab"];
      } else if ((m = /^\/v1\/layouts\/([^/]+)\/(comment|link)$/.exec(p)) !== null) {
        const id = this.resolveRef(m[1], req.ts);
        const l = id === null ? null : ((this.before ?? this.after).layouts.get(id) ?? this.after.layouts.get(id));
        spec.actor = l?.owner ?? LAB_USER;
        spec.notes = [l ? "actor:owner" : "actor:lab"];
      }
    }
    if (req.status === 304) spec.conditional304 = true;
    return spec;
  }

  // ---- writes ---------------------------------------------------------------------------------------------------

  #write(req) {
    const p = req.path;
    const m = req.method;
    let x;
    const lay = (re) => (x = re.exec(p));
    if (m === "POST" && p === "/v1/layouts") return this.#create(req);
    if (lay(/^\/v1\/layouts\/([^/]+)$/) && ["PUT", "PATCH", "DELETE"].includes(m)) return this.#layoutWrite(req, x[1]);
    if (lay(/^\/v1\/layouts\/([^/]+)\/restore$/) && m === "POST") return this.#simpleLayout(req, x[1], ["restored"], "layout", () => ({}));
    if (lay(/^\/v1\/layouts\/([^/]+)\/transfer$/) && m === "POST") return this.#transfer(req, x[1]);
    if (lay(/^\/v1\/layouts\/([^/]+)\/like$/) && ["PUT", "DELETE"].includes(m)) return this.#likeish(req, x[1], m === "PUT" ? "liked" : "unliked");
    if (lay(/^\/v1\/layouts\/([^/]+)\/comments\/([^/]+)\/like$/) && ["PUT", "DELETE"].includes(m)) return this.#likeish(req, x[1], m === "PUT" ? "comment_liked" : "comment_unliked", x[2]);
    if (lay(/^\/v1\/layouts\/([^/]+)\/link$/)) return m === "PUT" ? this.#linkSubmit(req, x[1]) : m === "DELETE" ? this.#bodiless(req, x[1], ["link_cleared"]) : { skip: "unknown-route" };
    if (lay(/^\/v1\/layouts\/([^/]+)\/comment$/)) return m === "PUT" ? this.#commentSubmit(req, x[1]) : m === "DELETE" ? this.#bodiless(req, x[1], ["comment_deleted"]) : { skip: "unknown-route" };
    if (m === "POST" && p === "/v1/wpm") return this.#wpmSubmit(req);
    if (m === "POST" && p === "/v1/admin/wpm") return this.#wpmOnBehalf(req);
    if (lay(/^\/v1\/wpm\/submissions\/([^/]+)\/discord-message$/) && m === "PUT") return this.#bind(req, x[1]);
    if (lay(/^\/v1\/admin\/(link|wpm|comment)-queue\/([^/]+)\/(approve|reject|reopen)$/) && m === "POST") return this.#decision(req, x[1], x[2], x[3]);
    if (lay(/^\/v1\/admin\/comments\/([^/]+)\/remove$/) && m === "POST") return this.#decision(req, "comment", x[1], "remove");
    if (lay(/^\/v1\/admin\/bans\/([^/]+)$/)) return this.#ban(req, x[1]);
    if (lay(/^\/v1\/admin\/authors\/([^/]+)$/) && m === "PUT") return this.#authorRename(req, x[1]);
    if (p === "/v1/admin/admins" && m === "POST") return this.#adminAdd(req);
    if (lay(/^\/v1\/admin\/admins\/([^/]+)$/) && m === "DELETE") return { actor: this.primaryAdmin(), body: null, notes: ["actor:admin"], kind: "write" };
    if (["/v1/admin/nightly/tick", "/v1/admin/dump", "/v1/admin/discord-users/refresh"].includes(p) && m === "POST") return { kind: "write", actor: this.primaryAdmin(), body: json({}), notes: ["actor:admin"] };
    if (p.startsWith("/v1/admin/clients") || p === "/v1/admin/magic-seed" || p === "/v1/admin/relabel-magic-thumbs") return { skip: "rare-admin-pack" };
    return { skip: "unknown-route" };
  }

  #ifMatchFor(req, e, scopeHint) {
    // A success carries the token of the rev BEFORE the event. A logged 412/428 is replayed so it fails the same way.
    if (req.status === 428) return {};
    if (req.status === 412) return { "If-Match": `"${scopeHint ?? "layout"}:0"` };
    if (e === null) return { "If-Match": "*" };
    const a = e.after;
    if (a?.scope === "format" && typeof (a.rev ?? e.rev) === "number" && (a.rev ?? e.rev) > 1) return { "If-Match": `"${a.lineage}:${(a.rev ?? e.rev) - 1}"` };
    if (a?.scope === "layout" && typeof a.layout_rev === "number" && a.layout_rev > 1) return { "If-Match": `"layout:${a.layout_rev - 1}"` };
    return { "If-Match": "*" };
  }

  #create(req) {
    const e = ok2xx(req.status) ? this.take(["created"], req) : null;
    if (e === null) return { skip: ok2xx(req.status) ? "write-no-event" : "failed-write-unrebuildable" };
    const fmt = this.window.find((x) => x.layout_id === e.layout_id && x.seq >= e.seq && x.after?.scope === "format") ?? e;
    const rev = this.revFor(fmt) ?? this.revFor(e);
    if (rev === null) return { skip: "no-rev-for-event" };
    const payload = JSON.parse(rev.payload_json);
    return { kind: "write", actor: e.actor, body: json({ name: e.name ?? e.after?.name, format: rev.format, payload }), mint: { kind: "layout", orig: e.layout_id }, notes: ["body:rev"] };
  }

  #layoutWrite(req, ref) {
    const id = this.resolveRef(ref, req.ts);
    if (id === null) return { skip: "unresolved-ref" };
    const m = req.method;
    if (m === "DELETE") return this.#simpleLayout(req, ref, ["deleted"], "layout", null, id);
    if (!ok2xx(req.status)) return { skip: "failed-write-unrebuildable" };
    const kinds = m === "PUT" ? ["updated", "format_added"] : ["renamed", "fingermap", "updated", "format_added"];
    let e = this.take(kinds, req, { layoutId: id });
    if (e === null) return { skip: "write-no-event" };
    // A format write emits a layout-scope event too; the format-scope one carries the payload.
    const rev = this.revFor(e) ?? this.revFor(this.window.find((x) => x.layout_id === id && x.after?.scope === "format" && Math.abs(x.atMs - e.atMs) < 1) ?? e);
    if (m === "PUT") {
      if (rev === null) return { skip: "no-rev-for-event" };
      return { kind: "write", actor: e.actor, body: json({ format: rev.format, payload: JSON.parse(rev.payload_json) }), headers: this.#ifMatchFor(req, e.kind === "format_added" ? null : e), notes: ["body:rev"] };
    }
    if (e.kind === "renamed") return { kind: "write", actor: e.actor, body: json({ name: e.name ?? e.after?.name }), headers: this.#ifMatchFor(req, e, "layout"), notes: ["body:event"] };
    if (rev === null) return { skip: "no-rev-for-event" };
    const payload = JSON.parse(rev.payload_json);
    const edit = {};
    for (const k of ["fingermap", "magic", "alts", "combos"]) if (payload?.[k] !== undefined) edit[k] = payload[k];
    if (Object.keys(edit).length === 0) return { skip: "patch-shape" };
    return { kind: "write", actor: e.actor, body: json({ format: rev.format, ...(e.kind === "fingermap" ? { fingermap: edit.fingermap } : edit) }), headers: this.#ifMatchFor(req, e), notes: ["body:rev"] };
  }

  #simpleLayout(req, ref, kinds, scope, bodyFn, idArg) {
    const id = idArg ?? this.resolveRef(ref, req.ts);
    if (id === null) return { skip: "unresolved-ref" };
    const e = ok2xx(req.status) ? this.take(kinds, req, { layoutId: id }) : null;
    if (ok2xx(req.status) && e === null) return { skip: "write-no-event" };
    return {
      kind: "write",
      actor: e?.actor ?? LAB_USER,
      body: bodyFn === null ? null : json(bodyFn(e)),
      headers: bodyFn === null ? this.#ifMatchFor(req, e, scope) : {},
      notes: [e ? "body:event" : "actor:lab"],
    };
  }

  #transfer(req, ref) {
    const id = this.resolveRef(ref, req.ts);
    if (id === null) return { skip: "unresolved-ref" };
    const e = ok2xx(req.status) ? this.take(["transferred"], req, { layoutId: id }) : null;
    if (ok2xx(req.status) && e === null) return { skip: "write-no-event" };
    const to = e?.after?.owner ?? e?.owner ?? LAB_USER;
    return { kind: "write", actor: e?.actor ?? LAB_USER, body: json({ to }), headers: this.#ifMatchFor(req, e, "layout"), notes: [e ? "body:event" : "actor:lab"] };
  }

  #likeish(req, ref, kind, authorId) {
    const id = this.resolveRef(ref, req.ts);
    if (id === null) return { skip: "unresolved-ref" };
    // A like that changed nothing (already liked) logs no event: replay it as the lab actor.
    const e = this.take([kind], req, { layoutId: id, pred: authorId === undefined ? undefined : (x) => x.detail?.author_id === authorId });
    // Else the most recent actor of the same kind on this layout (so the repeat stays the no-op it was), else the lab actor.
    let prior = null;
    if (e === null) {
      for (const h of this.history) {
        if (h.atMs > req.ts) break;
        if (h.kind === kind && h.layout_id === id && (authorId === undefined || h.detail?.author_id === authorId)) prior = h.actor;
      }
    }
    return { kind: "write", actor: e?.actor ?? prior ?? LAB_USER, body: null, notes: [e ? "actor:event" : prior ? "actor:prior" : "actor:lab"] };
  }

  #bodiless(req, ref, kinds) {
    const id = this.resolveRef(ref, req.ts);
    if (id === null) return { skip: "unresolved-ref" };
    const e = this.take(kinds, req, { layoutId: id });
    if (e === null && ok2xx(req.status)) return { skip: "write-no-event" };
    return { kind: "write", actor: e?.actor ?? LAB_USER, body: null, notes: [e ? "actor:event" : "actor:lab"] };
  }

  #linkSubmit(req, ref) {
    const id = this.resolveRef(ref, req.ts);
    if (id === null) return { skip: "unresolved-ref" };
    const e = ok2xx(req.status) ? this.take(["link_submitted"], req, { layoutId: id }) : null;
    if (e === null) return { skip: ok2xx(req.status) ? "write-no-event" : "failed-write-unrebuildable" };
    const sid = e.detail?.submission_id;
    const url = this.row("link", sid)?.url ?? e.detail?.url;
    if (typeof url !== "string") return { skip: "submit-body-unmatched" };
    return { kind: "write", actor: e.actor, body: json({ url }), mint: { kind: "submission", orig: sid }, notes: ["body:export"] };
  }

  #commentSubmit(req, ref) {
    const id = this.resolveRef(ref, req.ts);
    if (id === null) return { skip: "unresolved-ref" };
    const e = ok2xx(req.status) ? this.take(["comment_submitted"], req, { layoutId: id }) : null;
    if (e === null) return { skip: ok2xx(req.status) ? "write-no-event" : "failed-write-unrebuildable" };
    const sid = e.detail?.submission_id;
    const row = this.row("comment", sid);
    if (row === null) return { skip: "submit-body-unmatched" };
    let body = row.body;
    const notes = ["body:export"];
    if (body === null || body === undefined) {
      // Erased afterwards: a generated body of the same length. The length is not in the export; the request's byte
      // size (when Logpush carries one) minus the `{"body":""}` envelope, else a fixed default, noted in the report.
      const len = typeof row.body_length === "number" ? row.body_length : typeof req.bytes === "number" ? req.bytes - 11 : 40;
      body = generatedBody(sid ?? row.id, len);
      notes.push(typeof row.body_length === "number" || typeof req.bytes === "number" ? "body:generated" : "body:generated-default-length");
    }
    return { kind: "write", actor: e.actor, body: json({ body }), mint: { kind: "submission", orig: sid }, notes };
  }

  #wpmSubmit(req) {
    const e = ok2xx(req.status) ? this.take(["wpm_submitted"], req) : null;
    if (e === null) return { skip: ok2xx(req.status) ? "write-no-event" : "failed-write-unrebuildable" };
    const sid = e.detail?.submission_id;
    const row = this.row("wpm", sid);
    if (row === null) return { skip: "submit-body-unmatched" };
    return { kind: "write", actor: e.actor, body: json({ layout: e.layout_id ?? row.layout_id, wpm: row.wpm, proof: row.proof }), mint: { kind: "submission", orig: sid }, notes: ["body:export"] };
  }

  #wpmOnBehalf(req) {
    const submitted = new Set(this.history.filter((x) => x.kind === "wpm_submitted").map((x) => x.detail?.submission_id));
    const e = ok2xx(req.status) ? this.take(["wpm_approved"], req, { pred: (x) => !submitted.has(x.detail?.submission_id) && x.detail?.proof !== undefined }) : null;
    if (e === null) return { skip: ok2xx(req.status) ? "write-no-event" : "failed-write-unrebuildable" };
    const d = e.detail;
    return { kind: "write", actor: e.actor, body: json({ user_id: d.user_id, layout: e.layout_id, wpm: d.wpm, proof: d.proof }), mint: { kind: "submission", orig: d.submission_id }, notes: ["body:event"] };
  }

  #bind(req, sid) {
    const row = this.row("wpm", sid);
    const body = parseMessageUrl(row?.source_message_url);
    if (body === null) return { skip: "submit-body-unmatched" };
    return { kind: "write", actor: row.submitted_by ?? LAB_USER, body: json(body), notes: ["body:export", "actor:submitter"] };
  }

  #decision(req, family, id, action) {
    const kinds = action === "reject" ? [`${family}_rejected`] : action === "approve" ? [`${family}_approved`] : action === "reopen" ? [`${family}_reopened`] : [`${family}_removed`];
    const e = this.take(kinds, req, { pred: (x) => x.detail?.submission_id === id });
    const row = this.row(family, id);
    const actor = e?.actor ?? this.primaryAdmin();
    const seq = e?.seq ?? Number.MAX_SAFE_INTEGER;
    const reason = row?.reason ?? "replay";
    const rv = this.reviewVersion(family, id, seq);
    let body;
    if (family === "link") body = action === "reject" ? { reason } : {};
    else if (action === "approve") body = { review_version: rv };
    else if (action === "reject") body = { reason, review_version: rv };
    else if (action === "reopen") {
      const status = this.statusBefore(family, id, seq) ?? (row?.status === "rejected" ? "rejected" : "approved");
      body = { status, review_version: rv };
    } else body = { reason };
    return { kind: "write", actor, body: json(body), notes: [e ? "actor:event" : "actor:admin", "body:history"] };
  }

  #ban(req, uid) {
    const kind = req.method === "PUT" ? "admin.user_banned" : "admin.user_unbanned";
    const e = this.take([kind], req, { pred: (x) => x.detail?.user_id === uid });
    const reason = e?.detail?.reason;
    return { kind: "write", actor: e?.actor ?? this.primaryAdmin(), body: req.method === "PUT" ? json(typeof reason === "string" ? { reason } : {}) : null, notes: [e ? "actor:event" : "actor:admin"] };
  }

  #authorRename(req, uid) {
    const e = this.take(["admin.author_renamed"], req, { pred: (x) => x.detail?.user_id === uid });
    const name = e?.detail?.to ?? this.after.authors.get(uid)?.name;
    if (typeof name !== "string") return { skip: "submit-body-unmatched" };
    return { kind: "write", actor: e?.actor ?? this.primaryAdmin(), body: json({ name }), notes: ["body:event"] };
  }

  #adminAdd(req) {
    const e = ok2xx(req.status) ? this.take(["admin.added"], req) : null;
    if (e === null) return { skip: ok2xx(req.status) ? "write-no-event" : "failed-write-unrebuildable" };
    const d = e.detail ?? {};
    return { kind: "write", actor: e.actor, body: json(d.note ? { user_id: d.user_id, note: d.note } : { user_id: d.user_id }), notes: ["body:event"] };
  }
}

/** Plan a whole sorted request list. Returns `{items, skipped, ignored}`. */
export function buildPlan(requests, ex, opts = {}) {
  const planner = new Planner(ex, opts);
  const items = [];
  const skipped = [];
  let ignored = 0;
  requests.forEach((req, i) => {
    const s = planner.plan(req);
    if (s.ignored) ignored++;
    else if (s.skip !== undefined) skipped.push({ reason: s.skip, req });
    else items.push({ i, ...s });
  });
  return { items, skipped, ignored, considered: requests.length - ignored };
}
