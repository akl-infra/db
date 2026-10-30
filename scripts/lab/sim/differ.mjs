// Lane Q: the one place the simulator names its differ. Pinned signature: `diffPair(a, b, ctx) => Problem[]`
// (a = oracle side, b = AWS side, each `{status, headers (lower-case), body: Buffer}`; ctx = request context).
// Lane S's differ (scripts/lab/diff/pair.mjs).
export { diffPair } from "../diff/pair.mjs";
