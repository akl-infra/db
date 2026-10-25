// The two CloudFront Functions of the akldb.org site stack, and the renderer
// that puts their code into infra/site.yaml (design/aws-port.md §3a).
//
// Both are viewer-request functions in the cloudfront-js-2.0 runtime. Their
// source is built here as plain strings so the tests can run the exact bytes
// CloudFront will run (LDB-SITE4, LDB-SITE5).

/**
 * The SPA fallback. The build's asset manifest rides inside the function: a
 * URI in the manifest is served as is, anything else becomes `/index.html`.
 * That reproduces Workers' "asset if it exists, else index.html" exactly,
 * including a missing path with a file extension (a custom error response
 * would also rewrite the site Lambda's JSON 404s). `/index.html` itself is
 * redirected to `/`, as Workers' assets do (html_handling auto-trailing-slash).
 */
export function spaFallbackSource(manifest) {
  const paths = [...new Set(manifest)].sort();
  const table = {};
  for (const p of paths) table[p] = 1;
  return [
    `var MANIFEST = ${JSON.stringify(table)};`,
    "function handler(event) {",
    "  var request = event.request;",
    "  if (request.uri === '/index.html') {",
    "    return { statusCode: 307, statusDescription: 'Temporary Redirect', headers: { location: { value: '/' } } };",
    "  }",
    "  if (!Object.prototype.hasOwnProperty.call(MANIFEST, request.uri)) request.uri = '/index.html';",
    "  return request;",
    "}",
    "",
  ].join("\n");
}

/**
 * CloudFront replaces `Host` with the Lambda Function URL's host on the way
 * to the origin, so the viewer's host travels as `x-forwarded-host`. The
 * assignment overwrites anything the viewer sent under that name.
 */
export const HOST_FUNCTION_SOURCE = [
  "function handler(event) {",
  "  var request = event.request;",
  "  var host = request.headers.host;",
  "  request.headers['x-forwarded-host'] = { value: host ? host.value : '' };",
  "  return request;",
  "}",
  "",
].join("\n");

/** CloudFront Functions are limited to 10 KB of code. */
export const FUNCTION_CODE_LIMIT = 10 * 1024;

function indent(code, n) {
  const pad = " ".repeat(n);
  return code.replace(/\n$/, "").split("\n").map((l) => pad + l).join("\n");
}

/** Fill the template's two code placeholders (each on its own line, `|` block). */
export function renderTemplate(template, manifest) {
  const spa = spaFallbackSource(manifest);
  if (Buffer.byteLength(spa) > FUNCTION_CODE_LIMIT) {
    throw new Error(`SPA fallback function is ${Buffer.byteLength(spa)} bytes, over CloudFront's 10 KB limit`);
  }
  const fill = (text, token, code) => {
    const re = new RegExp(`^( *)${token}$`, "m");
    if (!re.test(text)) throw new Error(`template has no ${token} line`);
    return text.replace(re, (_, sp) => indent(code, sp.length));
  };
  return fill(fill(template, "__SPA_FALLBACK_CODE__", spa), "__HOST_FUNCTION_CODE__", HOST_FUNCTION_SOURCE);
}

/** The manifest: every file of the build, as the URI CloudFront sees. */
export async function manifestOf(distDir) {
  const { readdir } = await import("node:fs/promises");
  const { join, relative, sep } = await import("node:path");
  const out = [];
  const walk = async (dir) => {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, e.name);
      if (e.isDirectory()) await walk(full);
      else out.push("/" + relative(distDir, full).split(sep).join("/"));
    }
  };
  await walk(distDir);
  return out.sort();
}
