// GET /v1/changes -- the event feed (03 §5, 07 §6 S6). Thin wrapper over
// S4's `feed()`: parse/validate `since`/`limit`/`kinds`, ETag/304, done.
// LEDGER.md L4 adds the long-poll (`wait=`): see the route handler below.
import { Hono } from "hono";
import type { Bindings } from "../env";
import type { AuthDeps } from "../auth/discord";
import { resolveActor } from "../auth/discord";
import { CLIENT_LIMIT, CLIENT_WINDOW_SECONDS } from "../auth/ratelimit";
import { ApiError, badRequest, notFound, rateLimited } from "../core/errors";
import { cachePut, conditional, etagFor, headSeq } from "../core/etag";
import { feed, type FeedFilter, type InfoKind, type WriteKind } from "../core/events";
import { clampWaitSeconds, MAX_WAIT_SECONDS, waitForChanges, type SleepImpl } from "../core/longpoll";
import { byRef } from "../core/records";
import { take } from "../core/ratelimit";
import { systemClock, type Clock } from "../core/time";

const CACHE_CONTROL = "public, max-age=10";

// The complete phase-1+2 event vocabulary (03 §5): every `WriteKind`, every
// `InfoKind` (the six `admin.*` kinds, 09 §3 T3 + 10 C1, included -- the
// public changelog filters on them same as any other kind), plus the two
// like events (never rev-bumping, not in either type).
//
// A previous version of this list was a plain literal array pinned with
// `satisfies (WriteKind | InfoKind | "liked" | "unliked")[]` -- which only
// checks that every LISTED literal is a valid member of the union, never
// that every member of the union got listed; `admin.client_registered`/
// `admin.client_revoked` (10 C1's client-lane admin kinds) landed on
// `InfoKind` without ever being added here, silently. These two `Record<K,
// true>` objects are exhaustive instead: TypeScript refuses to compile if
// either type gains (or loses) a member without a matching key here --
// `tests/core/known-kinds.test.ts` also asserts every kind any events.ts
// writer function can actually append round-trips through KNOWN_KINDS, so
// a gap fails both at compile time and at test time.
const WRITE_KINDS_MAP: Record<WriteKind, true> = {
  created: true,
  format_added: true,
  updated: true,
  renamed: true,
  fingermap: true,
  transferred: true,
  deleted: true,
  restored: true,
  imported: true,
  upstream_deleted: true,
};
const INFO_KINDS_MAP: Record<InfoKind, true> = {
  upstream_changed: true,
  import_conflict: true,
  import_error: true,
  import_relabel: true,
  upstream_deleted: true, // deliberately in both maps -- see WriteKind/InfoKind's own header note (core/events.ts)
  "admin.added": true,
  "admin.removed": true,
  "admin.import_paused": true,
  "admin.import_resumed": true,
  "admin.client_registered": true,
  "admin.client_revoked": true,
  "admin.import_ticked": true,
  "admin.diff_ticked": true,
  "admin.nightly_ticked": true,
  "admin.import_unstalled": true,
  // L5 moderation (§4): bans (actor-scoped), author-rename (layout-scoped),
  // the link queue (layout-scoped). ("admin.likes_set" retired H24
  // 2026-09-13 -- the like-count override is gone.)
  "admin.user_banned": true,
  "admin.user_unbanned": true,
  "admin.author_renamed": true,
  link_submitted: true,
  link_approved: true,
  link_rejected: true,
  link_cleared: true,
};
const LIKE_KINDS_MAP: Record<"liked" | "unliked", true> = { liked: true, unliked: true };

// Exported for the changelog route's own `kinds` filter (`routes/
// changelog.ts`), which shares this same vocabulary.
export const KNOWN_KINDS: (WriteKind | InfoKind | "liked" | "unliked")[] = [
  ...new Set([...Object.keys(WRITE_KINDS_MAP), ...Object.keys(INFO_KINDS_MAP), ...Object.keys(LIKE_KINDS_MAP)]),
] as (WriteKind | InfoKind | "liked" | "unliked")[];
const KNOWN_KINDS_SET = new Set<string>(KNOWN_KINDS);

// Exported: routes/changelog.ts's `since`/`kinds` query params are parsed
// the same way `/v1/changes`' are (12 §2.2) -- one set of rules, one place.
export function parseSince(raw: string | undefined): number {
  if (raw === undefined) return 0;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) throw badRequest(`invalid 'since' (expected a non-negative integer seq)`, "since");
  return n;
}

function parseLimit(raw: string | undefined): number {
  if (raw === undefined) return 100;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) throw badRequest(`invalid 'limit' (expected a positive integer)`, "limit");
  return Math.min(n, 1000);
}

export function parseKinds(raw: string | undefined): string[] | undefined {
  if (raw === undefined) return undefined;
  const kinds = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  for (const k of kinds) {
    if (!KNOWN_KINDS_SET.has(k)) throw badRequest(`unknown kind '${k}'`, "kinds");
  }
  return kinds;
}

// LEDGER.md L4: `wait=<seconds>`, honoured for every registered client
// (any verified client-lane request; checked by the route handler, not
// here) -- this only parses+clamps the number itself. `undefined` means
// the param was absent; any parseable number (including 0 or a negative
// one) clamps into `[0, MAX_WAIT_SECONDS]`.
export function parseWait(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw badRequest(`invalid 'wait' (expected a number of seconds, <= ${MAX_WAIT_SECONDS})`, "wait");
  return clampWaitSeconds(n);
}

// X3 (12 §3 X3, §6.6): `layout=` (a `byRef` ref -- id or name, same rule
// `/v1/layouts/{ref}` uses) resolved to an id up front, so an unknown ref
// 404s before any feed read, and so the changelog page (which shares this
// exact resolution) can never disagree with `/v1/changes` about what
// `layout=` means -- that agreement is what makes LDB-H3 checkable.
// Exported for `routes/changelog.ts`.
export async function resolveLayoutFilter(db: Bindings["DB"], ref: string | undefined): Promise<string | undefined> {
  if (ref === undefined) return undefined;
  const rec = await byRef(db, ref);
  if (rec === null) throw notFound(`no layout '${ref}'`, ref);
  return rec.id;
}

// Test-only escape hatches, same shape as every other route's `TEST_CLOCK`
// (`src/routes/write.ts` etc.) -- absent in production.
function resolveNow(env: Bindings): Clock {
  return (env as unknown as { TEST_CLOCK?: Clock }).TEST_CLOCK ?? systemClock;
}
function resolveSleep(env: Bindings): SleepImpl {
  return (env as unknown as { TEST_LONGPOLL_SLEEP?: SleepImpl }).TEST_LONGPOLL_SLEEP ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
}

// `authDeps` is the same `AuthDeps` `src/index.ts` builds for
// `requireActorOnWrites`/`GET /v1/me` (real fetch + clock in production,
// injected in tests) -- `wait=`'s gate needs to resolve an actor on a GET
// route, which `requireActorOnWrites` skips entirely (SAFE_METHODS).
export function changesRoute(authDeps: AuthDeps) {
  const route = new Hono<{ Bindings: Bindings }>();

  route.get("/v1/changes", async (c) => {
    const db = c.env.DB;
    const since = parseSince(c.req.query("since"));
    const limit = parseLimit(c.req.query("limit"));
    const kinds = parseKinds(c.req.query("kinds"));
    const actor = c.req.query("actor");
    const layoutId = await resolveLayoutFilter(db, c.req.query("layout"));
    const filter: FeedFilter = { layoutId, actor };
    const waitRequested = parseWait(c.req.query("wait"));

    let waitIgnored = false;
    if (waitRequested !== undefined) {
      // Only the Ed25519 client lane ever gets a held response (saltorbit,
      // 2026-09-12; 2026-09-13: "any registered client should get this by
      // default" -- the `feed:wait` cap is no longer required, only
      // accepted) -- every other caller (no headers at all, a Discord
      // bearer, or a client-lane request that fails to verify) gets the SAME immediate
      // answer any plain `/v1/changes` call would, plus a header saying
      // so, never an error: a `wait=` is a hint this route MAY act on,
      // not a promise every caller must authenticate for.
      let honored = false;
      try {
        const requestActor = await resolveActor(c.env, c.req, authDeps);
        if (requestActor.via.startsWith("client:")) {
          // 12 §2.5-style counting (auth/ratelimit.ts): a held long-poll
          // counts against the SAME per-client counter/window a write
          // would -- real rate limiting, a 429 when exceeded, not a
          // silent downgrade (unlike the "unauthorized" case above).
          const clientId = requestActor.via.slice("client:".length);
          const now = resolveNow(c.env);
          const result = await take(db, now, `client:${clientId}`, CLIENT_LIMIT, CLIENT_WINDOW_SECONDS);
          if (!result.allowed) throw rateLimited(CLIENT_LIMIT, CLIENT_WINDOW_SECONDS, result.retryAfter, "client");
          honored = true;
        }
      } catch (e) {
        // A rate-limit refusal is a REAL error (429), not a silent
        // downgrade -- rethrow it. Anything else (bad signature, no
        // headers, a Discord bearer, ...) means "couldn't/didn't
        // authenticate for this", which is never an error here.
        if (e instanceof ApiError && e.status === 429) throw e;
      }
      if (honored) {
        await waitForChanges(db, since, waitRequested, resolveSleep(c.env));
      } else {
        waitIgnored = true;
      }
    }

    const seq = await headSeq(db);
    const etag = await etagFor(seq, { since, limit, kinds: kinds ?? null, layout: layoutId ?? null, actor: actor ?? null });
    // A `wait=` request always gets a fresh page -- conditional caching
    // and long-polling solve different problems, and a client holding a
    // stale `If-None-Match` while also asking to wait would otherwise be
    // as likely to get an empty 304 as the page it actually waited for.
    if (waitRequested === undefined) {
      const short = await conditional(c, etag, CACHE_CONTROL);
      if (short) return short;
    }

    const { next, items } = await feed(db, since, limit, kinds, filter);
    const res = c.json({ next, items });
    res.headers.set("ETag", etag);
    res.headers.set("Cache-Control", CACHE_CONTROL);
    if (waitIgnored) res.headers.set("X-Wait-Ignored", "unauthorized");
    if (waitRequested === undefined) await cachePut(c, res.clone());
    return res;
  });

  return route;
}
