#!/usr/bin/env node
// Renders db/docs/adoption.md into src/generated/docs.html.ts at build time
// (design/akldb-site/01-plan.md S8): an fs read of a sibling file inside
// db/, never an import specifier pointing into it -- an import like
// `import raw from '../../docs/adoption.md'` is exactly what LDB-G5's
// boundary scan (db/tests/tools/boundary.test.ts, extended per §4.7 item
// 16 for db/site/**) flags as a crossing. Precedent: scripts/
// assemble_dist.mjs's own fs read of design/layout-db/build_site.mjs.
//
// The generated file, and the raw-markdown copy under public/ (W1c,
// below), are both gitignored (.gitignore) and produced fresh by
// `predev`/`prebuild`/`pretest`/`pretypecheck` -- never committed, never
// stale. Fails LOUDLY (non-zero exit) if the source is missing, per the
// plan's own words: "never a silent empty page".
//
// W1c additions (design/akldb-site Docs overhaul): alongside the rendered
// HTML, this script also
//  1. writes the RAW markdown into public/adoption.md, which Vite copies
//     verbatim into dist/ -- so `curl https://akldb.org/adoption.md` serves
//     byte-identical content to db/docs/adoption.md (SITE-30), and the
//     page's own "Copy as Markdown" button (Docs.tsx) has an exact string
//     to hand to the clipboard (SITE-32) with no second fetch;
//  2. parses §9's own endpoint table (the same pipe table
//     db/tests/tools/docs-site.test.ts's LDB-G10 checks against the live
//     router) into a small, typed array Docs.tsx renders as the on-page
//     endpoint brief (SITE-31) -- method/path/auth/success/errors read
//     straight off the table, never hand-copied; only the one-line
//     `purpose` per route is authored here (ENDPOINT_PURPOSES below), the
//     same "documentation content, not site chrome" bucket the guide's own
//     prose already sits in (outside src/copy.ts, SITE-5's copy-scan
//     explicitly does not walk this file or src/generated/); a route with
//     no entry fails the build rather than silently shipping a blank cell;
//  3. demotes the guide's own leading `<h1>` (the markdown's title) to
//     `<h2>` -- the rendered guide is embedded inside the Docs page, which
//     has exactly one `<h1>` of its own (SITE-34); every other heading in
//     the guide is already `##`/`###`, so only the first line needs this;
//  4. extracts the production base URL from the guide's own fenced
//     "production   https://..." line, so the brief's "Base URL" line is
//     read from the guide too, never retyped.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { marked } from "marked";

const here = path.dirname(fileURLToPath(import.meta.url));
const SOURCE = path.resolve(here, "..", "..", "docs", "adoption.md");
const OUT_DIR = path.resolve(here, "..", "src", "generated");
const OUT_FILE = path.join(OUT_DIR, "docs.html.ts");
const PUBLIC_DIR = path.resolve(here, "..", "public");
const PUBLIC_FILE = path.join(PUBLIC_DIR, "adoption.md");

if (!existsSync(SOURCE)) {
  console.error(`build-docs: source file missing: ${SOURCE}`);
  console.error("db/docs/adoption.md must exist for the Docs page to render -- refusing to write an empty page.");
  process.exit(1);
}

const markdown = readFileSync(SOURCE, "utf8");

// ── §9's endpoint table, parsed the same way LDB-G10 locates it: by its
// header row's exact cells, never a comment marker (adoption.md renders
// through a plain-markdown pipeline elsewhere too, with no raw-HTML-comment
// passthrough to hide a marker in). ─────────────────────────────────────
function findPipeTable(md, headerCells) {
  const lines = md.split("\n");
  const cells = (line) =>
    line
      .replace(/^\|/, "")
      .replace(/\|\s*$/, "")
      .split("|")
      .map((c) => c.trim());
  for (let i = 0; i < lines.length - 1; i++) {
    const line = lines[i];
    if (!line.startsWith("|") || !/^\|[\s:|-]+\|$/.test(lines[i + 1])) continue;
    if (JSON.stringify(cells(line)) !== JSON.stringify(headerCells)) continue;
    const rows = [];
    for (let j = i + 2; j < lines.length && lines[j].startsWith("|"); j++) rows.push(cells(lines[j]));
    return rows;
  }
  throw new Error(`build-docs: no table with header ${JSON.stringify(headerCells)} in ${SOURCE}`);
}

function unbacktick(cell) {
  const m = /^`([^`]*)`$/.exec(cell.trim());
  return m ? m[1] : cell.trim();
}

// Everything else (auth/success/errors cells) may carry several
// `` `code` ``s and prose mixed -- just drop the backticks, keep the rest.
function stripBackticks(cell) {
  return cell.replace(/`/g, "").trim();
}

// One line each, sourced from the same routes/prose this guide's other
// sections already cite -- never invented. A route with no entry here
// fails the build (see the check right after ENDPOINT_PURPOSES's use).
const ENDPOINT_PURPOSES = {
  "GET /v1/meta": "Live head: current event sequence and counts, for a cheap freshness check.",
  "GET /v1/me": "Who the caller's credential resolves to -- user id, name, admin/banned flags.",
  "GET /v1/layouts": "List layouts, filterable by owner/format/likes/date; paged, or ?full=1 for every record.",
  "GET /v1/layouts/:ref": "One layout by id or name, with every format it stores and the one you asked for.",
  "GET /v1/layouts/:ref/likes": "The list of user ids who liked this layout.",
  "GET /v1/layouts/:ref/history": "Every event recorded against this layout, newest first.",
  "GET /v1/layouts/:ref/rev/:n": "This layout's payload as of one specific past revision.",
  "POST /v1/layouts": "Create a layout: one request, a layout-scope event and a format-scope event.",
  "PUT /v1/layouts/:ref": "Replace a format's payload (If-Match), or add a new format to the layout (If-None-Match: *).",
  "PATCH /v1/layouts/:ref": "Rename the layout, or edit one format's fingermap/board/magic -- never both at once.",
  "DELETE /v1/layouts/:ref": "Tombstone the layout; every format it stores is left untouched, restorable later.",
  "POST /v1/layouts/:ref/restore": "Undelete a tombstoned layout, optionally under a new name.",
  "POST /v1/layouts/:ref/transfer": "Reassign ownership to another known Discord user id.",
  "PUT /v1/layouts/:ref/like": "Like a layout; fails loudly if the caller already liked it.",
  "DELETE /v1/layouts/:ref/like": "Unlike a layout; fails loudly if there was nothing to undo.",
  "GET /v1/layouts/:ref/link": "Read the owner's submitted external link, approved or pending.",
  "PUT /v1/layouts/:ref/link": "Submit an external link; an admin's own submission is approved immediately, an owner's is queued.",
  "DELETE /v1/layouts/:ref/link": "Clear the layout's external link.",
  "GET /v1/authors": "Every known author (Discord user id + display name).",
  "GET /v1/authors/:user_id": "One author's display name.",
  "GET /v1/formats": "The format registry: every registered format's id, role, lineage and reachable translations.",
  "GET /v1/formats/:name/:major/schema.json": "The JSON Schema a payload in this format must satisfy.",
  "GET /v1/changes": "The event feed since a sequence number, ground truth for staying current; wait= long-polls for feed:wait clients.",
  "GET /admin/changelog": "A human-readable HTML changelog of every event, for browsing without a client.",
  "GET /v1/dump": "Redirects to the latest nightly full-state dump.",
  "GET /v1/dump/latest.json": "The latest nightly dump's own manifest (key, sha256, byte count, sequence floor).",
  "GET /v1/dump/monthly/:key": "One monthly-retained dump archive.",
  "GET /v1/dump/:key": "One dated nightly dump archive.",
  "GET /v1/admin/admins": "List every admin.",
  "POST /v1/admin/admins": "Promote a user id to admin.",
  "DELETE /v1/admin/admins/:user_id": "Demote an admin; refused if fewer than 2 would remain.",
  "POST /v1/admin/import/pause": "Pause the cmini import.",
  "POST /v1/admin/import/resume": "Resume the cmini import.",
  "POST /v1/admin/import/tick": "Run one cmini import tick immediately.",
  "POST /v1/admin/diff/tick": "Run one upstream-diff tick immediately.",
  "POST /v1/admin/nightly/tick": "Run one nightly dump tick immediately.",
  "POST /v1/admin/clients": "Register a new trusted client: its Ed25519 public key, owner, and capabilities.",
  "DELETE /v1/admin/clients/:id": "Revoke a trusted client immediately.",
  "GET /v1/admin/clients": "List every registered trusted client.",
  "GET /v1/admin/health": "Operational health: import lag, queue depth, recent error rates.",
  "GET /v1/admin/bans": "List every banned user.",
  "PUT /v1/admin/bans/:user_id": "Ban a user from writing; an admin can never be banned.",
  "DELETE /v1/admin/bans/:user_id": "Unban a user.",
  "PUT /v1/admin/layouts/:ref/likes": "Override a layout's displayed like count.",
  "PUT /v1/admin/authors/:user_id": "Override an author's displayed name; sticky against later sign-ins.",
  "GET /v1/admin/link-queue": "List submitted links awaiting moderation.",
  "POST /v1/admin/link-queue/:id/approve": "Approve a queued link submission.",
  "POST /v1/admin/link-queue/:id/reject": "Reject a queued link submission.",
};

function classify(method, routePath) {
  if (routePath.includes("/admin/")) return "admin";
  if (routePath.endsWith("/like")) return "likes";
  if (routePath.endsWith("/link")) return "link";
  return method === "GET" ? "read" : "write";
}

function buildEndpoints(md) {
  const rows = findPipeTable(md, ["METHOD", "PATH", "auth", "body", "success", "errors"]);
  const missing = [];
  const endpoints = rows.map((r) => {
    const method = unbacktick(r[0]);
    const routePath = unbacktick(r[1]);
    const key = `${method} ${routePath}`;
    const purpose = ENDPOINT_PURPOSES[key];
    if (purpose === undefined) missing.push(key);
    return {
      method,
      path: routePath,
      auth: stripBackticks(r[2]),
      success: stripBackticks(r[4]),
      errors: stripBackticks(r[5]),
      purpose: purpose ?? "",
      group: classify(method, routePath),
    };
  });
  if (missing.length > 0) {
    throw new Error(`build-docs: no ENDPOINT_PURPOSES entry for: ${missing.join(", ")} -- add one before building`);
  }
  return endpoints;
}

function parseBaseUrl(md) {
  const m = /production\s+(https:\/\/\S+)/.exec(md);
  if (m === null) throw new Error("build-docs: could not find the production base URL (the fenced 'production   https://...' line) in adoption.md");
  return m[1];
}

// Demote the guide's own leading `# Title` (rendered `<h1>...</h1>` by
// `marked`) to `<h2>` -- see this file's header comment, point 3. Only the
// FIRST `<h1>` is ever touched (adoption.md has exactly one `#`-heading,
// everything else is `##`/`###`); `String.replace` with a non-global regex
// already only touches the first match, so this is a one-line no-op on a
// guide that (still) has no second h1.
function demoteLeadingH1(html) {
  return html.replace("<h1>", "<h2>").replace("</h1>", "</h2>");
}

const html = demoteLeadingH1(marked.parse(markdown, { async: false }));
const endpoints = buildEndpoints(markdown);
const baseUrl = parseBaseUrl(markdown);

mkdirSync(OUT_DIR, { recursive: true });
const banner = "// GENERATED by scripts/build-docs.mjs from db/docs/adoption.md -- do not edit, do not commit (gitignored).\n";
writeFileSync(
  OUT_FILE,
  banner +
    `export const docsHtml: string = ${JSON.stringify(html)};\n` +
    `export const adoptionMarkdown: string = ${JSON.stringify(markdown)};\n` +
    `export const baseUrl: string = ${JSON.stringify(baseUrl)};\n` +
    `export type EndpointGroup = "read" | "write" | "likes" | "link" | "admin";\n` +
    `export interface EndpointRow {\n` +
    `  method: string;\n` +
    `  path: string;\n` +
    `  auth: string;\n` +
    `  success: string;\n` +
    `  errors: string;\n` +
    `  purpose: string;\n` +
    `  group: EndpointGroup;\n` +
    `}\n` +
    `export const endpoints: EndpointRow[] = ${JSON.stringify(endpoints, null, 2)};\n`,
);

mkdirSync(PUBLIC_DIR, { recursive: true });
writeFileSync(PUBLIC_FILE, markdown);

console.log(`build-docs: wrote ${path.relative(process.cwd(), OUT_FILE)} (${html.length} bytes of HTML, ${endpoints.length} endpoints)`);
console.log(`build-docs: wrote ${path.relative(process.cwd(), PUBLIC_FILE)} (${markdown.length} bytes, served verbatim at /adoption.md)`);
