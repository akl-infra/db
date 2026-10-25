// DynamoDB `CutoverStore` (src/store/port.ts). Owner: P2 lane G.
// P2 default: no cutover mode, exactly like D1. `{ realCutover: true }` reads
// STATE/cutover.mode (design/aws-port.md §5.2), cached 1 s per container.
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { withRetry } from "./tx";
import type { CutoverStore } from "../port";
import type { DdbContext } from "./contracts";
import { stateKey } from "./keys";

export interface CutoverOptions {
  realCutover?: boolean;
  cacheMs?: number;
  /** Replaceable for tests. */
  nowMs?: () => number;
}

export function ddbCutoverStore(ctx: DdbContext, opts: CutoverOptions = {}): CutoverStore {
  if (opts.realCutover !== true) {
    return {
      async mode() {
        return null;
      },
    };
  }
  const ttl = opts.cacheMs ?? 1000;
  const clock = opts.nowMs ?? Date.now;
  let cached: { at: number; mode: "read_only" | "proxy" | null } | undefined;
  return {
    async mode() {
      const t = clock();
      if (cached !== undefined && t - cached.at < ttl) return cached.mode;
      // Eventually consistent on purpose: the flag is cached for a second anyway.
      const r = await withRetry(() => ctx.doc.send(new GetCommand({ TableName: ctx.tables.main, Key: stateKey("cutover.mode") })));
      const v = r.Item?.value;
      const mode = v === "read_only" || v === "proxy" ? v : null;
      cached = { at: t, mode };
      return mode;
    },
  };
}
