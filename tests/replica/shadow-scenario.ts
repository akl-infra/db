// A seeded random scenario through production's REAL write path (the verbs of src/core/write.ts, appendLike and
// appendLinkChange, and the import lane's commitWrite), against the harness replica. Used by the shadow tests to produce
// "production" histories whose public feed the follower must reproduce. The op set follows tests/events/fold.test.ts (the
// shared write model): both scopes, two stored lineages (spark and the test-only t/1), upstream forks, tombstones, likes and
// links. State-table writes (authors, a ban with its event) are added so stale-state tracking has something to track.
import { env, store, testStore } from "../harness";
import type { Actor } from "../../src/auth/actor";
import type { Bindings } from "../../src/env";
import { appendAdmin, appendLike, appendLinkChange, commitWrite, type CommitInput } from "../../src/core/events";
import type { IfMatch, IfNoneMatch } from "../../src/core/ifmatch";
import { formatsForLayout, readById, type Upstream } from "../../src/core/records";
import { steppingClock } from "../../src/core/time";
import { nextUpstream } from "../../src/core/upstream";
import { createLayout, deleteLayout, patchFormat, putFormat, renameLayout, restoreLayout, transferLayout } from "../../src/core/write";
import { ulid } from "ulidx";

const bindings = env as unknown as Bindings;
export const OWNER_A = "800000000000000101";
export const OWNER_B = "800000000000000102";
const USER_SOURCE = { client: "discord-app:test", version: null };
const IMPORT_SOURCE = { client: "system:cmini-import", version: null };
const STAR: IfMatch = { kind: "any" };
const ABSENT: IfMatch = { kind: "absent" };
const ADD: IfNoneMatch = { kind: "any" };
const NO_INM: IfNoneMatch = { kind: "absent" };
const SPARK = { keys: [{ char: "a", row: 0, col: 0, finger: "LP" as const }] };

const actorFor = (userId: string): Actor => ({ user_id: userId, name: `user-${userId}`, via: "discord", admin: false, banned: false, source_client: "discord-app:test" });

interface Slot {
  id: string;
  owner: string;
  deleted: boolean;
  hasT: boolean;
  following: boolean;
  likedBy: Set<string>;
}

export function rng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 0x100000000;
  };
}

export interface Scenario {
  clock: () => string;
  /** n random ops through the real write path. */
  run(n: number): Promise<void>;
  /** A state-table change with its event: a ban row, an author row, nothing the feed could rebuild. */
  stateChange(tag: string): Promise<void>;
  slots: Slot[];
  kindsSeen: Set<string>;
}

export async function scenario(seed: number, startIso = "2026-11-02T00:00:00.000Z"): Promise<Scenario> {
  const rand = rng(seed);
  const clock = steppingClock(startIso, 1000);
  const slots: Slot[] = [];
  let uniq = 0;
  const unique = (): string => `s${seed}-${uniq++}`;
  const now = clock();
  for (const [user_id, name] of [[OWNER_A, "owner-a"], [OWNER_B, "owner-b"]] as const) {
    if ((await testStore.count("authors", { user_id })) === 0) await testStore.insert("authors", { user_id, name, first_seen_at: now, last_seen_at: now });
  }
  const kindsSeen = new Set<string>();

  async function createUser(): Promise<void> {
    const r = await createLayout(bindings, clock, actorFor(OWNER_A), { name: `n-${unique()}`, format: "spark/1", payload: SPARK }, null);
    slots.push({ id: r.layout.id, owner: OWNER_A, deleted: false, hasT: false, following: false, likedBy: new Set() });
  }
  async function createImport(): Promise<void> {
    const at = clock();
    const upstream: Upstream = { source: "cmini", id: `up-${unique()}`, state: "following" };
    const input: CommitInput = {
      layoutId: ulid(), creating: true, currentN: 0, currentLayout: null, currentFormats: new Map(),
      layout: { kind: "imported", name: `n-${unique()}`, owner: OWNER_A, created_at: at, deleted: false },
      format: { kind: "imported", lineage: "spark", format: "spark/1", payload: SPARK, hasMagic: false },
      modified_at: at, actor: "system:cmini-import", via: "import:cmini", source: IMPORT_SOURCE, upstream,
    };
    const r = await commitWrite(store, clock, input);
    slots.push({ id: r.layout.id, owner: OWNER_A, deleted: false, hasT: false, following: true, likedBy: new Set() });
  }

  async function one(): Promise<void> {
    const live = slots.filter((s) => !s.deleted);
    const pick = <T,>(xs: T[]): T => xs[Math.floor(rand() * xs.length)]!;
    const r = rand();
    if (live.length === 0 && slots.length === 0 || r < 0.12) return rand() < 0.5 ? createUser() : createImport();
    const dead = slots.filter((s) => s.deleted);
    if (dead.length > 0 && r < 0.2) {
      const s = pick(dead);
      await restoreLayout(bindings, clock, actorFor(s.owner), s.id, {}, null);
      s.deleted = false;
      return;
    }
    if (live.length === 0) return createUser();
    const s = pick(live);
    const roll = rand();
    if (roll < 0.1) {
      if (s.hasT) await putFormat(bindings, clock, actorFor(s.owner), s.id, { format: "t/1", payload: { a: uniq++ } }, STAR, NO_INM, null);
      else {
        await putFormat(bindings, clock, actorFor(s.owner), s.id, { format: "t/1", payload: { a: uniq++ } }, ABSENT, ADD, null);
        s.hasT = true;
      }
    } else if (roll < 0.22) {
      await putFormat(bindings, clock, actorFor(s.owner), s.id, { format: "spark/1", payload: { ...SPARK, magic: { rules: [{ inputs: "zz", output: unique() }] } } }, STAR, NO_INM, null);
    } else if (roll < 0.3) {
      const finger = (["LP", "LR", "LM", "LI"] as const)[uniq++ % 4]!;
      await patchFormat(bindings, clock, actorFor(s.owner), s.id, "spark/1", { fingermap: { a: finger } }, STAR, null);
    } else if (roll < 0.4) {
      await renameLayout(bindings, clock, actorFor(s.owner), s.id, `n-${unique()}`, STAR, null);
    } else if (roll < 0.46) {
      const to = s.owner === OWNER_A ? OWNER_B : OWNER_A;
      await transferLayout(bindings, clock, actorFor(s.owner), s.id, { to }, STAR, null);
      s.owner = to;
    } else if (roll < 0.52) {
      await deleteLayout(bindings, clock, actorFor(s.owner), s.id, STAR, null);
      s.deleted = true;
    } else if (roll < 0.74) {
      const userId = `u${Math.floor(rand() * 5)}`;
      const kind = s.likedBy.has(userId) ? "unliked" : "liked";
      await appendLike(store, clock, { kind, layoutId: s.id, userId, via: "discord", source: USER_SOURCE });
      if (kind === "liked") s.likedBy.add(userId);
      else s.likedBy.delete(userId);
    } else if (roll < 0.82) {
      const link = rand() < 0.3 ? null : `https://example.org/${unique()}`;
      await appendLinkChange(store, clock, { layoutId: s.id, kind: link === null ? "link_cleared" : "link_approved", link, actor: "moderator", via: "discord", admin: true, source: USER_SOURCE });
    } else if (s.following && roll < 0.95) {
      const current = (await readById(store, s.id))!;
      const currentFormats = await formatsForLayout(store, s.id);
      const upstream = nextUpstream(current.upstream, "import:cmini", true);
      const layoutPart = { kind: "imported" as const, name: `n-${unique()}`, owner: current.owner, created_at: current.created_at, deleted: false };
      const formatPart = { kind: "imported" as const, lineage: "spark", format: "spark/1", payload: { ...SPARK, magic: { rules: [{ inputs: "zz", output: unique() }] } }, hasMagic: false };
      const base = { layoutId: s.id, creating: false, currentN: current.n, currentLayout: current, currentFormats, modified_at: clock(), actor: "system:cmini-import", via: "import:cmini", source: IMPORT_SOURCE, upstream };
      const which = rand();
      const input: CommitInput = which < 0.3 ? { ...base, layout: layoutPart } : which < 0.6 ? { ...base, format: formatPart } : which < 0.85 ? { ...base, layout: layoutPart, format: formatPart } : { ...base, layout: { kind: "upstream_deleted", name: current.name, owner: current.owner, created_at: current.created_at, deleted: true } };
      const out = await commitWrite(store, clock, input);
      if (out.layout.deleted) s.deleted = true;
    } else {
      await renameLayout(bindings, clock, actorFor(s.owner), s.id, `n-${unique()}`, STAR, null);
    }
  }

  return {
    clock,
    slots,
    kindsSeen,
    async run(n) {
      for (let i = 0; i < n; i++) await one();
    },
    async stateChange(tag) {
      const at = clock();
      await testStore.insert("bans", { user_id: `banned-${tag}`, by: "moderator", at, reason: "scenario" });
      await appendAdmin(store, clock, { kind: "admin.user_banned", actor: "moderator", via: "discord", detail: { user_id: `banned-${tag}` } });
      await testStore.insert("authors", { user_id: `author-${tag}`, name: `Author ${tag}`, first_seen_at: at, last_seen_at: at });
    },
  };
}
