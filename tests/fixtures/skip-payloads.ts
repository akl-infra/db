// The skip vectors the 1.32 withholding tests run over (LDB-F52, LDB-V8..V10):
// every accepted vector of formats/spark/1/fixtures/parity-vectors.json that
// uses a skip construct, the three shapes tests/api/skip-magic-publish.test.ts
// publishes, and one payload mixing all of them with plain magic.
import vectors from "../../formats/spark/1/fixtures/parity-vectors.json";
import reported from "./skip-repeat-publish.json";
import type { Payload } from "../../formats/spark/1/index.ts";

export function usesSkipShape(magic: unknown): boolean {
  const s = JSON.stringify(magic);
  return s.includes('"skip_repeat"') || s.includes('"skip":true') || /"after":\[/.test(s);
}

const parity = (vectors as unknown as { keys: Payload["keys"]; magic: Payload["magic"]; expected?: unknown }[]).filter(
  (v) => v.expected !== undefined && usesSkipShape(v.magic),
);

const rep = reported as unknown as Payload;

export const SKIP_PAYLOADS: { name: string; payload: Payload }[] = [
  ...parity.map((v, i) => ({ name: `parity skip vector #${i}`, payload: { keys: v.keys, magic: v.magic } as Payload })),
  { name: "reported skip-repeat", payload: rep },
  { name: "explicit skip rule", payload: { ...rep, magic: { magic_keys: [{ key: "∯", rules: [{ after: ["h", null], emit: "e" }] }] } } },
  { name: "skip chiral", payload: { ...rep, magic: { chiral_keys: [{ key: "∯", skip: true, same: { kind: "repeat" }, opposite: { kind: "char", char: "e" } }] } } },
  {
    name: "skip beside a plain rule",
    payload: {
      ...rep,
      magic: {
        magic_keys: [
          { key: "∯", default: { kind: "skip_repeat" }, rules: [{ after: "h", emit: "e" }, { after: ["h", null], emit: "e" }] },
        ],
      },
    },
  },
];
