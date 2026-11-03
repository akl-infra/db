// The one failure prefix. Every failure the replica layer wants a human to see (a boot fallback taken, a snapshot, retention
// or proof failure, an unverified daily slot, a replica divergence) logs exactly ONE line that starts with
// `akldb-alarm: <component>: `. A CloudWatch metric filter on that prefix drives the alarm; the `akldb-boot:`, `akldb-snapshot:`
// ... lines stay as the info lines of successes. One event, one line: callers that already raised an alarm for an event do
// not raise a second one for the same event.
export const ALARM_PREFIX = "akldb-alarm: ";

/** The line for one failure: single-line (newlines in `message` become spaces). */
export function alarmLine(component: string, message: string): string {
  return `${ALARM_PREFIX}${component}: ${message.replace(/\s*[\r\n]+\s*/g, " ")}`;
}

/** Emit one alarm line to `sink`. */
export function raise(sink: (line: string) => void, component: string, message: string): void {
  sink(alarmLine(component, message));
}
