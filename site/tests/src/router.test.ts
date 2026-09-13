import { describe, expect, it } from "vitest";
import { parsePath, pathFor, type Route } from "../../src/router.ts";

describe("router: parsePath/pathFor round-trip", () => {
  const cases: Route[] = [
    { name: "home" },
    { name: "layout", ref: "colemak-dh" },
    { name: "author", userId: "184412255822020608" },
    { name: "changes" },
    { name: "docs" },
    { name: "admin" },
  ];

  for (const route of cases) {
    it(`round-trips ${route.name}`, () => {
      const path = pathFor(route);
      expect(parsePath(path)).toEqual(route);
    });
  }

  it("an unrecognized path is notFound", () => {
    expect(parsePath("/nope/at/all")).toEqual({ name: "notFound" });
  });

  it("the root path is home", () => {
    expect(parsePath("/")).toEqual({ name: "home" });
  });

  it("a layout ref with special characters round-trips through encoding", () => {
    const route: Route = { name: "layout", ref: "my layout/weird" };
    expect(parsePath(pathFor(route))).toEqual(route);
  });
});
