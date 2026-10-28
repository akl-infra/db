// [LDB-V8] The /v1 spark/1 reader contract is frozen at the 1.28 shape. This
// is the file a strict /v1 reader (emulayout) validates against; it is also
// the schema `GET /v1/formats/spark/1/schema.json` serves by default. It must
// never be edited in place: a change is a new file and a new decision.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { describe, expect, it } from "vitest";
import { SKIP_PAYLOADS } from "../fixtures/skip-payloads.ts";
import { withholdSkip } from "../../formats/spark/1/withhold.ts";

const FILE = path.join(import.meta.dirname, "spark-1.v1-reader.schema.json");
const PINNED_SHA256 = "5abb5985587f339393eccbb33ebf6ecf7d74f9ecbfcfc1f79c4d391af6fdb5c5";

describe("[LDB-V8] spark-1.v1-reader.schema.json", () => {
  it("[LDB-V8] is byte-for-byte the pinned 1.28 schema", () => {
    expect(crypto.createHash("sha256").update(fs.readFileSync(FILE)).digest("hex")).toBe(PINNED_SHA256);
  });

  it("[LDB-V8] compiles under ajv strict mode and has none of the 1.29 skip constructs", () => {
    const schema = JSON.parse(fs.readFileSync(FILE, "utf8"));
    const ajv = new Ajv2020({ strict: true });
    addFormats(ajv);
    expect(() => ajv.compile(schema)).not.toThrow();
    const text = JSON.stringify(schema);
    expect(text).not.toContain("skip_repeat");
    expect(text).not.toContain('"skip"');
  });

  it("[LDB-V8] accepts every skip vector once withheld, and refuses each in full", () => {
    const ajv = new Ajv2020({ strict: true });
    addFormats(ajv);
    const validate = ajv.compile(JSON.parse(fs.readFileSync(FILE, "utf8")));
    for (const { name, payload } of SKIP_PAYLOADS) {
      expect(validate(payload), `${name} in full`).toBe(false);
      expect(validate(withholdSkip(payload).payload), `${name} withheld: ${JSON.stringify(validate.errors)}`).toBe(true);
    }
  });
});
