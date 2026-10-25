// [LDB-DDB20] After any sequence of operations, the catalog's `current()` deep-equals a fresh full scan
// (`rebuildFromScan()`), and both equal what the operations left behind. Random sequences of create / update /
// delete / like / unlike with adversarial names, interleaved with reads, snapshots and restarts (a new catalog
// that boots from the snapshot or the scan). Lane G's commitWrite replaces the fixture writer when it lands.
import { beforeEach, describe, expect, it } from "vitest";
import { createCatalog } from "../../src/store/ddb/catalog";
import { txTuning } from "../../src/store/ddb/tx";
import { ddbHarness } from "../harness/ddb";
import { mulberry32, resetTables, Writer } from "./catalog-fixture";

const NAMES = ["Spark", "spark2", "ÉCOLE", "école", "😀 smile", "\u{10000}x", "a b", "Zed", "zed ", "Qwerty", "colemak-dh", "10", "_x"];
const USERS = ["u1", "U2", "adam", "Zoe", "😀", "mike"];
const T0 = Date.parse("2026-01-01T00:00:00.000Z");

beforeEach(async () => {
  await resetTables();
  (ddbHarness.blobs as unknown as { objects: Map<string, unknown> }).objects.clear();
  // the real backoff shape, scaled down: retries with no delay run in lockstep and exhaust their attempts
  txTuning.sleep = (ms) => new Promise((r) => setTimeout(r, ms / 5));
});

const newCatalog = () => createCatalog(ddbHarness.ctxBase);

describe("catalog property", () => {
  for (const seed of [1, 2, 3, 4, 5, 6]) {
    it(`[LDB-DDB20] current() == rebuildFromScan() == the writer's state after every step (seed ${seed})`, async () => {
      const rnd = mulberry32(seed * 7919);
      const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]!;
      const w = new Writer();
      let cat = newCatalog();
      const live: string[] = [];
      const all: string[] = [];
      let n = 0;
      const at = () => new Date(T0 + ++n * 1000).toISOString();
      for (let step = 0; step < 40; step++) {
        const r = rnd();
        if (live.length === 0 || r < 0.2) {
          const id = `L${seed}_${all.length}`;
          // a tombstone keeps its name; a new live layout may reuse it
          await w.create(id, pick(NAMES) + (rnd() < 0.5 ? "" : String(all.length)), pick(USERS), at(), rnd() < 0.1 ? JSON.stringify({ pad: "y".repeat(360_000) }) : `{"s":${step}}`);
          live.push(id);
          all.push(id);
        } else if (r < 0.45) await w.update(pick(live), at(), `{"s":${step},"r":${rnd()}}`);
        else if (r < 0.55) {
          const id = pick(live);
          await w.remove(id, at());
          live.splice(live.indexOf(id), 1);
        }
        else {
          // the store refuses a second like and an unlike of nothing, so toggle
          const id = pick(live);
          const user = pick(USERS);
          if (w.hasLike(id, user)) await w.unlike(id, user);
          else await w.like(id, user);
        }

        const roll = rnd();
        if (roll < 0.15) await cat.writeSnapshot();
        else if (roll < 0.3) cat = newCatalog(); // a restart: boots from the snapshot if there is one, else a scan
        if (rnd() < 0.7 || step === 39) {
          const view = await cat.current();
          const scanned = await cat.rebuildFromScan();
          expect(view.seq, `step ${step}`).toBe(scanned.seq);
          expect(view.layouts, `step ${step}: current vs scan`).toEqual(scanned.layouts);
          expect(view.layouts, `step ${step}: current vs writer`).toEqual(await w.expectedAt(view.seq));
        }
      }
    });
  }
});
