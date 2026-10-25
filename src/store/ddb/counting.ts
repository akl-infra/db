// Round-trip counting for the DynamoDB document client (lane L): the
// DynamoDB analog of LDB-L8's D1 round-trip bounds. `withCallCounter(doc)`
// returns a client with the same surface whose `calls` counts every `send`
// by command type. Wrap it outermost (around withFaults) to count the calls
// the store made, injected faults included; wrap it inside to count only
// what reached DynamoDB.
import type { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";

export interface CallSnapshot {
  total: number;
  /** By command, without the "Command" suffix: Get, Put, Query, TransactWrite, ... */
  byCommand: Record<string, number>;
  /** Get, Query, Scan, BatchGet, TransactGet. */
  reads: number;
  /** Put, Update, Delete, TransactWrite, BatchWrite. */
  writes: number;
  /** Items across all TransactWrite calls. */
  transactItems: number;
}

export interface CallCounter {
  snapshot(): CallSnapshot;
  reset(): void;
  /** Calls made while `fn` runs (nested/concurrent users of the same client are counted too). */
  measure<T>(fn: () => Promise<T>): Promise<{ result: T; calls: CallSnapshot }>;
}

export type CountingDoc = DynamoDBDocumentClient & { readonly calls: CallCounter };

const READ = new Set(["Get", "Query", "Scan", "BatchGet", "TransactGet"]);
const WRITE = new Set(["Put", "Update", "Delete", "TransactWrite", "BatchWrite"]);

export function withCallCounter(doc: DynamoDBDocumentClient): CountingDoc {
  let state: CallSnapshot = empty();
  function empty(): CallSnapshot {
    return { total: 0, byCommand: {}, reads: 0, writes: 0, transactItems: 0 };
  }
  const calls: CallCounter = {
    snapshot: () => ({ ...state, byCommand: { ...state.byCommand } }),
    reset() {
      state = empty();
    },
    async measure(fn) {
      const before = calls.snapshot();
      const result = await fn();
      const after = calls.snapshot();
      const byCommand: Record<string, number> = {};
      for (const [k, v] of Object.entries(after.byCommand)) {
        const d = v - (before.byCommand[k] ?? 0);
        if (d !== 0) byCommand[k] = d;
      }
      return {
        result,
        calls: {
          total: after.total - before.total,
          byCommand,
          reads: after.reads - before.reads,
          writes: after.writes - before.writes,
          transactItems: after.transactItems - before.transactItems,
        },
      };
    },
  };
  const send = (cmd: { constructor: { name: string }; input?: { TransactItems?: unknown[] } }, ...rest: unknown[]): Promise<unknown> => {
    const name = cmd.constructor.name.replace(/Command$/, "");
    state.total++;
    state.byCommand[name] = (state.byCommand[name] ?? 0) + 1;
    if (READ.has(name)) state.reads++;
    if (WRITE.has(name)) state.writes++;
    if (name === "TransactWrite") state.transactItems += cmd.input?.TransactItems?.length ?? 0;
    return (doc as unknown as { send(c: unknown, ...r: unknown[]): Promise<unknown> }).send(cmd, ...rest);
  };
  return new Proxy(doc, {
    get(target, prop) {
      if (prop === "send") return send;
      if (prop === "calls") return calls;
      const v = Reflect.get(target, prop, target);
      return typeof v === "function" ? v.bind(target) : v;
    },
  }) as CountingDoc;
}
