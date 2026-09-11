// A fake cmini upstream serving the frozen `upstream-100` snapshot, with
// knobs to mutate list/detail/likes entries, force 404/500/403, and log
// every request -- the test double `UpstreamClient`'s injected `fetchImpl`
// talks to (07 §6 S5). NOT built on `cloudflare:test`'s `fetchMock`: the
// pinned @cloudflare/vitest-pool-workers (0.22.0) does not export a
// `fetchMock` from "cloudflare:test" (verified against its dist/types --
// only the unrelated undici `MockAgent` class exists, unwired to the
// Worker's global fetch here). `UpstreamClient` takes `fetchImpl` as a
// constructor argument for exactly this reason: a plain fake function
// implementing the Fetch API shape is a complete substitute, no interception
// of the real global needed.
//
// The snapshot is loaded via a JSON import (resolved at bundle time by
// esbuild, the same way formats/cmini/1/index.ts pulls in its schema) --
// `node:fs` reads a workerd test file's own module graph, not the host
// filesystem, so runtime `readFileSync` calls here would see an empty/
// virtual fs.
import listSnapshot from "../fixtures/upstream-100/list.json" with { type: "json" };
import fullSnapshot from "../fixtures/upstream-100/full.json" with { type: "json" };
import authorsSnapshot from "../fixtures/upstream-100/authors.json" with { type: "json" };
import type { FetchImpl, RawUpstreamDetail, SleepImpl, UpstreamListEntry } from "../../src/import/upstream";

export interface FakeUpstreamOptions {
  requireUA?: string; // requests missing this exact UA get 403
}

export interface LoggedRequest {
  url: string;
  ua: string | undefined;
}

type DetailOverride = RawUpstreamDetail | "notfound" | "servererror";

export class FakeUpstream {
  readonly baseUrl = "https://fake-cmini.example/layoutapi/v3";
  readonly requestLog: LoggedRequest[] = [];

  private list: UpstreamListEntry[];
  private nameById: Map<string, string>;
  private fullEntries: RawUpstreamDetail[]; // array, not a map -- duplicate names must be representable
  private detailOverrides = new Map<string, DetailOverride>();
  // LDB-I9: raw response TEXT for a detail() call, bypassing `jsonResponse`'s
  // `JSON.stringify` entirely -- the only way to serve upstream text
  // carrying a literal (unescaped-backslash) `<`/`>`/`&`
  // sequence the way Go's `encoding/json` HTML-escapes actually look on the
  // wire (`JSON.stringify` never produces one; `detailOverrides` above goes
  // through it too).
  private rawDetailBodies = new Map<string, string>();
  private authorsMap: Record<string, string>;
  private metaObj: Record<string, unknown>;
  private failNext = new Map<string, number>(); // url-substring -> remaining forced 500s
  private opts: FakeUpstreamOptions;

  constructor(opts: FakeUpstreamOptions = {}) {
    this.list = structuredClone((listSnapshot as { layouts: UpstreamListEntry[] }).layouts);
    this.nameById = new Map(this.list.map((e) => [e.id, e.name]));
    this.fullEntries = structuredClone((fullSnapshot as { layouts: RawUpstreamDetail[] }).layouts);
    this.authorsMap = structuredClone(authorsSnapshot as Record<string, string>);
    this.metaObj = { revision: "seed-1", layout_count: this.list.length, author_count: Object.keys(this.authorsMap).length };
    this.opts = opts;
  }

  readonly fetchImpl: FetchImpl = async (url, init) => {
    const ua = init.headers["User-Agent"];
    this.requestLog.push({ url, ua });

    if (this.opts.requireUA !== undefined && ua !== this.opts.requireUA) {
      return new Response("forbidden -- missing/wrong User-Agent", { status: 403 });
    }

    const forced = this.consumeForcedFailure(url);
    if (forced !== null) return new Response("forced failure", { status: forced });

    const u = new URL(url);
    if (u.pathname.endsWith("/meta")) return jsonResponse(this.metaObj);
    if (u.pathname.endsWith("/authors")) return jsonResponse(this.authorsMap);
    if (u.pathname.endsWith("/layouts") && u.searchParams.get("full") === "1") {
      return jsonResponse({ layouts: this.fullEntries, total: this.fullEntries.length });
    }
    if (u.pathname.endsWith("/layouts")) {
      return jsonResponse({ layouts: this.list, total: this.list.length });
    }
    const m = /\/layouts\/([^/]+)$/.exec(u.pathname);
    if (m) return this.detailResponse(decodeURIComponent(m[1]!));
    return new Response("not found", { status: 404 });
  };

  // Instant -- tests never wait out the real 1s/2s/4s backoff.
  readonly sleepImpl: SleepImpl = () => Promise.resolve();

  private detailResponse(id: string): Response {
    const raw = this.rawDetailBodies.get(id);
    if (raw !== undefined) return new Response(raw, { status: 200, headers: { "Content-Type": "application/json" } });

    const override = this.detailOverrides.get(id);
    if (override === "notfound") return new Response("not found", { status: 404 });
    if (override === "servererror") return new Response("error", { status: 500 });
    if (override !== undefined) return jsonResponse(override);

    const name = this.nameById.get(id);
    const detail = name !== undefined ? this.fullEntries.find((d) => d.name === name) : undefined;
    if (detail === undefined) return new Response("not found", { status: 404 });
    return jsonResponse(detail);
  }

  private consumeForcedFailure(url: string): number | null {
    for (const [substr, remaining] of this.failNext) {
      if (remaining > 0 && url.includes(substr)) {
        this.failNext.set(substr, remaining - 1);
        return 500;
      }
    }
    return null;
  }

  // --- mutation knobs ----------------------------------------------------

  // LDB-I15/I16: the whole `/authors` body, verbatim -- key ORDER included,
  // so a test can serve the same content listed differently.
  setAuthors(map: Record<string, string>): void {
    this.authorsMap = structuredClone(map);
  }

  authors(): Record<string, string> {
    return structuredClone(this.authorsMap);
  }

  bumpMeta(): void {
    this.metaObj = { ...this.metaObj, revision: `rev-${this.requestLog.length}-${Math.random()}` };
  }

  setMeta(obj: Record<string, unknown>): void {
    this.metaObj = obj;
  }

  listEntry(id: string): UpstreamListEntry {
    const e = this.list.find((x) => x.id === id);
    if (e === undefined) throw new Error(`fake upstream: no list entry '${id}'`);
    return e;
  }

  mutateListEntry(id: string, patch: Partial<UpstreamListEntry>): void {
    const i = this.list.findIndex((e) => e.id === id);
    if (i === -1) throw new Error(`fake upstream: no list entry '${id}'`);
    this.list[i] = { ...this.list[i]!, ...patch };
  }

  removeFromList(id: string): void {
    this.list = this.list.filter((e) => e.id !== id);
  }

  addListEntry(entry: UpstreamListEntry): void {
    this.list.push(entry);
    this.nameById.set(entry.id, entry.name);
  }

  detailByName(name: string): RawUpstreamDetail {
    const d = this.fullEntries.find((e) => e.name === name);
    if (d === undefined) throw new Error(`fake upstream: no detail for '${name}'`);
    return d;
  }

  // Mutates the ?full=1 entry AND the per-id fallback (same underlying
  // array) in one step -- most tests want both paths to agree.
  mutateDetailByName(name: string, patch: Record<string, unknown>): void {
    const i = this.fullEntries.findIndex((e) => e.name === name);
    if (i === -1) throw new Error(`fake upstream: no detail for '${name}'`);
    this.fullEntries[i] = { ...this.fullEntries[i], ...patch };
  }

  set404(id: string): void {
    this.detailOverrides.set(id, "notfound");
    const name = this.nameById.get(id);
    if (name !== undefined) this.fullEntries = this.fullEntries.filter((e) => e.name !== name);
  }

  setServerError(id: string): void {
    this.detailOverrides.set(id, "servererror");
  }

  setDetailOverride(id: string, detail: RawUpstreamDetail): void {
    this.detailOverrides.set(id, detail);
  }

  // LDB-I9: serve exactly `rawBody` for `GET .../layouts/<id>`, no
  // `JSON.stringify` in between -- lets a test embed a literal Go-style
  // `<`/`>`/`&` escape (see `rawDetailBodies`'s own comment).
  setRawDetailBody(id: string, rawBody: string): void {
    this.rawDetailBodies.set(id, rawBody);
  }

  clearOverride(id: string): void {
    this.detailOverrides.delete(id);
  }

  // Pushes a second ?full=1 entry sharing `name` -- exercises the real
  // client's duplicate-name handling (dropped into `dupNames`, per-id
  // fallback used instead).
  duplicateName(name: string): void {
    const original = this.fullEntries.find((e) => e.name === name);
    if (original === undefined) throw new Error(`fake upstream: no detail for '${name}'`);
    this.fullEntries.push(structuredClone(original));
  }

  failNextRequestsMatching(urlSubstring: string, n: number): void {
    this.failNext.set(urlSubstring, n);
  }

  ids(): string[] {
    return this.list.map((e) => e.id);
  }
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
}
