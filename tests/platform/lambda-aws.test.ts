// src/platform/lambda-aws.ts: the SigV4-signed SSM, S3 and Lambda calls, against a fake network.
import { describe, expect, it } from "vitest";
import { createAws, encodeKey, quotedMd5 } from "../../src/platform/lambda-aws";

function harness(answer: (r: Request) => Response | Promise<Response>) {
  const seen: Request[] = [];
  const aws = createAws({
    region: "us-east-2",
    bucket: "akldb-staging-data-335937358231",
    functionName: "akldb-staging-api",
    ssmPrefix: "/akldb/staging/",
    credentials: () => ({ accessKeyId: "AKIAEXAMPLE", secretAccessKey: "secret", sessionToken: "token" }),
    fetch: async (r) => {
      seen.push(r);
      return answer(r);
    },
  });
  return { aws, seen };
}

describe("S3 under dumps/", () => {
  it("GET signs the request, prefixes the key with dumps/ and serves S3's quoted ETag as httpEtag", async () => {
    const bytes = new TextEncoder().encode("hello");
    const { aws, seen } = harness(() => new Response(bytes, { headers: { etag: quotedMd5(bytes), "content-type": "application/gzip", "content-length": "5" } }));
    const obj = await aws.dumps.get("monthly/dump-2026-11.json.gz");
    expect(seen[0]!.url).toBe("https://akldb-staging-data-335937358231.s3.us-east-2.amazonaws.com/dumps/monthly/dump-2026-11.json.gz");
    expect(seen[0]!.headers.get("authorization")).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIAEXAMPLE\/\d{8}\/us-east-2\/s3\/aws4_request/);
    expect(seen[0]!.headers.get("x-amz-security-token")).toBe("token");
    expect(obj).toMatchObject({ httpEtag: '"5d41402abc4b2a76b9719d911017c592"', contentType: "application/gzip", size: 5 });
    expect(new TextDecoder().decode(await new Response(obj!.body).arrayBuffer())).toBe("hello");
  });

  it("GET answers null for a missing key and throws for any other failure", async () => {
    expect(await harness(() => new Response("<Error/>", { status: 404 })).aws.dumps.get("nope")).toBeNull();
    await expect(harness(() => new Response("denied", { status: 403 })).aws.dumps.get("x")).rejects.toThrow(/403/);
  });

  it("PUT sends the bytes with the content type and throws on a failure", async () => {
    const { aws, seen } = harness(() => new Response(null, { status: 200 }));
    await aws.dumps.put("latest.json", "{}", "application/json");
    expect(seen[0]!.method).toBe("PUT");
    expect(seen[0]!.url).toContain("/dumps/latest.json");
    expect(seen[0]!.headers.get("content-type")).toBe("application/json");
    expect(await seen[0]!.text()).toBe("{}");
    await expect(harness(() => new Response("no", { status: 500 })).aws.dumps.put("k", new Uint8Array([1]), "x/y")).rejects.toThrow(/500/);
  });

  it("keys are percent-encoded per segment", () => {
    expect(encodeKey("a b/c+d")).toBe("a%20b/c%2Bd");
  });
});

describe("SSM GetParameters", () => {
  it("asks for decrypted values under the prefix and returns names without it, listing the missing ones", async () => {
    const { aws, seen } = harness(() => Response.json({ Parameters: [{ Name: "/akldb/staging/origin-secret", Value: "v" }], InvalidParameters: ["/akldb/staging/discord-bot-token"] }));
    const out = await aws.getParameters(["origin-secret", "discord-bot-token"]);
    expect(out).toEqual({ values: { "origin-secret": "v" }, missing: ["discord-bot-token"] });
    expect(seen[0]!.headers.get("x-amz-target")).toBe("AmazonSSM.GetParameters");
    expect(await seen[0]!.json()).toEqual({ Names: ["/akldb/staging/origin-secret", "/akldb/staging/discord-bot-token"], WithDecryption: true });
  });

  it("throws on an error answer", async () => {
    await expect(harness(() => new Response("AccessDenied", { status: 400 })).aws.getParameters(["x"])).rejects.toThrow(/SSM GetParameters: 400/);
  });
});

describe("Lambda Invoke of the live alias", () => {
  it("invokes name:live synchronously with the JSON payload and parses the answer", async () => {
    const { aws, seen } = harness(() => Response.json({ ok: true, container: "c1" }));
    expect(await aws.invokeLive({ akldb: "warm", child: true })).toEqual({ ok: true, container: "c1" });
    expect(seen[0]!.url).toBe("https://lambda.us-east-2.amazonaws.com/2015-03-31/functions/akldb-staging-api:live/invocations");
    expect(seen[0]!.headers.get("x-amz-invocation-type")).toBe("RequestResponse");
    expect(await seen[0]!.json()).toEqual({ akldb: "warm", child: true });
  });

  it("a function error is an error", async () => {
    await expect(harness(() => new Response('{"errorMessage":"boom"}', { headers: { "x-amz-function-error": "Unhandled" } })).aws.invokeLive({})).rejects.toThrow(/function error Unhandled/);
  });
});
