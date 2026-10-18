// [SITE-40] Inbox timestamps read as a human local date and time, never the
// ISO string with milliseconds (the ISO stays in the cell's title).
import { describe, expect, it } from "vitest";
import { formatWhen } from "../../src/lib/time.ts";

describe("[SITE-40] formatWhen", () => {
  it("formats an ISO instant in the given zone without seconds or milliseconds", () => {
    // newer ICU puts a narrow no-break space before AM/PM
    const plain = (s: string) => s.replace(/\u202f/g, " ");
    expect(plain(formatWhen("2026-10-18T14:34:56.789Z", { locale: "en-US", timeZone: "UTC" }))).toBe("Oct 18, 2026, 2:34 PM");
    expect(plain(formatWhen("2026-10-18T14:34:56.789Z", { locale: "en-US", timeZone: "America/New_York" }))).toBe("Oct 18, 2026, 10:34 AM");
  });

  it("returns an unparseable value unchanged rather than 'Invalid Date'", () => {
    expect(formatWhen("not a date")).toBe("not a date");
  });
});
