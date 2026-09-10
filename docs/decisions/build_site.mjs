#!/usr/bin/env node
// Assemble the layoutdb docs hub (akl.gg/layoutdb/) from one source per
// doc: markdown in the federation renderer's subset (design/federation/
// build_page.mjs's `inline`/`slug`, reused below), extended so a raw
// `<figure>…</figure>` block (inline SVG inside) passes through to HTML
// untouched. See design/layout-db/20-spark.md §1 decision 15, §3 S8.
//
//   node design/layout-db/build_site.mjs [outDir]   # from the repo root
//
// Sources: every design/layout-db/*.md, plus db/docs/*.md once that
// directory exists (the adoption guide, written after the API settles --
// S8 note; this builder does not create it, it only picks it up). Each
// source may embed `<figure>...</figure>` blocks (a `.frame` div wrapping
// one inline `<svg>`, plus a `<figcaption>`) -- those pass through to the
// HTML page byte-for-byte, and are replaced in the `.md` copy by one line:
// `Figure: <figcaption text> — <svg aria-label text>`.
//
// Outputs (into `outDir`, default web/layoutdb/ for a local preview --
// NEVER committed, see .gitignore and scripts/assemble_dist.mjs):
//   index.html                    -- what layoutdb is, who each doc is for
//   <slug>/index.html + <slug>.md -- one designed page + its raw markdown
//   all.md                        -- every doc's .md copy, nav order, one agent fetch
//
// Generated fresh on every real build (scripts/assemble_dist.mjs's
// buildLayoutdbHub(), straight into dist/layoutdb/) rather than checked
// in: design/layout-db/*.md gets edited by several sessions in parallel
// all day (13-ledger.md especially), and a committed copy would go stale
// against nearly every one of those edits. db/tests/tools/docs-site.test.ts
// (LDB-G9) is the drift guard -- not "checked-in output equals a fresh
// render" (there is no checked-in output), but the same-shape properties
// of a fresh build into a throwaway temp dir: every source is in the hub
// and nothing else is, nav lists every doc exactly once, every link
// resolves, all.md is the concatenation, each page's .md equals the
// builder's own render of its source, and two runs are byte-identical.
//
// Every function below that only reads sources and returns strings (no
// fs writes) is exported so the test can compute a fresh build in memory,
// or into a temp dir via writeSite(files, outDir), without ever touching
// web/layoutdb/ or dist/.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inline, slug } from '../federation/build_page.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..', '..');

export const LAYOUTDB_SRC_DIR = HERE; // design/layout-db
export const DB_DOCS_DIR = path.join(REPO_ROOT, 'db', 'docs');
export const OUT_DIR = path.join(REPO_ROOT, 'web', 'layoutdb');

// The main-line reader order (decision 15 / §3 S8): architecture, the
// adoption guide (only once it exists), 01 formats, 03 API, 02 auth,
// 04 governance, the spark plan, upcast. Everything else discovered under
// the two source globs falls into the collapsed "design record" group,
// ordered by its own filename (00, then 05-18 -- already the right order
// as a plain string sort, since every one of those stems shares the same
// two-digit-prefix shape).
const MAIN_ORDER = ['architecture', 'adoption', '01-format', '03-api', '02-auth', '04-governance', '20-spark', '19-upcast'];

// One-line "who this is for" blurbs for the hub index. Design-record docs
// (the collapsed group) share one blurb instead of twenty -- the group
// itself is the record, not a set of standalone reading recommendations.
const BLURBS = {
  architecture: 'How the service fits together end to end: the Worker, D1, R2, the read/write path, and the two formats it holds.',
  adoption: 'For a human or an agent building a Discord bot or a user client against the API.',
  '01-format': 'The layout record and its formats: what a stored record looks like, and what each format profile can and cannot hold.',
  '03-api': 'The HTTP surface: reads, writes, If-Match, the change feed, webhooks, dumps.',
  '02-auth': 'Authentication and authorization: the two auth lanes and what each route requires.',
  '04-governance': 'Who owns what, and what happens if a maintainer disappears.',
  '20-spark': 'The current implementation plan for the one-stored-format cutover, and its ledger.',
  '19-upcast': 'The format-versioning chain: how a stored record moves to a new major on write.',
};
const DESIGN_RECORD_BLURB = 'Earlier design rounds and phase-by-phase implementation briefs, kept for the record.';

const escHtml = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const stripTags = s => s.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, ' ').trim();

// --- doc discovery --------------------------------------------------------

// One entry per markdown source: {key, slug, title, srcPath, srcRel}. `key`
// is the filename stem (e.g. "01-format", "architecture"); `slug` is the
// URL segment (the stem with a leading "NN-" digit prefix stripped, so
// "01-format" -> "format", "20-spark" -> "spark", "architecture" stays
// "architecture"). `title` is the doc's own h1 text (raw markdown, not yet
// inline-rendered).
export function discoverDocs() {
  const found = [];
  for (const dir of [LAYOUTDB_SRC_DIR, DB_DOCS_DIR]) {
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir).sort()) {
      if (!name.endsWith('.md')) continue;
      const srcPath = path.join(dir, name);
      const key = name.slice(0, -3);
      const md = fs.readFileSync(srcPath, 'utf8');
      const { title } = renderBlocks(md);
      found.push({ key, slug: key.replace(/^\d+-/, ''), title, srcPath, srcRel: path.relative(REPO_ROOT, srcPath) });
    }
  }
  const byKey = new Map(found.map(d => [d.key, d]));
  const mainDocs = MAIN_ORDER.map(k => byKey.get(k)).filter(Boolean);
  const mainKeys = new Set(mainDocs.map(d => d.key));
  const recordDocs = found.filter(d => !mainKeys.has(d.key)).sort((a, b) => a.key.localeCompare(b.key));
  return { mainDocs, recordDocs, all: [...mainDocs, ...recordDocs] };
}

// --- markdown -> HTML blocks (federation's subset + <figure> passthrough) -

// Renders the same subset design/federation/build_page.mjs's `render` does
// (h1-h3, paragraphs, fenced code, pipe tables, flat lists, rules, and
// inline code/bold/em/links) plus one addition: a line starting `<figure`
// opens a raw-HTML block that runs verbatim to its matching `</figure>`
// line -- the block's own markup (already written for the browser) is
// never touched by `inline`/`esc`. `figure: true` on that block is what
// `figureToMdLine` below keys off when building the `.md` copy.
export function renderBlocks(md) {
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  const blocks = [];
  let title = '';
  let i = 0;
  const para = [];
  const flush = () => { if (para.length) { blocks.push({ html: `<p>${inline(para.join(' '))}</p>` }); para.length = 0; } };
  while (i < lines.length) {
    const line = lines[i];
    if (/^\s*$/.test(line)) { flush(); i++; continue; }
    if (/^<figure/.test(line)) {
      flush();
      const buf = [line];
      i++;
      while (i < lines.length && !/^<\/figure>/.test(lines[i])) { buf.push(lines[i]); i++; }
      if (i < lines.length) { buf.push(lines[i]); i++; }
      blocks.push({ html: buf.join('\n'), figure: true });
      continue;
    }
    if (/^---+\s*$/.test(line)) { flush(); blocks.push({ html: '<hr>' }); i++; continue; }
    const h = /^(#{1,3})\s+(.+?)\s*$/.exec(line);
    if (h) {
      flush();
      const level = h[1].length;
      if (level === 1 && !title) { title = h[2]; i++; continue; }
      blocks.push({ html: `<h${level} id="${slug(h[2])}">${inline(h[2])}</h${level}>` });
      i++; continue;
    }
    if (/^```/.test(line)) {
      flush();
      const buf = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) buf.push(lines[i++]);
      i++;
      blocks.push({ html: `<pre><code>${escHtml(buf.join('\n'))}</code></pre>` });
      continue;
    }
    if (/^\|/.test(line)) {
      flush();
      const rows = [];
      while (i < lines.length && /^\|/.test(lines[i])) rows.push(lines[i++]);
      const cells = r => r.replace(/^\|/, '').replace(/\|\s*$/, '').split('|').map(c => c.trim());
      const [head, , ...body] = rows;
      blocks.push({
        html: '<div class="tbl"><table><thead><tr>' + cells(head).map(c => `<th>${inline(c)}</th>`).join('') + '</tr></thead><tbody>'
          + body.map(r => '<tr>' + cells(r).map(c => `<td>${inline(c)}</td>`).join('') + '</tr>').join('')
          + '</tbody></table></div>',
      });
      continue;
    }
    const li = /^([-*]|\d+\.)\s+(.*)$/.exec(line);
    if (li) {
      flush();
      const ordered = /\d/.test(li[1]);
      const items = [];
      while (i < lines.length) {
        const m = /^([-*]|\d+\.)\s+(.*)$/.exec(lines[i]);
        if (m) { items.push(m[2]); i++; continue; }
        if (/^\s{2,}\S/.test(lines[i]) && items.length) { items[items.length - 1] += ' ' + lines[i].trim(); i++; continue; }
        break;
      }
      const tag = ordered ? 'ol' : 'ul';
      blocks.push({ html: `<${tag}>` + items.map(t => `<li>${inline(t)}</li>`).join('') + `</${tag}>` });
      continue;
    }
    para.push(line.trim());
    i++;
  }
  flush();
  if (!title) throw new Error('renderBlocks: the source has no h1 to use as the page title');
  return { title, blocks };
}

// --- markdown -> markdown copy (figures collapsed to one line) ----------

function figureToMdLine(figureHtml) {
  const cap = /<figcaption>([\s\S]*?)<\/figcaption>/.exec(figureHtml);
  const aria = /aria-label="([^"]*)"/.exec(figureHtml);
  const caption = cap ? stripTags(cap[1]) : '(no caption)';
  const label = aria ? stripTags(aria[1]) : '(no aria-label)';
  return `Figure: ${caption} — ${label}`;
}

// The `.md` copy is the raw source with every `<figure>...</figure>` block
// replaced by its one-line summary -- a text substitution over the source,
// not a re-serialization of the parsed blocks, so every other byte (prose,
// tables, code fences) survives untouched.
export function mdCopyFromSource(md) {
  return md.replace(/<figure[^]*?<\/figure>\n?/g, m => figureToMdLine(m) + '\n');
}

// --- page shell ------------------------------------------------------------

const CSS = `
  :root {
    --ground: #f6f5f1; --paper: #fdfcfa; --ink: #1f232e; --ink-2: #4d5363; --muted: #7a8090;
    --rule: #d8d9d3; --accent: #1f7a6d; --accent-soft: #e2efeb; --warn: #a8641c; --warn-soft: #f5ead9;
    --code-bg: #ecebe5; --fig-bg: #fbfaf7;
  }
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) {
      --ground: #15171c; --paper: #1b1e24; --ink: #e6e4dc; --ink-2: #b6b8b4; --muted: #858a95;
      --rule: #2f333b; --accent: #57bfab; --accent-soft: #1c2f2b; --warn: #d9a05b; --warn-soft: #2f2618;
      --code-bg: #23262d; --fig-bg: #191c22;
    }
  }
  :root[data-theme="dark"] {
    --ground: #15171c; --paper: #1b1e24; --ink: #e6e4dc; --ink-2: #b6b8b4; --muted: #858a95;
    --rule: #2f333b; --accent: #57bfab; --accent-soft: #1c2f2b; --warn: #d9a05b; --warn-soft: #2f2618;
    --code-bg: #23262d; --fig-bg: #191c22;
  }
  * { box-sizing: border-box; }
  body {
    background: var(--ground); color: var(--ink);
    font-family: ui-serif, Georgia, "Times New Roman", serif;
    font-size: 17px; line-height: 1.55;
  }
  .hubwrap { max-width: 1180px; margin-inline: auto; padding-inline: 20px; padding-block: 28px 80px; display: flex; gap: 36px; align-items: flex-start; }
  .hubnav { flex: 0 0 230px; position: sticky; top: 20px; font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", "Arial Narrow", sans-serif; font-size: 14px; }
  .hubnav-home { display: block; font-weight: 600; font-size: 15px; color: var(--ink); text-decoration: none; margin-bottom: 14px; }
  .hubnav-home:hover { color: var(--accent); }
  .hubnav-list { list-style: none; margin: 0 0 10px; padding: 0; }
  .hubnav-list li { margin: 0; }
  .hubnav-list a { display: block; padding: 5px 8px; margin: 1px 0; border-radius: 4px; color: var(--ink-2); text-decoration: none; }
  .hubnav-list a:hover { background: var(--accent-soft); color: var(--accent); }
  .hubnav-list a[aria-current="page"] { background: var(--accent-soft); color: var(--accent); font-weight: 600; }
  .hubnav-group summary { cursor: pointer; padding: 5px 8px; color: var(--muted); font-size: 12px; letter-spacing: .04em; text-transform: uppercase; }
  .hubmain { flex: 1 1 auto; min-width: 0; max-width: 78ch; }
  .eyebrow { font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace; font-size: 12px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--muted); margin: 0 0 10px; }
  h1 { font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", "Arial Narrow", sans-serif; font-weight: 600; font-size: 34px; line-height: 1.1; letter-spacing: -0.01em; margin: 0 0 14px; text-wrap: balance; }
  h2 { font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", "Arial Narrow", sans-serif; font-weight: 600; font-size: 23px; line-height: 1.15; margin: 42px 0 12px; padding-top: 16px; border-top: 1px solid var(--rule); text-wrap: balance; }
  h3 { font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", "Arial Narrow", sans-serif; font-weight: 600; font-size: 18px; margin: 26px 0 8px; }
  p { margin: 0 0 14px; max-width: 78ch; text-wrap: pretty; overflow-wrap: break-word; }
  ul, ol { margin: 0 0 16px; padding-left: 1.2em; }
  li { margin-bottom: 8px; max-width: 78ch; overflow-wrap: break-word; }
  li::marker { color: var(--accent); }
  b, strong { font-weight: 600; }
  hr { border: 0; border-top: 1px solid var(--rule); margin: 24px 0; }
  /* overflow-wrap: a long unbreakable inline code span (a file path with
     no spaces, e.g. scripts/tests/test_migrate_records_to_spark.py) has no
     soft break point, and an inline element with none overflows its block
     ancestor instead of being clipped by it -- unlike a table or a <pre>,
     ordinary paragraph/list text has no overflow-x:auto container to catch
     that. break-word lets the browser break mid-token, but only when a
     token alone is wider than the line has room for. */
  code { font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace; font-size: 0.86em; background: var(--code-bg); padding: 1px 5px; border-radius: 3px; overflow-wrap: break-word; }
  pre { font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace; font-size: 13px; line-height: 1.5; background: var(--code-bg); padding: 14px 16px; overflow-x: auto; margin: 0 0 16px; }
  pre code { background: none; padding: 0; }
  a { color: var(--accent); }
  figure { margin: 18px 0 26px; }
  figure .frame { background: var(--fig-bg); border: 1px solid var(--rule); padding: 14px; overflow-x: auto; }
  figure svg { display: block; width: 100%; height: auto; color: var(--ink); }
  figure svg text { font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", "Arial Narrow", sans-serif; font-size: 14px; fill: currentColor; }
  figure svg .t { font-size: 16px; font-weight: 600; }
  figure svg .s { font-size: 12px; fill: var(--muted); letter-spacing: 0.02em; }
  figure svg .lbl { font-size: 13px; fill: var(--ink-2); }
  figure svg .box { fill: var(--paper); stroke: currentColor; stroke-width: 1; }
  figure svg .zone { fill: none; stroke: var(--muted); stroke-width: 1; stroke-dasharray: 3 3; }
  figure svg .store { fill: var(--paper); stroke: currentColor; stroke-width: 1.2; }
  figure svg .edge { stroke: currentColor; stroke-width: 1.2; fill: none; }
  figure svg .edge.faint { stroke: var(--muted); }
  figure svg .acc { stroke: var(--accent); }
  figure svg .acc-fill { fill: var(--accent-soft); stroke: var(--accent); stroke-width: 1.5; }
  figure svg .acc-text { fill: var(--accent); }
  figure svg .prop { stroke: var(--warn); stroke-dasharray: 5 3; }
  figure svg .prop-fill { fill: var(--warn-soft); stroke: var(--warn); stroke-width: 1.2; stroke-dasharray: 5 3; }
  figure svg .prop-text { fill: var(--warn); }
  figure svg .ghost { fill: var(--fig-bg); stroke: var(--muted); stroke-width: 1.2; stroke-dasharray: 4 3; }
  figcaption { font-size: 14px; color: var(--ink-2); margin-top: 8px; max-width: 74ch; text-wrap: pretty; }
  figcaption .rec { font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace; font-size: 11px; letter-spacing: 0.06em; text-transform: uppercase; color: var(--accent); }
  .tbl { overflow-x: auto; margin: 0 0 16px; }
  table { border-collapse: collapse; font-size: 14px; min-width: 100%; }
  th, td { text-align: left; vertical-align: top; padding: 7px 10px; border: 1px solid var(--rule); }
  th { background: var(--code-bg); color: var(--ink-2); font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace; font-size: 11px; letter-spacing: 0.04em; text-transform: uppercase; white-space: nowrap; }
  .prevnext { display: flex; justify-content: space-between; gap: 16px; margin-top: 44px; padding-top: 16px; border-top: 1px solid var(--rule); font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", "Arial Narrow", sans-serif; font-size: 14px; }
  .prevnext a { text-decoration: none; }
  .prevnext .dir { display: block; font-size: 11px; color: var(--muted); text-transform: uppercase; letter-spacing: .04em; }
  .prevnext .next { text-align: right; margin-left: auto; }
  .mdbar { display: flex; align-items: center; gap: 10px; font-size: 12px; color: var(--muted); margin: 8px 0 26px; font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", "Arial Narrow", sans-serif; }
  .mdbar a { white-space: nowrap; font-weight: 600; color: var(--ink-2); background: var(--code-bg); border: 1px solid var(--rule); border-radius: 5px; padding: 5px 10px; text-decoration: none; }
  .mdbar a:hover { color: var(--accent); border-color: var(--accent); }
  .doclist { list-style: none; margin: 0 0 8px; padding: 0; }
  .doclist li { margin: 0 0 14px; max-width: 74ch; }
  .doclist a { font-weight: 600; text-decoration: none; }
  .doclist .blurb { display: block; color: var(--ink-2); font-size: 15px; margin-top: 2px; }
  @media (max-width: 760px) {
    /* align-items: flex-start (desktop's top-align for the two columns) is
       a cross-axis rule -- once flex-direction flips to column the cross
       axis is horizontal, so flex-start stops stretching each item to the
       container's width and sizes it to its content's max-content width
       instead (a table or wide figure then silently sets .hubmain's own
       width, and its overflow-x:auto containers have nothing left to
       clip). align-items: stretch here is what keeps every item -- and
       everything inside it -- clamped to the viewport. */
    .hubwrap { flex-direction: column; align-items: stretch; padding-inline: 16px; }
    .hubnav { position: static; flex-basis: auto; width: 100%; max-width: 100%; }
    .hubmain { max-width: 100%; }
  }
`;

function navHtml(mainDocs, recordDocs, activeSlug) {
  const item = d => `<li><a href="/layoutdb/${d.slug}/"${d.slug === activeSlug ? ' aria-current="page"' : ''}>${inline(d.title)}</a></li>`;
  const inGroup = recordDocs.some(d => d.slug === activeSlug);
  return `<nav class="hubnav" aria-label="layoutdb docs">
  <a class="hubnav-home" href="/layoutdb/">layoutdb docs</a>
  <ul class="hubnav-list">${mainDocs.map(item).join('')}</ul>
  <details class="hubnav-group"${inGroup ? ' open' : ''}>
    <summary>Design record</summary>
    <ul class="hubnav-list">${recordDocs.map(item).join('')}</ul>
  </details>
</nav>`;
}

function prevNextHtml(prev, next) {
  const side = (d, dir, cls) => d
    ? `<a class="${cls}" href="/layoutdb/${d.slug}/"><span class="dir">${dir}</span>${inline(d.title)}</a>`
    : '<span></span>';
  return `<div class="prevnext">${side(prev, 'Previous', 'prev')}${side(next, 'Next', 'next')}</div>`;
}

function docPageHtml(doc, { mainDocs, recordDocs, prev, next }) {
  const { blocks } = renderBlocks(fs.readFileSync(doc.srcPath, 'utf8'));
  const body = blocks.map(b => b.html).join('\n');
  // `inline()` already HTML-escapes and wraps markup; strip the tags it
  // added (a title with a code span or emphasis reads as plain text here)
  // without re-escaping already-escaped entities.
  return `<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${inline(doc.title).replace(/<[^>]+>/g, '')} — layoutdb docs</title>
<style>${CSS}</style>
<div class="hubwrap">
${navHtml(mainDocs, recordDocs, doc.slug)}
  <main class="hubmain">
    <h1>${inline(doc.title)}</h1>
    <div class="mdbar"><span>Source: <code>${escHtml(doc.srcRel)}</code></span><span style="flex:1"></span><a href="/layoutdb/${doc.slug}/${doc.slug}.md">Markdown for agents</a></div>
${body}
${prevNextHtml(prev, next)}
  </main>
</div>`;
}

function indexPageHtml({ mainDocs, recordDocs }) {
  const li = d => `<li><a href="/layoutdb/${d.slug}/">${inline(d.title)}</a>${BLURBS[d.key] ? `<span class="blurb">${escHtml(BLURBS[d.key])}</span>` : ''}</li>`;
  return `<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>layoutdb docs</title>
<style>${CSS}</style>
<div class="hubwrap">
${navHtml(mainDocs, recordDocs, '')}
  <main class="hubmain">
    <p class="eyebrow">layoutdb</p>
    <h1>layoutdb docs</h1>
    <p>One Cloudflare Worker over one D1 database. Every record is stored in one format, <b>spark</b>, which akl.gg and the bot both read and write. cmini is an import source: its layouts become spark records the moment they arrive. <b>mana2</b> is the format the analyzer reads, produced from spark on request.</p>
    <p>Each doc below is a single markdown source; every page on this hub carries the same navigation and a link to its own raw markdown, for handing to an agent. <a href="/layoutdb/all.md">The whole set, concatenated</a>, is one fetch away.</p>
    <ul class="doclist">${mainDocs.map(li).join('')}</ul>
    <h2>Design record</h2>
    <p>${escHtml(DESIGN_RECORD_BLURB)}</p>
    <ul class="doclist">${recordDocs.map(li).join('')}</ul>
  </main>
</div>`;
}

// --- build -----------------------------------------------------------------

// Pure: reads every source, returns every file the site needs as
// {relPath: content}, relative to OUT_DIR. No filesystem writes -- the test
// diffs this against the checked-in tree; `main()` below is what writes it.
export function buildSite() {
  const { mainDocs, recordDocs, all } = discoverDocs();
  const files = new Map();

  files.set('index.html', indexPageHtml({ mainDocs, recordDocs }));

  const mdCopies = [];
  all.forEach((doc, i) => {
    const prev = all[i - 1] ?? null;
    const next = all[i + 1] ?? null;
    files.set(`${doc.slug}/index.html`, docPageHtml(doc, { mainDocs, recordDocs, prev, next }));
    const md = mdCopyFromSource(fs.readFileSync(doc.srcPath, 'utf8'));
    files.set(`${doc.slug}/${doc.slug}.md`, md);
    mdCopies.push(md);
  });

  files.set('all.md', mdCopies.join('\n\n---\n\n'));
  return { files, mainDocs, recordDocs, all };
}

// `outDir` defaults to OUT_DIR (web/layoutdb, for a local preview served
// the same way web/federation/ is) but the real deploy never writes there:
// scripts/assemble_dist.mjs calls this with dist/layoutdb so the hub is
// generated fresh on every build instead of being a committed copy that
// three sessions editing design/layout-db/*.md all day would immediately
// go stale against.
export function writeSite(files, outDir = OUT_DIR) {
  fs.mkdirSync(outDir, { recursive: true });
  for (const [relPath, content] of files) {
    const dest = path.join(outDir, relPath);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, content);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // node design/layout-db/build_site.mjs [outDir] -- outDir defaults to
  // web/layoutdb (local preview); scripts/assemble_dist.mjs imports
  // buildSite/writeSite directly instead of shelling out, so this CLI path
  // is for a human running it by hand.
  const outDir = process.argv[2] ? path.resolve(process.argv[2]) : OUT_DIR;
  const { files, all } = buildSite();
  writeSite(files, outDir);
  console.log(`wrote ${files.size} files into ${path.relative(REPO_ROOT, outDir)}/ (${all.length} docs)`);
}
