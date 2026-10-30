// Lane Q: the signed Discord interaction generator (design/aws-port.md §5.1: "Discord interactions"). Builds component
// (type 3), modal-submit (type 5) and ping (type 1) payloads for approve / deny (with and without a reason) / reopen on the
// three queues, plus the hostile variants: a stale card, a wrong channel or guild, a non-admin, a banned admin, a forged
// custom id, an unknown confirmation, the same interaction id twice, a bad signature.
//
// Signing: Ed25519 over `timestamp + body` with the lab application key, the one the fake Discord derives from its seed
// (`deriveKeys` in ../fake-discord/server.mjs). The lab must run with MODQUEUE_DISCORD_PUBLIC_KEY set to that key's hex,
// MODQUEUE_DISCORD_APPLICATION_ID to the fake's application id, MODQUEUE_DISCORD_GUILD_ID / MODQUEUE_DISCORD_CHANNEL_ID to
// the cfg below, MODQUEUE_DISCORD_ACTIONS=true and MODQUEUE_DISCORD_BOT_TOKEN set (otherwise every card answers
// "Moderation actions are unavailable", identically on both sides).
import crypto from "node:crypto";

export const INTERACTION_PATH = "/discord/interactions";
export const QUEUES = ["link", "wpm", "comment"];

const hex = (n, seedText) => crypto.createHash("sha256").update(seedText).digest("hex").slice(0, n);
const snowflakeFrom = (text) => String(100000000000000000n + (crypto.createHash("sha256").update(text).digest().readBigUInt64BE(0) % 900000000000000000n));
const uuidFrom = (text) => {
  const h = hex(32, text);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
};

/** The cfg the lab sets on the Worker: `{applicationId, guildId, channelId, admins[], members[], banned[]}`. */
export function defaultInteractionConfig(applicationId, over = {}) {
  return {
    applicationId,
    guildId: "300000000000000001",
    channelId: "300000000000000002",
    admins: ["100000000000000001"],
    members: ["100000000000000003", "100000000000000004"], // not admins
    banned: [], // admins that got banned during the run, set by the caller
    ...over,
  };
}

/** The custom id akldb puts on a card button (modqueue-message.ts `actionRow`). */
export function customIdFor(kind, action, id, version) {
  return `aklmod2|${kind}|${action}|${id}|${version}`;
}

/**
 * Cards currently posted in the fake Discord channel: [{kind, id, version, status, messageId}] read from the buttons'
 * custom ids in the message list the fake serves (GET /v10/channels/<c>/messages). Components may be nested.
 */
export function cardsFromMessages(messages) {
  const out = [];
  const walk = (node, messageId) => {
    if (Array.isArray(node)) return node.forEach((n) => walk(n, messageId));
    if (node === null || typeof node !== "object") return;
    if (typeof node.custom_id === "string") {
      const m = /^aklmod2\|(link|wpm|comment)\|(approve|deny|reopen-approved|reopen-rejected)\|([0-9A-HJKMNP-TV-Z]{26})\|(\d+)$/.exec(node.custom_id);
      if (m) {
        const status = m[2] === "reopen-approved" ? "approved" : m[2] === "reopen-rejected" ? "rejected" : "pending";
        out.push({ kind: m[1], id: m[3], version: Number(m[4]), status, messageId, action: m[2] });
      }
    }
    for (const v of Object.values(node)) if (typeof v === "object") walk(v, messageId);
  };
  for (const msg of messages) walk(msg.components, msg.id);
  return out;
}

/**
 * A side-independent interaction spec (JSON). `messageKey` ("kind:id") is resolved to that side's own message id at
 * send time. `variant` is one of VARIANTS. Deterministic from (rng, n).
 */
export const VARIANTS = [
  "approve", "deny", "deny-reason", "reopen", "stale", "wrong-channel", "wrong-guild", "non-admin", "banned-admin",
  "forged-custom-id", "unknown-confirmation", "duplicate", "bad-signature", "wrong-application", "ping", "unknown-type",
];

export function interactionSpec(rng, cfg, card, variant, n) {
  const stable = `${n}:${card.kind}:${card.id}:${variant}`;
  const admin = rng.pick(cfg.admins);
  const spec = {
    variant,
    n,
    id: snowflakeFrom(`interaction:${stable}`),
    token: hex(48, `token:${stable}`),
    kind: card.kind,
    submission: card.id,
    messageKey: `${card.kind}:${card.id}`,
    version: card.version,
    status: card.status,
    user: { id: admin, username: `mod-${admin.slice(-3)}` },
    application_id: cfg.applicationId,
    guild_id: cfg.guildId,
    channel_id: cfg.channelId,
    signature: "good",
    steps: 1, // 2 for the deny flow: component, then modal
  };
  const nonAdmin = () => ({ id: rng.pick(cfg.members), username: "plain-member" });
  switch (variant) {
    case "approve": spec.action = "approve"; break;
    case "deny": spec.action = "deny"; spec.steps = 2; spec.reason = null; break;
    case "deny-reason": spec.action = "deny"; spec.steps = 2; spec.reason = rng.pick(["needs a clearer video", "wrong layout", "ünï reason ✓", "x".repeat(500), "x".repeat(501)]); break;
    case "reopen": spec.action = card.status === "rejected" ? "reopen-rejected" : "reopen-approved"; break; // on a pending card or a link card it is refused
    case "stale": spec.action = "approve"; spec.version = card.version + rng.pick([1, 3]); break; // the card's version is not current
    case "wrong-channel": spec.action = "approve"; spec.channel_id = snowflakeFrom(`other-channel:${stable}`); break;
    case "wrong-guild": spec.action = "approve"; spec.guild_id = snowflakeFrom(`other-guild:${stable}`); break;
    case "non-admin": spec.action = "approve"; spec.user = nonAdmin(); break;
    case "banned-admin": spec.action = "approve"; spec.user = { id: cfg.banned.length > 0 ? rng.pick(cfg.banned) : admin, username: "banned-admin" }; break;
    case "forged-custom-id": spec.action = rng.pick(["approve", "nuke", "deny\u0000", "approve|x"]); spec.forged = true; break;
    case "unknown-confirmation": spec.action = "confirm"; spec.confirmation = uuidFrom(`confirm:${stable}`); break;
    case "duplicate": spec.action = "approve"; spec.duplicate = true; break;
    case "bad-signature": spec.action = "approve"; spec.signature = rng.pick(["tampered-body", "wrong-key", "stale-timestamp"]); break;
    case "wrong-application": spec.action = "approve"; spec.application_id = snowflakeFrom(`other-app:${stable}`); break;
    case "ping": spec.action = "ping"; break;
    case "unknown-type": spec.action = "approve"; spec.type = rng.pick([2, 4, 99]); break;
    default: throw new Error(`unknown interaction variant ${variant}`);
  }
  return spec;
}

/** The interaction JSON for one HTTP step of a spec. `modalId` (from the deny component's type-9 reply) is for step 2. */
export function materialize(spec, { messageId, modalId, step = 1 }) {
  if (spec.action === "ping") return { type: 1, id: spec.id, application_id: spec.application_id, token: spec.token, version: 1 };
  const base = {
    id: step === 1 ? spec.id : snowflakeFrom(`modal-interaction:${spec.id}`),
    application_id: spec.application_id,
    token: step === 1 ? spec.token : hex(48, `modal-token:${spec.token}`),
    version: 1,
    guild_id: spec.guild_id,
    channel_id: spec.channel_id,
    member: { user: { id: spec.user.id, username: spec.user.username }, roles: [] },
  };
  if (step === 2) {
    return { ...base, type: 5, data: { custom_id: `aklmod1|deny|${modalId}`, components: [{ type: 18, component: { type: 4, custom_id: "reason", value: spec.reason ?? "" } }] } };
  }
  const message = { id: messageId, channel_id: spec.channel_id, interaction_metadata: { id: spec.id } };
  let customId;
  if (spec.action === "confirm") customId = `aklmod2|confirm|${spec.confirmation}`;
  else customId = customIdFor(spec.kind, spec.action, spec.submission, spec.version);
  return { ...base, type: spec.type ?? 3, message, data: { component_type: 2, custom_id: customId } };
}

/** The body text and signature headers. `privateKey` is the fake Discord's (`deriveKeys(seed).privateKey`). */
export function signBody(bodyText, { nowMs, privateKey, mode = "good", wrongKey }) {
  let ts = String(Math.floor(nowMs / 1000));
  if (mode === "stale-timestamp") ts = String(Math.floor(nowMs / 1000) - 3600);
  const sign = (key, text) => crypto.sign(null, Buffer.from(ts + text), key).toString("hex");
  const signature = mode === "wrong-key" ? sign(wrongKey, bodyText) : sign(privateKey, bodyText);
  const sent = mode === "tampered-body" ? bodyText.replace(/"token":"/, '"token":"x') : bodyText;
  return { body: sent, headers: { "X-Signature-Ed25519": signature, "X-Signature-Timestamp": ts, "Content-Type": "application/json" } };
}

/**
 * The scenario for one card: the ordered HTTP steps it takes (1, or 2 for a deny), as step records for the driver:
 * `{label, method, path, interaction: {spec, step}}`. The driver resolves the message id per side, feeds the type-9 reply's
 * modal id into step 2, signs, sends, and (for "duplicate") sends step 1 again with the same interaction id.
 */
export function scenarioSteps(spec) {
  const steps = [{ label: `discord ${spec.variant} ${spec.kind}`, method: "POST", path: INTERACTION_PATH, interaction: { spec, step: 1 }, stepMs: 1000 }];
  if (spec.steps === 2) steps.push({ label: `discord ${spec.variant} ${spec.kind} modal`, method: "POST", path: INTERACTION_PATH, interaction: { spec, step: 2 }, stepMs: 1000 });
  if (spec.duplicate) steps.push({ label: `discord duplicate ${spec.kind}`, method: "POST", path: INTERACTION_PATH, interaction: { spec, step: 1 }, stepMs: 0 });
  return steps;
}

/** Which variants a card in `status` can usefully take (reopen is real only on decided non-link cards; elsewhere it is a refusal to match). */
export function variantsFor(card) {
  const decided = card.status !== "pending";
  if (card.kind === "link") return decided ? ["reopen", "stale", "non-admin", "wrong-channel"] : VARIANTS;
  return decided ? ["reopen", "stale", "non-admin", "banned-admin", "duplicate", "unknown-confirmation"] : VARIANTS.filter((v) => v !== "reopen");
}

/** The full required matrix: approve, deny, deny-reason and (non-link) reopen on all three queues. */
export function requiredMatrix() {
  const out = [];
  for (const kind of QUEUES) {
    for (const variant of ["approve", "deny", "deny-reason", "reopen"]) out.push({ kind, variant }); // link has no reopen button: its forged reopen is a refusal to match
  }
  return out;
}
