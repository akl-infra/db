// Lane Q: the one place the simulator names its differ. Pinned signature: `diffPair(a, b, ctx) => Problem[]`
// (a = oracle side, b = AWS side, each `{status, headers (lower-case), body: Buffer}`; ctx = request context).
// Until lane S's scripts/lab/diff/pair.mjs exists this re-exports the replay shim (p1-crawl-diff's logic); the switch is
// this one line:  export { diffPair } from "../diff/pair.mjs";
export { diffPair } from "../replay/diff-shim.mjs";
