// [SITE-1] Session seal/open round-trip + tamper/expiry -> null.
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { openSession, sealSession, type SessionPayload } from "../../server/session.ts";

const secretArb = fc.string({ minLength: 1, maxLength: 64 });
const payloadArb: fc.Arbitrary<SessionPayload> = fc.record({
  access_token: fc.string({ minLength: 1, maxLength: 200 }),
  expires_at: fc.integer({ min: Date.now() + 60_000, max: Date.now() + 1000 * 60 * 60 * 24 * 30 }),
  user_id: fc.string({ minLength: 1, maxLength: 32 }),
  name: fc.string({ minLength: 0, maxLength: 64 }),
});

describe("[SITE-1] session seal/open", () => {
  it("round-trips any payload under any non-empty secret", async () => {
    await fc.assert(
      fc.asyncProperty(payloadArb, secretArb, async (payload, secret) => {
        const sealed = await sealSession(payload, secret);
        const opened = await openSession(sealed, secret);
        expect(opened).toEqual(payload);
      }),
      { numRuns: 50 },
    );
  });

  it("a tampered ciphertext opens to null", async () => {
    await fc.assert(
      fc.asyncProperty(payloadArb, secretArb, fc.nat({ max: 20 }), async (payload, secret, flipIndex) => {
        const sealed = await sealSession(payload, secret);
        const dot = sealed.indexOf(".");
        const ctPart = sealed.slice(dot + 1);
        if (ctPart.length === 0) return;
        const idx = flipIndex % ctPart.length;
        const chars = ctPart.split("");
        // Flip one base64url character to something definitely different.
        chars[idx] = chars[idx] === "A" ? "B" : "A";
        const tampered = sealed.slice(0, dot + 1) + chars.join("");
        const opened = await openSession(tampered, secret);
        expect(opened).toBeNull();
      }),
      { numRuns: 50 },
    );
  });

  it("a session sealed under a different secret opens to null (re-keyed)", async () => {
    await fc.assert(
      fc.asyncProperty(payloadArb, secretArb, secretArb, async (payload, secretA, secretB) => {
        fc.pre(secretA !== secretB);
        const sealed = await sealSession(payload, secretA);
        const opened = await openSession(sealed, secretB);
        expect(opened).toBeNull();
      }),
      { numRuns: 50 },
    );
  });

  it("an expired session opens to null", async () => {
    const payload: SessionPayload = { access_token: "tok", expires_at: Date.now() - 1000, user_id: "u1", name: "n" };
    const sealed = await sealSession(payload, "some-secret");
    expect(await openSession(sealed, "some-secret")).toBeNull();
  });

  it("malformed tokens open to null instead of throwing", async () => {
    for (const bad of [null, undefined, "", "no-dot-here", ".", "abc.", ".abc", "not base64url!!.also not!!"]) {
      await expect(openSession(bad as string | null | undefined, "secret")).resolves.toBeNull();
    }
  });

  it("no secret configured opens to null (fail closed)", async () => {
    const sealed = await sealSession({ access_token: "t", expires_at: Date.now() + 10_000, user_id: "u", name: "n" }, "secret");
    expect(await openSession(sealed, "")).toBeNull();
    expect(await openSession(sealed, undefined as unknown as string)).toBeNull();
  });
});
