// [LDB-FZ10] Shared harness for the seeded property suites (Stage 4 F-db). CI runs every property at a FIXED seed with a small
// `numRuns` (deterministic: a red run is always reproducible, never caused by an unrelated change); the nightly `fuzz` job sets
// FUZZ_RUNS large and FUZZ_SEED random. No assertion here reads a clock.
//
//   FUZZ_RUNS  multiplier base: runs per property (default: the property's own small `runs`)
//   FUZZ_SEED  integer seed (default FIXED_SEED)
//   FUZZ_OUT   directory; a failing property writes `<name>-<seed>.json` there (seed, shrunk counterexample, error, replay line)
import fs from "node:fs";
import path from "node:path";
import fc from "fast-check";

export const FIXED_SEED = 0x46555a31; // 'FUZ1'

export function fuzzSeed(): number {
  const s = process.env.FUZZ_SEED;
  if (s === undefined || s === "") return FIXED_SEED;
  const n = Number(s);
  if (!Number.isInteger(n)) throw new Error(`FUZZ_SEED must be an integer, got ${JSON.stringify(s)}`);
  return n;
}

export function fuzzRuns(defaultRuns: number): number {
  const r = process.env.FUZZ_RUNS;
  if (r === undefined || r === "") return defaultRuns;
  const n = Number(r);
  if (!Number.isInteger(n) || n < 1) throw new Error(`FUZZ_RUNS must be a positive integer, got ${JSON.stringify(r)}`);
  return n;
}

// fc.assert with the seed pinned, and a failure that carries seed + minimal input in its message (and in FUZZ_OUT).
export async function runProperty<T>(name: string, prop: fc.IAsyncPropertyWithHooks<T> | fc.IPropertyWithHooks<T>, defaultRuns: number): Promise<void> {
  const seed = fuzzSeed();
  const numRuns = fuzzRuns(defaultRuns);
  const r = await fc.check(prop as fc.IAsyncPropertyWithHooks<T>, { seed, numRuns, verbose: 0 });
  if (!r.failed) return;
  const cause = r.errorInstance instanceof Error ? `${r.errorInstance.message}` : String(r.errorInstance ?? "property returned false");
  const counterexample = JSON.stringify(r.counterexample, (_k, v) => (typeof v === "bigint" ? String(v) : v));
  const replay = `FUZZ_SEED=${seed} FUZZ_RUNS=${numRuns} npx vitest run <file> -t ${JSON.stringify(name)}`;
  const out = process.env.FUZZ_OUT;
  if (out) {
    fs.mkdirSync(out, { recursive: true });
    const file = path.join(out, `${name.replace(/[^A-Za-z0-9._-]+/g, "_")}-${seed}.json`);
    fs.writeFileSync(file, JSON.stringify({ name, seed, numRuns, path: r.counterexamplePath, cause: cause.slice(0, 8000), counterexample: r.counterexample, replay }, null, 2));
  }
  throw new Error(`property "${name}" failed at FUZZ_SEED=${seed} (numRuns ${numRuns}, shrunk ${r.numShrinks}x)\n${cause}\ncounterexample: ${counterexample?.slice(0, 6000)}\nreplay: ${replay}`);
}
