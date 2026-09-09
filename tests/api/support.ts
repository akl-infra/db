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
import { canonical } from "../../src/core/canonical";
import { fixedClock } from "../../src/core/time";
import { tick } from "../../src/import/cmini";
import { FakeUpstream } from "../import/fake-upstream";
import type { ConformanceCase, ConformanceStep } from "../conformance/manifest";

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

// One request/setup-step as `runConformanceRequest` fires it (09 §3 T2):
// bearer -> Authorization, body -> JSON + Content-Type, extra headers
// merged on top.
export async function fireConformanceStep(step: ConformanceStep, resolvePath: PathResolver = (p) => p): Promise<Response> {
  const url = `https://example.com${resolvePath(step.path)}`;
  const headers: Record<string, string> = { ...step.headers };
  if (step.bearer !== undefined) headers.Authorization = `Bearer ${step.bearer}`;
  const init: RequestInit = { method: step.method, headers };
  if (step.body !== undefined) {
    headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(step.body);
  }
  return SELF.fetch(url, init);
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

  for (const [name, expected] of Object.entries(kase.response.headers ?? {})) {
    expect(res.headers.get(name), `${kase.id}: header '${name}'`).toBe(expected);
  }

  if (kase.request.ifNoneMatchSelf && kase.response.status === 304) {
    expect(res.headers.get("ETag"), kase.id).toBe(primingEtag);
    expect(await res.text(), kase.id).toBe("");
    return;
  }

  if (kase.response.body === undefined) return;

  const contentType = res.headers.get("Content-Type") ?? "";
  const actual = contentType.includes("json") ? await res.json() : await res.text();
  expect(canonical(normalizeIds(actual)), kase.id).toBe(canonical(normalizeIds(kase.response.body)));
}
