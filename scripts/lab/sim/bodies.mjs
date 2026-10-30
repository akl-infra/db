// Lane Q: generated submit bodies (design/aws-port.md §5.1: "Submit bodies the replay cannot rebuild"). Pure functions of
// a seeded rng. Per-side values (a Discord proof URL points at that side's own fake Discord message) are `{{name}}`
// tokens, substituted into the body at send time from the side's `vars` (see wire.mjs), so a recorded stream is
// side-independent JSON.

const ZWJ = "‍";
export const COMMENT_TEXTS = [
  "nice layout",
  "ünïcode ✓ comment",
  "astral 𝕜𝕖𝕪 🧑" + ZWJ + "💻 🏳️" + ZWJ + "🌈",
  "é vs é (NFD vs NFC)",
  "line1\nline2\r\nline3",
  "  padded  ",
  "<b>html</b> & <script>alert(1)</script>",
  "https://example.com/a?b=c&d=e#f",
  "tab\tsep",
  "‮RTL override‬",
  "zero​width",
  "a",
];

/** { json, kind } for a comment PUT body; `kind` says what the server is expected to do with it. */
export function commentBody(rng) {
  const kind = rng.weighted([[10, "ok"], [1, "max"], [1, "over"], [1, "blank"], [1, "empty"], [1, "wrong-type"], [1, "extra-key"], [1, "missing"]]);
  switch (kind) {
    case "ok": return { kind, json: { body: rng.pick(COMMENT_TEXTS) } };
    case "max": return { kind, json: { body: "x".repeat(2000) } };
    case "over": return { kind, json: { body: "x".repeat(2001) } };
    case "blank": return { kind, json: { body: "   \n\t " } };
    case "empty": return { kind, json: { body: "" } };
    case "wrong-type": return { kind, json: { body: rng.pick([5, null, ["a"], { a: 1 }, true]) } };
    case "extra-key": return { kind, json: { body: "hi", extra: 1 } };
    default: return { kind, json: {} };
  }
}

export const YOUTUBE_PROOFS = ["https://www.youtube.com/watch?v=simAAAAAAA1", "https://youtu.be/simAAAAAAA2", "https://www.youtube.com/watch?v=simAAAAAAA3&t=42s"];
export const OTHER_PROOFS = ["https://example.com/proof.png", "https://i.imgur.com/simProof.png", "http://insecure.example.com/p"];
export const BAD_PROOFS = ["not a url", "ftp://example.com/x", "", "   ", "https://", "javascript:alert(1)", "https://example.com/" + "p".repeat(3000)];

/**
 * A WPM submit body for `layout` (a ref). `userId` is the submitting user (the one whose Discord message counts as "own").
 * Proof kinds: a non-Discord URL, a Discord message authored by the submitter, one authored by someone else (LDB-WPM15,
 * refused), a Discord message that does not exist, a malformed URL. Speeds: valid 1..1000, and the edges.
 */
export function wpmBody(rng, { layout, userId, onBehalf = false }) {
  const proofKind = rng.weighted([[6, "youtube"], [3, "other"], [3, "discord-own"], [1, "discord-other"], [1, "discord-missing"], [1, "bad"]]);
  const proof =
    proofKind === "youtube" ? rng.pick(YOUTUBE_PROOFS)
    : proofKind === "other" ? rng.pick(OTHER_PROOFS)
    : proofKind === "discord-own" ? `{{proof:own:${userId}}}`
    : proofKind === "discord-other" ? `{{proof:other:${userId}}}`
    : proofKind === "discord-missing" ? "{{proof:missing}}"
    : rng.pick(BAD_PROOFS);
  const speedKind = rng.weighted([[12, "ok"], [1, "zero"], [1, "over"], [1, "fraction"], [1, "string"], [1, "negative"], [1, "edge"]]);
  const wpm = speedKind === "ok" ? rng.int(20, 220)
    : speedKind === "zero" ? 0
    : speedKind === "over" ? 1001
    : speedKind === "fraction" ? 87.5
    : speedKind === "string" ? "100"
    : speedKind === "negative" ? -3
    : rng.pick([1, 1000]);
  const json = { layout, wpm, proof };
  if (onBehalf) json.user_id = userId;
  return { kind: `${proofKind}/${speedKind}`, json };
}

const snowflake = (rng) => String(100000000000000000n + BigInt(rng.int(0, 2 ** 30)) * 1000n + BigInt(rng.int(0, 999)));

/**
 * The discord-message bind for a WPM submission: `phase` "first" mints a (guild, channel, message) triple and remembers it
 * in `memo` (a Map keyed by submission id); "same" repeats it (idempotent), "conflict" sends a different message (refused),
 * "invalid" sends a malformed id.
 */
export function bindBody(rng, memo, submissionId, phase) {
  if (phase === "invalid") return { kind: "invalid", json: rng.pick([{ guild_id: "1", channel_id: "2", message_id: "3" }, { guild_id: null, channel_id: "x", message_id: "y" }, { channel_id: snowflake(rng) }]) };
  let triple = memo.get(submissionId);
  if (phase === "first" || triple === undefined) {
    triple = { guild_id: rng.chance(0.8) ? snowflake(rng) : null, channel_id: snowflake(rng), message_id: snowflake(rng) };
    memo.set(submissionId, triple);
    return { kind: "first", json: { ...triple } };
  }
  if (phase === "same") return { kind: "same", json: { ...triple } };
  return { kind: "conflict", json: { guild_id: triple.guild_id, channel_id: triple.channel_id, message_id: snowflake(rng) } };
}

/** link PUT bodies: valid and invalid URLs. `n` makes supersede chains distinct. */
export function linkBody(rng, n = 0) {
  const kind = rng.weighted([[8, "ok"], [2, "query"], [1, "http"], [1, "userinfo"], [1, "ftp"], [1, "garbage"], [1, "long"], [1, "non-string"], [1, "empty"]]);
  const url = {
    ok: `https://example.com/sim/${n}`,
    query: `https://example.com/sim?x=${n}&y=ü`,
    http: `http://insecure.example.com/sim/${n}`,
    userinfo: "https://user:pw@example.com/sim",
    ftp: "ftp://example.com/x",
    garbage: "not a url",
    long: "https://example.com/" + "p".repeat(3000),
    "non-string": 5,
    empty: "",
  }[kind];
  return { kind, json: { url } };
}

const FAKE_CHANNEL_AUTH = { Authorization: "Bot sim-lab-bot", "Content-Type": "application/json" };

/**
 * Seed one fake Discord with the messages the WPM proof check reads: a message authored by each user in `users`
 * ("own" for that user), one authored by `other` ("other" proof for anyone else), and a URL of a message that was never
 * posted ("missing"). Returns the side's `vars`: `proof:own:<user>`, `proof:other:<user>`, `proof:missing`.
 * @param {string} fakeBase the fake Discord's DISCORD_API_URL base (`http://127.0.0.1:<port>/api`)
 */
export async function seedDiscordProofs(fakeBase, { guildId, channelId, users, other }) {
  const vars = {};
  const post = async (authorId, username, content) => {
    const r = await fetch(`${fakeBase}/v10/channels/${channelId}/messages`, { method: "POST", headers: FAKE_CHANNEL_AUTH, body: JSON.stringify({ content, author: { id: authorId, username, bot: false } }) });
    if (!r.ok) throw new Error(`fake Discord refused the proof message: ${r.status}`);
    return (await r.json()).id;
  };
  const urlOf = (m) => `https://discord.com/channels/${guildId}/${channelId}/${m}`;
  for (const u of users) vars[`proof:own:${u}`] = urlOf(await post(u, `sim-${u.slice(-3)}`, `proof by ${u}`));
  const foreign = urlOf(await post(other, "sim-other", "proof by another typist"));
  for (const u of users) vars[`proof:other:${u}`] = foreign;
  vars["proof:missing"] = urlOf("1199999999999999999");
  return vars;
}
