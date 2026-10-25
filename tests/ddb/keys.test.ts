import { describe, expect, it } from "vitest";
import { eventKey, fold, nameKey, padOrdinal, padRev, padSeq, revKey } from "../../src/store/ddb/keys";

describe("ddb keys", () => {
  it("[LDB-DDB15] pads numbers so byte order is numeric order", () => {
    expect(padSeq(7)).toBe("000000000007");
    expect(padRev(12)).toBe("00000012");
    expect(padOrdinal(3)).toBe("000003");
    expect(padSeq(99) < padSeq(100)).toBe(true);
    expect(() => padRev(1e8)).toThrow();
    expect(() => padSeq(-1)).toThrow();
  });

  it("[LDB-DDB15] folds ASCII only, like SQLite NOCASE", () => {
    expect(fold("QwErTy-Ä")).toBe("qwerty-Ä");
    expect(nameKey("Foo")).toEqual({ pk: "NAME#foo", sk: "LIVE" });
  });

  it("[LDB-DDB15] builds event and rev keys", () => {
    expect(eventKey(5)).toEqual({ pk: "EV", sk: "000000000005" });
    expect(revKey("L1", null, 2).sk).toBe("V#-#00000002");
    expect(revKey("L1", "qwerty", 2).sk).toBe("V#qwerty#00000002");
  });
});

import { payloadRef, sha256Hex } from "../../src/store/ddb/payload";

describe("payload hash", () => {
  it("[LDB-DDB8] is SHA-256", () => {
    const enc = new TextEncoder();
    expect(sha256Hex(enc.encode(""))).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(sha256Hex(enc.encode("abc"))).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(payloadRef("abc")).toBe("payloads/ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    // 56 and 64 bytes straddle the padding boundary
    expect(sha256Hex(enc.encode("a".repeat(56)))).toBe("b35439a4ac6f0948b6d6f9e3c6af0f5f590ce20f1bde7090ef7970686ec6738a");
    expect(sha256Hex(enc.encode("a".repeat(64)))).toBe("ffe054fe7ae0cb6dc65c3af9b61d5209f439851db43d0ba5997337df154668eb");
  });
});

import fs from "node:fs";
import path from "node:path";

describe("HEAD has one writer", () => {
  it("[LDB-DDB16] only tx.ts (runEventTx) and the codec build writes touching META/HEAD; no other store file both names HEAD and issues a write command", () => {
    const dir = path.resolve(import.meta.dirname, "../../src/store/ddb");
    const offenders: string[] = [];
    const walk = (d: string): string[] =>
      fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : e.name.endsWith(".ts") ? [path.join(d, e.name)] : []));
    for (const file of walk(dir)) {
      const rel = path.relative(dir, file);
      if (["tx.ts", "keys.ts", "faults.ts", "counting.ts"].includes(rel) || rel.startsWith("schema/")) continue;
      const src = fs.readFileSync(file, "utf8").replace(/\/\/.*$/gm, "");
      const namesHead = /\bHEAD_KEY\b|pk:\s*"META",\s*sk:\s*"HEAD"/.test(src);
      const writes = /\b(Put|Update|Delete|TransactWrite|BatchWrite)Command\b/.test(src);
      if (namesHead && writes) offenders.push(rel);
    }
    expect(offenders).toEqual([]);
  });
});
