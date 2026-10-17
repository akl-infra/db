// Not in errors.ts: every function there is an error() factory with a row in
// INTEGRATION.md's error table (LDB-G8).
//
// One-line description of a thrown value (name, message, cause), so a thrown
// message is queryable in Workers Logs (a bare `console.error(err)` there
// kept only the stack frames of a D1 error, never its message: 2026-10-14).
export function describeError(e: unknown): string {
  if (!(e instanceof Error)) return String(e);
  const cause = e.cause === undefined ? "" : ` cause=${e.cause instanceof Error ? `${e.cause.name}: ${e.cause.message}` : String(e.cause)}`;
  return `${e.name}: ${e.message}${cause}`;
}
