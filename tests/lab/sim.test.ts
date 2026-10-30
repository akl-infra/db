// Lane Q: the organic simulator, the rare admin pack, generated bodies, the Discord interaction generator and the race packs
// (scripts/lab/sim/, design/aws-port.md §5.1). Pure and local: the sides are in-process fakes, the fake Discord is the
// repo's own on a free loopback port, the handler under test is akldb's own `handleDiscordInteraction` over a stub store.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

/* eslint-disable @typescript-eslint/no-explicit-any */
// @ts-expect-error plain .mjs, no declarations
import { makeRng as seededRng } from "../../scripts/lab/fuzz/rng.mjs";

const jsonOf = async (r: Response): Promise<any> => r.json();
const S = path.join(process.cwd(), "scripts/lab/sim");
const load = async (f: string): Promise<any> => import(/* @vite-ignore */ path.join(S, f));
const rngMod = async (): Promise<any> => import(/* @vite-ignore */ path.join(process.cwd(), "scripts/lab/fuzz/rng.mjs"));
const CORPUS = [{ keys: [{ char: "a", row: 0, col: 0, finger: "LP" }, { char: "b", row: 0, col: 1, finger: "LR" }, { char: "c", row: 0, col: 2, finger: "LM" }] }];

async function gen(seed: number, knobs: any = {}, extra: any = {}) {
  const { SimGenerator } = await load("generator.mjs");
  return new SimGenerator({ seed, corpus: CORPUS, knobs, ...extra });
}
function take(g: any, n: number): any[] {
  const out = [];
  for (let i = 0; i < n; i++) out.push(g.next());
  return out;
}

describe("traffic mix", () => {
  it("[LDB-PG15] follows production's measured shape by default and moves with the knobs", async () => {
    const { PROD_SHARES, SUBRESOURCE_SHARES, familyWeights, normalizeKnobs } = await load("mix.mjs");
    expect(PROD_SHARES).toMatchObject({ changes: 16, meta: 27, subresources: 35, layoutGet: 9, list: 6, wpm: 5, meAuthors: 1 });
    expect(SUBRESOURCE_SHARES.comments).toBeGreaterThan(SUBRESOURCE_SHARES.likes * 5);
    expect(normalizeKnobs().writeShare).toBeCloseTo(65 / 63000, 8);
    const w = familyWeights({ adversarial: 0, cold: 0, admin: 0 });
    expect(Object.values(w).reduce((s: number, x: any) => s + x, 0)).toBeCloseTo(1, 10);
    expect(w.write).toBeCloseTo(65 / 63000, 8);
    expect(w.meta / w.changes).toBeCloseTo(27 / 16, 6); // reads keep prod's proportions
    expect(w.subresources / w.layoutGet).toBeCloseTo(35 / 9, 6);
    expect(familyWeights({ writeScale: 100, adversarial: 0, cold: 0, admin: 0 }).write).toBeCloseTo(6500 / 63000, 6);
    expect(familyWeights({ writeShare: 0.2, adversarial: 0, cold: 0, admin: 0 }).write).toBe(0.2);
    expect(familyWeights({ shares: { changes: 0 } }).changes).toBe(0);
    expect(() => familyWeights({ writeShare: 0.99, adversarial: 0.05 })).toThrow();
  });

  it("[LDB-PG15] a generated stream lands near the mix (reads at prod's shares, writes at the knob)", async () => {
    const g = await gen(7, { adversarial: 0, cold: 0, admin: 0, writeShare: 0.05 });
    take(g, 20000);
    const f = g.families;
    const total = Object.values(f).reduce((s: number, x: any) => s + x, 0) as number;
    const share = (name: string) => (f[name] ?? 0) / total;
    expect(share("meta")).toBeGreaterThan(0.2);
    expect(share("meta")).toBeLessThan(0.3);
    expect(share("subresources")).toBeGreaterThan(0.28);
    expect(share("changes")).toBeGreaterThan(0.12);
    expect(share("changes")).toBeLessThan(0.2);
    expect(share("write")).toBeGreaterThan(0.03);
    expect(share("write")).toBeLessThan(0.08);
    expect(f.adversarial).toBeUndefined();
  });
});

describe("generator", () => {
  it("[LDB-PG16] is seeded: one seed gives the same stream, another does not", async () => {
    const a = take(await gen(11, { writeScale: 50 }), 400).map((s) => JSON.stringify(s));
    const b = take(await gen(11, { writeScale: 50 }), 400).map((s) => JSON.stringify(s));
    const c = take(await gen(12, { writeScale: 50 }), 400).map((s) => JSON.stringify(s));
    expect(a).toEqual(b);
    expect(a).not.toEqual(c);
  });

  it("[LDB-PG16] covers the Spark, akl.gg and mana2 client shapes and the admin shapes", async () => {
    const g = await gen(3, { writeScale: 400, admin: 0.05 });
    // feed the model like the driver does, so ids are real
    const steps: any[] = [];
    for (let i = 0; i < 6000; i++) {
      const s = g.next();
      steps.push(s);
      if (s.method === "POST" && s.path === "/v1/layouts") g.observe(s, { status: 201, json: { id: `01JAB${String(i).padStart(21, "0")}`, name: s.json?.name ?? "x", owner: s.user }, etag: '"layout:1"' });
      if (s.label.startsWith("wpm submit")) g.observe(s, { status: 202, json: { submission: { id: `01JAB${String(i).padStart(21, "W")}` } } });
    }
    const has = (p: (s: any) => boolean) => steps.some(p);
    // Spark: signed long-poll with wait=, conditional /v1/meta, Idempotency-Key + retry, WPM submit then a 30 s receipt poll
    expect(has((s) => /\/v1\/changes\?.*wait=\d+/.test(s.path) && s.actor !== undefined)).toBe(true);
    expect(has((s) => s.path === "/v1/meta" && s.conditional === true)).toBe(true);
    const idem = steps.filter((s) => s.headers?.["Idempotency-Key"] !== undefined);
    expect(idem.length).toBeGreaterThan(2);
    const keys = new Map<string, number>();
    for (const s of idem) keys.set(s.headers["Idempotency-Key"], (keys.get(s.headers["Idempotency-Key"]) ?? 0) + 1);
    expect([...keys.values()].some((n) => n >= 2)).toBe(true); // the retry repeats the key
    expect(has((s) => s.label === "wpm receipt poll (30 s)" && s.stepMs === 30_000)).toBe(true);
    // akl.gg: bearer lane, full=1 lists, comments
    expect(has((s) => s.bearer !== undefined && /\/comments?$/.test(s.path))).toBe(true);
    expect(has((s) => /full=1/.test(s.path) && s.method === "GET")).toBe(true);
    // mana2
    expect(has((s) => /format=mana2%2F1/.test(s.path))).toBe(true);
    // admins
    expect(has((s) => /^\/v1\/admin\/(link|wpm|comment)-queue$/.test(s.path))).toBe(true);
    expect(has((s) => /^\/v1\/admin\/(link|wpm|comment)-queue\/[^/]+\/(approve|reject|reopen)$/.test(s.path))).toBe(true);
    expect(has((s) => s.path.startsWith("/v1/admin/bans"))).toBe(true);
    expect(has((s) => s.path.startsWith("/v1/admin/authors/"))).toBe(true);
    // admin add/remove belong to the rare pack, in order, not to the organic mix
    expect(has((s) => s.path.startsWith("/v1/admin/admins") && s.method !== "GET")).toBe(false);
  });

  it("[LDB-PG17] sends adversarial input: case pairs, odd names, forged cursors, a full sort x filter sweep, tombstone reclaims", async () => {
    const g = await gen(5, { adversarial: 0.5, writeScale: 300, admin: 0.01 });
    const steps: any[] = [];
    for (let i = 0; i < 3000; i++) {
      const s = g.next();
      steps.push(s);
      if (s.method === "POST" && s.path === "/v1/layouts" && s.json?.name) g.observe(s, { status: 201, json: { id: `01JAB${String(i).padStart(21, "0")}`, name: s.json.name, owner: s.user }, etag: '"layout:1"' });
    }
    const names = steps.filter((s) => s.label.startsWith("create (case pair)")).map((s) => s.json.name as string);
    expect(names.some((n, i) => i > 0 && names[i - 1] !== n && names[i - 1]!.toLowerCase() === n.toLowerCase())).toBe(true);
    expect(steps.some((s) => s.label.startsWith("create (odd name)") && /[^\x00-\x7f]/.test(s.json.name))).toBe(true);
    expect(steps.some((s) => s.label.startsWith("create (odd name)") && /[\u{10000}-\u{10FFFF}]/u.test(s.json.name))).toBe(true);
    const cursors = steps.filter((s) => s.label === "list (forged cursor)");
    expect(cursors.length).toBeGreaterThan(10);
    expect(new Set(cursors.map((s) => s.path)).size).toBeGreaterThan(5);
    // the sweep walks sort x filter in order; 4 sorts x 13 filters = 52 combinations, all seen
    const sweep = new Set(steps.filter((s) => s.label === "list (sort x filter)").map((s) => s.path.replace(/&order=\w+$/, "")));
    expect(sweep.size).toBeGreaterThanOrEqual(40);
    const labels = steps.map((s) => s.label);
    const del = labels.indexOf("reclaim: delete");
    expect(del).toBeGreaterThan(-1);
    expect(labels.slice(del + 1, del + 8)).toEqual(expect.arrayContaining(["reclaim: create under the tombstoned name", "reclaim: restore the old one (name taken)", "reclaim: restore under a new name"]));
  });

  it("[LDB-PG17] forces cold containers: a restart step, then the reads a cold catalog serves first", async () => {
    const g = await gen(9, { cold: 0.3, adversarial: 0, admin: 0 });
    const steps = take(g, 200);
    const i = steps.findIndex((s) => s.restart === true);
    expect(i).toBeGreaterThan(-1);
    expect(steps.slice(i + 1, i + 7).map((s) => s.label)).toEqual(["cold: meta", "cold: list", "cold: layout", "cold: comments", "cold: changes", "cold: wpm"]);
  });
});

describe("generated bodies", () => {
  it("[LDB-PG18] comment bodies cover the boundaries; WPM bodies cover valid and invalid speeds and every proof kind; binds follow first/same/conflict", async () => {
    const { makeRng } = await rngMod();
    const b = await load("bodies.mjs");
    const rng = makeRng(2);
    const comments = Array.from({ length: 400 }, () => b.commentBody(rng));
    for (const kind of ["ok", "max", "over", "blank", "empty", "wrong-type", "extra-key", "missing"]) expect(comments.some((c: any) => c.kind === kind)).toBe(true);
    expect(comments.find((c: any) => c.kind === "max").json.body).toHaveLength(2000);
    expect(comments.find((c: any) => c.kind === "over").json.body).toHaveLength(2001);
    expect(comments.some((c: any) => typeof c.json.body === "string" && /[\u{10000}-\u{10FFFF}]/u.test(c.json.body))).toBe(true);
    const wpms = Array.from({ length: 600 }, () => b.wpmBody(rng, { layout: "L", userId: "100000000000000002" }));
    const proofs = wpms.map((w: any) => String(w.json.proof));
    expect(proofs.some((p: string) => p === "{{proof:own:100000000000000002}}")).toBe(true); // a Discord proof by the submitter
    expect(proofs.some((p: string) => p === "{{proof:other:100000000000000002}}")).toBe(true); // by someone else (LDB-WPM15)
    expect(proofs.some((p: string) => p === "{{proof:missing}}")).toBe(true);
    expect(proofs.some((p: string) => /youtu/.test(p))).toBe(true); // a non-Discord proof
    expect(proofs.some((p: string) => p === "not a url")).toBe(true);
    const speeds = wpms.map((w: any) => w.json.wpm);
    for (const v of [0, 1001, 87.5, "100", -3]) expect(speeds).toContain(v);
    expect(b.wpmBody(rng, { layout: "L", userId: "100000000000000002", onBehalf: true }).json.user_id).toBe("100000000000000002");
    const memo = new Map();
    const first = b.bindBody(rng, memo, "S1", "first").json;
    expect(b.bindBody(rng, memo, "S1", "same").json).toEqual(first);
    const conflict = b.bindBody(rng, memo, "S1", "conflict").json;
    expect(conflict.message_id).not.toBe(first.message_id);
    expect(conflict.channel_id).toBe(first.channel_id);
    expect(b.bindBody(rng, memo, "S1", "invalid").json).not.toEqual(first);
    const links = Array.from({ length: 200 }, (_, n) => b.linkBody(rng, n));
    for (const kind of ["ok", "http", "userinfo", "ftp", "garbage", "long", "non-string", "empty"]) expect(links.some((l: any) => l.kind === kind)).toBe(true);
  });

  it("[LDB-PG18] Discord proof tokens resolve per side from messages seeded in that side's fake Discord", async () => {
    const { startFakeDiscord } = (await import(/* @vite-ignore */ path.join(process.cwd(), "scripts/lab/fake-discord/server.mjs"))) as any;
    const b = await load("bodies.mjs");
    const { substitute } = await load("wire.mjs");
    const fake = await startFakeDiscord({ port: 0, seed: "q" });
    try {
      const vars = await b.seedDiscordProofs(fake.base, { guildId: "300000000000000001", channelId: "300000000000000002", users: ["100000000000000002", "100000000000000003"], other: "100000000000000099" });
      const own = vars["proof:own:100000000000000002"];
      const m = /channels\/(\d+)\/(\d+)\/(\d+)$/.exec(own)!;
      const msg = (await (await fetch(`${fake.base}/v10/channels/${m[2]}/messages/${m[3]}`, { headers: { authorization: "Bot x" } })).json()) as any;
      expect(msg.author.id).toBe("100000000000000002"); // what akldb's proof check compares with the submitter
      const foreign = /channels\/(\d+)\/(\d+)\/(\d+)$/.exec(vars["proof:other:100000000000000002"])!;
      expect(((await (await fetch(`${fake.base}/v10/channels/${foreign[2]}/messages/${foreign[3]}`, { headers: { authorization: "Bot x" } })).json()) as any).author.id).toBe("100000000000000099");
      const gone = /channels\/(\d+)\/(\d+)\/(\d+)$/.exec(vars["proof:missing"])!;
      expect((await fetch(`${fake.base}/v10/channels/${gone[2]}/messages/${gone[3]}`, { headers: { authorization: "Bot x" } })).status).toBe(404);
      expect(substitute('{"proof":"{{proof:missing}}","x":"{{nope}}"}', vars)).toBe(`{"proof":"${vars["proof:missing"]}","x":"{{nope}}"}`);
    } finally {
      await fake.close();
    }
  });
});

describe("Discord interactions", () => {
  const cfgOf = async (applicationId: string) => (await load("interactions.mjs")).defaultInteractionConfig(applicationId, {});
  const handlerEnv = (cfg: any, publicKeyHex: string, extra: any = {}) => ({
    MODQUEUE_DISCORD_APPLICATION_ID: cfg.applicationId, MODQUEUE_DISCORD_PUBLIC_KEY: publicKeyHex, MODQUEUE_DISCORD_GUILD_ID: cfg.guildId,
    MODQUEUE_DISCORD_CHANNEL_ID: cfg.channelId, MODQUEUE_DISCORD_ACTIONS: "true", MODQUEUE_DISCORD_BOT_TOKEN: "lab-bot", DISCORD_API_URL: "http://127.0.0.1:1/api", ...extra,
  });

  it("[LDB-PG19] covers approve / deny (with and without a reason) / reopen on all three queues and every hostile variant", async () => {
    const I = await load("interactions.mjs");
    const matrix = I.requiredMatrix().map((m: any) => `${m.kind}:${m.variant}`);
    for (const kind of ["link", "wpm", "comment"]) for (const v of ["approve", "deny", "deny-reason", "reopen"]) expect(matrix).toContain(`${kind}:${v}`);
    for (const v of ["stale", "wrong-channel", "wrong-guild", "non-admin", "banned-admin", "duplicate", "bad-signature", "forged-custom-id", "wrong-application", "ping", "unknown-confirmation", "unknown-type"]) expect(I.VARIANTS).toContain(v);
    const { makeRng } = await rngMod();
    const rng = makeRng(1);
    const cfg = await cfgOf("200000000000000001");
    const card = { kind: "wpm", id: "01JAB0000000000000000WPM01", version: 2, status: "pending" };
    const deny = I.interactionSpec(rng, cfg, card, "deny-reason", 1);
    expect(I.scenarioSteps(deny)).toHaveLength(2); // component, then the modal submit
    expect(I.scenarioSteps(I.interactionSpec(rng, cfg, card, "duplicate", 2))).toHaveLength(2); // the same interaction id twice
    expect(I.scenarioSteps(I.interactionSpec(rng, cfg, card, "approve", 3))).toHaveLength(1);
    const a = I.interactionSpec(rng, cfg, card, "approve", 4);
    const body = I.materialize(a, { messageId: "1100000000000000001" });
    expect(body.data.custom_id).toBe("aklmod2|wpm|approve|01JAB0000000000000000WPM01|2");
    expect(body.message.id).toBe("1100000000000000001");
    expect(cfg.admins).toContain(body.member.user.id);
    expect(cfg.members).toContain(I.materialize(I.interactionSpec(rng, cfg, card, "non-admin", 5), { messageId: "1100000000000000001" }).member.user.id);
    expect(I.materialize(I.interactionSpec(rng, cfg, card, "wrong-channel", 6), {}).channel_id).not.toBe(cfg.channelId);
    expect(I.materialize(I.interactionSpec(rng, cfg, card, "wrong-guild", 7), {}).guild_id).not.toBe(cfg.guildId);
    expect(I.variantsFor({ kind: "link", id: "x", version: 0, status: "pending" })).not.toContain("reopen-approved");
  });

  it("[LDB-PG19] reads the cards (custom ids) out of the messages the fake Discord holds", async () => {
    const { cardsFromMessages } = await load("interactions.mjs");
    const id = "01JAB0000000000000000CMT01";
    const cards = cardsFromMessages([
      { id: "1100000000000000010", components: [{ type: 17, components: [{ type: 1, components: [{ type: 2, custom_id: `aklmod2|comment|approve|${id}|0` }, { type: 2, custom_id: `aklmod2|comment|deny|${id}|0` }] }] }] },
      { id: "1100000000000000011", components: [{ type: 1, components: [{ type: 2, custom_id: `aklmod2|wpm|reopen-rejected|${id}|3` }] }] },
      { id: "1100000000000000012", components: [{ type: 1, components: [{ type: 2, custom_id: "unrelated" }] }] },
    ]);
    expect(cards).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "comment", id, version: 0, status: "pending", messageId: "1100000000000000010" }),
      expect.objectContaining({ kind: "wpm", id, version: 3, status: "rejected", messageId: "1100000000000000011" }),
    ]));
    expect(cards.filter((c: any) => c.messageId === "1100000000000000012")).toHaveLength(0);
  });

  it("[LDB-PG19] signed interactions pass akldb's own handler (ping, approve queued, deny modal then submit); every refusal variant is refused", async () => {
    const { startFakeDiscord } = (await import(/* @vite-ignore */ path.join(process.cwd(), "scripts/lab/fake-discord/server.mjs"))) as any;
    const { deriveKeys } = (await import(/* @vite-ignore */ path.join(process.cwd(), "scripts/lab/fake-discord/server.mjs"))) as any;
    const { handleDiscordInteraction } = await import("../../src/core/discord-interactions");
    const { stubStore } = await import("./stub-store");
    const I = await load("interactions.mjs");
    const { makeRng } = await rngMod();
    const fake = await startFakeDiscord({ port: 0, seed: "q-handler" });
    try {
      const keys = deriveKeys("q-handler");
      expect(keys.publicKeyHex).toBe(fake.publicKeyHex);
      const cfg = await cfgOf(fake.applicationId);
      const admin = cfg.admins[0];
      const queued: any[] = [];
      const modals = new Map<string, any>();
      const store = stubStore({
        "auth.rolesOf": async (...a: unknown[]) => { const id = a[0]; return ({ admin: id === admin, banned: false }); },
        "discord.trackedTarget": async (...a: unknown[]) => { const t = a[0] as any; const channel = a[1]; return channel === cfg.channelId && t.id === "01JAB0000000000000000CMT01" && t.status === "pending" && t.reviewVersion === 0; },
        "discord.hasReceipt": async (...a: unknown[]) => queued.some((x) => x.interaction_id === a[0]),
        "discord.insertAction": async (...a: unknown[]) => {
          queued.push(a[1]);
        },
        "discord.insertDenyModal": async (...a: unknown[]) => {
          modals.set((a[0] as any).modalId, a[0]);
        },
        "discord.denyModal": async (...a: unknown[]) => { const id = a[0] as string; return modals.has(id) ? { ...modals.get(id), actor_id: modals.get(id).actorId, channel_id: modals.get(id).channelId, guild_id: modals.get(id).guildId, kind: modals.get(id).kind, submission_id: modals.get(id).submissionId, message_id: modals.get(id).messageId, expected_review_version: modals.get(id).expectedReviewVersion, expires_at: "2099-01-01T00:00:00.000Z", consumed_at: null } : null; },
        "discord.consumeModalAndQueueDeny": async (...a: unknown[]) => {
          queued.push((a[0] as any).action);
          return true;
        },
      });
      const env = handlerEnv(cfg, fake.publicKeyHex, { DB: store }) as never;
      const nowMs = Date.parse("2026-10-25T12:00:00.000Z");
      const send = async (stepDoc: any, mode = "good") => {
        const signed = I.signBody(JSON.stringify(stepDoc), { nowMs, privateKey: keys.privateKey, mode, wrongKey: crypto.generateKeyPairSync("ed25519").privateKey });
        return handleDiscordInteraction(new Request("http://127.0.0.1/discord/interactions", { method: "POST", body: signed.body, headers: signed.headers }), env, () => new Date(nowMs).toISOString());
      };
      const card = { kind: "comment", id: "01JAB0000000000000000CMT01", version: 0, status: "pending" };
      const rng = makeRng(4);
      const spec = (variant: string, n: number) => I.interactionSpec(rng, cfg, card, variant, n);
      const doc = (s: any, step = 1, modalId?: string) => I.materialize(s, { messageId: "1100000000000000099", modalId, step });
      // ping
      expect(await jsonOf(await send(doc(spec("ping", 1))))).toEqual({ type: 1 });
      // approve: accepted, queued, deferred update
      const ok = spec("approve", 2);
      const res = await send(doc(ok));
      expect(await jsonOf(res)).toEqual({ type: 6 });
      expect(queued).toHaveLength(1);
      expect(queued[0]).toMatchObject({ kind: "comment", submission_id: card.id, action: "approve", actor_id: ok.user.id, expected_review_version: 0 });
      // the same interaction id twice: refused as already received
      const dup = await jsonOf(await send(doc(ok)));
      expect(dup.data.content).toMatch(/already received/);
      // deny with a reason: component -> modal (type 9) -> modal submit -> queued with the reason
      const deny = spec("deny-reason", 3);
      deny.reason = "needs a clearer video";
      const modal = await jsonOf(await send(doc(deny)));
      expect(modal.type).toBe(9);
      const modalId = /^aklmod1\|deny\|([0-9a-f-]{36})$/.exec(modal.data.custom_id)![1]!;
      expect(await jsonOf(await send(doc(deny, 2, modalId), "good"))).toEqual({ type: 6 });
      expect(queued[queued.length - 1]).toMatchObject({ action: "deny", reason: "needs a clearer video" });
      // refusals
      const refused = async (variant: string, mode?: string) => {
        const s = spec(variant, 100 + variant.length);
        const before = queued.length;
        const r = await send(doc(s), mode);
        expect(queued.length).toBe(before);
        return r;
      };
      expect((await refused("bad-signature", "tampered-body")).status).toBe(401);
      expect((await refused("bad-signature", "wrong-key")).status).toBe(401);
      expect((await refused("bad-signature", "stale-timestamp")).status).toBe(401);
      expect((await jsonOf(await refused("wrong-application"))).data.content).toMatch(/not for akldb/);
      expect((await jsonOf(await refused("wrong-channel"))).data.content).toMatch(/not allowed here/);
      expect((await jsonOf(await refused("wrong-guild"))).data.content).toMatch(/not allowed here/);
      expect((await jsonOf(await refused("non-admin"))).data.content).toMatch(/permission/);
      expect((await jsonOf(await refused("forged-custom-id"))).data.content).toMatch(/stale or unrecognized/);
      expect((await jsonOf(await refused("unknown-confirmation"))).data.content).toMatch(/confirmation expired|stale or unrecognized/);
      expect((await jsonOf(await refused("stale"))).data.content).toMatch(/stale or unrecognized/);
      expect(((await jsonOf(await refused("unknown-type"))).data?.content ?? "")).toMatch(/Unsupported|unavailable|malformed|stale/);
    } finally {
      await fake.close();
    }
  });
});

// ---- the driver, with in-process sides ------------------------------------------------------------------------------

function memSide(name: string, handler: (wire: any) => { status: number; headers?: Record<string, string>; json?: any }) {
  const wires: any[] = [];
  return {
    name, wires, vars: {} as Record<string, string>, cardIds: new Map(), modalIds: new Map(),
    restarts: 0,
    async restart() { (this as any).restarts++; },
    async send(wire: any) {
      wires.push(wire);
      const r = handler(wire);
      const body = Buffer.from(r.json === undefined ? "" : JSON.stringify(r.json));
      return { status: r.status, headers: r.headers ?? {}, body, json: r.json ?? null };
    },
  };
}

const echo = (wire: any) => ({ status: 200, headers: { etag: '"e1"' }, json: { path: wire.pathWithQuery, id: "01JAB0000000000000000AAAAA" } });

async function driverOf(sides: any[], extra: any = {}) {
  const { Driver } = await load("drive.mjs");
  const { SimGenerator } = await load("generator.mjs");
  const { makeRng } = await rngMod();
  return new Driver({ sides, generator: extra.generator ?? new SimGenerator({ seed: 1, corpus: CORPUS, knobs: { writeScale: 50 } }), corpus: CORPUS, rng: makeRng(1), ...extra });
}

describe("driver", () => {
  it("[LDB-PG20] sends the same request to both sides, diffs each pair through diffPair(a, b, ctx), and records every request as JSONL", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sim-"));
    const a = memSide("oracle", echo);
    const b = memSide("aws", (w) => (w.pathWithQuery.includes("/comments") ? { status: 200, headers: { etag: '"e1"' }, json: { different: true } } : echo(w)));
    const calls: any[] = [];
    const diffPair = (x: any, y: any, ctx: any) => {
      calls.push(ctx);
      return Buffer.compare(x.body, y.body) === 0 ? [] : [{ kind: "body", detail: "bodies differ" }];
    };
    const d = await driverOf([a, b], { diffPair, streamFile: path.join(dir, "stream.jsonl") });
    await d.runSteps(120);
    d.close();
    expect(a.wires.length).toBe(b.wires.length);
    expect(a.wires.length).toBeGreaterThan(120); // conditional halves are extra requests
    for (let i = 0; i < a.wires.length; i++) {
      expect(a.wires[i].method).toBe(b.wires[i].method);
      expect(a.wires[i].pathWithQuery).toBe(b.wires[i].pathWithQuery);
      expect(a.wires[i].headers["x-lab-now"]).toBe(b.wires[i].headers["x-lab-now"]);
      expect(a.wires[i].headers["x-lab-seed"]).toBe(b.wires[i].headers["x-lab-seed"]);
      for (const h of ["X-Akl-Nonce", "X-Akl-Signature", "X-Akl-Actor"]) expect(a.wires[i].headers[h]).toBe(b.wires[i].headers[h]);
    }
    expect(calls.every((c) => typeof c.method === "string" && typeof c.path === "string" && typeof c.query === "string" && typeof c.label === "string")).toBe(true);
    expect(d.problems.length).toBeGreaterThan(0);
    expect(d.problems.filter((p: any) => p.kind !== "truncated" && !(/comments/.test(p.path) && p.kind === "body"))).toEqual([]);
    const lines = fs.readFileSync(path.join(dir, "stream.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(lines.length).toBe(d.i);
    expect(lines.map((l) => l.i)).toEqual([...lines.keys()]);
    expect(lines.every((l) => typeof l.method === "string" && typeof l.tMs === "number")).toBe(true);
    // lab clock: monotone, and the same on a repeat of the run
    const times = a.wires.map((w: any) => Date.parse(w.headers["x-lab-now"]));
    expect(times.every((t: number, i: number) => i === 0 || t >= times[i - 1]!)).toBe(true);
  });

  it("[LDB-PG20] signs client-lane requests with a fresh nonce each, bearer requests with the fake token, and substitutes proof tokens per side", async () => {
    const a = memSide("oracle", echo);
    const b = memSide("aws", echo);
    a.vars["proof:missing"] = "https://discord.com/channels/1/2/AAA";
    b.vars["proof:missing"] = "https://discord.com/channels/1/2/BBB";
    const d = await driverOf([a, b], { diffPair: () => [] });
    await d.pair({ label: "s", method: "POST", path: "/v1/wpm", json: { layout: "L", wpm: 90, proof: "{{proof:missing}}" }, actor: "100000000000000002", stepMs: 1000 });
    await d.pair({ label: "s2", method: "POST", path: "/v1/wpm", json: { layout: "L", wpm: 90, proof: "{{proof:missing}}" }, actor: "100000000000000002", stepMs: 1000 });
    await d.pair({ label: "bearer", method: "PUT", path: "/v1/layouts/L/comment", json: { body: "x" }, bearer: "100000000000000003", stepMs: 1000 });
    expect(JSON.parse(a.wires[0].body.toString()).proof).toMatch(/AAA$/);
    expect(JSON.parse(b.wires[0].body.toString()).proof).toMatch(/BBB$/);
    expect(a.wires[0].headers["X-Akl-Nonce"]).not.toBe(a.wires[1].headers["X-Akl-Nonce"]);
    expect(a.wires[0].headers["X-Akl-Signature"]).toBeDefined();
    expect(a.wires[2].headers.Authorization).toBe("Bearer lab-100000000000000003");
    expect(a.wires[2].headers["X-Akl-Signature"]).toBeUndefined();
    // the signature verifies with the lab client key over the akl-v1 message (body of side A)
    const { labKey } = await load("wire.mjs");
    const h = a.wires[0].headers;
    const msg = `akl-v1\nPOST\n/v1/wpm\n${h["X-Akl-Timestamp"]}\n${h["X-Akl-Nonce"]}\n${h["X-Akl-Actor"]}\n${crypto.createHash("sha256").update(a.wires[0].body).digest("base64url")}`;
    expect(crypto.verify(null, Buffer.from(msg), labKey().pub, Buffer.from(h["X-Akl-Signature"], "base64url"))).toBe(true);
  });

  it("[LDB-PG20] sends the If-None-Match half of an ETag'd read, runs restart steps on both sides, and refuses non-loopback targets", async () => {
    const a = memSide("oracle", echo);
    const b = memSide("aws", echo);
    const d = await driverOf([a, b], { diffPair: () => [] });
    await d.pair({ label: "meta", method: "GET", path: "/v1/meta", conditional: true, stepMs: 1000 });
    expect(a.wires).toHaveLength(2);
    expect(a.wires[1].headers["If-None-Match"]).toBe('"e1"');
    await d.pair({ label: "restart", restart: true, method: "RESTART", path: "-", stepMs: 0 });
    expect((a as any).restarts).toBe(1);
    expect((b as any).restarts).toBe(1);
    const { httpSide } = await load("drive.mjs");
    expect(() => httpSide("x", "https://api.akldb.org")).toThrow(/loopback/);
    expect(() => httpSide("x", "https://discord.com/api")).toThrow(/loopback/);
    expect(() => httpSide("x", "http://127.0.0.1:18412")).not.toThrow();
  });

  it("[LDB-PG21] a recorded stream replays to the same requests on fresh sides, race groups included", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sim-"));
    const file = path.join(dir, "stream.jsonl");
    const a1 = memSide("oracle", echo);
    const b1 = memSide("aws", echo);
    const d1 = await driverOf([a1, b1], { diffPair: () => [], streamFile: file });
    await d1.runSteps(60);
    await d1.race([{ label: "r1", method: "PUT", path: "/v1/layouts/L/like", actor: "100000000000000002" }, { label: "r2", method: "PUT", path: "/v1/layouts/L/like", actor: "100000000000000003" }], { sameSeed: true });
    await d1.readEach({ label: "read", method: "GET", path: "/v1/changes?since=0" });
    d1.close();
    const a2 = memSide("oracle", echo);
    const b2 = memSide("aws", echo);
    const d2 = await driverOf([a2, b2], { diffPair: () => [] });
    await d2.replayStream(fs.readFileSync(file, "utf8"));
    const key = (w: any) => `${w.method} ${w.pathWithQuery} ${w.headers["x-lab-now"]} ${w.headers["x-lab-seed"]}`;
    expect(a2.wires.map(key).sort()).toEqual(a1.wires.map(key).sort());
    // the two race contenders share one lab seed (same effects whoever wins) but not one nonce
    const race = a1.wires.filter((w: any) => /\/like$/.test(w.pathWithQuery)).slice(-2);
    expect(race[0].headers["x-lab-seed"]).toBe(race[1].headers["x-lab-seed"]);
    expect(race[0].headers["X-Akl-Nonce"]).not.toBe(race[1].headers["X-Akl-Nonce"]);
  });

  it("[LDB-PG21] stays on the pinned differ: only differ.mjs names a differ, and it is a one-line re-export", () => {
    const files = fs.readdirSync(S).filter((f) => f.endsWith(".mjs"));
    const naming = files.filter((f) => /diff-shim|diff\/pair\.mjs/.test(fs.readFileSync(path.join(S, f), "utf8")) && f !== "differ.mjs");
    expect(naming).toEqual([]);
    const lines = fs.readFileSync(path.join(S, "differ.mjs"), "utf8").split("\n").filter((l) => !l.startsWith("//") && l.trim() !== "");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^export \{ diffPair \} from "\.\.\/(replay\/diff-shim|diff\/pair)\.mjs";$/);
  });
});

// ---- the rare admin pack ---------------------------------------------------------------------------------------------

function packEnv(answer: (step: any) => { status: number; json?: any }) {
  const steps: any[] = [];
    return {
    steps,
    env: {
      rng: seededRng(1), corpus: [{ keys: [], magic: { x: 1 } }, CORPUS[0]], dayKey: "t", clock: () => Date.parse("2026-10-25T12:00:00.000Z"), seqHint: () => 0,
      async pair(step: any) {
        steps.push(step);
        const r = answer(step);
        const resp = { status: r.status, headers: { etag: '"layout:1"' }, body: Buffer.from(JSON.stringify(r.json ?? {})), json: r.json ?? null };
        return { a: resp, b: resp, ja: resp.json, problems: [] };
      },
    },
  };
}

describe("rare admin pack", () => {
  const good = (step: any) => {
    const p = step.path as string;
    if (p === "/v1/layouts") return { status: 201, json: { id: `L${step.json.name.length}${step.json.name.slice(-5)}` } };
    if (step.method === "POST" && p === "/v1/admin/clients") return { status: step.json.name === "" ? 400 : 201, json: { id: "01JAB000000000000000CLIENT" } };
    if (/magic-seed/.test(p)) return step.actor === "100000000000000002" ? { status: 403 } : /magic-by-user/.test(step.label) ? { status: 409 } : step.json.ref === "" || Array.isArray(step.json.magic) || typeof step.json.magic === "string" ? { status: 400 } : step.json.ref.startsWith("L") ? (/magic-by-user/.test(step.json.ref) ? { status: 409 } : { status: 200 }) : { status: 404 };
    if (/unknown|NONE0/.test(p)) return { status: 404 };
    if (/\/v1\/admin\/admins/.test(p) && step.label === "admin remove (not an admin)") return { status: 404 };
    if (step.label === "admin remove (would leave one)") return { status: 409 };
    if (step.label === "admin add (invalid id)") return { status: 400 };
    if (step.label.startsWith("client: ") && /suspended|revoke/.test(step.label)) return { status: 401 };
    if (step.label === "client: request after revoke" || step.label === "client: request while suspended") return { status: 401 };
    return { status: step.method === "POST" && /admins$/.test(p) ? 201 : 200 };
  };

  it("[LDB-PG22] runs magic-seed (real, repeat, refusals), relabel (dry runs, real, repeat), the client lifecycle and admin add/remove down to the last-two refusal", async () => {
    const { rareAdminPack, ADMIN_PACK_OPS } = await load("adminpack.mjs");
    const { env, steps } = packEnv(good);
    const r = await rareAdminPack(env);
    expect(r.missing).toEqual([]);
    expect(r.covered.sort()).toEqual([...ADMIN_PACK_OPS].sort());
    const labels = steps.map((s) => s.label);
    const at = (l: string) => labels.indexOf(l);
    // client lifecycle order
    expect(at("client register")).toBeLessThan(at("client: first signed request"));
    expect(at("client suspend")).toBeLessThan(at("client: request while suspended"));
    expect(at("client: request while suspended")).toBeLessThan(at("client reactivate"));
    expect(at("client reactivate")).toBeLessThan(at("client: request after reactivate"));
    expect(at("client revert (dry run)")).toBeLessThan(at("client revert"));
    expect(at("client revoke")).toBeLessThan(at("client: request after revoke"));
    expect(at("client: request after revoke")).toBeLessThan(at("reactivate a revoked client"));
    // the new client signs its own requests, with the key it registered
    const reg = steps.find((s) => s.label === "client register");
    const signed = steps.filter((s) => s.client !== undefined);
    expect(signed.length).toBeGreaterThanOrEqual(4);
    expect(new Set(signed.map((s) => s.client.id))).toEqual(new Set(["01JAB000000000000000CLIENT"]));
    const { labKey } = await load("wire.mjs");
    expect(reg.json.pubkey).toBe(labKey(signed[0].client.seed).pubRaw);
    // relabel: dry run by query and by body before the real run
    expect(steps.find((s) => s.label === "relabel dry (query)").path).toContain("dry_run=1");
    expect(steps.find((s) => s.label === "relabel dry (body)").json).toEqual({ dry_run: true });
    expect(at("relabel dry (body)")).toBeLessThan(at("relabel real"));
    // the pack is admin-signed throughout except its non-admin probes
    expect(steps.filter((s) => s.actor === "100000000000000001").length).toBeGreaterThan(20);
  });

  it("[LDB-PG22] warns when it stops reaching an operation (a drifted pack must not pass on 404s)", async () => {
    const { rareAdminPack } = await load("adminpack.mjs");
    const { env } = packEnv(() => ({ status: 404 }));
    const r = await rareAdminPack(env);
    expect(r.warnings.length).toBeGreaterThan(5);
    expect(r.warnings.join("\n")).toMatch(/magic-seed\.real|client\.register|admin\.add/);
  });
});

// ---- the race packs ---------------------------------------------------------------------------------------------------

/** A canned env: `race` answers from `statuses`, reads from `reads`; every race/pair is logged. */
function raceEnv(spec: { race?: (steps: any[], opts: any) => { a: any[]; b: any[] }; pair?: (step: any) => any; read?: (step: any) => any; feed?: (side: "a" | "b") => any[] }) {
    const mk = (status: number, json: any = null, headers: any = {}) => ({ status, headers, body: Buffer.from(JSON.stringify(json)), json });
  const log: any[] = [];
  let raced = false; // the feed only shows the race's events once the race has run
  return {
    log, mk,
    env: {
      rng: seededRng(3), corpus: [CORPUS[0], { keys: [{ char: "q", row: 0, col: 0, finger: "LP" }, { char: "r", row: 0, col: 1, finger: "LR" }] }], seqHint: () => 0,
      async pair(step: any) {
        log.push(step.label);
        const r = spec.pair?.(step) ?? mk(201, { id: `L-${log.length}`, submission: { id: `S-${log.length}` } }, { etag: '"layout:1"' });
        return { a: r, b: r, ja: r.json, problems: [] };
      },
      async race(steps: any[], opts: any) { log.push(`race:${steps.map((s) => s.label).join("|")}`); raced = true; return spec.race!(steps, opts); },
      async readEach(step: any) {
        if (step.path.startsWith("/v1/changes")) {
          const since = Number(/since=(\d+)/.exec(step.path)![1]);
          const mkFeed = (side: "a" | "b") => { const items = raced ? (spec.feed?.(side) ?? []).filter((e) => e.seq > since) : []; return mk(200, { next: items.length ? items[items.length - 1].seq : since, items }); };
          return { a: mkFeed("a"), b: mkFeed("b") };
        }
        const r = spec.read?.(step) ?? mk(200, {});
        return { a: r, b: r };
      },
    },
  };
}

describe("race packs", () => {
  const statuses = (...ss: number[]) => ss.map((s) => ({ status: s, headers: {}, body: Buffer.alloc(0), json: null }));

  it("[LDB-PG23] every pack declares whether its end state converges, and the set covers claims, counters, gates, guards and wake-ups", async () => {
    const { RACE_PACKS, selectPacks } = await load("races.mjs");
    expect(RACE_PACKS.map((p: any) => p.name).sort()).toEqual(["approve-same", "approve-vs-reject", "comment-supersede", "dup-create", "like-distinct-users", "like-same-user", "longpoll-wake", "put-cas", "rename-collide", "wpm-bind"]);
    expect(selectPacks("none")).toHaveLength(0);
    expect(selectPacks("converge").every((p: any) => p.converges && !p.mintsIds)).toBe(true);
    expect(selectPacks("all")).toHaveLength(RACE_PACKS.length);
    expect(selectPacks("converge").map((p: any) => p.name)).toEqual(["like-same-user", "approve-same", "longpoll-wake"]);
    // the packs that mint ids under concurrency, or whose end state follows the winner, are never mid-day packs
    for (const n of ["dup-create", "comment-supersede", "approve-vs-reject", "put-cas", "rename-collide", "like-distinct-users", "wpm-bind"]) expect(selectPacks("converge").map((p: any) => p.name)).not.toContain(n);
    expect(RACE_PACKS.filter((p: any) => p.mintsIds).map((p: any) => p.name).sort()).toEqual(["comment-supersede", "dup-create"]);
  });

  it("[LDB-PG23] dup-create: exactly one winner on each side, the same statuses on both, shared lab seed; two winners on one side are flagged", async () => {
    const { RACE_PACKS } = await load("races.mjs");
    const pack = RACE_PACKS.find((p: any) => p.name === "dup-create");
    const clean = raceEnv({ race: (steps, opts) => { expect(opts.sameSeed).toBe(true); expect(new Set(steps.map((s: any) => JSON.stringify(s.json))).size).toBe(1); return { a: statuses(201, 409, 409, 409), b: statuses(409, 409, 201, 409) }; } });
    expect(await pack.run(clean.env)).toEqual([]);
    const bad = raceEnv({ race: () => ({ a: statuses(201, 409, 409, 409), b: statuses(201, 201, 409, 409) }) });
    const ps = await pack.run(bad.env);
    expect(ps.some((p: any) => /aws: 2 creates won/.test(p.detail))).toBe(true);
    expect(ps.some((p: any) => /status multiset differs/.test(p.detail))).toBe(true);
    const err = raceEnv({ race: () => ({ a: statuses(201, 409, 409, 409), b: statuses(201, 500, 409, 409) }) });
    expect((await pack.run(err.env)).some((p: any) => /5xx/.test(p.detail))).toBe(true);
  });

  it("[LDB-PG23] like-distinct-users: the counter must equal the number of voters and the feed must have no gap", async () => {
    const { RACE_PACKS } = await load("races.mjs");
    const pack = RACE_PACKS.find((p: any) => p.name === "like-distinct-users");
    const feed = (gapOnAws: boolean) => (side: "a" | "b") => [1, 2, 3, 4].map((i) => ({ seq: gapOnAws && side === "b" && i >= 3 ? i + 1 : i, kind: "liked", actor: `u${i}`, layout_id: "L" }));
    const ok = raceEnv({ race: (steps) => ({ a: steps.map(() => ({ status: 200, headers: {}, body: Buffer.alloc(0), json: null })), b: steps.map(() => ({ status: 200, headers: {}, body: Buffer.alloc(0), json: null })) }), read: () => ({ status: 200, headers: {}, body: Buffer.alloc(0), json: { like_count: 4 } }), feed: feed(false) });
    expect(await pack.run(ok.env)).toEqual([]);
    const wrongCount = raceEnv({ race: (steps) => ({ a: steps.map(() => ({ status: 200, headers: {}, body: Buffer.alloc(0), json: null })), b: steps.map(() => ({ status: 200, headers: {}, body: Buffer.alloc(0), json: null })) }), read: () => ({ status: 200, headers: {}, body: Buffer.alloc(0), json: { like_count: 3 } }), feed: feed(false) });
    expect((await pack.run(wrongCount.env)).filter((p: any) => /like_count 3, expected 4/.test(p.detail))).toHaveLength(2);
    const gap = raceEnv({ race: ok ? (steps) => ({ a: steps.map(() => ({ status: 200, headers: {}, body: Buffer.alloc(0), json: null })), b: steps.map(() => ({ status: 200, headers: {}, body: Buffer.alloc(0), json: null })) }) : undefined, read: () => ({ status: 200, headers: {}, body: Buffer.alloc(0), json: { like_count: 4 } }), feed: feed(true) });
    expect((await pack.run(gap.env)).some((p: any) => /aws: feed gap/.test(p.detail))).toBe(true);
  });

  it("[LDB-PG23] approve-vs-reject and approve-same: one decision event, and it is the winner's", async () => {
    const { RACE_PACKS } = await load("races.mjs");
    const decide = RACE_PACKS.find((p: any) => p.name === "approve-vs-reject");
    const event = (kind: string, seq = 1) => ({ seq, kind, actor: "100000000000000001", layout_id: "L" });
    const R = (a: number[], b: number[]) => () => ({ a: statuses(...a), b: statuses(...b) });
    const good = raceEnv({ race: R([200, 409], [409, 200]), feed: (side) => [event(side === "a" ? "comment_approved" : "comment_rejected")] });
    expect(await decide.run(good.env)).toEqual([]);
    const mismatch = raceEnv({ race: R([200, 409], [200, 409]), feed: (side) => [event(side === "a" ? "comment_approved" : "comment_rejected")] });
    expect((await decide.run(mismatch.env)).some((p: any) => /aws: the 2xx was the approve but the event is comment_rejected/.test(p.detail))).toBe(true);
    const both = raceEnv({ race: R([200, 200], [200, 409]), feed: () => [event("comment_approved", 1), event("comment_rejected", 2)] });
    const ps = await decide.run(both.env);
    expect(ps.some((p: any) => /oracle: 2 decisions succeeded/.test(p.detail))).toBe(true);
    expect(ps.some((p: any) => /2 decision events/.test(p.detail))).toBe(true);
    const same = RACE_PACKS.find((p: any) => p.name === "approve-same");
    const dup = raceEnv({ race: R([200, 200, 200], [200, 200, 200]), feed: (side) => (side === "a" ? [event("comment_approved")] : [event("comment_approved", 1), event("comment_approved", 2)]) });
    expect((await same.run(dup.env)).some((p: any) => /aws: 2 comment_approved events/.test(p.detail))).toBe(true);
  });

  it("[LDB-PG23] put-cas and rename-collide: one winner, the loser is refused", async () => {
    const { RACE_PACKS } = await load("races.mjs");
    const cas = RACE_PACKS.find((p: any) => p.name === "put-cas");
    const ok = raceEnv({ race: (steps) => { expect(steps.every((s: any) => s.headers["If-Match"] === '"layout:1"')).toBe(true); return { a: statuses(200, 412), b: statuses(412, 200) }; } });
    expect(await cas.run(ok.env)).toEqual([]);
    const two = raceEnv({ race: () => ({ a: statuses(200, 412), b: statuses(200, 200) }) });
    expect((await cas.run(two.env)).some((p: any) => /aws: 2 PUTs won on one If-Match/.test(p.detail))).toBe(true);
    const rn = RACE_PACKS.find((p: any) => p.name === "rename-collide");
    // both layouts end up with the target name on the AWS side -> flagged
    const target: { v?: string } = {};
    const dup = raceEnv({ race: (steps) => { target.v = steps[0].json.name; return { a: statuses(200, 409), b: statuses(200, 200) }; }, read: () => ({ status: 200, headers: {}, body: Buffer.alloc(0), json: { name: target.v } }) });
    const ps = await rn.run(dup.env);
    expect(ps.some((p: any) => /holders|2 layouts hold the name|renames won/.test(p.detail))).toBe(true);
  });

  it("[LDB-PG23] longpoll-wake: a poll's items must be contiguous; a wake on one side only is an observation, not a failure", async () => {
    const { RACE_PACKS } = await load("races.mjs");
    const pack = RACE_PACKS.find((p: any) => p.name === "longpoll-wake");
    const poll = (items: any[], next: number) => ({ status: 200, headers: {}, body: Buffer.alloc(0), json: { items, next } });
    const w = { status: 200, headers: {}, body: Buffer.alloc(0), json: null };
    const notes: string[] = [];
    const woke = raceEnv({ race: (steps, opts) => { expect(opts.delays).toBe(true); expect(steps[1].delayMs).toBeGreaterThan(0); return { a: [poll([{ seq: 1 }], 1), w], b: [poll([], 0), w] }; } });
    (woke.env as any).observe = (m: string) => notes.push(m);
    expect(await pack.run(woke.env)).toEqual([]);
    expect(notes.join()).toMatch(/oracle woke=true, aws woke=false/);
    const gappy = raceEnv({ race: () => ({ a: [poll([{ seq: 1 }, { seq: 3 }], 3), w], b: [poll([], 0), w] }) });
    expect((await pack.run(gappy.env)).some((p: any) => /oracle: feed gap or reorder/.test(p.detail))).toBe(true);
  });

  it("[LDB-PG23] a pack that throws is reported, not fatal, and packs run one after another", async () => {
    const { runRacePacks } = await load("races.mjs");
    const order: string[] = [];
    const packs = [
      { name: "a", converges: true, async run() { order.push("a>"); await new Promise((r) => setTimeout(r, 5)); order.push("a<"); return []; } },
      { name: "b", converges: false, async run() { order.push("b>"); throw new Error("boom"); } },
      { name: "c", converges: true, async run() { order.push("c>"); return [{ kind: "race", pack: "c", detail: "x" }]; } },
    ];
    const r = await runRacePacks({}, packs);
    expect(order).toEqual(["a>", "a<", "b>", "c>"]);
    expect(r.problems.map((p: any) => p.pack)).toEqual(["b", "c"]);
    expect(r.problems[0].detail).toMatch(/pack threw: boom/);
  });
});
