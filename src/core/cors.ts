// Browser reads from any origin (LDB-CORS1..2, saltorbit 2026-11-01: "signed-out public GETs go straight to
// api.akldb.org"). Every GET/HEAD answer, success or error, fresh, edge-cached or a bare 304, carries
// `Access-Control-Allow-Origin: *`, so a page on any site can `fetch()` the public reads without a proxy of its own.
// The wildcard is the whole policy: akldb favours no client, and no origin is named.
//
// Nothing credentialed is opened by it. akldb's credentials are bearer headers, never cookies, and a cross-origin
// request that carries `Authorization` (or any other non-safelisted header, `If-None-Match` included) needs a
// preflight, which akldb never grants: `OPTIONS` is not answered with any `Access-Control-*` header, so the browser
// refuses the real request. A browser therefore only ever sends akldb the plain, anonymous GET any other client can
// send, and gets the shared public answer. Writes are never given the header either.
//
// Conditional reads still work cross-origin: the browser's own HTTP cache adds `If-None-Match` to a revalidation
// (`fetch(url, { cache: 'no-cache' })`) without a preflight, and akldb's `public, max-age=10` answers are storable.
// `Access-Control-Expose-Headers` lets the page read the validator and the headers a client reports on failures.

export const CORS_ALLOW_ORIGIN = "*";
export const CORS_EXPOSE_HEADERS = "ETag, Retry-After, X-AKLDB-API, CF-Ray";

export function corsApplies(method: string): boolean {
  const m = method.toUpperCase();
  return m === "GET" || m === "HEAD";
}

/** The CORS headers for a response to `method`, or `{}` when none apply. */
export function corsHeadersFor(method: string): Record<string, string> {
  if (!corsApplies(method)) return {};
  return { "Access-Control-Allow-Origin": CORS_ALLOW_ORIGIN, "Access-Control-Expose-Headers": CORS_EXPOSE_HEADERS };
}
