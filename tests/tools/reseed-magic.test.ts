// [LDB-P25] docs/decisions/26-magic-reseed.md: the periodic magic reseed
// from akl.gg prod (scripts/reseed-magic.mjs) never clobbers a rule set a
// person wrote in akldb, never undoes a fork, sends nothing for an
// identical rule set, and signs exactly like the Worker verifies. Driven
// offline: a fake fetch plays both akl.gg's index and akldb, so the whole
// run (index -> per-record read -> guard -> seed) is exercised without a
// network or a D1 -- hence the "node" vitest project.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
// reseed-magic.mjs is a plain script (no .d.ts) -- typed locally, the same
// way error-table.test.ts imports gen-error-table.mjs.
// @ts-expect-error -- see above
import * as reseed from "../../scripts/reseed-magic.mjs";

type RuleSet = Record<string, unknown>;
interface Report {
  seeded: { id: string; rev?: number | null; dry_run?: boolean }[];
  identical: { id: string }[];
  edited: { id: string; reason: string }[];
  missing: { id: string }[];
  collision: { id: string; error: unknown }[];
  invalid: { id: string; error: unknown }[];
}
type Signer = (method: string, pathWithQuery: string, bodyBytes: Uint8Array) => Record<string, string>;

const candidateFrom = reseed.candidateFrom as (ruleSet: unknown) => RuleSet;
const magicEqual = reseed.magicEqual as (a: unknown, b: unknown) => boolean;
const editedReason = reseed.editedReason as (record: unknown) => string | null;
const makeSigner = reseed.makeSigner as (opts: {
  clientId: string;
  privateKeyB64url: string;
  actor: string;
  now?: () => number;
  randomNonce?: () => Uint8Array;
}) => Signer;
const reseedMagic = reseed.reseedMagic as (opts: {
  baseUrl: string;
  rulesUrl?: string;
  fetchImpl: typeof fetch;
  sign?: Signer | null;
  dryRun?: boolean;
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
}) => Promise<Report>;
const summarize = reseed.summarize as (r: Report) => Record<string, number>;

const DB_ROOT = path.resolve(import.meta.dirname, "..", "..");
const VECTORS = JSON.parse(fs.readFileSync(path.join(DB_ROOT, "tests", "vectors", "client-signing.json"), "utf8")) as {
  keys: { id: string; pkcs8_b64url: string }[];
  vectors: { name: string; key: string; client_id: string; method: string; path: string; timestamp: string; nonce: string; actor: string; body: string | null; signature_b64url: string }[];
};

// --- fixtures -------------------------------------------------------------------

// akl.gg's index speaks the bare-string default vocabulary
// (`web/data/magic_rules.json`'s own header): this is what prod serves.
const PROD_TWIRL: RuleSet = {
  magic_keys: [{ key: "*", default: "repeat_previous", rules: [{ after: "'", output: "'r" }] }],
  chiral_keys: [],
  adaptive_swaps: [{ trigger: "n", swap: ["g", "h"] }],
};
// ... and this is the same rule set as spark/1 stores it.
const WIRE_TWIRL: RuleSet = {
  magic_keys: [{ key: "*", default: { kind: "repeat" }, rules: [{ after: "'", output: "'r" }] }],
  adaptive_swaps: [{ trigger: "n", swap: ["g", "h"] }],
};

interface FakeRecord {
  id: string;
  name: string;
  magic: RuleSet | null;
  sourceClient: string | null;
  upstreamState: "following" | "forked" | null;
  rev?: number;
}

function recordBody(r: FakeRecord) {
  return {
    id: r.id,
    name: r.name,
    upstream: r.upstreamState === null ? null : { source: "cmini", id: r.name, state: r.upstreamState },
    format: "spark/1",
    payload: { board: "ortho", keys: [], ...(r.magic === null ? {} : { magic: r.magic }) },
    formats: {
      "spark/1": {
        rev: r.rev ?? 1,
        has_magic: r.magic !== null && Object.values(r.magic).some((v) => Array.isArray(v) && v.length > 0),
        source: r.sourceClient === null ? null : { client: r.sourceClient, version: null },
      },
    },
  };
}

interface SeedCall {
  ref: string;
  magic: RuleSet;
  headers: Record<string, string>;
}

// A fake of both ends: akl.gg's index at RULES_URL and akldb at BASE.
// `answerSeed` decides what a seed POST returns (default: 200).
function fakeWorld(index: Record<string, RuleSet>, records: FakeRecord[], answerSeed?: (ref: string) => { status: number; body: unknown; headers?: Record<string, string> }) {
  const BASE = "https://db.test";
  const RULES_URL = "https://site.test/api/magic-rules";
  const byRef = new Map<string, FakeRecord>();
  for (const r of records) {
    byRef.set(r.id, r);
    byRef.set(r.name, r);
  }
  const seeds: SeedCall[] = [];
  const gets: string[] = [];
  const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
  const fetchImpl: typeof fetch = async (input, init) => {
    const u = new URL(String(input));
    const method = init?.method ?? "GET";
    if (u.href === RULES_URL) return json(200, index);
    if (method === "GET" && u.pathname.startsWith("/v1/layouts/")) {
      const ref = decodeURIComponent(u.pathname.slice("/v1/layouts/".length));
      gets.push(ref);
      expect(u.searchParams.get("format")).toBe("spark/1");
      const r = byRef.get(ref);
      return r === undefined ? json(404, { error: "not_found", message: `no layout '${ref}'` }) : json(200, recordBody(r));
    }
    if (method === "POST" && u.pathname === "/v1/admin/magic-seed") {
      const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>));
      const body = JSON.parse(Buffer.from(init?.body as Uint8Array).toString("utf8")) as { ref: string; magic: RuleSet };
      seeds.push({ ref: body.ref, magic: body.magic, headers });
      const answer = answerSeed?.(body.ref) ?? { status: 200, body: { id: body.ref, name: byRef.get(body.ref)?.name, rev: (byRef.get(body.ref)?.rev ?? 1) + 1, has_magic: true, upstream: null } };
      return json(answer.status, answer.body, answer.headers);
    }
    throw new Error(`unexpected request ${method} ${u.href}`);
  };
  return { BASE, RULES_URL, fetchImpl, seeds, gets };
}

const VECTOR_KEY = VECTORS.keys[0]!;
const fixedSigner = (nonceB64url: string, timestamp: string, clientId: string, actor: string): Signer =>
  makeSigner({
    clientId,
    privateKeyB64url: VECTOR_KEY.pkcs8_b64url,
    actor,
    now: () => Number(timestamp) * 1000,
    randomNonce: () => Buffer.from(nonceB64url, "base64url"),
  });

const quiet = () => {};

// --- the candidate ---------------------------------------------------------------

describe("[LDB-P25] the candidate: akl.gg's rule set as spark/1 stores it", () => {
  it("[LDB-P25] strips to spark/1's three fields and retags every bare-string default and chiral value", () => {
    const candidate = candidateFrom({
      ...PROD_TWIRL,
      chiral_keys: [
        { key: "y", same: "repeat_previous", opposite: "y" },
        { key: "q", same: "none", opposite: "" },
      ],
      updated: "2026-09-01",
      notes: "never carried",
    });
    expect(candidate).toEqual({
      magic_keys: WIRE_TWIRL.magic_keys,
      chiral_keys: [{ key: "y", same: { kind: "repeat" }, opposite: { kind: "char", char: "y" } }, { key: "q" }],
      adaptive_swaps: WIRE_TWIRL.adaptive_swaps,
    });
  });

  it("[LDB-P25] compares equal to the stored magic whatever the key order, and treats an empty list like an absent field", () => {
    expect(magicEqual(candidateFrom(PROD_TWIRL), WIRE_TWIRL)).toBe(true);
    expect(magicEqual({ chiral_keys: [], magic_keys: [] }, undefined)).toBe(true);
    expect(magicEqual(candidateFrom({ ...PROD_TWIRL, adaptive_swaps: [] }), WIRE_TWIRL)).toBe(false);
  });
});

// --- the guard ---------------------------------------------------------------------

describe("[LDB-P25] the guard: a person's akldb write is never clobbered, a fork never undone", () => {
  const base = { id: "01A", name: "x", magic: WIRE_TWIRL, rev: 2 } as const;
  it("[LDB-P25] allows a record whose spark/1 row was last written by the seed or the import, forked or not", () => {
    expect(editedReason(recordBody({ ...base, sourceClient: "system:magic-seed", upstreamState: "following" }))).toBeNull();
    expect(editedReason(recordBody({ ...base, sourceClient: "system:cmini-import", upstreamState: "following" }))).toBeNull();
  });
  it("[LDB-P25] allows a record with no magic that is not forked (a fresh import, a bot-native record)", () => {
    expect(editedReason(recordBody({ ...base, magic: null, sourceClient: "client:01BOT", upstreamState: "following" }))).toBeNull();
    expect(editedReason(recordBody({ ...base, magic: null, sourceClient: "discord-app:1", upstreamState: null }))).toBeNull();
    expect(editedReason(recordBody({ ...base, magic: { magic_keys: [] }, sourceClient: "client:01BOT", upstreamState: null }))).toBeNull();
  });
  it("[LDB-P25] refuses a record whose magic a person last wrote, and a forked record with no magic (the seed route would un-fork it)", () => {
    expect(editedReason(recordBody({ ...base, sourceClient: "client:01BOT", upstreamState: "forked" }))).toMatch(/magic last written by client:01BOT/);
    expect(editedReason(recordBody({ ...base, sourceClient: "discord-app:1", upstreamState: null }))).toMatch(/magic last written by discord-app:1/);
    expect(editedReason(recordBody({ ...base, magic: null, sourceClient: "client:01BOT", upstreamState: "forked" }))).toMatch(/forked by client:01BOT/);
  });
});

// --- signing ---------------------------------------------------------------------------

describe("[LDB-P25] the signer reproduces tests/vectors/client-signing.json (the Worker's own verification vectors)", () => {
  for (const v of VECTORS.vectors) {
    it(`[LDB-P25] vector ${v.name}`, () => {
      expect(v.key).toBe(VECTOR_KEY.id);
      const sign = fixedSigner(v.nonce, v.timestamp, v.client_id, v.actor);
      const headers = sign(v.method, v.path, v.body === null ? new Uint8Array(0) : new TextEncoder().encode(v.body));
      expect(headers).toEqual({
        "X-Akl-Client": v.client_id,
        "X-Akl-Timestamp": v.timestamp,
        "X-Akl-Nonce": v.nonce,
        "X-Akl-Actor": v.actor,
        "X-Akl-Signature": v.signature_b64url,
      });
    });
  }
});

// --- the run -----------------------------------------------------------------------------

describe("[LDB-P25] one pass over akl.gg's index", () => {
  const index: Record<string, RuleSet> = {
    twirl: PROD_TWIRL, // identical to what akldb holds
    whirl: PROD_TWIRL, // akldb has stale seeded magic -> seeded
    fresh: PROD_TWIRL, // no magic yet, following -> seeded
    mine: PROD_TWIRL, // a person's magic in akldb -> edited
    forkd: PROD_TWIRL, // forked, no magic -> edited (never un-forked)
    ghost: PROD_TWIRL, // no record -> missing
  };
  const records: FakeRecord[] = [
    { id: "01TWIRL", name: "twirl", magic: WIRE_TWIRL, sourceClient: "system:magic-seed", upstreamState: "following", rev: 3 },
    { id: "01WHIRL", name: "whirl", magic: { magic_keys: [{ key: "*", rules: [] }] }, sourceClient: "system:magic-seed", upstreamState: "following", rev: 2 },
    { id: "01FRESH", name: "fresh", magic: null, sourceClient: "system:cmini-import", upstreamState: "following" },
    { id: "01MINE", name: "mine", magic: { magic_keys: [{ key: "@", rules: [] }] }, sourceClient: "client:01BOT", upstreamState: "forked", rev: 4 },
    { id: "01FORKD", name: "forkd", magic: null, sourceClient: "discord-app:1", upstreamState: "forked", rev: 2 },
  ];

  it("[LDB-P25] seeds exactly the records that differ and are safe, by record id, with the retagged candidate, client-lane signed", async () => {
    const world = fakeWorld(index, records);
    const sign = fixedSigner("c3n-MHUOLraqLSy4lX8rIw", "1788000000", "01ARZ3NDEKTSV4RRFFQ69G5FAV", "184412255822020608");
    const report = await reseedMagic({ baseUrl: world.BASE, rulesUrl: world.RULES_URL, fetchImpl: world.fetchImpl, sign, log: quiet });

    expect(summarize(report)).toEqual({ seeded: 2, identical: 1, edited: 2, missing: 1, collision: 0, invalid: 0 });
    expect(report.seeded.map((s) => s.id)).toEqual(["whirl", "fresh"]);
    expect(report.identical.map((s) => s.id)).toEqual(["twirl"]);
    expect(report.edited.map((s) => s.id)).toEqual(["mine", "forkd"]);
    expect(report.missing.map((s) => s.id)).toEqual(["ghost"]);

    expect(world.seeds.map((s) => s.ref)).toEqual(["01WHIRL", "01FRESH"]);
    for (const s of world.seeds) {
      // Sent as akl.gg publishes it (empty lists included), only retagged --
      // the same shape the 2026-09-13 seed stored, so nothing re-seeds over
      // a cosmetic difference.
      expect(s.magic).toEqual({ ...WIRE_TWIRL, chiral_keys: [] });
      expect(s.headers["X-Akl-Client"]).toBe("01ARZ3NDEKTSV4RRFFQ69G5FAV");
      expect(s.headers["X-Akl-Actor"]).toBe("184412255822020608");
      expect(s.headers["X-Akl-Signature"]).toMatch(/^[A-Za-z0-9_-]{86}$/);
      expect(s.headers["Content-Type"]).toBe("application/json");
    }
    // Every id in the index was read exactly once (public reads, no auth).
    expect(world.gets).toEqual(Object.keys(index));
  });

  it("[LDB-P25] a dry run reads everything and sends nothing", async () => {
    const world = fakeWorld(index, records);
    const report = await reseedMagic({ baseUrl: world.BASE, rulesUrl: world.RULES_URL, fetchImpl: world.fetchImpl, dryRun: true, log: quiet });
    expect(summarize(report)).toEqual({ seeded: 2, identical: 1, edited: 2, missing: 1, collision: 0, invalid: 0 });
    expect(report.seeded.every((s) => s.dry_run === true)).toBe(true);
    expect(world.seeds).toEqual([]);
  });

  it("[LDB-P25] a second pass after a full one is idempotent: zero writes", async () => {
    const afterFirst = records.map((r) => (r.name === "whirl" || r.name === "fresh" ? { ...r, magic: WIRE_TWIRL, sourceClient: "system:magic-seed" } : r));
    const world = fakeWorld(index, afterFirst);
    const sign = fixedSigner("c3n-MHUOLraqLSy4lX8rIw", "1788000000", "01ARZ3NDEKTSV4RRFFQ69G5FAV", "184412255822020608");
    const report = await reseedMagic({ baseUrl: world.BASE, rulesUrl: world.RULES_URL, fetchImpl: world.fetchImpl, sign, log: quiet });
    expect(summarize(report)).toEqual({ seeded: 0, identical: 3, edited: 2, missing: 1, collision: 0, invalid: 0 });
    expect(world.seeds).toEqual([]);
  });

  it("[LDB-P25] the DB's own refusals are classified, not thrown; one 429 is waited out; anything else aborts", async () => {
    const sign = fixedSigner("c3n-MHUOLraqLSy4lX8rIw", "1788000000", "01ARZ3NDEKTSV4RRFFQ69G5FAV", "184412255822020608");
    const idx = { whirl: PROD_TWIRL, fresh: PROD_TWIRL };
    const recs = records.filter((r) => r.name === "whirl" || r.name === "fresh");

    const refused = fakeWorld(idx, recs, (ref) =>
      ref === "01WHIRL"
        ? { status: 400, body: { error: "magic_collision", message: "collides", inputs: "ab", from: "scaffold" } }
        : { status: 400, body: { error: "invalid_payload", message: "bad" } },
    );
    const report = await reseedMagic({ baseUrl: refused.BASE, rulesUrl: refused.RULES_URL, fetchImpl: refused.fetchImpl, sign, log: quiet });
    expect(summarize(report)).toEqual({ seeded: 0, identical: 0, edited: 0, missing: 0, collision: 1, invalid: 1 });
    expect(report.collision[0]).toMatchObject({ id: "whirl", error: { error: "magic_collision" } });
    expect(report.invalid[0]).toMatchObject({ id: "fresh", error: { error: "invalid_payload" } });

    let first = true;
    const limited = fakeWorld(idx, recs, () => {
      if (first) {
        first = false;
        return { status: 429, body: { error: "rate_limited" }, headers: { "Retry-After": "7" } };
      }
      return { status: 200, body: { rev: 9 } };
    });
    const slept: number[] = [];
    const ok = await reseedMagic({ baseUrl: limited.BASE, rulesUrl: limited.RULES_URL, fetchImpl: limited.fetchImpl, sign, sleep: async (ms) => void slept.push(ms), log: quiet });
    expect(summarize(ok).seeded).toBe(2);
    expect(slept).toEqual([7000]);
    expect(limited.seeds).toHaveLength(3);

    const broken = fakeWorld(idx, recs, () => ({ status: 500, body: { error: "internal" } }));
    await expect(reseedMagic({ baseUrl: broken.BASE, rulesUrl: broken.RULES_URL, fetchImpl: broken.fetchImpl, sign, log: quiet })).rejects.toThrow(/unexpected seed response 500/);
  });

  it("[LDB-P25] a live run without a signer is refused before any request", async () => {
    const world = fakeWorld(index, records);
    await expect(reseedMagic({ baseUrl: world.BASE, rulesUrl: world.RULES_URL, fetchImpl: world.fetchImpl, log: quiet })).rejects.toThrow(/needs a signer/);
    expect(world.gets).toEqual([]);
  });
});
