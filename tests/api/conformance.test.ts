// [LDB-P7] [LDB-R3] The conformance suite: `tests/conformance/**` IS the
// API contract (03 §1, 07 §6 S6). Every case runs against a real
// upstream-100 seed and is asserted byte-exact (status, listed headers,
// `canonical(normalizeIds(body))`); a second test enumerates the live
// route table (`app.routes`) and the error vocabulary (`core/errors.ts`)
// and fails when a required (route, status) pair has no case, so an added
// route or a silently-dropped error path can't go uncovered.
import { SELF } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { canonical } from "../../src/core/canonical";
import { badRequest, notFound, unknownFormat, unauthorized } from "../../src/core/errors";
import { app } from "../../src/index";
import { CASES, type ConformanceCase } from "../conformance/manifest";
import { normalizeIds, seedUpstream100 } from "./support";

beforeAll(async () => {
  await seedUpstream100();
});

async function runRequest(req: ConformanceCase["request"]): Promise<{ res: Response; primingEtag?: string }> {
  const url = `https://example.com${req.path}`;
  if (!req.ifNoneMatchSelf) {
    return { res: await SELF.fetch(url, { method: req.method }) };
  }
  const priming = await SELF.fetch(url);
  const primingEtag = priming.headers.get("ETag") ?? undefined;
  const res = await SELF.fetch(url, { headers: primingEtag !== undefined ? { "If-None-Match": primingEtag } : {} });
  return { res, primingEtag };
}

describe("conformance fixtures", () => {
  for (const kase of CASES) {
    it(kase.id, async () => {
      const { res, primingEtag } = await runRequest(kase.request);

      expect(res.status).toBe(kase.response.status);

      for (const [name, expected] of Object.entries(kase.response.headers ?? {})) {
        expect(res.headers.get(name)).toBe(expected);
      }

      if (kase.request.ifNoneMatchSelf && kase.response.status === 304) {
        // The fixture can't pin the ETag's value (it's derived from the
        // live event-log head); it CAN insist a 304 echoes exactly the
        // ETag the priming request just saw.
        expect(res.headers.get("ETag")).toBe(primingEtag);
        expect(await res.text()).toBe("");
        return;
      }

      if (kase.response.body === undefined) return;

      const contentType = res.headers.get("Content-Type") ?? "";
      const actual = contentType.includes("json") ? await res.json() : await res.text();
      expect(canonical(normalizeIds(actual))).toBe(canonical(normalizeIds(kase.response.body)));
    });
  }
});

// --- enumeration: routes from app.routes, error codes from errors.ts -----

const ERROR_CODES = {
  unauthorized: unauthorized().body.error,
  bad_request: badRequest("x").body.error,
  unknown_format: unknownFormat("x", []).body.error,
  not_found: notFound("x").body.error,
};

interface RequiredCase {
  status: number;
  code?: string;
}

// Hand-authored (route semantics aren't derivable from the route table
// itself): which (status[, error code]) pairs a route can actually
// produce. `held` is deliberately absent here -- phase 1's only two
// registered formats (cmini/1, akl/1) translate both ways losslessly
// (01 §6), so a real conformance seed can never produce a genuine `held`
// response; that behaviour is covered instead by held.test.ts's
// test-only format (LDB-F9), in its own isolated storage.
const REQUIRED: Record<string, RequiredCase[]> = {
  "/v1/meta": [{ status: 200 }, { status: 304 }],
  // /v1/me: the user lane (T1). Only the anonymous 401 is reproducible from a
  // static fixture -- a 200 needs a Discord bearer, which discord.test.ts /
  // me.test.ts cover with the injected fake.
  "/v1/me": [{ status: 401, code: ERROR_CODES.unauthorized }],
  "/v1/layouts": [
    { status: 200 },
    { status: 400, code: ERROR_CODES.bad_request },
    { status: 400, code: ERROR_CODES.unknown_format },
    { status: 304 },
  ],
  "/v1/layouts/:ref": [
    { status: 200 },
    { status: 404, code: ERROR_CODES.not_found },
    { status: 400, code: ERROR_CODES.unknown_format },
  ],
  "/v1/layouts/:ref/likes": [{ status: 200 }, { status: 404, code: ERROR_CODES.not_found }],
  "/v1/layouts/:ref/history": [{ status: 200 }, { status: 404, code: ERROR_CODES.not_found }],
  "/v1/layouts/:ref/rev/:n": [
    { status: 200 },
    { status: 404, code: ERROR_CODES.not_found },
    { status: 400, code: ERROR_CODES.bad_request },
    { status: 400, code: ERROR_CODES.unknown_format },
  ],
  "/v1/authors": [{ status: 200 }, { status: 304 }],
  "/v1/authors/:user_id": [{ status: 200 }, { status: 404, code: ERROR_CODES.not_found }],
  "/v1/formats": [{ status: 200 }],
  "/v1/formats/:name/:major/schema.json": [{ status: 200 }, { status: 404, code: ERROR_CODES.not_found }],
  "/v1/changes": [{ status: 200 }, { status: 400, code: ERROR_CODES.bad_request }, { status: 304 }],
};

describe("conformance enumeration", () => {
  const liveGetRoutes = [...new Set(app.routes.filter((r) => r.method === "GET").map((r) => r.path))];

  it("every live GET route has a REQUIRED entry", () => {
    for (const path of liveGetRoutes) {
      expect(Object.keys(REQUIRED), `route '${path}' has no REQUIRED entry`).toContain(path);
    }
  });

  it("every REQUIRED route is actually live", () => {
    for (const path of Object.keys(REQUIRED)) {
      expect(liveGetRoutes, `REQUIRED references '${path}', not a live route`).toContain(path);
    }
  });

  it("every manifest case names a live route", () => {
    for (const kase of CASES) {
      expect(liveGetRoutes, `case '${kase.id}' names unknown route '${kase.routeTemplate}'`).toContain(
        kase.routeTemplate,
      );
    }
  });

  it("[LDB-P7] [LDB-R3] every (route, required status[, code]) pair has a conformance case", () => {
    const missing: string[] = [];
    for (const [route, required] of Object.entries(REQUIRED)) {
      for (const req of required) {
        const found = CASES.some((kase) => {
          if (kase.routeTemplate !== route || kase.response.status !== req.status) return false;
          if (req.code === undefined) return true;
          const body = kase.response.body as { error?: string } | undefined;
          return body?.error === req.code;
        });
        if (!found) missing.push(`${route} ${req.status}${req.code ? ` (${req.code})` : ""}`);
      }
    }
    expect(missing, `missing conformance cases:\n${missing.join("\n")}`).toEqual([]);
  });

  it("every case body claiming an error code carries 'error' and 'message'", () => {
    for (const kase of CASES) {
      if (kase.response.status < 400) continue;
      if (kase.response.body === undefined) continue; // 304s
      const body = kase.response.body as { error?: unknown; message?: unknown };
      expect(typeof body.error, `case '${kase.id}' body.error`).toBe("string");
      expect(typeof body.message, `case '${kase.id}' body.message`).toBe("string");
    }
  });
});
