// The two CloudFront Functions, run as the exact source CloudFront will run.
import vm from "node:vm";
import { describe, expect, it } from "vitest";
// @ts-expect-error plain .mjs without types
import { HOST_FUNCTION_SOURCE, renderTemplate, spaFallbackSource } from "../../aws/cf-functions.mjs";

type Req = { uri: string; headers: Record<string, { value: string }> };
function run(source: string, request: Req): Req {
  const ctx: Record<string, unknown> = {};
  vm.runInNewContext(source, ctx);
  return (ctx.handler as (e: { request: Req }) => Req)({ request });
}

const manifest = ["/index.html", "/assets/app-abc123.js", "/assets/app-abc123.css", "/adoption.md", "/favicon.svg"];
const spa = spaFallbackSource(manifest);

describe("[LDB-SITE4] the SPA fallback is Workers' asset-else-index", () => {
  const uriOf = (uri: string) => run(spa, { uri, headers: {} }).uri;

  it("serves a manifest path as is", () => {
    for (const p of manifest.filter((m) => m !== "/index.html")) expect(uriOf(p)).toBe(p);
  });

  it("rewrites everything else to /index.html, routes and missing files alike", () => {
    for (const p of ["/", "/l/qwerty", "/changes", "/docs", "/admin", "/assets/app-zzz.js", "/missing.png", "/assets/", "/index.htm", "/__proto__", "/constructor", "/toString"]) {
      expect(uriOf(p)).toBe("/index.html");
    }
  });

  it("redirects /index.html to / like Workers' assets, and serves / as the index", () => {
    const r = run(spa, { uri: "/index.html", headers: {} }) as unknown as { statusCode: number; headers: { location: { value: string } } };
    expect(r.statusCode).toBe(307);
    expect(r.headers.location.value).toBe("/");
    expect(uriOf("/")).toBe("/index.html");
  });

  it("stays well under CloudFront's 10 KB limit for a realistic build", () => {
    const big = Array.from({ length: 150 }, (_, i) => `/assets/chunk-${i}-0123456789abcdef.js`);
    expect(Buffer.byteLength(spaFallbackSource(big))).toBeLessThan(10 * 1024);
  });
});

describe("[LDB-SITE5] the host function sets x-forwarded-host from the viewer's Host", () => {
  it("copies Host", () => {
    const out = run(HOST_FUNCTION_SOURCE, { uri: "/auth/login", headers: { host: { value: "akldb.org" } } });
    expect(out.headers["x-forwarded-host"]).toEqual({ value: "akldb.org" });
  });

  it("overwrites a viewer-supplied x-forwarded-host", () => {
    const out = run(HOST_FUNCTION_SOURCE, {
      uri: "/auth/login",
      headers: { host: { value: "next.akldb.org" }, "x-forwarded-host": { value: "evil.example" } },
    });
    expect(out.headers["x-forwarded-host"]).toEqual({ value: "next.akldb.org" });
  });
});

describe("renderTemplate", () => {
  it("fills both placeholders with the exact sources, indented under the YAML block", () => {
    const t = "A:\n  FunctionCode: |\n    __SPA_FALLBACK_CODE__\nB:\n  FunctionCode: |\n    __HOST_FUNCTION_CODE__\n";
    const out = renderTemplate(t, manifest);
    expect(out).not.toContain("__");
    expect(out).toContain("    function handler(event) {");
    expect(out).toContain('    var MANIFEST = {"/adoption.md":1');
  });
  it("throws if a placeholder is missing", () => {
    expect(() => renderTemplate("nothing", manifest)).toThrow();
  });
});
