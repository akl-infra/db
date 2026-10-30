// Lane Q: the organic simulator's request generator (design/aws-port.md §5.1, "Simulated, organic").
//
// A subclass of the fuzzer's `Generator` (scripts/lab/fuzz/generator.mjs): the step shapes and the feedback model
// (`observe`) are the fuzzer's; what changes is the mix (production's measured shape, mix.mjs, with knobs), the client
// shapes (Spark, akl.gg, mana2, admins), the generated submit bodies (bodies.mjs), Discord interactions
// (interactions.mjs), the adversarial inputs and the forced cold containers.
//
// `next()` returns a step (wire.mjs documents the shape). A family may queue follow-up steps (a retry with the same
// Idempotency-Key, receipt polls 30 s later, the second half of a tombstone reclaim): queue items are steps or
// functions returning a step (or null) so they can read what the oracle answered by then.
import { Generator, ADMIN_ID, USER_IDS } from "../fuzz/generator.mjs";
import { bindBody, commentBody, linkBody, wpmBody } from "./bodies.mjs";
import { cardsFromMessages, interactionSpec, scenarioSteps, variantsFor } from "./interactions.mjs";
import { SUBRESOURCE_SHARES, WRITE_SHARES, familyWeights } from "./mix.mjs";

export { ADMIN_ID, USER_IDS, cardsFromMessages };

const NAME_PAIRS = [
  ["Colemak-DH", "colemak-dh"], ["Ünï", "ünï"], ["İstanbul", "i̇stanbul"], ["ǅ-title", "ǆ-title"], ["STRASSE", "straße"],
  ["é-nfd", "é-nfc"], ["𝕜𝕖𝕪", "𝕂𝔼𝕐"], ["ß", "SS"], ["ﬁnger", "FINGER"],
];
const WEIRD_NAMES = ["🧑‍💻-zwj", "𝔞𝔟𝔠-astral", "‮rtl-override", "zero​width", "tab\tname", "new\nline", "nul\u0000byte", "a".repeat(64), "a".repeat(65), "..", ".", "a/b", "q?x=1", "100%", "hash#tag", "  lead", "trail  "];
const SORTS = ["name", "modified_at", "created_at", "like_count"];
const FILTERS = ["", "has_magic=true", "has_magic=false", "has_alts=true", "has_combos=true", "full=1", "format=mana2%2F1", "format=mana2%2F1&full=1", "since=2026-10-25T12:00:00.000Z", "has_magic=maybe", "limit=0", "limit=-1", "limit=1000000"];
const BAD_REFS = ["..%2f..%2fetc", "%00", "%E0%A4%A", "a%252Fb", "01JAB0000000000000000NONE0", "x".repeat(300), "%F0%9F%A7%91", "%C3%9Cn%C3%AF"];

export class SimGenerator extends Generator {
  /**
   * @param {{seed:number, corpus:object[], knobs?:object, interaction?:object, restartEvery?:number}} o
   *   `interaction` = defaultInteractionConfig(...): without it no Discord interaction steps are generated.
   */
  constructor(o) {
    super({ seed: o.seed, corpus: o.corpus, restartEvery: o.restartEvery ?? Infinity });
    this.knobs = o.knobs ?? {};
    this.weights = Object.entries(familyWeights(this.knobs)).filter(([, w]) => w > 0).map(([name, w]) => [w, name]);
    this.interaction = o.interaction ?? null;
    this.cards = [];
    this.n = 0;
    this.sweep = 0; // walks every sort x filter combination
    this.interactionN = 0;
    this.idemN = 0;
    this.linkN = 0;
    this.bindMemo = new Map();
    this.families = {}; // family -> count, for the report
  }

  /**
   * The parent's reference picker (mostly an existing layout, sometimes by name or an invented ref), except that a name which
   * cannot be percent-encoded (a lone surrogate the server echoed back) falls back to the layout id instead of throwing.
   */
  layoutRef(opts = {}) {
    const rng = this.rng;
    const live = [...this.layouts.values()].filter((l) => (opts.deleted === undefined ? true : l.deleted === opts.deleted));
    if (live.length === 0 || rng.chance(0.06)) return { id: rng.pick(["no-such-layout", "01JAB0000000000000000NONE0", "x"]), l: null, byName: false };
    const l = rng.pick(live);
    if (rng.chance(0.2) && !l.deleted && typeof l.name === "string") {
      try {
        return { id: encodeURIComponent(rng.chance(0.5) ? l.name.toUpperCase() : l.name), l, byName: true };
      } catch {
        // a lone surrogate: not encodable, use the id
      }
    }
    return { id: l.id, l, byName: false };
  }

  /** Targets of bans, renames and transfers: never the admin (the admin signs the pack and the queue steps) and, for ids, only the sim's typists. */
  anyUser() {
    return this.rng.weighted([[8, this.rng.pick(USER_IDS)], [1, "199999999999999999"], [1, "not-a-snowflake"]]);
  }

  /** The fuzzer's feedback model keys on its own labels; ours carry a "(kind)" suffix and lower-case verbs. */
  observe(step, res) {
    const base = typeof step.label === "string" ? step.label.replace(/ \([^)]*\)$/, "") : step.label;
    super.observe({ ...step, label: base === "link put" ? "link PUT" : base }, res);
  }

  /** The driver passes what the fake Discord currently shows: `cardsFromMessages(await messages())`. */
  setCards(cards) {
    this.cards = cards;
  }

  next() {
    this.n++;
    while (this.queue.length > 0) {
      const item = this.queue.shift();
      const step = typeof item === "function" ? item() : item;
      if (step === null || step === undefined) continue;
      return this.finish(step, "queued");
    }
    const family = this.rng.weighted(this.weights.map(([w, name]) => [w, name]));
    const step = this[`fam_${family}`]();
    return this.finish(step, family);
  }

  finish(step, family) {
    this.families[family] = (this.families[family] ?? 0) + 1;
    step.family ??= family;
    step.stepMs ??= this.rng.chance(0.7) ? 1000 : this.rng.pick([0, 60_000, 3_600_000]);
    return step;
  }

  // ---- read families (production's shape) ---------------------------------------------------------------------

  /** Spark's signed client lane: a long-poll with wait=, resuming at the last seq it saw. */
  fam_changes() {
    const rng = this.rng;
    const u = this.user();
    const since = rng.weighted([[8, this.lastSeq], [1, 0], [1, Math.max(0, this.lastSeq - rng.int(1, 30))]]);
    const wait = rng.weighted([[8, rng.pick([25, 30, 55])], [1, 0], [1, 1]]);
    const parts = [`since=${since}`, "limit=100"];
    if (wait > 0) parts.push(`wait=${wait}`);
    if (rng.chance(0.15)) parts.push(`kinds=${encodeURIComponent(rng.pick(["created", "liked,unliked", "link_approved", "wpm_approved", "comment_approved"]))}`);
    return { label: "changes (spark long-poll)", method: "GET", path: `/v1/changes?${parts.join("&")}`, actor: u, user: u, observe: "changes", conditional: wait === 0, stepMs: 1000 };
  }

  /** Spark sends a conditional /v1/meta per command. */
  fam_meta() {
    return { label: "meta", method: "GET", path: "/v1/meta", conditional: true, stepMs: this.rng.pick([200, 1000, 5000]) };
  }

  fam_subresources() {
    const rng = this.rng;
    const r = this.layoutRef();
    const kind = rng.weighted(Object.entries(SUBRESOURCE_SHARES).map(([k, w]) => [w, k]));
    const viewer = rng.chance(0.3) ? { bearer: this.user() } : {}; // the akl.gg proxy forwards a viewer sometimes
    switch (kind) {
      case "comments": return { label: "comments (akl.gg)", method: "GET", path: `/v1/layouts/${r.id}/comments${rng.chance(0.2) ? "?sort=newest" : ""}`, ...viewer, conditional: true };
      case "comment": return { label: "own comment", method: "GET", path: `/v1/layouts/${r.id}/comment`, bearer: this.user(), conditional: true };
      case "likes": return { label: "likes", method: "GET", path: `/v1/layouts/${r.id}/likes`, conditional: true };
      case "history": return { label: "history", method: "GET", path: `/v1/layouts/${r.id}/history`, conditional: true };
      case "rev": return { label: "rev", method: "GET", path: `/v1/layouts/${r.id}/rev/${rng.int(1, 4)}?format=${rng.pick(["spark%2F1", "mana2%2F1"])}`, conditional: true };
      default: return { label: "link read", method: "GET", path: `/v1/layouts/${r.id}/link`, conditional: true };
    }
  }

  /** Single layout GETs; mana2's `format=mana2/1` reads and held (spark-only) layouts included. */
  fam_layoutGet() {
    const rng = this.rng;
    const r = this.layoutRef();
    const fmt = rng.weighted([[6, "spark%2F1"], [2, "mana2%2F1"], [2, ""]]);
    return { label: `layout get${fmt === "mana2%2F1" ? " (mana2)" : ""}`, method: "GET", path: `/v1/layouts/${r.id}${fmt ? `?format=${fmt}` : ""}`, conditional: true };
  }

  /** Lists: akl.gg's `full=1`, mana2's `format=mana2/1&full=1`, Spark's paged lists. */
  fam_list() {
    return this.stepList();
  }

  fam_wpm() {
    const rng = this.rng;
    if (rng.chance(0.25) && this.pending.wpm.length > 0) {
      const u = this.user();
      return { label: "wpm receipt", method: "GET", path: `/v1/wpm/submissions/${rng.pick(this.pending.wpm)}`, actor: u, user: u };
    }
    const r = this.layoutRef();
    return { label: "wpm read", method: "GET", path: rng.pick(["/v1/wpm", `/v1/wpm?layout=${r.id}`, `/v1/wpm?user=${this.user()}`]), conditional: true };
  }

  fam_meAuthors() {
    const rng = this.rng;
    const u = this.user();
    return rng.weighted([
      [3, { label: "me", method: "GET", path: "/v1/me", actor: u, user: u }],
      [3, { label: "authors", method: "GET", path: rng.pick(["/v1/authors", "/v1/authors?by=name", `/v1/authors/${this.anyUser()}`]), conditional: true }],
    ]);
  }

  fam_other() {
    const rng = this.rng;
    return rng.weighted([
      [3, { label: "formats", method: "GET", path: "/v1/formats", conditional: true }],
      [2, { label: "schema", method: "GET", path: rng.pick(["/v1/formats/spark/1/schema.json", "/v1/formats/mana2/1/schema.json"]) }],
      [1, { label: "dump read", method: "GET", path: rng.pick(["/v1/dump/latest.json", "/v1/dump"]), conditional: true }],
      [1, { label: "changelog", method: "GET", path: "/admin/changelog" }],
    ]);
  }

  // ---- writes (prod's ~65/day mix) ---------------------------------------------------------------------------

  fam_write() {
    if (this.layouts.size === 0) return this.stepCreate();
    const kind = this.rng.weighted(Object.entries(WRITE_SHARES).map(([k, w]) => [w, k]));
    switch (kind) {
      case "put": return this.sparkWrite(this.stepPut());
      case "create": return this.sparkWrite(this.stepCreate());
      case "patch": return this.stepPatch();
      case "like": return this.stepLike();
      case "comment": return this.commentWrite();
      case "wpm": return this.wpmWrite();
      case "link": return this.linkWrite();
      default: return this.stepDelete();
    }
  }

  /** Spark's write shape: an Idempotency-Key, and a retry after an unknown outcome that must replay byte-identically. */
  sparkWrite(step) {
    if (!this.rng.chance(0.5)) return step;
    const key = `sim-idem-${this.seedKey()}-${++this.idemN}`;
    step.headers = { ...(step.headers ?? {}), "Idempotency-Key": key };
    step.actor ??= this.user();
    delete step.bearer;
    this.queue.push({ ...step, label: `${step.label} (idem retry)`, stepMs: 1000, observe: undefined });
    return step;
  }

  seedKey() {
    return this.rng.int(0, 0xfffff).toString(16);
  }

  /** akl.gg's lane (bearer): comment PUT/DELETE, comment like/unlike, with generated bodies. */
  commentWrite() {
    const rng = this.rng;
    const r = this.layoutRef({ deleted: false });
    const u = this.user();
    const kind = rng.weighted([[6, "put"], [1, "delete"], [3, "like"], [1, "unlike"]]);
    if (kind === "put") {
      const b = commentBody(rng);
      return { label: `comment put (${b.kind})`, method: "PUT", path: `/v1/layouts/${r.id}/comment`, json: b.json, bearer: u, user: u };
    }
    if (kind === "delete") return { label: "comment delete", method: "DELETE", path: `/v1/layouts/${r.id}/comment`, bearer: u, user: u };
    const author = rng.chance(0.8) ? this.user() : this.anyUser();
    return { label: `comment ${kind}`, method: kind === "like" ? "PUT" : "DELETE", path: `/v1/layouts/${r.id}/comments/${author}/like`, bearer: u, user: u };
  }

  /** Spark's WPM submit, then the 30 s receipt polls; sometimes the discord-message bind (first, same, conflict). */
  wpmWrite() {
    const rng = this.rng;
    const r = this.layoutRef({ deleted: false });
    const u = this.user();
    const onBehalf = rng.chance(0.12);
    const b = wpmBody(rng, { layout: r.id, userId: u, onBehalf });
    const step = onBehalf
      ? { label: `wpm on behalf (${b.kind})`, method: "POST", path: "/v1/admin/wpm", json: b.json, actor: ADMIN_ID, user: ADMIN_ID }
      : { label: `wpm submit (${b.kind})`, method: "POST", path: "/v1/wpm", json: b.json, actor: u, user: u };
    if (!onBehalf) {
      const poll = () => {
        const id = this.pending.wpm[this.pending.wpm.length - 1];
        return id === undefined ? null : { label: "wpm receipt poll (30 s)", method: "GET", path: `/v1/wpm/submissions/${id}`, actor: u, user: u, stepMs: 30_000 };
      };
      this.queue.push(poll, poll);
      if (rng.chance(0.5)) {
        const bind = (phase) => () => {
          const id = this.pending.wpm[this.pending.wpm.length - 1];
          if (id === undefined) return null;
          const bb = bindBody(rng, this.bindMemo, id, phase);
          return { label: `wpm bind ${bb.kind}`, method: "PUT", path: `/v1/wpm/submissions/${id}/discord-message`, json: bb.json, actor: u, user: u, stepMs: 1000 };
        };
        this.queue.push(bind("first"), bind(rng.pick(["same", "conflict", "invalid"])));
      }
    }
    return step;
  }

  linkWrite() {
    const rng = this.rng;
    const r = this.layoutRef({ deleted: false });
    const u = this.user();
    const verb = rng.weighted([[7, "PUT"], [2, "DELETE"], [1, "GET"]]);
    if (verb !== "PUT") return { label: `link ${verb}`, method: verb, path: `/v1/layouts/${r.id}/link`, bearer: u, user: u };
    const b = linkBody(rng, ++this.linkN);
    const step = { label: `link put (${b.kind})`, method: "PUT", path: `/v1/layouts/${r.id}/link`, json: b.json, bearer: u, user: u };
    // a supersede chain: a second PUT on the same layout by the same user replaces the first while pending
    if (b.kind === "ok" && rng.chance(0.3)) this.queue.push({ ...step, label: "link put (supersede)", json: { url: `https://example.com/sim/${this.linkN}-v2` }, stepMs: 1000 });
    return step;
  }

  // ---- admins -------------------------------------------------------------------------------------------------

  fam_admin() {
    const rng = this.rng;
    if (this.interaction !== null && this.cards.length > 0 && rng.chance(0.4)) return this.interactionScenario();
    return rng.weighted([
      [4, () => this.stepAdminQueueRead()],
      [5, () => this.stepModerate()],
      [3, () => this.adminLite()],
      [1, () => this.stepDumpOrTick()],
    ])();
  }

  /** Bans, author renames, client list: stepAdmin without admin add/remove (the rare pack owns those, in order). */
  adminLite() {
    for (let i = 0; i < 6; i++) {
      const s = this.stepAdmin();
      if (!/^admin (add|remove)$/.test(s.label)) return s;
    }
    return this.stepAdminQueueRead();
  }

  interactionScenario() {
    const rng = this.rng;
    const card = rng.pick(this.cards);
    const variant = rng.pick(variantsFor(card));
    const spec = interactionSpec(rng, this.interaction, card, variant, ++this.interactionN);
    const [first, ...rest] = scenarioSteps(spec);
    this.queue.push(...rest);
    return first;
  }

  // ---- adversarial input --------------------------------------------------------------------------------------

  fam_adversarial() {
    const rng = this.rng;
    return rng.weighted([
      [3, () => this.caseCollision()],
      [3, () => this.weirdName()],
      [3, () => this.forgedCursor()],
      [4, () => this.sortFilterSweep()],
      [3, () => this.tombstoneReclaim()],
      [2, () => this.badRef()],
    ])();
  }

  /** Two names that differ only in case / normalization: the second create must refuse identically. */
  caseCollision() {
    const [a, b] = this.rng.pick(NAME_PAIRS);
    const u = this.user();
    const create = (name) => ({ label: `create (case pair) ${JSON.stringify(name)}`, method: "POST", path: "/v1/layouts", json: { name, format: "spark/1", payload: this.payload() }, actor: u, user: u, stepMs: 1000 });
    this.queue.push(create(b), { label: "list after case pair", method: "GET", path: "/v1/layouts?sort=name&limit=100", conditional: true });
    return create(a);
  }

  weirdName() {
    const u = this.user();
    const name = this.rng.pick(WEIRD_NAMES);
    return { label: `create (odd name) ${JSON.stringify(name).slice(0, 40)}`, method: "POST", path: "/v1/layouts", json: { name, format: "spark/1", payload: this.payload() }, ...this.lane(u), user: u };
  }

  /** A cursor that was never issued: junk, truncated, altered, or from another sort. */
  forgedCursor() {
    const rng = this.rng;
    const real = [...this.cursors.values()][0] ?? "eyJ0IjoxfQ";
    const bad = rng.pick([
      "!!!", "%25%25", "", "AAAA", real.slice(0, Math.max(1, real.length - 3)), real.slice(1) + "A", Buffer.from('{"after":"zzz"}').toString("base64url"),
      Buffer.from(JSON.stringify({ k: "name", v: "x" })).toString("base64url"), "e30", "null", real + real,
    ]);
    const sort = rng.pick(SORTS);
    return { label: "list (forged cursor)", method: "GET", path: `/v1/layouts?sort=${sort}&limit=${rng.pick([2, 5, 50])}&cursor=${encodeURIComponent(bad)}`, conditional: true };
  }

  /** Every sort and every filter, walked in order so a long run covers the whole grid. */
  sortFilterSweep() {
    const i = this.sweep++;
    const sort = SORTS[i % SORTS.length];
    const filter = FILTERS[Math.floor(i / SORTS.length) % FILTERS.length];
    const dir = this.rng.pick(["", "&order=asc", "&order=desc"]);
    const q = [`sort=${sort}`, "limit=7", filter].filter((x) => x !== "").join("&") + dir;
    return { label: "list (sort x filter)", method: "GET", path: `/v1/layouts?${q}`, conditional: true, observe: `list:${q}` };
  }

  /** Delete a layout, take its name with a new one, then restore the old one: a tombstone reclaim and its refusal. */
  tombstoneReclaim() {
    const rng = this.rng;
    const live = [...this.layouts.values()].filter((l) => !l.deleted && typeof l.name === "string");
    if (live.length === 0) return this.weirdName();
    const l = rng.pick(live);
    const owner = l.owner ?? this.user();
    const lane = this.lane(owner);
    const other = this.user();
    this.queue.push(
      { label: "reclaim: create under the tombstoned name", method: "POST", path: "/v1/layouts", json: { name: l.name, format: "spark/1", payload: this.payload() }, ...this.lane(other), user: other, stepMs: 1000 },
      { label: "reclaim: restore the old one (name taken)", method: "POST", path: `/v1/layouts/${l.id}/restore`, ...lane, user: owner, stepMs: 1000 },
      { label: "reclaim: restore under a new name", method: "POST", path: `/v1/layouts/${l.id}/restore`, json: { name: `${l.name}-back`.slice(0, 60) }, ...lane, user: owner, stepMs: 1000 },
    );
    return { label: "reclaim: delete", method: "DELETE", path: `/v1/layouts/${l.id}`, headers: { "If-Match": this.ifMatch(l) }, ...lane, user: owner };
  }

  badRef() {
    const ref = this.rng.pick(BAD_REFS);
    return { label: "layout get (bad ref)", method: "GET", path: this.rng.pick([`/v1/layouts/${ref}`, `/v1/layouts/${ref}/comments`, `/v1/layouts/${ref}/history`]), conditional: true };
  }

  // ---- forced cold containers ---------------------------------------------------------------------------------

  /** A restart (a cold container on the AWS side, a no-op on D1), then the reads a cold catalog serves first. */
  fam_cold() {
    const r = this.layoutRef({ deleted: false });
    this.queue.push(
      { label: "cold: meta", method: "GET", path: "/v1/meta", conditional: true, stepMs: 0 },
      { label: "cold: list", method: "GET", path: "/v1/layouts?sort=name&limit=20", conditional: true, stepMs: 0 },
      { label: "cold: layout", method: "GET", path: `/v1/layouts/${r.id}`, conditional: true, stepMs: 0 },
      { label: "cold: comments", method: "GET", path: `/v1/layouts/${r.id}/comments`, conditional: true, stepMs: 0 },
      { label: "cold: changes", method: "GET", path: `/v1/changes?since=${Math.max(0, this.lastSeq - 5)}&limit=20`, conditional: true, stepMs: 0 },
      { label: "cold: wpm", method: "GET", path: "/v1/wpm", conditional: true, stepMs: 0 },
    );
    return { label: "restart", restart: true, method: "RESTART", path: "-", stepMs: 0 };
  }
}
