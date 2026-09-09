// Fault isolation for any group of independently-scheduled jobs run inside
// one dispatch (`src/index.ts`'s `scheduled()`, `core/nightly.ts`'s
// `runNightly()`): one job throwing must never stop the jobs queued after
// it in the same batch. Originally local to `scheduled()` (four previously-
// independent cron triggers -- `*/1`, `*/5`, `0 3`, `0 4` -- collapsed onto
// one `*/5 * * * *` trigger must not silently recreate a single point of
// failure out of four); pulled out here so `runNightly` can share the exact
// same guard instead of a second copy.
export async function runJob(name: string, job: () => Promise<unknown>): Promise<boolean> {
  try {
    await job();
    return true;
  } catch (e) {
    console.error(`job '${name}' failed`, e);
    return false;
  }
}
