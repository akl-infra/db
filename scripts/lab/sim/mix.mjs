// Lane Q: the simulator's traffic mix (design/aws-port.md §5.1, "Simulated, organic").
//
// PROD_SHARES is production's measured shape, 2026-10-30, ~63k requests/day:
//   16% /v1/changes (long-polls from Spark's signed client lane), 27% /v1/meta, 35% per-layout sub-resources (mostly
//   /v1/layouts/<id>/comments from the akl.gg proxy), 9% single layout GETs, 6% layout lists, 5% /v1/wpm*, 1% /v1/me and
//   authors; writes ~65/day (PUT layouts, POST/DELETE likes/comments/wpm).
// Knobs (all optional): `writeShare` (absolute share of writes, default = prod's 65/63000), `writeScale` (multiplier on
// that default), `shares` (override any read family's weight), `adversarial` (share of the request stream that is hostile
// input, default 0.02), `cold` (share of steps that force a cold container, default 0.004), `admin` (share of admin reads
// and moderation, default 0.01).
export const PROD_REQUESTS_PER_DAY = 63000;
export const PROD_WRITES_PER_DAY = 65;

/** Read families, percent of all requests. They sum to 99 with the 1% "other" (formats, schema, dump, health). */
export const PROD_SHARES = {
  changes: 16,
  meta: 27,
  subresources: 35,
  layoutGet: 9,
  list: 6,
  wpm: 5,
  meAuthors: 1,
  other: 1,
};

/** Inside "subresources": /comments dominates (the akl.gg proxy). */
export const SUBRESOURCE_SHARES = { comments: 70, comment: 5, likes: 8, history: 7, rev: 5, link: 5 };

/** Inside the writes (prod's mix): PUT layouts, likes, comments, WPM, deletes. */
export const WRITE_SHARES = { put: 38, create: 4, patch: 6, like: 24, comment: 16, wpm: 6, link: 2, delete: 4 };

/** Which client shape each read family comes from (the auth lane it is sent on). */
export const LANES = {
  changes: "spark-signed", // long-poll with wait=, caps feed:wait
  meta: "anon", // Spark sends it conditional, per command
  subresources: "aklgg-bearer-or-anon",
  layoutGet: "anon",
  list: "anon",
  wpm: "anon-or-signed",
  meAuthors: "signed",
};

export function normalizeKnobs(k = {}) {
  const writeDefault = PROD_WRITES_PER_DAY / PROD_REQUESTS_PER_DAY;
  const writeShare = k.writeShare ?? writeDefault * (k.writeScale ?? 1);
  if (!(writeShare >= 0 && writeShare < 1)) throw new Error(`writeShare must be in [0,1), got ${writeShare}`);
  return {
    writeShare,
    shares: { ...PROD_SHARES, ...(k.shares ?? {}) },
    adversarial: k.adversarial ?? 0.02,
    cold: k.cold ?? 0.004,
    admin: k.admin ?? 0.01,
  };
}

/**
 * The top-level family weights (sum 1): reads in PROD_SHARES proportion, scaled to leave room for writes, adversarial
 * input, cold-container batteries and admin traffic. Pure, so a test can pin it.
 */
export function familyWeights(knobs) {
  const k = normalizeKnobs(knobs);
  const readTotal = Object.values(k.shares).reduce((s, x) => s + x, 0);
  const room = 1 - k.writeShare - k.adversarial - k.cold - k.admin;
  if (room <= 0) throw new Error("writes + adversarial + cold + admin shares leave no room for reads");
  const out = { write: k.writeShare, adversarial: k.adversarial, cold: k.cold, admin: k.admin };
  for (const [name, share] of Object.entries(k.shares)) out[name] = (share / readTotal) * room;
  return out;
}
