// The shadow stage's egress guard (LDB-PV1). With STAGE=shadow every outbound `fetch` of the Lambda goes through this,
// because shadow must never post to Discord, never reach production's write paths, and never talk to anything that is not
// part of its own AWS stack. Allowed, and only these:
//   - AWS endpoints in us-east-2 for the four services the stack uses (DynamoDB, S3, SSM, Lambda), any method;
//   - https://api.akldb.org, GET and HEAD only (the feed follower reads production's public API);
//   - the in-process fake Discord's host: answered right here by `fakeDiscord.handle`, never sent.
// Anything else throws ShadowEgressError and logs ONE line `akldb-alarm: shadow-egress: refused <METHOD> <host>` (host
// only: a Discord webhook's token lives in its path, and no query or header is ever logged).
import { logByLevel } from "../replica/alarm";
import { raise } from "../replica/alarm";
import { FAKE_DISCORD_HOST, type FakeDiscord } from "./fake-discord";

export class ShadowEgressError extends Error {
  constructor(readonly method: string, readonly host: string) {
    super(`shadow egress refused: ${method} ${host}`);
    this.name = "ShadowEgressError";
  }
}

/** Production's public API, the only non-AWS host shadow may read. */
export const UPSTREAM_HOST = "api.akldb.org";
const AWS_HOST = /^(?:[a-z0-9][a-z0-9.-]*\.)?(?:dynamodb|s3|ssm|lambda)\.us-east-2\.amazonaws\.com$/;
const READ_METHODS = new Set(["GET", "HEAD"]);

export type FetchFn = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface EgressOptions {
  /** The real network fetch (the global one when the guard is installed). */
  inner: FetchFn;
  fakeDiscord: FakeDiscord;
  /** Where the alarm line goes (the Lambda's console.error). */
  logLine?: (line: string) => void;
}

/** True for the guard's own fetch (installEgressGuard is idempotent through it). */
export const GUARDED = Symbol.for("akldb.shadow.egress-guard");

export function createEgressGuard(o: EgressOptions): FetchFn {
  const logLine = o.logLine ?? logByLevel;
  const guarded: FetchFn = async (input, init) => {
    const request = input instanceof Request ? input : undefined;
    const method = (init?.method ?? request?.method ?? "GET").toUpperCase();
    let url: URL;
    try {
      url = new URL(request?.url ?? String(input));
    } catch {
      raise(logLine, "shadow-egress", `refused ${method} (unparseable url)`);
      throw new ShadowEgressError(method, "unparseable");
    }
    const host = url.hostname.toLowerCase();
    if (host === FAKE_DISCORD_HOST && url.protocol === "http:") {
      return o.fakeDiscord.handle(request !== undefined && init === undefined ? request : new Request(request ?? url, init));
    }
    if (url.protocol === "https:" && url.port === "") {
      if (AWS_HOST.test(host)) return o.inner(input, init);
      if (host === UPSTREAM_HOST && READ_METHODS.has(method)) return o.inner(input, init);
    }
    raise(logLine, "shadow-egress", `refused ${method} ${host}`);
    await request?.body?.cancel().catch(() => {});
    throw new ShadowEgressError(method, host);
  };
  return Object.assign(guarded, { [GUARDED]: true });
}

/**
 * Replace `globalThis.fetch` with the guard (once: a second call keeps the guard already there). Returns a function that puts
 * back what was there, for tests.
 */
export function installEgressGuard(o: Omit<EgressOptions, "inner"> & { inner?: FetchFn }): () => void {
  const current = globalThis.fetch as unknown as FetchFn & { [GUARDED]?: true };
  if (current[GUARDED] === true) return () => {};
  globalThis.fetch = createEgressGuard({ ...o, inner: o.inner ?? current }) as unknown as typeof fetch;
  return () => {
    globalThis.fetch = current as unknown as typeof fetch;
  };
}
