// [LDB-A4] [LDB-D5] db/scripts/report-drill.mjs -- the drill's own copy of
// the client-lane signer (a plain Node script duplicates `src/auth/
// client.ts`'s `signingString` the same way `bot/scripts/sign.mjs` and
// `bot/src/client/sign.ts` do -- see report-drill.mjs's own header). This
// file is that copy's `tests/vectors/client-signing.json` reproduction,
// the same role `bot/tests/client/sign.test.ts` plays for the bot's copy
// (LDB-B4's sibling here), plus the report-body-shape and
// steps-to-report assembly logic that's unique to the drill.
import { describe, expect, it } from "vitest";
// report-drill.mjs is a plain script (no .d.ts) -- typed locally the same
// way tests/tools/codeowners.test.ts's own `.mjs` import is.
// @ts-expect-error -- see above
import { assembleFromSteps, bodyHash, buildReportBody, importPrivateKey, readStepJson, signingString, signRequest } from "../../scripts/report-drill.mjs";
import vectorsFixture from "../vectors/client-signing.json" with { type: "json" };

interface VectorKey {
  id: string;
  seed_hex: string;
  pubkey_b64url: string;
  pkcs8_b64url: string;
}
interface Vector {
  name: string;
  key: string;
  client_id: string;
  method: string;
  path: string;
  timestamp: string;
  nonce: string;
  actor: string;
  body: string | null;
  signing_string: string;
  signature_b64url: string;
}
interface VectorsFile {
  version: 1;
  keys: VectorKey[];
  vectors: Vector[];
}

const vectors = vectorsFixture as VectorsFile;

function base64UrlDecode(s: string): Uint8Array {
  return new Uint8Array(Buffer.from(s, "base64url"));
}

describe("[LDB-A4] report-drill.mjs -- client-signing vectors", () => {
  it("reproduces every vector's signing_string and signature_b64url", async () => {
    expect(vectors.vectors.length).toBeGreaterThanOrEqual(1);
    const keysById = new Map(vectors.keys.map((k) => [k.id, k]));

    for (const v of vectors.vectors) {
      const keyInfo = keysById.get(v.key);
      if (keyInfo === undefined) throw new Error(`vector '${v.name}': unknown key '${v.key}'`);

      const bodyBytes = v.body === null ? new Uint8Array(0) : new TextEncoder().encode(v.body);
      const hash = await bodyHash(bodyBytes);
      const builtSigningString = signingString(v.method, v.path, v.timestamp, v.nonce, v.actor, hash);
      expect(builtSigningString, v.name).toBe(v.signing_string);

      const key = await importPrivateKey(keyInfo.pkcs8_b64url);
      const headers = await signRequest(
        key,
        v.client_id,
        v.actor,
        v.method,
        v.path,
        v.body === null ? undefined : bodyBytes,
        Number(v.timestamp) * 1000,
        base64UrlDecode(v.nonce),
      );
      expect(headers["X-Akl-Signature"], v.name).toBe(v.signature_b64url);
      expect(headers["X-Akl-Timestamp"], v.name).toBe(v.timestamp);
      expect(headers["X-Akl-Nonce"], v.name).toBe(v.nonce);
      expect(headers["X-Akl-Client"], v.name).toBe(v.client_id);
      expect(headers["X-Akl-Actor"], v.name).toBe(v.actor);
    }
  });
});

describe("[LDB-D5] report-drill.mjs -- buildReportBody (the drillReportSchema shape)", () => {
  it("[LDB-D5] builds {ok} with no detail", () => {
    expect(buildReportBody(true, undefined)).toEqual({ ok: true });
    expect(buildReportBody(false, undefined)).toEqual({ ok: false });
  });

  it("[LDB-D5] builds {ok, detail} when detail is given", () => {
    expect(buildReportBody(true, { at: "2026-01-01T00:00:00.000Z" })).toEqual({
      ok: true,
      detail: { at: "2026-01-01T00:00:00.000Z" },
    });
  });

  it("[LDB-D5] rejects a non-boolean 'ok' (a runtime check -- buildReportBody's import is untyped, so this is deliberately wrong at runtime only)", () => {
    expect(() => buildReportBody("true", undefined)).toThrow(/must be a boolean/);
  });

  it("[LDB-D5] rejects a non-object 'detail' (runtime-only, same reason as above)", () => {
    expect(() => buildReportBody(true, "not an object")).toThrow(/must be a plain object/);
    expect(() => buildReportBody(true, ["array", "not", "object"])).toThrow(/must be a plain object/);
  });

  it("[LDB-D5] rejects a 'detail' whose canonical encoding is over the 4 KB cap (routes/admin.ts's own bound)", () => {
    const big = { blob: "x".repeat(5000) };
    expect(() => buildReportBody(true, big)).toThrow(/over the 4096-byte cap/);
  });

  it("[LDB-D5] accepts a 'detail' right at the boundary and rejects one byte over it", () => {
    // canonical({blob:"..."}) == `{"blob":"..."}` -- 11 wrapper bytes
    // (measured directly against canonical() itself, not assumed).
    const atCap = { blob: "x".repeat(4096 - 11) }; // exactly 4096 bytes
    expect(() => buildReportBody(true, atCap)).not.toThrow();
    const overCap = { blob: "x".repeat(4096 - 10) }; // exactly 4097 bytes
    expect(() => buildReportBody(true, overCap)).toThrow(/over the 4096-byte cap/);
  });
});

describe("[LDB-D5] report-drill.mjs -- readStepJson / assembleFromSteps", () => {
  it("[LDB-D5] readStepJson returns null for a null/undefined path (the step never ran)", () => {
    expect(readStepJson(null)).toBeNull();
    expect(readStepJson(undefined)).toBeNull();
  });

  it("[LDB-D5] readStepJson surfaces an unreadable path as its own failure record, never throws", () => {
    const result = readStepJson("/nonexistent/path/does-not-exist.json");
    expect(result?.ok).toBe(false);
    expect(result?.step).toBe("unreadable");
  });

  it("[LDB-D5] assembleFromSteps is ok:true only when every supplied step reported ok:true", () => {
    const now = new Date("2026-01-01T00:00:00.000Z");
    const good = assembleFromSteps({
      fetchResult: { ok: true, latest: { key: "dump-x.json.gz" }, sha256: "abc", bytes: 10 },
      restoreResult: { ok: true },
      verifyResult: { ok: true },
      durationMs: 1234,
      now,
    });
    expect(good.ok).toBe(true);
    expect(good.detail).toEqual({
      at: "2026-01-01T00:00:00.000Z",
      dump: { key: "dump-x.json.gz", sha256: "abc", bytes: 10 },
      checks: { fetch: true, restore: true, verify: true },
      duration_ms: 1234,
    });
  });

  it("[LDB-D5] is ok:false when any supplied step reported ok:false", () => {
    const bad = assembleFromSteps({
      fetchResult: { ok: true, latest: { key: "k" }, sha256: "s", bytes: 1 },
      restoreResult: { ok: false },
      verifyResult: { ok: true },
      durationMs: 1,
      now: new Date(),
    });
    expect(bad.ok).toBe(false);
    expect(bad.detail.checks).toEqual({ fetch: true, restore: false, verify: true });
  });

  it("[LDB-D5] distinguishes a step that never ran (null -- an earlier step failed first) from one that ran and failed", () => {
    const result = assembleFromSteps({
      fetchResult: { ok: false, step: "integrity" },
      restoreResult: null,
      verifyResult: null,
      durationMs: 5,
      now: new Date(),
    });
    expect(result.ok).toBe(false);
    expect(result.detail.checks).toEqual({ fetch: false, restore: null, verify: null });
    expect(result.detail.dump).toBeNull(); // no `latest` on a failed fetch
  });
});
