import { describe, expect, it } from "vitest";
import { validate, schema } from "../../formats/spark/1/index.ts";
import Ajv2020 from "ajv/dist/2020.js";

const keys = [{ char: "w", row: 0, col: 3, finger: "LI" }, { char: "s", row: 1, col: 2, finger: "LM" }];
const alt = (finger: string) => ({ ngram: ["w"], fingers: [finger] });
describe("[LDB-F52] default spark/1 fuzzy alternatives", () => {
  it("[LDB-F52] keeps a default plus multiple alternatives and accepts the same schema", () => {
    const payload = { keys, alts: [alt("LM"), alt("LR"), alt("LT"), alt("RT"), { ngram: ["w", "s"], fingers: ["LI", "LR"] }] };
    expect(validate(payload)).toEqual({ ok: true });
    expect(new Ajv2020({ strict: true }).compile(schema)(payload)).toBe(true);
    expect(payload.keys[0]!.finger).toBe("LI");
  });
  it("[LDB-F52] rejects duplicate unary assignments but keeps multigram uniqueness", () => {
    expect(validate({ keys, alts: [alt("LM"), alt("LM")] }).ok).toBe(false);
    expect(validate({ keys, alts: [
      { ngram: ["w", "s"], fingers: ["LM", "LI"] },
      { ngram: ["w", "s"], fingers: ["LR", "LI"] },
    ] }).ok).toBe(false);
  });
  it.each([
    { ngram: [null], fingers: [null] },
    { ngram: ["w"], fingers: [null] },
    { ngram: ["w"], fingers: [] },
    { ngram: ["w"], fingers: ["LM", "LR"] },
    { ngram: ["w"], fingers: ["bad"] },
    { ngram: ["x"], fingers: ["LM"] },
    { ngram: ["ws"], fingers: ["LM"] },
    { ngram: ["w"], fingers: ["LM"], unknown: true },
  ])("rejects malformed unary alt %j", entry => {
    expect(validate({ keys, alts: [entry] }).ok).toBe(false);
  });
  it("[LDB-F52] allows an explicit default finger consistently with existing no-move alts", () => {
    expect(validate({ keys, alts: [alt("LI"), alt("LM")] }).ok).toBe(true);
  });
});
