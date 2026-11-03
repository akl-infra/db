// Which GET requests the replay may send, and how each route class is judged (LDB-PV3, PV8).
//
// The replay sends PUBLIC GETs only: the routes below, no credentials of any kind. A path that is not listed (admin, /v1/me*,
// anything unknown, any method but GET) is never replayed; it is counted in the plan's "dropped" summary by reason.
//
// Judging. A route class is judged by the tables its answer reads:
//   feed   the answer depends only on tables the follower reproduces exactly (events, layouts, layout_formats, layout_revs,
//          likes): any difference is a diff, and the gate wants none.
//   static the answer is code (formats): no database.
//   state  the answer reads a table the follower replaces only from the daily public dump (authors, comments, comment likes,
//          wpm): it can legitimately differ after production changed that table since shadow's last dump, so a difference is
//          `diff-state` (reported, not gated) unless production shows no such change, and `skipped` when it does.
//   blob   dump files: compared by content; skipped when the two sides publish different dump generations.

/** [pattern, class name, judging group] in match order. */
const ROUTES = [
  [/^\/v1\/meta$/, "meta", "feed"],
  [/^\/v1\/formats$/, "formats", "static"],
  [/^\/v1\/formats\/[^/]+\/\d+\/schema\.json$/, "formats", "static"],
  [/^\/v1\/layouts$/, "layouts-list", "feed"],
  [/^\/v1\/layouts\/[^/]+$/, "layout", "feed"],
  [/^\/v1\/layouts\/[^/]+\/(?:likes|history)$/, "layout-sub", "feed"],
  [/^\/v1\/layouts\/[^/]+\/rev\/\d+$/, "layout-rev", "feed"],
  [/^\/v1\/layouts\/[^/]+\/comments$/, "layout-comments", "state"],
  [/^\/v1\/changes$/, "changes", "feed"],
  [/^\/v1\/authors$/, "authors", "state"],
  [/^\/v1\/authors\/[^/]+$/, "authors", "state"],
  [/^\/v1\/comment-counts$/, "comment-counts", "state"],
  [/^\/v1\/comments$/, "comments", "state"],
  [/^\/v1\/wpm$/, "wpm", "state"],
  [/^\/v1\/dump\/latest\.json$/, "dump-latest", "blob"],
  [/^\/v1\/dump$/, "dump-latest", "blob"],
  [/^\/v1\/dump\/(?:monthly\/)?dump-[\d-]+\.json\.gz$/, "dump-file", "blob"],
];

/** `{class, group}` for a public GET path (no query), or null when the path is not replayable. */
export function classify(path) {
  for (const [re, cls, group] of ROUTES) if (re.test(path)) return { class: cls, group };
  return null;
}

/** All class names, for the report's rows. */
export const CLASSES = [...new Set(ROUTES.map((r) => r[1]))];

/**
 * The event kinds whose occurrence in production means a STATE class may have moved since shadow's last dump. `authors` has no
 * event for most of its changes (a sign-in writes the author without one), so its class can only be informational.
 */
export const STATE_KINDS = {
  "layout-comments": ["comment_submitted", "comment_approved", "comment_rejected", "comment_reopened", "comment_removed", "comment_deleted", "comment_liked", "comment_unliked"],
  comments: ["comment_submitted", "comment_approved", "comment_rejected", "comment_reopened", "comment_removed", "comment_deleted", "comment_liked", "comment_unliked"],
  "comment-counts": ["comment_submitted", "comment_approved", "comment_rejected", "comment_reopened", "comment_removed", "comment_deleted", "comment_liked", "comment_unliked"],
  wpm: ["wpm_submitted", "wpm_approved", "wpm_rejected", "wpm_reopened"],
  authors: ["admin.author_renamed"],
};

/** Query parameters the replay never sends: `wait` holds a response open (and only matters to registered clients). */
export const DROPPED_PARAMS = new Set(["wait"]);

/**
 * A request's path and query, normalized for replay: `wait` dropped, parameters sorted so the same request is one request.
 * Returns null for a query that is not a plain query string.
 */
export function normalizeQuery(search) {
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  const kept = [...params.entries()].filter(([k]) => !DROPPED_PARAMS.has(k)).sort(([a, x], [b, y]) => (a < b ? -1 : a > b ? 1 : x < y ? -1 : x > y ? 1 : 0));
  if (kept.length === 0) return "";
  return `?${new URLSearchParams(kept).toString()}`;
}

/** The head seq in an ETag of the form `"<seq>:<hash>"` (weak or strong), or null. */
export function headOfEtag(etag) {
  const m = /^(?:W\/)?"(\d+):/.exec(etag ?? "");
  return m === null ? null : Number(m[1]);
}
