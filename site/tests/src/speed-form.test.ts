// [SITE-41] "Submit a speed for a user": the client-side check mirrors the
// DB's, and an error is shown only after blur or a submit attempt.
import { describe, expect, it } from "vitest";
import { speedFormBody, speedFormErrors, visibleSpeedErrors, type SpeedFormValues } from "../../src/lib/speedForm.ts";

const GOOD: SpeedFormValues = { userId: "184412255822020608", layout: "io", wpm: "120", proof: "https://example.org/proof" };

describe("[SITE-41] speedFormErrors", () => {
  it("a complete, valid entry has no errors", () => {
    expect(speedFormErrors(GOOD)).toEqual({});
  });

  it("flags exactly the fields that are wrong", () => {
    expect(speedFormErrors({ ...GOOD, userId: "123" })).toEqual({ userId: true });
    expect(speedFormErrors({ ...GOOD, userId: "18441225582202060x" })).toEqual({ userId: true });
    expect(speedFormErrors({ ...GOOD, layout: "  " })).toEqual({ layout: true });
    expect(speedFormErrors({ ...GOOD, proof: "ftp://example.org/p" })).toEqual({ proof: true });
    expect(speedFormErrors({ ...GOOD, proof: "https://" })).toEqual({ proof: true });
    expect(speedFormErrors({ ...GOOD, proof: `https://example.org/${"a".repeat(512)}` })).toEqual({ proof: true });
    expect(speedFormErrors({ userId: "", layout: "", wpm: "", proof: "" })).toEqual({ userId: true, layout: true, wpm: true, proof: true });
  });

  it("wpm is a whole number from 1 to 1000", () => {
    for (const ok of ["1", "85", "1000", " 90 "]) expect(speedFormErrors({ ...GOOD, wpm: ok }), ok).toEqual({});
    for (const bad of ["0", "1001", "85.5", "-5", "fast", "", "1e3"]) expect(speedFormErrors({ ...GOOD, wpm: bad }), bad).toEqual({ wpm: true });
  });

  it("surrounding whitespace is ignored", () => {
    expect(speedFormErrors({ userId: " 184412255822020608 ", layout: " io ", wpm: " 120 ", proof: " https://example.org/p " })).toEqual({});
  });
});

describe("[SITE-41] visibleSpeedErrors", () => {
  const allWrong = speedFormErrors({ userId: "", layout: "", wpm: "", proof: "" });

  it("shows nothing on a form nobody has touched", () => {
    expect(visibleSpeedErrors(allWrong, {}, false)).toEqual({});
  });

  it("shows a field's error once that field was left, and only that field's", () => {
    expect(visibleSpeedErrors(allWrong, { wpm: true }, false)).toEqual({ wpm: true });
  });

  it("a touched field that is fine shows nothing", () => {
    expect(visibleSpeedErrors(speedFormErrors(GOOD), { wpm: true, proof: true }, false)).toEqual({});
  });

  it("a submit attempt shows every error", () => {
    expect(visibleSpeedErrors(allWrong, {}, true)).toEqual({ userId: true, layout: true, wpm: true, proof: true });
  });
});

describe("[SITE-41] speedFormBody", () => {
  it("trims, and sends wpm as a number", () => {
    expect(speedFormBody({ userId: " 184412255822020608 ", layout: " io ", wpm: " 120 ", proof: " https://example.org/p " })).toEqual({
      user_id: "184412255822020608",
      layout: "io",
      wpm: 120,
      proof: "https://example.org/p",
    });
  });
});
