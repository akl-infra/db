// Shared helpers for the S6 read-route suite (07 §6 S6). Not a `*.test.ts`
// file itself -- vitest.config.ts's `include` only picks up `tests/api/
// **/*.test.ts`, so this module is safe to import from several of them
// without becoming its own (empty) suite.
import { env } from "cloudflare:test";
import type { Bindings } from "../../src/env";
import { fixedClock } from "../../src/core/time";
import { tick } from "../../src/import/cmini";
import { FakeUpstream } from "../import/fake-upstream";

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
