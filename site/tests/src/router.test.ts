import { afterEach, describe, expect, it, vi } from "vitest";
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

// [SITE-19] the Home list's whole-row click target (design/akldb-site/
// 01-plan.md's W1b, saltorbit 2026-09-13) is a single real <a> stretched over
// the row via CSS (styles.css's `akl-row-link`/`::after`) -- there is no
// separate row-level click handler to test, so the guarantee this
// invariant states ("a click anywhere in the row navigates; a modified
// click does not") reduces exactly to `onLinkClick`'s own behavior, since
// every click landing on the stretched pseudo-element is a click on that
// same anchor. `tests/tools/row-link.test.ts` checks the wiring (the anchor
// carries `akl-row-link` and calls this handler); this is the behavior.
function fakeMouseEvent(overrides: Partial<MouseEvent> = {}): MouseEvent {
  let prevented = false;
  return {
    defaultPrevented: false,
    button: 0,
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    preventDefault: () => {
      prevented = true;
    },
    get __prevented() {
      return prevented;
    },
    ...overrides,
  } as unknown as MouseEvent & { __prevented: boolean };
}

async function freshRouter(pathname = "/") {
  vi.resetModules();
  vi.stubGlobal("location", { pathname, origin: "https://akldb.org", search: "", hash: "" });
  const pushed: string[] = [];
  vi.stubGlobal("history", {
    pushState: (_state: unknown, _title: string, url: string) => pushed.push(url),
    replaceState: () => {},
  });
  vi.stubGlobal("window", { addEventListener: () => {} });
  const mod = await import("../../src/router.ts");
  return { ...mod, pushed };
}

describe("[SITE-19] onLinkClick: unmodified click navigates, modified click is left alone", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("an unmodified left click prevents default and pushes the new route", async () => {
    const { onLinkClick, currentRoute, pushed } = await freshRouter("/");
    const evt = fakeMouseEvent() as MouseEvent & { __prevented: boolean };
    onLinkClick(evt, "/l/colemak-dh");
    expect(evt.__prevented).toBe(true);
    expect(currentRoute()).toEqual({ name: "layout", ref: "colemak-dh" });
    expect(pushed).toEqual(["/l/colemak-dh"]);
  });

  it("a modified click (meta/ctrl/shift/alt, or a non-left button) never calls preventDefault and never navigates", async () => {
    const { onLinkClick, currentRoute, pushed } = await freshRouter("/");
    const before = currentRoute();
    const modifiers: Partial<MouseEvent>[] = [{ metaKey: true }, { ctrlKey: true }, { shiftKey: true }, { altKey: true }, { button: 1 }];
    for (const mod of modifiers) {
      const evt = fakeMouseEvent(mod) as MouseEvent & { __prevented: boolean };
      onLinkClick(evt, "/l/colemak-dh");
      expect(evt.__prevented).toBe(false);
    }
    expect(currentRoute()).toEqual(before);
    expect(pushed).toEqual([]);
  });

  it("a click already handled elsewhere (defaultPrevented) is left alone", async () => {
    const { onLinkClick, currentRoute, pushed } = await freshRouter("/");
    const before = currentRoute();
    const evt = fakeMouseEvent({ defaultPrevented: true }) as MouseEvent & { __prevented: boolean };
    onLinkClick(evt, "/l/colemak-dh");
    expect(evt.__prevented).toBe(false); // preventDefault() itself is never (re-)called
    expect(currentRoute()).toEqual(before);
    expect(pushed).toEqual([]);
  });
});
