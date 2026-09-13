// [LDB-G12] [LDB-G13] db/tests/tools/adoption-examples.test.ts -- keeps
// db/docs/adoption.md's examples real, not aspirational prose.
//
// [LDB-G12]: every fenced code block marked with the info string
// ```json spark-payload``` is a literal `spark/1` payload -- it parses as
// JSON and validate()s against the real, live spark/1 module, exactly the
// way [LDB-F24]'s spec-example.test.ts pins design/layout-db/
// 22-spark-spec.md's worked examples. The marker itself is documented in
// adoption.md's own opening paragraph.
//
// [LDB-G13]: db/docs/adoption.md's §0 Quickstart is real. This file proves
// the static half (real fs, no D1 needed, hence the "node" vitest
// project): every literal `/v1/...` path in its fenced examples (template
// interpolations normalized to a wildcard segment first) matches a route
// the live Hono router actually registers (`app.routes`, the same export
// [LDB-G10]'s docs-site.test.ts already introspects); every JSON payload
// embedded in a `-d '...'` body validate()s as a real spark/1 payload; and
// the Quickstart's own Node client-lane signing snippet (item 4) is
// byte-identical to `tests/fixtures/adoption-quickstart-snippet.json`'s
// `code` field -- the copy `tests/api/adoption-quickstart.test.ts` actually
// EXECUTES against a live Worker via `SELF.fetch`, duplicated only because
// the "workers" vitest project runs inside workerd, which has no real
// filesystem access at all (`tests/api/fixture-export.test.ts`'s own
// header has the same constraint, verified empirically there) -- this
// drift check is what keeps the executed copy from silently diverging from
// what the doc actually shows a reader.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { app } from "../../src/index";
import { validate } from "../../formats/spark/1/index.ts";
import quickstartSnippetFixture from "../fixtures/adoption-quickstart-snippet.json" with { type: "json" };

const DB_ROOT = path.resolve(import.meta.dirname, "..", "..");
const ADOPTION_GUIDE_PATH = path.join(DB_ROOT, "docs", "adoption.md");

function readAdoptionGuide(): string {
  return fs.readFileSync(ADOPTION_GUIDE_PATH, "utf8");
}

// Every fenced ```json spark-payload``` block, in reading order.
const SPARK_PAYLOAD_FENCE_RE = /```json spark-payload\n([^]*?)\n```/g;

function extractSparkPayloadExamples(md: string): { raw: string; parsed: unknown }[] {
  const out: { raw: string; parsed: unknown }[] = [];
  let m: RegExpExecArray | null;
  while ((m = SPARK_PAYLOAD_FENCE_RE.exec(md)) !== null) out.push({ raw: m[1]!, parsed: JSON.parse(m[1]!) });
  return out;
}

// Everything between the "## 0. Quickstart" heading and the next "## "
// heading -- exact, not fuzzy, so a doc edit that renames or removes the
// section fails loudly here instead of silently checking nothing.
function quickstartSection(md: string): string {
  const start = md.indexOf("## 0. Quickstart");
  if (start === -1) throw new Error(`quickstartSection: heading '## 0. Quickstart' not found in ${ADOPTION_GUIDE_PATH}`);
  const rest = md.slice(start + 1);
  const nextHeadingRel = rest.search(/\n## /);
  const end = nextHeadingRel === -1 ? md.length : start + 1 + nextHeadingRel;
  return md.slice(start, end);
}

interface FencedBlock {
  lang: string;
  body: string;
}

function fencedBlocks(section: string): FencedBlock[] {
  const out: FencedBlock[] = [];
  const re = /```(\w*)\n([^]*?)\n```/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(section)) !== null) out.push({ lang: m[1] ?? "", body: m[2]! });
  return out;
}

// Every `/v1/...` substring in a block, template interpolations (`${x}`)
// normalized to a literal "X" segment first so a JS template literal like
// `` `/v1/layouts/${LAYOUT}` `` extracts as `/v1/layouts/X` -- concrete
// enough to path-match, without the test caring what the variable holds.
const URL_RE = /\/v1\/[^\s'"`)]+/g;

function extractPaths(body: string): string[] {
  const normalized = body.replace(/\$\{[^}]*\}/g, "X");
  const matches = normalized.match(URL_RE) ?? [];
  return matches.map((m) => m.split("?")[0]!);
}

function routerPaths(): Set<string> {
  const out = new Set<string>();
  for (const route of app.routes) {
    if (route.method === "ALL") continue;
    out.add(route.path);
  }
  return out;
}

// A concrete path segment matches a route's `:param` segment unconditionally
// (that's what a param means); it must match a literal segment exactly.
function pathMatchesPattern(concretePath: string, pattern: string): boolean {
  const a = concretePath.split("/").filter((s) => s.length > 0);
  const b = pattern.split("/").filter((s) => s.length > 0);
  if (a.length !== b.length) return false;
  return b.every((seg, i) => seg.startsWith(":") || seg === a[i]);
}

function matchesSomeRoute(concretePath: string, patterns: Set<string>): boolean {
  for (const p of patterns) if (pathMatchesPattern(concretePath, p)) return true;
  return false;
}

// The `-d '...'` argument of a curl invocation -- a compact single-line
// JSON body, the only shape every Quickstart example uses.
function embeddedBodies(body: string): unknown[] {
  const out: unknown[] = [];
  const re = /-d '([^']*)'/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) out.push(JSON.parse(m[1]!));
  return out;
}

describe("[LDB-G12] adoption.md's spark-payload examples", () => {
  it("[LDB-G12] the guide carries at least one ```json spark-payload``` example", () => {
    expect(extractSparkPayloadExamples(readAdoptionGuide()).length).toBeGreaterThan(0);
  });

  it("[LDB-G12] every ```json spark-payload``` block parses as JSON and validate()s as a valid spark/1 payload", () => {
    for (const { raw, parsed } of extractSparkPayloadExamples(readAdoptionGuide())) {
      const result = validate(parsed);
      expect(result, `example did not validate: ${raw}\n${JSON.stringify(result)}`).toEqual({ ok: true });
    }
  });

  it("[LDB-G12] the marker is documented at the top of the file", () => {
    expect(readAdoptionGuide().slice(0, 2000)).toMatch(/spark-payload/);
  });
});

describe("[LDB-G13] adoption.md §0 Quickstart (static checks)", () => {
  it("[LDB-G13] the guide carries the Quickstart heading with at least 8 fenced examples", () => {
    const section = quickstartSection(readAdoptionGuide());
    expect(fencedBlocks(section).length).toBeGreaterThanOrEqual(8);
  });

  it("[LDB-G13] every literal /v1/... path in the Quickstart's fences matches a route the live router registers", () => {
    const section = quickstartSection(readAdoptionGuide());
    const patterns = routerPaths();
    expect(patterns.size).toBeGreaterThan(0);

    const unmatched: string[] = [];
    let checked = 0;
    for (const block of fencedBlocks(section)) {
      for (const p of extractPaths(block.body)) {
        checked++;
        if (!matchesSomeRoute(p, patterns)) unmatched.push(p);
      }
    }
    expect(checked).toBeGreaterThan(0);
    expect(unmatched).toEqual([]);
  });

  it("[LDB-G13] every embedded -d JSON body's payload validates as a real spark/1 payload", () => {
    const section = quickstartSection(readAdoptionGuide());
    let checked = 0;
    for (const block of fencedBlocks(section)) {
      for (const parsed of embeddedBodies(block.body)) {
        const payload = (parsed as { payload?: unknown }).payload;
        if (payload === undefined) continue;
        checked++;
        expect(validate(payload)).toEqual({ ok: true });
      }
    }
    expect(checked).toBeGreaterThan(0);
  });

  it("[LDB-G13] the Node signing snippet (item 4) is byte-identical to the fixture tests/api/adoption-quickstart.test.ts executes", () => {
    const section = quickstartSection(readAdoptionGuide());
    const jsBlock = fencedBlocks(section).find((b) => b.body.includes("CLIENT_PRIVATE_KEY"));
    expect(jsBlock, "no fenced JS block naming CLIENT_PRIVATE_KEY found in the Quickstart").toBeDefined();
    expect(jsBlock!.body).toEqual(quickstartSnippetFixture.code);
  });
});
