// The full `/v1` route-table contract (design/layout-db/25-api-versioning.md
// "Enforcement" (i)): one row per conformance case (`db/tests/conformance/
// manifest.ts`'s `CASES` -- already the API's real contract, LDB-R3),
// carrying the route's auth lane (joined from `db/docs/adoption.md`'s own
// endpoint table, the same table LDB-G10 already keeps in sync with
// `app.routes`) and a structural fingerprint of the response body
// (`shape.ts` -- field names/types, never values). `route-table.golden.json`
// is this array, generated once and checked in; `contract.test.ts` diffs
// the live computation against it.
import fs from "node:fs";
import path from "node:path";
import type { ConformanceCase } from "../conformance/manifest";
import { CASES } from "../conformance/manifest";
import { findPipeTable, unbacktick } from "../tools/mdtable";
import { shapeOf, type Shape } from "./shape";

const DB_ROOT = path.resolve(import.meta.dirname, "..", "..");
export const ADOPTION_GUIDE_PATH = path.join(DB_ROOT, "docs", "adoption.md");

export interface RouteTableRow {
  id: string;
  method: string;
  route: string;
  auth: string;
  status: number;
  // `null` for a response with no body (a 304, or a case that only pins
  // status/headers -- `manifest.ts`'s `ConformanceResponse.body` is
  // optional for exactly that reason).
  shape: Shape | null;
}

// `adoption.md`'s endpoint table (§9), keyed "METHOD /path" -- the SAME
// parse LDB-G10 (docs-site.test.ts) already runs to prove this table
// equals `app.routes`; this reads only its `auth` column, third cell.
export function loadAuthByRoute(guidePath: string = ADOPTION_GUIDE_PATH): Map<string, string> {
  const md = fs.readFileSync(guidePath, "utf8");
  const rows = findPipeTable(md, ["METHOD", "PATH", "auth", "body", "success", "errors"], guidePath);
  const map = new Map<string, string>();
  for (const row of rows) {
    const method = unbacktick(row[0]!);
    const routePath = unbacktick(row[1]!);
    map.set(`${method} ${routePath}`, (row[2] ?? "").trim());
  }
  return map;
}

export function computeRouteTable(cases: readonly ConformanceCase[] = CASES, authByRoute: Map<string, string> = loadAuthByRoute()): RouteTableRow[] {
  const rows: RouteTableRow[] = cases.map((kase) => {
    const method = kase.request.method;
    const route = kase.routeTemplate;
    const auth = authByRoute.get(`${method} ${route}`) ?? "unlisted";
    const shape = kase.response.body !== undefined ? shapeOf(kase.response.body) : null;
    return { id: kase.id, method, route, auth, status: kase.response.status, shape };
  });
  rows.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return rows;
}
