#!/usr/bin/env node
// Lane Q: the simulator's driver (design/aws-port.md §5.1). Sends one seeded request stream to two targets (a = the D1
// oracle, b = the DynamoDB lab) and hands every response pair to the differ through `diffPair(a, b, ctx) => Problem[]`
// (./differ.mjs: lane S's differ, or the replay shim until it lands).
//
//   node scripts/lab/sim/drive.mjs --a http://127.0.0.1:<d1> --b http://127.0.0.1:<aws> [--a-discord <base> --b-discord <base>]
//     [--seed 1] [--steps 2000] [--out <dir>] [--corpus <payloads.json>] [--write-share 0.05 | --write-scale 50]
//     [--races all|converge|none] [--no-admin-pack] [--no-interactions] [--stream <recorded.jsonl>] [--b-lab]
//     [--drain-path /__lab/tick] [--max-problems 50]
//   --b-lab        side b is the DynamoDB lab server: restart steps POST /__lab/restart, /__lab/check runs every 25 steps
//   --a-discord/--b-discord  each side's fake Discord (its DISCORD_API_URL, `http://127.0.0.1:<port>/api`): proof messages
//                  are seeded there and Discord cards are read from it
//   --stream       replay a recorded stream (a previous run's stream.jsonl) instead of generating one
// Output (--out): stream.jsonl (every request, in order: the seeded request stream), problems.json, report.json.
// Exit code 0 = no problem, 1 = problems, 2 = bad usage. Loopback only: any other host is refused.
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { comparableBody } from "../fuzz/dumpmask.mjs";
import { deriveKeys } from "../fake-discord/server.mjs";
import { diffPair as defaultDiffPair } from "./differ.mjs";
import { ADMIN_ID, SimGenerator, USER_IDS } from "./generator.mjs";
import { rareAdminPack } from "./adminpack.mjs";
import { seedDiscordProofs } from "./bodies.mjs";
import { cardsFromMessages, defaultInteractionConfig, interactionSpec, requiredMatrix, scenarioSteps } from "./interactions.mjs";
import { RACE_PACKS, runRacePacks, selectPacks } from "./races.mjs";
import { CLOCK0, createSigner, labKey, parseStream, streamLine, wireFor } from "./wire.mjs";
import { makeRng, mixSeed } from "../fuzz/rng.mjs";

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

/** A side over HTTP. No cloud, ever: only loopback hosts are accepted. */
export function httpSide(name, base, extra = {}) {
  const u = new URL(base);
  if (!LOOPBACK.has(u.hostname)) throw new Error(`the simulator sends only to loopback (got ${u.hostname})`);
  return {
    name,
    url: base,
    vars: {},
    cardIds: new Map(),
    modalIds: new Map(),
    ...extra,
    async send(wire) {
      const r = await fetch(new URL(wire.pathWithQuery, u), { method: wire.method, headers: wire.headers, body: wire.body, redirect: "manual" });
      const headers = {};
      r.headers.forEach((val, key) => {
        headers[key] = val;
      });
      const body = Buffer.from(await r.arrayBuffer());
      let json = null;
      try {
        json = JSON.parse(body.toString("utf8"));
      } catch {
        // not JSON
      }
      return { status: r.status, headers, body, json };
    },
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class Driver {
  /**
   * @param {{sides:[object,object], generator?:SimGenerator, diffPair?:Function, signer?:any, clock0?:number, streamFile?:string,
   *          interaction?:object, discordKeys?:{privateKey:any}, maxProblems?:number, log?:(m:string)=>void,
   *          drainPath?:string, checkEvery?:number, corpus?:object[], rng?:any, dayKey?:string}} o
   */
  constructor(o) {
    this.sides = o.sides;
    this.gen = o.generator ?? null;
    this.diffPair = o.diffPair ?? defaultDiffPair;
    this.signer = o.signer ?? createSigner();
    this.tick = 0;
    this.clock0 = o.clock0 ?? CLOCK0;
    this.seed = 0;
    this.nonce = 0;
    this.i = 0;
    this.pairs = 0;
    this.problems = [];
    this.notes = [];
    this.maxProblems = o.maxProblems ?? 50;
    this.interaction = o.interaction ?? null;
    this.discordKeys = o.discordKeys ?? null;
    this.wrongKey = labKey("not-the-discord-key").priv;
    this.log = o.log ?? (() => {});
    this.corpus = o.corpus ?? [{ keys: [] }];
    this.rng = o.rng ?? makeRng(1);
    this.dayKey = o.dayKey ?? "d0";
    this.checkEvery = o.checkEvery ?? 0;
    this.stream = o.streamFile === undefined ? null : fs.openSync(o.streamFile, "w");
    this.statuses = new Map();
    this.drainPath = o.drainPath;
    this.raceGroup = 0;
  }

  close() {
    if (this.stream !== null) fs.closeSync(this.stream);
    this.stream = null;
  }

  now() {
    return this.clock0 + this.tick;
  }

  record(step, extra = {}) {
    if (this.stream !== null) fs.writeSync(this.stream, streamLine(step, this.i, this.tick, extra));
    this.i++;
  }

  ctxFor(sideIx, nowMs, seed, nonceSeed) {
    const side = this.sides[sideIx];
    return {
      nowMs, seed, nonceSeed, signer: this.signer, vars: side.vars,
      discord: this.discordKeys === null ? undefined : {
        privateKey: this.discordKeys.privateKey, wrongKey: this.wrongKey,
        messageIdFor: (key) => side.cardIds.get(key),
        modalIdFor: (specId) => side.modalIds.get(specId),
      },
    };
  }

  async sendStep(sideIx, step, nowMs, seed, nonceSeed) {
    const wire = wireFor(step, this.ctxFor(sideIx, nowMs, seed, nonceSeed));
    return this.sides[sideIx].send(wire);
  }

  addProblem(p) {
    if (this.problems.length < this.maxProblems) this.problems.push(p);
    else if (this.problems.length === this.maxProblems) this.problems.push({ kind: "truncated", detail: `more than ${this.maxProblems} problems; the rest are not kept` });
  }

  async restartSides() {
    for (const s of this.sides) await s.restart?.();
  }

  async checkSides(label) {
    for (const s of this.sides) {
      if (s.check === undefined) continue;
      const r = await s.check();
      if (r && r.ok === false) this.addProblem({ kind: "check", step: label, side: s.name, detail: JSON.stringify(r.problems ?? r).slice(0, 400) });
    }
  }

  maskDump(step, a, b) {
    if (!step.path.startsWith("/v1/dump")) return [a, b];
    const ma = comparableBody(step.path, a.body);
    const mb = comparableBody(step.path, b.body);
    const same = Buffer.compare(ma, mb) === 0;
    return [{ ...a, body: ma, headers: same ? { ...a.headers, etag: "" } : a.headers }, { ...b, body: mb, headers: same ? { ...b.headers, etag: "" } : b.headers }];
  }

  /** One step to both sides, diffed. Returns {a, b, ja, problems}. */
  async pair(step, flags = {}) {
    if (step.restart) {
      this.record(step);
      await this.restartSides();
      return { a: { status: 0, headers: {}, body: Buffer.alloc(0), json: null }, b: { status: 0, headers: {}, body: Buffer.alloc(0), json: null }, ja: null, problems: [] };
    }
    this.tick += step.stepMs ?? 1000;
    const nowMs = this.now();
    const seed = ++this.seed;
    const nonceSeed = `${this.dayKey}:${++this.nonce}`;
    this.record(step, { ...(flags.noDiff ? { noDiff: true } : {}), ...(flags.half ? { half: true } : {}) });
    const [a, b] = await Promise.all([this.sendStep(0, step, nowMs, seed, nonceSeed), this.sendStep(1, step, nowMs, seed, nonceSeed)]);
    this.pairs++;
    this.statuses.set(`${step.family ?? "pack"}:${a.status}`, (this.statuses.get(`${step.family ?? "pack"}:${a.status}`) ?? 0) + 1);
    const ctx = { method: step.method, path: step.path.split("?")[0], query: step.path.includes("?") ? step.path.slice(step.path.indexOf("?")) : "", family: step.family ?? step.label, label: step.label };
    const [ma, mb] = this.maskDump(step, a, b);
    const problems = this.diffPair(ma, mb, ctx);
    for (const p of problems) this.addProblem({ ...p, step: this.i - 1, label: step.label, method: step.method, path: step.path });
    this.gen?.observe(step, { status: a.status, json: a.json, etag: a.headers.etag });
    // The conditional half of an ETag'd read: both sides must answer the same If-None-Match the same way.
    if (step.conditional && step.method === "GET" && a.headers.etag !== undefined && !flags.noConditional) {
      await this.pair({ ...step, conditional: false, headers: { ...(step.headers ?? {}), "If-None-Match": a.headers.etag }, label: `${step.label} (If-None-Match)`, stepMs: 0 }, { noConditional: true, half: true });
    }
    // Discord: a deny's component answers a modal (type 9); step 2 of the scenario needs its id. Drain after every interaction.
    if (step.interaction !== undefined) {
      for (const [ix, r] of [a, b].entries()) {
        const id = r.json?.type === 9 ? /^aklmod1\|deny\|([0-9a-f-]{36})$/.exec(r.json?.data?.custom_id ?? "")?.[1] : undefined;
        if (id !== undefined) this.sides[ix].modalIds.set(step.interaction.spec.id, id);
      }
      await this.drain();
    }
    return { a, b, ja: a.json, problems };
  }

  /** Each side gets the step; nothing is diffed (a read that feeds an invariant check). */
  async readEach(step) {
    this.tick += step.stepMs ?? 0;
    const nowMs = this.now();
    const seed = ++this.seed;
    const nonceSeed = `${this.dayKey}:${++this.nonce}`;
    this.record(step, { noDiff: true });
    const [a, b] = await Promise.all([this.sendStep(0, step, nowMs, seed, nonceSeed), this.sendStep(1, step, nowMs, seed, nonceSeed)]);
    return { a, b };
  }

  /**
   * `steps` concurrently on each side (and both sides at once). opts.sameSeed: one lab seed for every contender (their
   * effects are then identical whoever wins); opts.delays: honour step.delayMs (a write that should land while a long-poll
   * is held). Each contender gets its own nonce.
   */
  async race(steps, opts = {}) {
    this.tick += 1000;
    const nowMs = this.now();
    const group = ++this.raceGroup;
    const sharedSeed = ++this.seed;
    const planned = steps.map((s) => ({ step: s, seed: opts.sameSeed ? sharedSeed : ++this.seed, nonceSeed: `${this.dayKey}:${++this.nonce}` }));
    planned.forEach((p, k) => this.record(p.step, { race: group, raceSize: steps.length, raceIndex: k, raceOpts: opts }));
    const go = async (sideIx) => Promise.all(planned.map(async (p) => {
      if (opts.delays && p.step.delayMs) await sleep(p.step.delayMs);
      return this.sendStep(sideIx, p.step, nowMs, p.seed, p.nonceSeed);
    }));
    const [a, b] = await Promise.all([go(0), go(1)]);
    return { a, b };
  }

  async drain() {
    if (this.drainPath === undefined) return;
    for (const [ix, s] of this.sides.entries()) {
      void ix;
      await s.send({ method: "POST", pathWithQuery: this.drainPath, headers: { "x-lab-now": new Date(this.now()).toISOString() }, body: undefined }).catch(() => undefined);
    }
  }

  // ---- Discord cards ------------------------------------------------------------------------------------------

  /** Read each side's fake Discord channel; remember message ids per side; hand the oracle's cards to the generator. */
  async refreshCards() {
    if (this.interaction === null) return [];
    let oracle = [];
    for (const [ix, s] of this.sides.entries()) {
      if (s.discordBase === undefined) continue;
      const r = await fetch(`${s.discordBase}/v10/channels/${this.interaction.channelId}/messages?limit=100`, { headers: { Authorization: "Bot sim-lab-bot" } }).catch(() => null);
      if (r === null || !r.ok) continue;
      const cards = cardsFromMessages(await r.json());
      s.cardIds = new Map();
      for (const c of cards) s.cardIds.set(`${c.kind}:${c.id}`, c.messageId);
      if (ix === 0) oracle = cards;
    }
    this.gen?.setCards(oracle);
    return oracle;
  }

  // ---- the organic stream -------------------------------------------------------------------------------------

  async runSteps(n, { everyCheck = this.checkEvery } = {}) {
    for (let k = 0; k < n; k++) {
      const step = this.gen.next();
      await this.pair(step);
      if (this.interaction !== null && k % 20 === 19) await this.refreshCards();
      if (everyCheck > 0 && k % everyCheck === everyCheck - 1) await this.checkSides(`step ${this.i}`);
    }
  }

  /** Replay a recorded stream (stream.jsonl). Race groups are re-run concurrently. */
  async replayStream(text) {
    const lines = parseStream(text);
    for (let k = 0; k < lines.length;) {
      const { i, tMs, race, raceSize, raceOpts, noDiff, half, ...step } = lines[k];
      void i; void tMs;
      if (half) { k++; continue; } // regenerated by the original step's `conditional`, with the live ETag
      if (race !== undefined) {
        const group = lines.slice(k, k + raceSize).map(({ i: _i, tMs: _t, race: _r, raceSize: _s, raceIndex: _x, raceOpts: _o, noDiff: _n, half: _h, ...st }) => st);
        await this.race(group, raceOpts ?? {});
        k += raceSize;
        continue;
      }
      if (noDiff) await this.readEach(step);
      else await this.pair(step);
      k++;
    }
  }

  // ---- the Discord interaction matrix (approve / deny / reopen x three queues + the hostile variants) ---------

  async submitFor(kind, layoutId) {
    const u = USER_IDS[1];
    const step = kind === "link"
      ? { label: "matrix: link put", method: "PUT", path: `/v1/layouts/${layoutId}/link`, json: { url: `https://example.com/matrix/${this.i}` }, bearer: u, user: u }
      : kind === "wpm"
        ? { label: "matrix: wpm submit", method: "POST", path: "/v1/wpm", json: { layout: layoutId, wpm: 100 + (this.i % 50), proof: `https://youtu.be/mx${this.i}` }, actor: u, user: u }
        : { label: "matrix: comment put", method: "PUT", path: `/v1/layouts/${layoutId}/comment`, json: { body: `matrix ${this.i}` }, bearer: u, user: u };
    const r = await this.pair({ stepMs: 1000, ...step });
    return r.ja?.submission?.id ?? r.ja?.id ?? null;
  }

  /** Every required (kind, variant) at least once, with real cards when the lab posts them. Returns coverage. */
  async interactionMatrix() {
    const covered = [];
    if (this.interaction === null) return { covered, skipped: "no interaction config" };
    const made = await this.pair({ label: "matrix: layout", method: "POST", path: "/v1/layouts", json: { name: `matrix-${this.dayKey}-${this.i}`, format: "spark/1", payload: this.corpus[0] ?? { keys: [] } }, actor: USER_IDS[0], user: USER_IDS[0], stepMs: 1000 });
    const layoutId = made.ja?.id;
    if (typeof layoutId !== "string") return { covered, skipped: `layout create answered ${made.a.status}` };
    let n = 1000;
    for (const { kind, variant } of requiredMatrix()) {
      const sid = await this.submitFor(kind, layoutId);
      if (sid === null) continue;
      await this.drain();
      let cards = await this.refreshCards();
      let card = cards.find((c) => c.kind === kind && c.id === sid);
      if (variant === "reopen" && kind !== "link") {
        await this.pair({ label: `matrix: approve ${kind} (to reopen)`, method: "POST", path: `/v1/admin/${kind}-queue/${sid}/approve`, json: kind === "link" ? {} : { review_version: 0 }, actor: ADMIN_ID, user: ADMIN_ID, stepMs: 1000 });
        await this.drain();
        cards = await this.refreshCards();
        card = cards.find((c) => c.kind === kind && c.id === sid);
      }
      card ??= { kind, id: sid, version: 0, status: "pending", messageId: undefined };
      const spec = interactionSpec(this.rng, this.interaction, card, variant, ++n);
      for (const step of scenarioSteps(spec)) await this.pair(step);
      covered.push(`${kind}:${variant}`);
    }
    // the hostile variants, each once, on a fresh pending comment card
    for (const variant of ["stale", "wrong-channel", "wrong-guild", "non-admin", "banned-admin", "forged-custom-id", "unknown-confirmation", "duplicate", "bad-signature", "wrong-application", "ping", "unknown-type"]) {
      const sid = await this.submitFor("comment", layoutId);
      if (sid === null) continue;
      await this.drain();
      const cards = await this.refreshCards();
      const card = cards.find((c) => c.kind === "comment" && c.id === sid) ?? { kind: "comment", id: sid, version: 0, status: "pending" };
      const spec = interactionSpec(this.rng, this.interaction, card, variant, ++n);
      for (const step of scenarioSteps(spec)) await this.pair(step);
      covered.push(`comment:${variant}`);
    }
    return { covered };
  }

  // ---- the env the packs run against --------------------------------------------------------------------------

  packEnv() {
    return {
      pair: (step) => this.pair(step),
      race: (steps, opts) => this.race(steps, opts),
      readEach: (step) => this.readEach(step),
      rng: this.rng,
      corpus: this.corpus,
      clock: () => this.now(),
      dayKey: this.dayKey,
      seqHint: () => this.gen?.lastSeq ?? 0,
      observe: (m) => this.notes.push(m),
    };
  }

  /**
   * One simulated day: the rare admin pack, the interaction matrix, `steps` organic steps with the race packs spread through
   * them, and a final structural check. `which.races` = "all" | "converge" | "none".
   */
  async runDay({ steps, adminPack = true, interactions = true, races = "all" }) {
    const report = { steps, adminPack: null, interactions: null, races: null };
    if (adminPack) {
      report.adminPack = await rareAdminPack(this.packEnv());
      this.log(`admin pack: ${report.adminPack.covered.length} ops, missing ${report.adminPack.missing.length}, warnings ${report.adminPack.warnings.length}`);
    }
    if (interactions) {
      report.interactions = await this.interactionMatrix();
      this.log(`interaction matrix: ${report.interactions.covered.length} scenarios`);
    }
    const midDay = selectPacks("converge");
    const poisoning = races === "all" ? RACE_PACKS.filter((p) => !midDay.includes(p)) : [];
    const half = Math.floor(steps / 2);
    await this.runSteps(half);
    if (races !== "none") {
      report.races = await runRacePacks(this.packEnv(), midDay);
      for (const p of report.races.problems) this.addProblem(p);
      this.log(`race packs (mid-day): ${report.races.ran.length} ran, ${report.races.problems.length} problems`);
    }
    await this.runSteps(steps - half);
    await this.checkSides("end of day");
    if (poisoning.length > 0) {
      // These leave the two sides different by arrival order or minted ids: the lab must be reloaded after them.
      const end = await runRacePacks(this.packEnv(), poisoning);
      for (const p of end.problems) this.addProblem(p);
      report.races = { ran: [...(report.races?.ran ?? []), ...end.ran], problems: [...(report.races?.problems ?? []), ...end.problems], endOfDay: end.ran.map((r) => r.name), reloadRequired: true };
      this.log(`race packs (end of day, reload the lab after): ${end.ran.length} ran, ${end.problems.length} problems`);
    }
    return report;
  }
}

// ---- CLI -----------------------------------------------------------------------------------------------------------

export function parseArgs(argv) {
  const a = { seed: 1, steps: 2000, races: "all", adminPack: true, interactions: true, maxProblems: 50 };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const v = () => argv[++i];
    if (k === "--a") a.a = v();
    else if (k === "--b") a.b = v();
    else if (k === "--a-discord") a.aDiscord = v();
    else if (k === "--b-discord") a.bDiscord = v();
    else if (k === "--seed") a.seed = Number(v());
    else if (k === "--steps") a.steps = Number(v());
    else if (k === "--out") a.out = v();
    else if (k === "--corpus") a.corpus = v();
    else if (k === "--write-share") a.writeShare = Number(v());
    else if (k === "--write-scale") a.writeScale = Number(v());
    else if (k === "--races") a.races = v();
    else if (k === "--no-admin-pack") a.adminPack = false;
    else if (k === "--no-interactions") a.interactions = false;
    else if (k === "--stream") a.stream = v();
    else if (k === "--b-lab") a.bLab = true;
    else if (k === "--drain-path") a.drainPath = v();
    else if (k === "--max-problems") a.maxProblems = Number(v());
    else if (k === "--discord-seed") a.discordSeed = v();
    else if (k === "--day") a.day = v();
    else throw new Error(`unknown argument ${k}`);
  }
  return a;
}

export function loadCorpus(file, root = process.cwd()) {
  if (file !== undefined) return JSON.parse(fs.readFileSync(file, "utf8"));
  const dir = path.join(root, "formats/spark/1/fixtures");
  if (!fs.existsSync(dir)) return [{ keys: [] }];
  return fs.readdirSync(dir).filter((f) => /^\d+-[a-z0-9-]+\.json$/.test(f)).sort().slice(0, 12).map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")));
}

async function labCall(base, method, p) {
  const r = await fetch(base + p, { method });
  const text = await r.text();
  if (!r.ok) throw new Error(`${method} ${p} -> ${r.status} ${text.slice(0, 200)}`);
  return JSON.parse(text);
}

export async function main(argv) {
  const a = parseArgs(argv);
  if (a.a === undefined || a.b === undefined) {
    console.error("usage: drive.mjs --a <oracle url> --b <aws lab url> [--a-discord <base> --b-discord <base>] [--seed N] [--steps N] [--out dir] [--races all|converge|none]");
    return 2;
  }
  const out = a.out ?? null;
  if (out !== null) fs.mkdirSync(out, { recursive: true });
  const corpus = loadCorpus(a.corpus);
  const dk = deriveKeys(a.discordSeed ?? "lab");
  const interaction = a.aDiscord !== undefined && a.interactions ? defaultInteractionConfig(null, {}) : null;
  const sideA = httpSide("oracle", a.a, { discordBase: a.aDiscord });
  const sideB = httpSide("aws", a.b, a.bLab ? { discordBase: a.bDiscord, restart: () => labCall(a.b, "POST", "/__lab/restart"), check: () => labCall(a.b, "GET", "/__lab/check") } : { discordBase: a.bDiscord });
  if (interaction !== null) {
    // application id: the fake's (GET /__fake/signer on its origin)
    const origin = new URL(a.aDiscord).origin;
    interaction.applicationId = (await (await fetch(`${origin}/__fake/signer`)).json()).application_id;
  }
  for (const s of [sideA, sideB]) {
    if (s.discordBase !== undefined) Object.assign(s.vars, await seedDiscordProofs(s.discordBase, { guildId: interaction?.guildId ?? "300000000000000001", channelId: interaction?.channelId ?? "300000000000000002", users: [ADMIN_ID, ...USER_IDS], other: "100000000000000099" }));
  }
  const rng = makeRng(mixSeed(a.seed, 7));
  const generator = new SimGenerator({ seed: a.seed, corpus, knobs: { writeShare: a.writeShare, writeScale: a.writeScale }, interaction });
  const driver = new Driver({
    sides: [sideA, sideB], generator, interaction, discordKeys: { privateKey: dk.privateKey }, corpus, rng, dayKey: a.day ?? `d${a.seed}`,
    streamFile: out === null ? undefined : path.join(out, "stream.jsonl"), maxProblems: a.maxProblems, drainPath: a.drainPath, checkEvery: a.bLab ? 25 : 0,
    log: (m) => console.log(`[sim] ${m}`),
  });
  let report;
  try {
    if (a.stream !== undefined) {
      await driver.replayStream(fs.readFileSync(a.stream, "utf8"));
      report = { replayed: a.stream };
    } else {
      report = await driver.runDay({ steps: a.steps, adminPack: a.adminPack, interactions: a.interactions, races: a.races });
    }
  } finally {
    driver.close();
  }
  const summary = { seed: a.seed, pairs: driver.pairs, requests: driver.i, problems: driver.problems.length, families: generator.families, notes: driver.notes, ...report };
  if (out !== null) {
    fs.writeFileSync(path.join(out, "problems.json"), JSON.stringify(driver.problems, null, 2));
    fs.writeFileSync(path.join(out, "report.json"), JSON.stringify(summary, null, 2));
  }
  console.log(`[sim] ${driver.pairs} pairs, ${driver.i} requests, ${driver.problems.length} problems`);
  for (const p of driver.problems.slice(0, 20)) console.log(`  PROBLEM ${p.kind} ${p.method ?? ""} ${p.path ?? p.pack ?? ""}: ${String(p.detail).slice(0, 300)}`);
  return driver.problems.length === 0 ? 0 : 1;
}

export { RACE_PACKS };

if (import.meta.url === `file://${process.argv[1]}`) main(process.argv.slice(2)).then((c) => process.exit(c), (e) => { console.error(e); process.exit(2); });
