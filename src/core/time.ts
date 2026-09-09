// Time is injected everywhere writes happen (`events.ts`, `import/*`) so
// tests can pin a fixed or stepping clock instead of racing Date.now().
export type Clock = () => string; // ISO 8601, e.g. "2026-09-08T00:00:00.000Z"

export function systemClock(): string {
  return new Date().toISOString();
}

// A clock that returns the same instant every call -- the default in tests.
export function fixedClock(iso: string): Clock {
  return () => iso;
}

// A clock that advances by `stepMs` on every call, starting at `startIso` --
// for tests that need events to sort strictly by `at`.
export function steppingClock(startIso: string, stepMs = 1000): Clock {
  let t = new Date(startIso).getTime();
  return () => {
    const iso = new Date(t).toISOString();
    t += stepMs;
    return iso;
  };
}
