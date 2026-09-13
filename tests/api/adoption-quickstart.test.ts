// [LDB-G13] db/tests/api/adoption-quickstart.test.ts -- the executable
// half of adoption.md §0 Quickstart's item 4 (the Node client-lane signing
// snippet): with placeholders substituted for a seeded test keypair,
// client and layout, the snippet runs verbatim against the in-test Worker
// via `SELF.fetch` and gets a 2xx.
//
// The snippet's source comes from `tests/fixtures/adoption-quickstart-
// snippet.json` (a static `with { type: "json" }` import), not a runtime
// read of the doc -- the "workers" vitest project (tests/api/**) runs
// inside workerd via @cloudflare/vitest-pool-workers, which has no real
// filesystem access at all (`tests/api/fixture-export.test.ts`'s own
// header verified this empirically; only a static JSON import or the OS
// temp dir is reachable from inside the isolate). `tests/tools/
// adoption-examples.test.ts`'s own [LDB-G13] "byte-identical to the
// fixture" case, which DOES have real fs access (the "node" project), is
// what keeps this fixture from silently drifting from what the doc
// actually shows a reader.
import { SELF, env } from "cloudflare:test";
import { ulid } from "ulidx";
import { describe, expect, it, vi } from "vitest";
import type { Bindings } from "../../src/env";
import { bytesToBase64Url } from "../../src/auth/client";
import { commitWrite, type CommitInput } from "../../src/core/events";
import { fixedClock } from "../../src/core/time";
import { seedClient } from "../auth/client-support";
import quickstartSnippetFixture from "../fixtures/adoption-quickstart-snippet.json" with { type: "json" };
import { AKL_PAYLOAD, uniqueName } from "./write-support";

const db = (env as unknown as Bindings).DB;
const clock = fixedClock("2026-07-01T00:00:00.000Z");

async function seedOwnedLayout(owner: string): Promise<{ id: string }> {
  const input: CommitInput = {
    layoutId: ulid(),
    creating: true,
    currentN: 0,
    currentLayout: null,
    currentFormats: new Map(),
    layout: { kind: "created", name: uniqueName("quickstart-seed"), owner, created_at: clock(), deleted: false },
    format: { kind: "format_added", lineage: "spark", format: "spark/1", payload: AKL_PAYLOAD, hasMagic: false },
    modified_at: clock(),
    actor: owner,
    via: "discord",
    source: { client: "discord-app:test", version: null },
    upstream: null,
  };
  const { layout } = await commitWrite(db, clock, input);
  return { id: layout.id };
}

async function registerTestClient(ownerUserId: string): Promise<{ clientId: string; pkcs8B64url: string }> {
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const pubkeyRaw = new Uint8Array((await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer);
  const pkcs8 = new Uint8Array((await crypto.subtle.exportKey("pkcs8", pair.privateKey)) as ArrayBuffer);
  const clientId = ulid();
  await seedClient(db, clock, {
    id: clientId,
    pubkeyB64url: bytesToBase64Url(pubkeyRaw),
    ownerUserId,
    caps: "act-as-owner-only",
  });
  return { clientId, pkcs8B64url: bytesToBase64Url(pkcs8) };
}

describe("[LDB-G13] adoption.md §0 Quickstart item 4 (executed)", () => {
  it("[LDB-G13] the Node client-lane signing snippet, run against the in-test Worker, gets a 2xx", async () => {
    const OWNER = "800000000000000099";
    const { id: layoutId } = await seedOwnedLayout(OWNER);
    const { clientId, pkcs8B64url } = await registerTestClient(OWNER);

    let code = quickstartSnippetFixture.code;
    code = code.replaceAll('"<client id>"', JSON.stringify(clientId));
    code = code.replaceAll('"<base64url pkcs8 private key>"', JSON.stringify(pkcs8B64url));
    code = code.replaceAll('"<id-or-name>"', JSON.stringify(layoutId));
    code = code.replaceAll('"<discord user id>"', JSON.stringify(OWNER));
    // Sanity: every placeholder the snippet declares was actually replaced
    // (a doc/fixture edit that renames a placeholder should fail loudly
    // here, not silently sign requests for the literal string "<client id>").
    expect(code).not.toMatch(/<client id>|<base64url pkcs8 private key>|<id-or-name>|<discord user id>/);

    // fetch(), in the doc's own snippet, is the browser/Node global -- here
    // it's redirected at the in-test Worker, the same `https://example.com`
    // rewrite every other workers-pool test in this suite uses
    // (write-support.ts's `writeFetch`), never a re-implementation of the
    // route dispatch itself.
    async function workerFetch(url: string | URL, init?: RequestInit): Promise<Response> {
      const u = new URL(String(url));
      return SELF.fetch(`https://example.com${u.pathname}${u.search}`, init);
    }
    vi.stubGlobal("fetch", workerFetch);

    // Plain `new Function`/`eval` is refused inside workerd ("Code
    // generation from strings disallowed for this context"). @cloudflare/
    // vitest-pool-workers itself unconditionally wires an `unsafeEval`
    // binding onto every project worker under the internal name
    // `__VITEST_POOL_WORKERS_UNSAFE_EVAL` (it needs one for its own
    // module-transform machinery) -- since this test file executes INSIDE
    // that same project worker (the same `env` object route handlers see,
    // confirmed by `TEST_CLOCK`'s own use elsewhere in this suite), that
    // binding is reachable here too, and is the sanctioned escape hatch
    // Cloudflare Workers use for compiling a function from source at
    // runtime (`newFunction(body, name)`), never a workaround this test
    // invented.
    const unsafeEval = (env as unknown as { __VITEST_POOL_WORKERS_UNSAFE_EVAL: { newFunction: (body: string, name: string) => () => Promise<Response> } }).__VITEST_POOL_WORKERS_UNSAFE_EVAL;
    const run = unsafeEval.newFunction(`return (async () => {\n${code}\nreturn res;\n})();`, "quickstartSnippet");
    try {
      const res = await run();
      expect(res).toBeInstanceOf(Response);
      const bodyText = await res.clone().text();
      expect(res.status, `expected 2xx, got ${res.status}: ${bodyText}`).toBeGreaterThanOrEqual(200);
      expect(res.status).toBeLessThan(300);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
