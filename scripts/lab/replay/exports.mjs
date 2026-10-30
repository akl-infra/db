// Lane R: the private exports the replay rebuilds bodies from. An export is `RowsByTable` JSON (the shape
// `exportRows` returns and `/__lab/export` serves; optionally gzip, optionally wrapped as `{tables}`), or a public
// `Dump` (`records` for `layouts`). The BEFORE export is the state the window started from; the AFTER export, taken
// just after the window, holds the rows the events point at (submissions, comment text, discord message urls).
import fs from "node:fs";
import zlib from "node:zlib";

export function readJsonMaybeGz(file) {
  const raw = fs.readFileSync(file);
  return JSON.parse((raw[0] === 0x1f && raw[1] === 0x8b ? zlib.gunzipSync(raw) : raw).toString("utf8"));
}

export function normalizeTables(x) {
  const t = x !== null && typeof x === "object" && x.tables !== undefined ? x.tables : x;
  const out = { ...t };
  if (out.layouts === undefined && out.records !== undefined) out.layouts = out.records;
  return out;
}

const parseJson = (s) => {
  if (s === null || s === undefined) return null;
  if (typeof s !== "string") return s;
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
};

const rows = (t, name) => (Array.isArray(t[name]) ? t[name] : []);

export class Export {
  constructor(tables) {
    this.t = normalizeTables(tables ?? {});
    this.layouts = new Map(rows(this.t, "layouts").map((r) => [r.id, r]));
    this.events = rows(this.t, "events").slice().sort((a, b) => a.seq - b.seq);
    for (const e of this.events) {
      e.detail = parseJson(e.detail_json);
      e.after = parseJson(e.after_json);
      e.before = parseJson(e.before_json);
      e.atMs = Date.parse(e.at);
    }
    this.maxSeq = this.events.length === 0 ? 0 : this.events[this.events.length - 1].seq;
    this.revsByEventSeq = new Map(rows(this.t, "layout_revs").map((r) => [r.event_seq, r]));
    this.wpm = new Map(rows(this.t, "wpm_submissions").map((r) => [r.id, r]));
    this.links = new Map(rows(this.t, "link_submissions").map((r) => [r.id, r]));
    this.comments = new Map(rows(this.t, "layout_comments").map((r) => [r.id, r]));
    this.admins = rows(this.t, "admins").map((r) => r.user_id).sort();
    this.authors = new Map(rows(this.t, "authors").map((r) => [r.user_id, r]));
  }
}

export function loadExport(fileOrTables) {
  return new Export(typeof fileOrTables === "string" ? readJsonMaybeGz(fileOrTables) : fileOrTables);
}
