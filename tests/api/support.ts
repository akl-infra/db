// Shared helpers for the S6 read-route suite (07 §6 S6). Not a `*.test.ts`
// file itself -- vitest.config.ts's `include` only picks up `tests/api/
// **/*.test.ts`, so this module is safe to import from several of them
// without becoming its own (empty) suite. `tests/rehost.test.ts` (top-level,
// S7) also imports from here despite the directory name -- it's the one
// other file that needs to run the exact same conformance assertions
// (against a restored DB instead of a freshly-seeded one).
import { SELF, env } from "cloudflare:test";
import { expect } from "vitest";
import type { Bindings } from "../../src/env";
import { base64UrlToBytes } from "../../src/auth/client";
import { canonical } from "../../src/core/canonical";
import { fixedClock } from "../../src/core/time";
import { tick } from "../../src/import/cmini";
import { FakeUpstream } from "../import/fake-upstream";
import { importPrivateKeyPkcs8, signHeaders, vectors } from "../auth/client-support";
import type { ConformanceCase, ConformanceStep } from "../conformance/manifest";
import { API_VERSION_HEADER, apiVersionString } from "../../src/core/version";

// 10 C1: the well-known client every `signed` conformance step (manifest.ts)
// authenticates against -- a fixed, non-ULID id (not `registerClient`'s
// minted one) so a signed case's response body stays byte-exact without
// `normalizeIds`. `conformance.test.ts`'s `seedWriteFixtures` inserts the
// matching `clients` row directly; this module only signs.
export const CONFORMANCE_CLIENT_ID = "conformance-client-1";

let conformancePrivateKeyPromise: Promise<CryptoKey> | null = null;
function conformancePrivateKey(): Promise<CryptoKey> {
  conformancePrivateKeyPromise ??= importPrivateKeyPkcs8(vectors.keys[0]!.pkcs8_b64url);
  return conformancePrivateKeyPromise;
}

export const bindings = env as unknown as Bindings;
export const db = bindings.DB;

export const SEED_CLOCK_ISO = "2026-06-01T00:00:00.000Z";

// Seeds the whole `upstream-100` fixture through the real import pipeline
// (07 §6 S5's `tick()`) -- the same path production uses, so what these
// tests read back is exactly what an imported record looks like, not a
// hand-built stand-in. Returns the `FakeUpstream` in case a test wants to
// mutate it and tick again.
export async function seedUpstream100(clockIso: string = SEED_CLOCK_ISO): Promise<FakeUpstream> {
  const fake = new FakeUpstream();
  await tick(bindings, fixedClock(clockIso), fake.fetchImpl, fake.sleepImpl);
  return fake;
}

const ULID_RE = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/i;
const ID_PLACEHOLDER = "01ARZ3NDEKTSV4RRFFQ69G5FAV";

// Record ids are minted fresh (random, via ulidx) on every import, so a
// byte-fixed conformance fixture can never pin one -- this collapses any
// ULID-shaped string, in the actual response AND the stored fixture, to
// one placeholder before comparing (07 §6 S6: "seeds ... at a FIXED clock
// (fixed ULIDs too, or normalise ids in the comparison -- say which)"; this
// suite picked normalisation, so it never has to make `appendWrite`'s id
// minting seedable).
export function normalizeIds(v: unknown): unknown {
  if (typeof v === "string") return ULID_RE.test(v) ? ID_PLACEHOLDER : v;
  if (Array.isArray(v)) return v.map(normalizeIds);
  if (v !== null && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) out[k] = normalizeIds(val);
    return out;
  }
  return v;
}

// Maps a fixture path (possibly carrying a T2 id-placeholder, e.g.
// `__CW_RESTORE_ID__` -- a fixture file can never embed a freshly-minted
// ulid) to the real path to fetch. Defaults to identity; conformance.test.ts
// passes its own substitution, tests/rehost.test.ts needs none.
export type PathResolver = (path: string) => string;

// X1 (12 §2.1): same reasoning as `write-support.ts`'s `writeFetch` --
// `index.ts`'s webhook nudge fires via `waitUntil`, which `SELF.fetch`
// doesn't wait on, so a dangling delivery attempt can outlive whatever
// fetch stub was active when it was triggered and hit the real network in
// the sandboxed test runtime (workerd's "hung" watchdog). Awaited once
// here so every conformance step (and `tests/rehost.test.ts`'s replay,
// which shares this function) is covered without touching individual
// cases. Swallowed: a rejected drain is not this step's problem.
async function awaitPendingNudge(): Promise<void> {
  const pending = (bindings as unknown as { TEST_LAST_NUDGE?: Promise<unknown> }).TEST_LAST_NUDGE;
  if (pending === undefined) return;
  try {
    await pending;
  } catch {
    // logged by the nudge's own caller in production; not this helper's job
  }
}

// One request/setup-step as `runConformanceRequest` fires it (09 §3 T2):
// bearer -> Authorization, body -> JSON + Content-Type, extra headers
// merged on top.
export async function fireConformanceStep(step: ConformanceStep, resolvePath: PathResolver = (p) => p): Promise<Response> {
  const path = resolvePath(step.path);
  const url = `https://example.com${path}`;
  const headers: Record<string, string> = { ...step.headers };
  if (step.bearer !== undefined) headers.Authorization = `Bearer ${step.bearer}`;
  const init: RequestInit = { method: step.method, headers };
  if (step.body !== undefined) {
    headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(step.body);
  }
  if (step.signed !== undefined) {
    // LDB-A4 follow-up: `nonce`, when the fixture names one, is forwarded
    // verbatim instead of a fresh random one -- how a `replay` fixture's
    // `setup` step and its asserted step share one nonce while each still
    // signs a real, freshly-timestamped request (manifest.ts's
    // `ConformanceStep.signed` comment explains why this can't be frozen).
    const nonce = step.signed.nonce !== undefined ? (base64UrlToBytes(step.signed.nonce) ?? undefined) : undefined;
    const signedHeaders = await signHeaders({
      privateKey: await conformancePrivateKey(),
      clientId: CONFORMANCE_CLIENT_ID,
      actor: step.signed.actor,
      method: step.method,
      pathWithQuery: path,
      body: typeof init.body === "string" ? new TextEncoder().encode(init.body) : undefined,
      timestamp: Math.floor(Date.now() / 1000), // the live auth clock is real wall-clock, never a fixture value
      nonce,
    });
    Object.assign(headers, signedHeaders);
  }
  const res = await SELF.fetch(url, init);
  await awaitPendingNudge();
  return res;
}

// The conformance runner (07 §6 S6/S7, 09 §3 T2): one case, asserted byte-
// exact. Factored out of tests/api/conformance.test.ts so tests/
// rehost.test.ts can replay the exact same assertions against a RESTORED
// database (LDB-G1) -- two copies of this logic could quietly drift on
// what "conformant" means. `req.setup` (T2's write cases: e.g. a first
// POST that must land so the second one collides on the name) fires first,
// responses discarded.
export async function runConformanceRequest(
  req: ConformanceCase["request"],
  resolvePath: PathResolver = (p) => p,
): Promise<{ res: Response; primingEtag?: string }> {
  for (const step of req.setup ?? []) {
    await fireConformanceStep(step, resolvePath);
  }
  if (!req.ifNoneMatchSelf) {
    return { res: await fireConformanceStep(req, resolvePath) };
  }
  const priming = await fireConformanceStep({ method: req.method, path: req.path }, resolvePath);
  const primingEtag = priming.headers.get("ETag") ?? undefined;
  const res = await fireConformanceStep(
    { method: req.method, path: req.path, headers: primingEtag !== undefined ? { "If-None-Match": primingEtag } : {} },
    resolvePath,
  );
  return { res, primingEtag };
}

export async function assertConformanceCase(kase: ConformanceCase, resolvePath?: PathResolver): Promise<void> {
  const { res, primingEtag } = await runConformanceRequest(kase.request, resolvePath);

  expect(res.status, kase.id).toBe(kase.response.status);

  // [LDB-V2] design/layout-db/25-api-versioning.md "Policy" (b): every
  // response, success or error, carries `X-AKLDB-API`. Asserted HERE
  // (rather than per-fixture) so it runs for all ~350+ conformance cases
  // (conformance.test.ts's per-case loop, tagged `[LDB-V2]`) AND for
  // `tests/rehost.test.ts`'s replay against a RESTORED database, which
  // calls this exact function -- one real matrix over (route, status)
  // pairs including every error code, not just the success path.
  expect(res.headers.get(API_VERSION_HEADER), `${kase.id}: ${API_VERSION_HEADER} header`).toBe(apiVersionString());

  for (const [name, expected] of Object.entries(kase.response.headers ?? {})) {
    expect(res.headers.get(name), `${kase.id}: header '${name}'`).toBe(expected);
  }

  if (kase.request.ifNoneMatchSelf && kase.response.status === 304) {
    expect(res.headers.get("ETag"), kase.id).toBe(primingEtag);
    expect(await res.text(), kase.id).toBe("");
    return;
  }

  if (kase.response.body === undefined) {
    // X1: a case that only asserts status/headers (e.g. `changes-stream/200`
    // -- an open SSE response can't be byte-pinned) must still drain its
    // body if it has one: `routes/stream.ts`'s `pump` writes into a
    // `TransformStream` with a writable-side queue of 1, so an abandoned,
    // never-read stream backpressures on its very next frame -- nothing
    // ever drains the queue, so the pump's own bound check never gets
    // another turn (`.cancel()` was tried first and did not reliably
    // unstick it in this sandbox; fully reading does). Harmless for every
    // non-streamed case: reading an already-buffered small body (or one
    // with no body at all) to exhaustion costs nothing.
    await res.text();
    return;
  }

  const contentType = res.headers.get("Content-Type") ?? "";
  let actual = contentType.includes("json") ? await res.json() : await res.text();
  // LDB-A4 follow-up: strip whatever `omitBodyKeys` names (e.g. client-lane
  // `stale_timestamp`'s real-clock `skew`) from the ACTUAL body only --
  // never from `kase.response.body`, which is asserted to omit it already.
  if (kase.response.omitBodyKeys !== undefined && actual !== null && typeof actual === "object" && !Array.isArray(actual)) {
    actual = { ...(actual as Record<string, unknown>) };
    for (const key of kase.response.omitBodyKeys) delete (actual as Record<string, unknown>)[key];
  }
  expect(canonical(normalizeIds(actual)), kase.id).toBe(canonical(normalizeIds(kase.response.body)));
}
