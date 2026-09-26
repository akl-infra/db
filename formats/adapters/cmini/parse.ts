// Parsing a raw cmini upstream detail object into the shape this adapter's
// own `fromCmini`/`validate` expect (moved here from the now-deleted
// `src/import/apply.ts` when the cmini importer was removed -- this is the
// one piece of that file that was pure parsing/shaping logic, not an
// importer behaviour, so it lives on as part of the adapter itself: reading
// one upstream detail object and validating/shaping it is a legitimate
// thing a future consumer of the cmini format might still want to do, even
// with no importer left to call it automatically).
import * as cmini1 from "./index.ts";

// A Discord snowflake as cmini's API sends it: a JSON number or a numeric
// string (the API's v2 fix for consumers whose numbers are IEEE doubles,
// which lose precision above 2**53). Returns the value as a decimal string
// (never a JS number) or null if `value` is neither. Booleans are excluded:
// `typeof true === "boolean"`, not reachable via the `number`/`string`
// branches, but called out explicitly to match the ported behaviour
// (`isinstance(True, int)` is True in Python).
export function parseSnowflake(value: unknown): string | null {
  if (typeof value === "boolean") return null;
  if (typeof value === "number") return Number.isInteger(value) ? String(value) : null;
  if (typeof value === "string" && /^[0-9]+$/.test(value)) return value;
  return null;
}

export type RawUpstreamDetail = Record<string, unknown>;

const RECORD_FIELDS = new Set(["name", "user", "likes", "created_at", "modified_at"]);
// LDB-I10 (M1): cmini's magic is never akl.gg's -- dropped here, before
// validation, so it can never reach `ParsedUpstreamDetail.payload` at all.
const IMPORT_DROPPED_FIELDS = new Set(["magic"]);

export interface ParsedUpstreamDetail {
  name: string;
  owner: string; // snowflake, as text
  created_at: string;
  modified_at: string;
  likes: string[]; // snowflakes, as text
  payload: cmini1.Payload;
}

export interface ShapeErr {
  path: string;
  message: string;
}

export type ParseResult = { ok: true; detail: ParsedUpstreamDetail } | { ok: false; error: ShapeErr };

function payloadFromRaw(raw: RawUpstreamDetail): unknown {
  const payload: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (!RECORD_FIELDS.has(k) && !IMPORT_DROPPED_FIELDS.has(k)) payload[k] = v;
  }
  return payload;
}

export function parseUpstreamDetail(raw: unknown): ParseResult {
  if (typeof raw !== "object" || raw === null) {
    return { ok: false, error: { path: "/", message: "detail response is not an object" } };
  }
  const r = raw as Record<string, unknown>;

  if (typeof r.name !== "string") {
    return { ok: false, error: { path: "/name", message: "missing or non-string 'name'" } };
  }
  const owner = parseSnowflake(r.user);
  if (owner === null) {
    return { ok: false, error: { path: "/user", message: "missing or invalid 'user' (not a snowflake)" } };
  }
  if (typeof r.created_at !== "string") {
    return { ok: false, error: { path: "/created_at", message: "missing or non-string 'created_at'" } };
  }
  if (typeof r.modified_at !== "string") {
    return { ok: false, error: { path: "/modified_at", message: "missing or non-string 'modified_at'" } };
  }

  const likes: string[] = [];
  if (r.likes !== undefined) {
    if (!Array.isArray(r.likes)) {
      return { ok: false, error: { path: "/likes", message: "'likes' is not an array" } };
    }
    for (const u of r.likes) {
      const s = parseSnowflake(u);
      if (s === null) return { ok: false, error: { path: "/likes", message: "'likes' contains a non-snowflake value" } };
      likes.push(s);
    }
  }

  const payload = payloadFromRaw(r);
  const check = cmini1.validate(payload);
  if (!check.ok) {
    const path = typeof check.error.path === "string" ? check.error.path : "/";
    return { ok: false, error: { path, message: check.error.message } };
  }

  return {
    ok: true,
    detail: {
      name: r.name,
      owner,
      created_at: r.created_at,
      modified_at: r.modified_at,
      likes,
      payload: payload as cmini1.Payload,
    },
  };
}
