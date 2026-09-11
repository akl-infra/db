// GET /admin/changelog (03 §7, 12 §3 X3): the public, read-only, no-JS
// rendering of the event feed. A rendering, never a second source of truth
// (LDB-H3): every row comes from the same `feed()` call `/v1/changes`
// itself uses, filtered by the exact same `layout=`/`actor=` resolution
// (`resolveLayoutFilter`, `routes/changes.ts`) -- the two routes can never
// disagree about what a filter means. No auth (same posture as
// `/v1/changes`); not rendered into the nightly dump (12 §7: nobody reads a
// static HTML snapshot in R2, the dump is a restore artifact).
import { Hono } from "hono";
import type { Bindings } from "../env";
import { cachePut, conditional, etagFor, headSeq } from "../core/etag";
import { feed, type Event, type FeedFilter } from "../core/events";
import { parseKinds, parseSince, resolveLayoutFilter } from "./changes";

const CACHE_CONTROL = "public, max-age=10";
// 12 §3 X3: "limit fixed at 100" -- unlike `/v1/changes`, this route takes
// no `limit` query param at all.
const PAGE_SIZE = 100;

// Every interpolated string goes through this one function (12 §3 X3: "0.1
// measured `<`/`>` in live names") -- `renderRow`/`renderPage` never
// interpolate a DB-sourced string without it.
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// `renamed`/`transferred` are always LAYOUT-scope kinds (21-formats.md
// §2.2) -- `before`/`after` are `LayoutSnapshot`s whenever they fire, so
// the scope check below is a type guard, not a real "could be a format
// event" case.
function fmtChange(e: Event): string {
  if (e.kind === "renamed" && e.before?.scope === "layout" && e.after?.scope === "layout") {
    return `${escapeHtml(e.before.name)} &rarr; ${escapeHtml(e.after.name)}`;
  }
  if (e.kind === "transferred" && e.before?.scope === "layout" && e.after?.scope === "layout") {
    return `${escapeHtml(e.before.owner)} &rarr; ${escapeHtml(e.after.owner)}`;
  }
  return "";
}

// `data-seq` is load-bearing, not decorative: `tests/api/changelog.test.ts`
// extracts it to prove the rendered row set equals `/v1/changes`' own
// `items` for the same params (LDB-H3).
function renderRow(e: Event): string {
  const nameCell =
    e.layout_id !== null && e.name !== null
      ? `<a href="/v1/layouts/${encodeURIComponent(e.layout_id)}">${escapeHtml(e.name)}</a>`
      : "";
  return `<tr data-seq="${e.seq}">
    <td>${e.seq}</td>
    <td>${escapeHtml(e.at)}</td>
    <td>${escapeHtml(e.kind)}</td>
    <td>${nameCell}</td>
    <td>${escapeHtml(e.actor)}</td>
    <td>${escapeHtml(e.via)}</td>
    <td>${e.rev ?? ""}</td>
    <td>${e.admin ? '<span class="admin">admin</span>' : ""}</td>
    <td>${fmtChange(e)}</td>
  </tr>`;
}

function renderPage(opts: {
  items: Event[];
  newerHref: string;
  olderHref: string;
  kindsRaw: string;
  layoutRaw: string;
  actorRaw: string;
}): string {
  // Newest-first (12 §3 X3): `feed()` itself always returns ascending by
  // `seq` (`core/events.ts`) -- the reversal is display-only, here.
  const rows = [...opts.items].reverse().map(renderRow).join("\n");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>akl-db changelog</title>
<style>
  body { font: 14px/1.4 -apple-system, system-ui, sans-serif; margin: 2rem; color: #111; background: #fff; }
  h1 { font-size: 1.1rem; }
  table { border-collapse: collapse; width: 100%; }
  th, td { border-bottom: 1px solid #ddd; padding: 0.3rem 0.6rem; text-align: left; font-size: 13px; white-space: nowrap; }
  th { background: #f5f5f5; }
  .admin { color: #a00; font-weight: bold; }
  form { margin-bottom: 1rem; }
  form input { margin-right: 0.5rem; }
  nav a { margin-right: 1rem; }
</style>
</head>
<body>
<h1>akl-db changelog</h1>
<form method="get" action="/admin/changelog">
  <input type="text" name="kinds" placeholder="kinds (comma-separated)" value="${escapeHtml(opts.kindsRaw)}">
  <input type="text" name="layout" placeholder="layout (id or name)" value="${escapeHtml(opts.layoutRaw)}">
  <input type="text" name="actor" placeholder="actor" value="${escapeHtml(opts.actorRaw)}">
  <button type="submit">filter</button>
</form>
<nav>
  <a href="${escapeHtml(opts.newerHref)}">newer</a>
  <a href="${escapeHtml(opts.olderHref)}">older</a>
</nav>
<table>
<thead><tr><th>seq</th><th>at</th><th>kind</th><th>name</th><th>actor</th><th>via</th><th>rev</th><th></th><th>change</th></tr></thead>
<tbody>
${rows}
</tbody>
</table>
</body>
</html>
`;
}

export const changelogRoute = new Hono<{ Bindings: Bindings }>();

changelogRoute.get("/admin/changelog", async (c) => {
  const db = c.env.DB;
  const head = await headSeq(db);

  const sinceRaw = c.req.query("since");
  // 12 §3 X3: "default max(0, head - 100) so the first page is the newest
  // 100" -- an explicit `since=` (from a nav link, or hand-edited) overrides
  // it exactly like `/v1/changes`' own `parseSince`.
  const since = sinceRaw !== undefined ? parseSince(sinceRaw) : Math.max(0, head - PAGE_SIZE);
  const kindsRawParam = c.req.query("kinds");
  const kinds = parseKinds(kindsRawParam);
  const actor = c.req.query("actor");
  const layoutRawParam = c.req.query("layout");
  const layoutId = await resolveLayoutFilter(db, layoutRawParam);
  const filter: FeedFilter = { layoutId, actor };

  const etag = await etagFor(head, { page: { since, kinds: kinds ?? null, layout: layoutId ?? null, actor: actor ?? null } });
  const short = await conditional(c, etag, CACHE_CONTROL);
  if (short) return short;

  const { next, items } = await feed(db, since, PAGE_SIZE, kinds, filter);

  // `newer`/`older` links (12 §3 X3): "?since=<last seq>" / "?since=<max(0,
  // pageStart - 100)>" -- `next` IS "last seq" (core/events.ts's own
  // definition: the last seq returned, or `since` unchanged when the page
  // was empty). Every other active filter rides along unchanged.
  const carried = new URLSearchParams();
  if (kindsRawParam !== undefined) carried.set("kinds", kinds!.join(","));
  if (layoutRawParam !== undefined) carried.set("layout", layoutRawParam);
  if (actor !== undefined) carried.set("actor", actor);

  const newerQuery = new URLSearchParams(carried);
  newerQuery.set("since", String(next));
  const olderQuery = new URLSearchParams(carried);
  olderQuery.set("since", String(Math.max(0, since - PAGE_SIZE)));

  const html = renderPage({
    items,
    newerHref: `/admin/changelog?${newerQuery.toString()}`,
    olderHref: `/admin/changelog?${olderQuery.toString()}`,
    kindsRaw: kindsRawParam ?? "",
    layoutRaw: layoutRawParam ?? "",
    actorRaw: actor ?? "",
  });

  const res = new Response(html, {
    headers: { "Content-Type": "text/html; charset=utf-8", ETag: etag, "Cache-Control": CACHE_CONTROL },
  });
  await cachePut(c, res.clone());
  return res;
});
