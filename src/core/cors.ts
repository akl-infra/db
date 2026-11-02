// Browser reads from any origin (LDB-CORS1..2, saltorbit 2026-11-01: "signed-out public GETs go straight to
// api.akldb.org"). Every GET/HEAD answer, success or error, fresh, edge-cached or a bare 304, carries
// `Access-Control-Allow-Origin: *`, so a page on any site can `fetch()` the public reads without a proxy of its own.
// The wildcard is the whole policy: akldb favours no client, and no origin is named.
//
// Nothing credentialed is opened by it. akldb's credentials are bearer headers, never cookies, and a cross-origin
// request that carries `Authorization` (or any other non-safelisted header, `If-None-Match` included) needs a
// preflight, which akldb does not grant for those: `OPTIONS` answers them with no `Access-Control-*` header, so the browser
// refuses the real request (LDB-CORS3 grants exactly one preflight: a GET/HEAD asking for the revalidation headers
// only). A browser therefore only ever sends akldb the plain, anonymous GET any other client can
// send, and gets the shared public answer. Writes are never given the header either.
//
// Conditional reads still work cross-origin: the browser's own HTTP cache adds `If-None-Match` to a revalidation
// (`fetch(url, { cache: 'no-cache' })`) without a preflight, and akldb's `public, max-age=10` answers are storable.
// `Access-Control-Expose-Headers` lets the page read the validator and the headers a client reports on failures.

// [LDB-CORS3] (2026-11-02, the Firefox 146 direct-read NetworkError from akl.gg, a COEP require-corp page):
// every GET/HEAD answer also carries `Cross-Origin-Resource-Policy: cross-origin`, so an embedding policy never
// blocks a public read, and a preflight for a GET/HEAD that asks only for the headers a browser adds on its own
// revalidation (`If-None-Match`, `Cache-Control`, `Pragma`) is granted: `204` with those, `GET, HEAD`, a day's
// `Max-Age`. Nothing else is granted: no credentials ever, no other method, no other header (`Authorization`
// above all), so a credentialed or writing cross-origin request is still refused before it is sent.

export const CORS_ALLOW_ORIGIN = "*";
export const CORS_EXPOSE_HEADERS = "ETag, Retry-After, X-AKLDB-API, CF-Ray";
export const CORP = "cross-origin";
export const PREFLIGHT_METHODS = "GET, HEAD";
export const PREFLIGHT_HEADERS = ["if-none-match", "cache-control", "pragma"] as const;
export const PREFLIGHT_MAX_AGE = "86400";

export function corsApplies(method: string): boolean {
  const m = method.toUpperCase();
  return m === "GET" || m === "HEAD";
}

/** The CORS headers for a response to `method`, or `{}` when none apply. */
export function corsHeadersFor(method: string): Record<string, string> {
  if (!corsApplies(method)) return {};
  return { "Access-Control-Allow-Origin": CORS_ALLOW_ORIGIN, "Access-Control-Expose-Headers": CORS_EXPOSE_HEADERS, "Cross-Origin-Resource-Policy": CORP };
}

/** [LDB-CORS3] The answer to an `OPTIONS` request: the granting headers when it is a preflight for a GET/HEAD that
 * asks for no header outside PREFLIGHT_HEADERS, else `{}` (the browser then refuses the real request). */
export function preflightHeadersFor(requestMethod: string | undefined, requestHeaders: string | undefined): Record<string, string> {
  if (requestMethod === undefined || !corsApplies(requestMethod.trim())) return {};
  const asked = (requestHeaders ?? "").split(",").map((h) => h.trim().toLowerCase()).filter((h) => h !== "");
  if (!asked.every((h) => (PREFLIGHT_HEADERS as readonly string[]).includes(h))) return {};
  return {
    "Access-Control-Allow-Origin": CORS_ALLOW_ORIGIN,
    "Access-Control-Allow-Methods": PREFLIGHT_METHODS,
    "Access-Control-Allow-Headers": "If-None-Match, Cache-Control, Pragma",
    "Access-Control-Max-Age": PREFLIGHT_MAX_AGE,
    "Cross-Origin-Resource-Policy": CORP,
  };
}
