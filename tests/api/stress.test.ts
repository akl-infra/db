// [LDB-ST1] The fast part of the concurrency stress harness (the same scenarios `scripts/stress/run.mjs` runs over HTTP
// against a local `wrangler dev`, plus a soak there): many writers on one layout, one name, one scope or two, readers
// during writes, unary-alt payloads, delete/recreate races, likes, Idempotency-Key and dumps taken under writes.
// Every assertion is a count, an ordering or a content check -- no wall-clock bound anywhere.
import { SELF, env } from "../harness";
import { afterEach, describe, it, vi } from "vitest";
import { FakeDiscord } from "../auth/fake-discord";
import * as S from "../stress/scenarios";

const fake = new FakeDiscord();
function target(): S.Target {
  vi.stubGlobal("fetch", fake.fetchImpl);
  return {
    async call({ method, path, user, body, headers }) {
      const h: Record<string, string> = { ...(headers ?? {}) };
      if (user !== undefined) {
        const id = S.userId(user);
        fake.setAnswer(`t${id}`, { kind: "ok", id, username: `u${id}`, global_name: null });
        h["Authorization"] = `Bearer t${id}`;
      }
      if (body !== undefined) h["Content-Type"] = "application/json";
      const res = await SELF.fetch(`https://akl.test${path}`, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
      const etag = res.headers.get("ETag");
      if ((res.headers.get("Content-Type") ?? "").includes("gzip")) return { status: res.status, etag, json: null, bytes: new Uint8Array(await res.arrayBuffer()) };
      const text = await res.text();
      let json: unknown = text;
      try { json = JSON.parse(text); } catch { /* not JSON */ }
      return { status: res.status, etag, json };
    },
    async sql(q, ...p) {
      const out = await (env as unknown as { DB: D1Database }).DB.prepare(q).bind(...p).all();
      return out.results as Record<string, unknown>[];
    },
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("[LDB-ST1] concurrent writers", () => {
  it("[LDB-ST1] same-scope writers on one layout: exactly one winner per revision, losers get 409 stale carrying the winner", async () => {
    (await S.sameScopeCas(target(), { writers: 6, rounds: 8, owner: 1 })).assertOk();
  });
  it("[LDB-ST1] layout-scope and format-scope writers do not block each other (MF-6) and nothing is lost", async () => {
    (await S.crossScope(target(), { rounds: 6, perScope: 3, owner: 2 })).assertOk();
  });
  it("[LDB-ST1] concurrent creates of one name (case variants): one 201, the rest name_taken, no orphan rows", async () => {
    (await S.createSameName(target(), { creators: 6, rounds: 6 })).assertOk();
  });
  it("[LDB-ST1] a reader during writes only ever sees acknowledged, intact states and never goes backwards", async () => {
    (await S.readersDuringWrites(target(), { rounds: 10, readers: 3, owner: 3 })).assertOk();
  });
  it("[LDB-ST1] unary-alt payloads round-trip through every read path; duplicates and bad shapes leave no trace", async () => {
    (await S.unaryAltPayloads(target(), { owner: 4 })).assertOk();
  });
  it("[LDB-ST1] delete / restore / recreate / format-write races leave one live holder per name and no write on a tombstone", async () => {
    (await S.deleteRecreateRaces(target(), { rounds: 6, owner: 5 })).assertOk();
  });
  it("[LDB-ST1] likes keep like_count equal to distinct likers and never move a version", async () => {
    (await S.likeRaces(target(), { likers: 6, owner: 7 })).assertOk();
  });
  it("[LDB-ST1] concurrent identical POSTs under one Idempotency-Key create exactly one layout", async () => {
    (await S.idempotentCreate(target(), { copies: 6, owner: 8 })).assertOk();
  });
  it("[LDB-ST1] a dump taken while writes land is consistent with itself and not behind its manifest", async () => {
    (await S.dumpDuringWrites(target(), { owner: 9, dumps: 3, writers: 3 })).assertOk();
  });
  it("[LDB-ST1] a short randomized soak ends with every invariant intact", async () => {
    (await S.soak(target(), { durationMs: 3000, workers: 6, owners: 12, layouts: 12, seed: 42 })).assertOk();
  });
});
