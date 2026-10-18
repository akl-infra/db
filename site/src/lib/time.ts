// Inbox timestamps: the API's ISO strings (`2026-10-18T12:34:56.789Z`) read
// as a local, human date and time ("Oct 18, 2026, 2:34 PM"); the ISO itself
// stays available in a `title`. Pure given its options, so it is testable
// without depending on the machine's locale or zone.
export function formatWhen(iso: string, opts: { locale?: string; timeZone?: string } = {}): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat(opts.locale, { dateStyle: "medium", timeStyle: "short", timeZone: opts.timeZone }).format(date);
}
