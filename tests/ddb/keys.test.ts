import { describe, expect, it } from "vitest";
import { eventKey, fold, nameKey, padOrdinal, padRev, padSeq, revKey } from "../../src/store/ddb/keys";

describe("ddb keys", () => {
  it("pads numbers so byte order is numeric order", () => {
    expect(padSeq(7)).toBe("000000000007");
    expect(padRev(12)).toBe("00000012");
    expect(padOrdinal(3)).toBe("000003");
    expect(padSeq(99) < padSeq(100)).toBe(true);
    expect(() => padRev(1e8)).toThrow();
    expect(() => padSeq(-1)).toThrow();
  });

  it("folds ASCII only, like SQLite NOCASE", () => {
    expect(fold("QwErTy-Ä")).toBe("qwerty-Ä");
    expect(nameKey("Foo")).toEqual({ pk: "NAME#foo", sk: "LIVE" });
  });

  it("builds event and rev keys", () => {
    expect(eventKey(5)).toEqual({ pk: "EV", sk: "000000000005" });
    expect(revKey("L1", null, 2).sk).toBe("V#-#00000002");
    expect(revKey("L1", "qwerty", 2).sk).toBe("V#qwerty#00000002");
  });
});
