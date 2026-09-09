#!/usr/bin/env node
// Render design/layout-db/*.md into one readable page, proposal.html, next
// to the sources. Reuses the federation page's markdown renderer (same
// subset: headings to h3, paragraphs, fenced code, pipe tables, flat lists)
// so the two proposals read alike.
//
//   node design/layout-db/build_page.mjs        # from the repo root
//
// Not deployed: it writes into design/, never web/. Publishing to akl.gg is
// a separate, gated step (00-plan.md phase 0).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { render, inline, slug } from '../federation/build_page.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DOCS = ['00-plan.md', '01-format.md', '02-auth.md', '03-api.md', '04-governance.md', '05-bot.md', '06-akl-integration.md', '07-implementation-phase1.md', '08-infrastructure.md', '09-implementation-phase2.md', '10-implementation-phase4.md', '11-implementation-phase3.md', '12-implementation-phase5.md'];
const OUT = path.join(HERE, 'proposal.html');

const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const CSS = `
  :root { --bg:#0f1117; --bg2:#181c27; --border:#2e3450; --text:#d0d6f0; --text2:#9aa0b5; --text3:#6a7396;
    --green:#4ec97a; --teal:#69cad3; --amber:#e0a94e; --purple:#b48cf2;
    --font:-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif; --mono:"SF Mono","Fira Mono","Cascadia Mono",Consolas,monospace; }
  * { box-sizing:border-box; }
  body { margin:0; background:#0a0b0f; color:var(--text); font:15px/1.6 var(--font); }
  .layout { display:grid; grid-template-columns:240px minmax(0,1fr); gap:0; }
  nav { position:sticky; top:0; height:100vh; overflow:auto; padding:28px 18px; border-right:1px solid var(--border); background:var(--bg); font-size:13px; }
  nav .t { font-weight:650; color:#fff; margin:0 0 12px; font-size:14px; }
  nav a { display:block; color:var(--text2); text-decoration:none; padding:3px 0; }
  nav a.doc { color:var(--teal); font-weight:600; margin-top:10px; }
  nav a.h3 { padding-left:14px; color:var(--text3); }
  nav a:hover { color:#fff; }
  .wrap { max-width:880px; padding:44px 32px 120px; }
  h1 { font-size:1.5rem; font-weight:650; margin:0 0 6px; }
  .sub { color:var(--text3); font-size:13px; margin:0 0 30px; }
  section.doc { margin-top:56px; padding-top:28px; border-top:2px solid var(--purple); }
  section.doc > h1 { color:var(--purple); font-size:1.35rem; }
  section.doc .path { font:12px var(--mono); color:var(--text3); margin:0 0 18px; }
  h2 { font-size:1.2rem; font-weight:650; margin:38px 0 10px; padding-top:14px; border-top:1px solid var(--border); }
  h3 { font-size:1rem; font-weight:650; margin:26px 0 8px; color:var(--teal); }
  p { margin:0 0 12px; max-width:80ch; }
  li { margin:0 0 6px; max-width:80ch; }
  ul, ol { padding-left:22px; margin:0 0 12px; }
  b { color:#fff; }
  hr { border:0; border-top:1px solid var(--border); margin:22px 0; }
  hr + h2 { border-top:0; padding-top:0; margin-top:0; }
  code { font-family:var(--mono); font-size:.9em; background:var(--bg2); border:1px solid var(--border); border-radius:4px; padding:1px 5px; color:var(--text); }
  pre { background:var(--bg2); border:1px solid var(--border); border-radius:8px; padding:12px 14px; overflow:auto; font:13px/1.5 var(--mono); margin:0 0 14px; }
  pre code { background:none; border:0; padding:0; font-size:inherit; }
  a { color:var(--teal); }
  .tbl { overflow-x:auto; margin:0 0 14px; }
  table { border-collapse:collapse; font-size:13px; min-width:100%; }
  th, td { text-align:left; vertical-align:top; padding:6px 10px; border:1px solid var(--border); }
  th { background:var(--bg2); color:var(--text2); font-weight:600; white-space:nowrap; }
  @media (max-width:900px) { .layout { grid-template-columns:1fr; } nav { position:static; height:auto; border-right:0; border-bottom:1px solid var(--border); } }
`;

export function buildPage() {
  const sections = [];
  const toc = [];
  for (const file of DOCS) {
    const md = fs.readFileSync(path.join(HERE, file), 'utf8');
    const { title, body } = render(md);
    if (!title) throw new Error(`${file}: no h1`);
    const id = 'doc-' + file.replace(/\.md$/, '');
    toc.push(`<a class="doc" href="#${id}">${inline(title)}</a>`);
    // Section ids collide across docs (every doc has a "1. …"), so prefix
    // them per doc and rewrite the toc from the h2/h3 the renderer emitted.
    const prefixed = body.replace(/<h([23]) id="([^"]+)">/g, (_, l, s) => {
      const hid = `${id}--${s}`;
      const text = /<h[23] id="[^"]+">(.*?)<\/h[23]>/.exec(body.slice(body.indexOf(`id="${s}"`)))?.[1] ?? s;
      toc.push(`<a class="h${l}" href="#${hid}">${text}</a>`);
      return `<h${l} id="${hid}">`;
    });
    sections.push(`<section class="doc" id="${id}"><h1>${inline(title)}</h1><p class="path">design/layout-db/${file}</p>${prefixed}</section>`);
  }
  return `<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>The layout database — proposal</title>
<style>${CSS}</style>
<div class="layout">
<nav><p class="t">The layout database</p>${toc.join('\n')}</nav>
<div class="wrap">
  <h1>The layout database — proposal, round 1</h1>
  <p class="sub">Seven documents, rendered from <code>design/layout-db/*.md</code> on ${new Date().toISOString().slice(0, 10)}. Read <b>00</b> first; <b>01</b> slowly.</p>
${sections.join('\n')}
</div>
</div>`;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  fs.writeFileSync(OUT, buildPage());
  console.log('wrote', OUT);
}
