// [LDB-S1a] `db/tests/fixtures/db-responses/` is the fixture
// `scripts/tests/test_sync_db_source.py` [LDB-S1] serves as a stand-in DB
// (design/layout-db/11-implementation-phase3.md §1 W1): recorded from the
// LIVE routes over the standard upstream-100 seed, ULID-normalised, and
// frozen here so a change to any route's response shape shows up as a red
// `db.yml` here -- never a silently stale Python fixture on the site side.
//
// Two deliberate deviations from 11 §1's description of this test, both
// forced by a hard constraint discovered while building it: the "workers"
// vitest project (`tests/api/**`) runs INSIDE workerd via
// @cloudflare/vitest-pool-workers, which has no real filesystem access at
// all -- reading OR writing any project-relative path fails (ENOENT/EPERM,
// verified empirically); only a static `import ... with { type: "json" }`
// (resolved by the bundler on the host side before the isolate starts,
// same as `fullSnapshot` in list.test.ts) and the OS temp dir are
// reachable, and `process.env` does not reach the isolate either (also
// verified empirically -- undefined even with the var exported in the
// invoking shell).
//   1. This test statically imports each committed fixture file and
//      compares the live route's (normalised) response against it in
//      memory -- never a runtime `fs.readFileSync` of the committed file.
//   2. Recording a NEW committed snapshot (the API contract changed) can't
//      be an env-flag toggle (11 §1 says `WRITE_FIXTURES=1`) or a
//      vitest.config.ts binding (adding one is outside W1's db/ edit
//      scope) -- and can't write a file at all, not even to the OS temp
//      dir (also verified empirically: every path is unreachable from
//      inside this pool's isolate, not just project-relative ones). Flip
//      the RECORD constant below to true, run
//        npx vitest run tests/api/fixture-export.test.ts --reporter=verbose > /tmp/ldb-s1a.out
//      (stdout DOES reach the real host process -- vitest's own reporter
//      needs it to), then slice out each printed
//      `===LDB-S1a-FIXTURE-START:<relPath>===` / `-END-` block into its
//      file, e.g.:
//        python3 -c "
//        import re, pathlib
//        text = pathlib.Path('/tmp/ldb-s1a.out').read_text()
//        for m in re.finditer(r'===LDB-S1a-FIXTURE-START:(.+?)===\n(.*?)\n===LDB-S1a-FIXTURE-END:\1===', text, re.S):
//            p = pathlib.Path('db/tests/fixtures/db-responses') / m.group(1)
//            p.write_text(m.group(2) + '\n')
//        "
//      then flip RECORD back to false and re-run normally to confirm.
//
// Also unlike 11 §1's table (reported in the W1 handoff): the plan assumed
// `GET .../layouts/{ref}?as=cmini/1` (and the `?full=1` batch) already
// carry a `likes` list, the way upstream cmini's own detail response
// always has. They don't -- likes live in the DB's separate `likes`
// table, surfaced only by `GET .../layouts/{ref}/likes` (likes are not
// part of any format's payload) -- so this fixture also exports a
// `likes.json` map, which `DbSource` (scripts/sync_cmini_data.py) reads to
// fill that gap before handing a merged raw dict to the same
// normalize_detail/extract_likes the cmini path already uses. And rather
// than 100 `detail/<name>.json`/`likes/<name>.json` files (11 §1's
// literal layout), `detail.json`/`likes.json` are single maps keyed by
// name -- 100 static import statements would themselves need to name 100
// files that must already exist before the bundler can even resolve this
// test file, the same chicken-and-egg problem RECORD above solves once,
// not per file.
import { SELF } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import authorsFixture from "../fixtures/db-responses/authors.json" with { type: "json" };
import detailFixture from "../fixtures/db-responses/detail.json" with { type: "json" };
import layoutsFullFixture from "../fixtures/db-responses/layouts-full-cmini1.json" with { type: "json" };
import layoutsListFixture from "../fixtures/db-responses/layouts-list.json" with { type: "json" };
import likesFixture from "../fixtures/db-responses/likes.json" with { type: "json" };
import metaFixture from "../fixtures/db-responses/meta.json" with { type: "json" };
import { normalizeIds, seedUpstream100 } from "./support";

const RECORD = false; // NEVER true on a committed run -- see the header doc

async function getJson(url: string): Promise<unknown> {
  const res = await SELF.fetch(`https://example.com${url}`);
  expect(res.status, url).toBe(200);
  return normalizeIds(await res.json());
}

// RECORD mode can't write a file directly: `node:fs` inside this pool's
// workerd isolate has no real disk at all -- every path, even the OS temp
// dir, reads/writes ENOENT/EPERM (verified; see the header doc). It CAN
// write to stdout, which vitest pipes straight through to the real host
// process -- so recording means printing each fixture between two unique
// markers and having a host-side script (not vitest, not this repo --
// just `npx vitest run ... | that script`) slice stdout back into files.
function record(relPath: string, data: unknown): void {
  // eslint-disable-next-line no-console -- the whole point of RECORD mode
  console.log(`===LDB-S1a-FIXTURE-START:${relPath}===\n${JSON.stringify(data, null, 1)}\n===LDB-S1a-FIXTURE-END:${relPath}===`);
}

function checkOrRecord(relPath: string, committed: unknown, actual: unknown): void {
  if (RECORD) {
    record(relPath, actual);
    return;
  }
  expect(actual, `[LDB-S1a] db-responses/${relPath} drifted from the live route`).toEqual(committed);
}

describe("[LDB-S1a] db-responses/ fixture equals the live routes over upstream-100", () => {
  let names: string[] = [];

  beforeAll(async () => {
    await seedUpstream100();
    const list = (await getJson("/v1/layouts?limit=1000")) as { items: { name: string }[] };
    names = list.items.map((i) => i.name).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  });

  it("[LDB-S1a] /v1/meta", async () => {
    checkOrRecord("meta.json", metaFixture, await getJson("/v1/meta"));
  });

  it("[LDB-S1a] /v1/layouts (every page at limit=1000)", async () => {
    const pages: unknown[] = [];
    let cursor: string | undefined;
    for (;;) {
      const qs = new URLSearchParams({ limit: "1000" });
      if (cursor !== undefined) qs.set("cursor", cursor);
      const page = (await getJson(`/v1/layouts?${qs.toString()}`)) as {
        items: unknown[];
        next_cursor: string | null;
      };
      pages.push(page);
      if (page.next_cursor === null) break;
      cursor = page.next_cursor;
    }
    checkOrRecord("layouts-list.json", layoutsListFixture, pages);
  });

  it("[LDB-S1a] /v1/layouts?full=1&as=cmini/1", async () => {
    checkOrRecord("layouts-full-cmini1.json", layoutsFullFixture, await getJson("/v1/layouts?full=1&as=cmini/1"));
  });

  it("[LDB-S1a] every /v1/layouts/{name}?as=cmini/1 and its /likes", async () => {
    expect(names.length).toBe(100);
    // In parallel -- 200 sequential round trips through Hono+D1 was slow
    // enough (this file's own beforeAll seeds a full 100-layout import
    // too) to starve OTHER test files' 5s-per-test budget under the
    // "workers" project's shared concurrency (measured: reliably timed
    // out tests/api/{list,refs}.test.ts until this changed).
    const pairs = await Promise.all(
      names.map(async (name) => {
        const [detail, likes] = await Promise.all([
          getJson(`/v1/layouts/${encodeURIComponent(name)}?as=cmini/1`),
          getJson(`/v1/layouts/${encodeURIComponent(name)}/likes`),
        ]);
        return [name, detail, likes] as const;
      }),
    );
    const detail: Record<string, unknown> = {};
    const likes: Record<string, unknown> = {};
    for (const [name, d, l] of pairs) {
      detail[name] = d;
      likes[name] = l;
    }
    checkOrRecord("detail.json", detailFixture, detail);
    checkOrRecord("likes.json", likesFixture, likes);
  });

  it("[LDB-S1a] /v1/authors", async () => {
    checkOrRecord("authors.json", authorsFixture, await getJson("/v1/authors"));
  });
});
