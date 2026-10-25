// Fault injection for the DynamoDB document client (design/aws-port.md §5.1
// item 3; lane L). DynamoDB Local never throws TransactionConflict, never
// throttles and never lags, so a wrapper does it: `withFaults(doc, opts)`
// returns a client with the same surface whose `send` injects
//  - seeded random faults (TransactionConflict, Throttling, InternalServerError)
//    on a fraction of write calls (reads only with `reads: true`: the SDK's own
//    retries already absorb read throttles before the store sees them);
//  - `failWritesFor(predicate)`: a hard, non-retryable failure of every write
//    call touching an item the predicate selects (TestStore.faults);
//  - `staleReads(n)`: the next n eventual reads see the previous version of
//    what the last write changed (lane I's replica-lag tests).
// Injected calls are never applied. The suite runs under LAB_FAULT_RATE=0.2.
import {
  InternalServerError,
  ProvisionedThroughputExceededException,
  TransactionCanceledException,
  TransactionConflictException,
} from "@aws-sdk/client-dynamodb";
import { GetCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";

export type FaultKind = "TransactionConflict" | "Throttling" | "InternalServerError";
export const ALL_FAULT_KINDS: readonly FaultKind[] = ["TransactionConflict", "Throttling", "InternalServerError"];

export interface FaultOptions {
  /** Probability (0..1) that an eligible call is faulted. Default 0 (wrapper inert except for the hooks). */
  rate?: number;
  /** PRNG seed. Default 1. */
  seed?: number;
  /** Kinds to draw from. Default all three. */
  kinds?: readonly FaultKind[];
  /** Also fault read calls (Get/Query/Scan/BatchGet) with Throttling or InternalServerError. Default false. */
  reads?: boolean;
  /**
   * The AWS SDK retries throttling and 5xx itself (3 attempts by default) before the store sees them;
   * this wrapper sits above it, so Throttling/InternalServerError surface only after this many
   * consecutive injections. TransactionConflict is never retried by the SDK and always surfaces. Default 3.
   */
  sdkAttempts?: number;
  /** Table names, so `WriteTouch.kind` can say "main" or "ephemeral". */
  tables?: { main: string; ephemeral: string };
}

export type Item = Record<string, unknown>;

/** One item a write call touches. `item` is the full item for a Put, and the stored pre-image for Update/Delete (read on demand, only while a predicate is registered). */
export interface WriteTouch {
  table: string;
  kind: "main" | "ephemeral" | "other";
  op: "put" | "update" | "delete";
  key: { pk: string; sk: string };
  item?: Item;
}

export interface FaultStats {
  calls: number;
  injected: Record<FaultKind, number>;
  predicateFailures: number;
  staleServed: number;
}

export interface FaultControl {
  /** Fail (non-retryably, unapplied) every write call touching an item `predicate` selects, until the returned disposer or `clearFaults()`. */
  failWritesFor(predicate: (touch: WriteTouch) => boolean): () => void;
  /** Serve the next `n` eventual reads from the item versions before the most recent write to them. Tracks pre-images from the first call on. */
  staleReads(n: number): void;
  /** Drop every predicate and pending stale read. Random faults stay (they are the wrapper's rate). */
  clearFaults(): void;
  /** Change the random fault rate (0 stops it). */
  setFaultRate(rate: number): void;
  faultStats(): FaultStats;
}

export type FaultyDoc = DynamoDBDocumentClient & FaultControl;

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const WRITES = new Set(["PutCommand", "UpdateCommand", "DeleteCommand", "TransactWriteCommand", "BatchWriteCommand"]);
const READS = new Set(["GetCommand", "QueryCommand", "ScanCommand", "BatchGetCommand", "TransactGetCommand"]);

type Cmd = { constructor: { name: string }; input: Record<string, any> };

function keyOf(k: Record<string, unknown> | undefined): { pk: string; sk: string } {
  return { pk: String(k?.pk), sk: String(k?.sk) };
}

/** Every write item in `cmd` (condition checks are not writes). */
function touchesOf(cmd: Cmd, tables: FaultOptions["tables"]): WriteTouch[] {
  const kindOf = (t: string): WriteTouch["kind"] => (tables === undefined ? "other" : t === tables.main ? "main" : t === tables.ephemeral ? "ephemeral" : "other");
  const out: WriteTouch[] = [];
  const put = (table: string, item: Item): void => {
    out.push({ table, kind: kindOf(table), op: "put", key: keyOf(item), item });
  };
  const upd = (table: string, op: "update" | "delete", key: Record<string, unknown>): void => {
    out.push({ table, kind: kindOf(table), op, key: keyOf(key) });
  };
  const i = cmd.input;
  switch (cmd.constructor.name) {
    case "PutCommand":
      put(i.TableName, i.Item);
      break;
    case "UpdateCommand":
      upd(i.TableName, "update", i.Key);
      break;
    case "DeleteCommand":
      upd(i.TableName, "delete", i.Key);
      break;
    case "TransactWriteCommand":
      for (const t of i.TransactItems ?? []) {
        if (t.Put) put(t.Put.TableName, t.Put.Item);
        else if (t.Update) upd(t.Update.TableName, "update", t.Update.Key);
        else if (t.Delete) upd(t.Delete.TableName, "delete", t.Delete.Key);
      }
      break;
    case "BatchWriteCommand":
      for (const [table, reqs] of Object.entries<any[]>(i.RequestItems ?? {})) {
        for (const r of reqs) {
          if (r.PutRequest) put(table, r.PutRequest.Item);
          else if (r.DeleteRequest) upd(table, "delete", r.DeleteRequest.Key);
        }
      }
      break;
  }
  return out;
}

const stamp = (t: { table: string; key: { pk: string; sk: string } }): string => `${t.table}\u0000${t.key.pk}\u0000${t.key.sk}`;

export function withFaults(doc: DynamoDBDocumentClient, opts: FaultOptions = {}): FaultyDoc {
  let rate = opts.rate ?? 0;
  const rand = mulberry32(opts.seed ?? 1);
  const kinds = opts.kinds ?? ALL_FAULT_KINDS;
  const predicates = new Set<(t: WriteTouch) => boolean>();
  const stats: FaultStats = {
    calls: 0,
    injected: { TransactionConflict: 0, Throttling: 0, InternalServerError: 0 },
    predicateFailures: 0,
    staleServed: 0,
  };
  let staleLeft = 0;
  let trackStale = false;
  /** Item before the most recent successful write to it (null = it did not exist). */
  const prev = new Map<string, Item | null>();
  let throttleFlip = false;

  const preImage = async (t: WriteTouch): Promise<Item | undefined> => {
    const r = await doc.send(new GetCommand({ TableName: t.table, Key: { pk: t.key.pk, sk: t.key.sk }, ConsistentRead: true }));
    return r.Item as Item | undefined;
  };

  const meta = { $metadata: { httpStatusCode: 400 } };
  const inject = (kind: FaultKind, cmd: Cmd, touches: WriteTouch[]): Error => {
    stats.injected[kind]++;
    if (kind === "TransactionConflict") {
      if (cmd.constructor.name === "TransactWriteCommand") {
        const n = (cmd.input.TransactItems ?? []).length;
        const hit = Math.floor(rand() * Math.max(n, 1));
        const reasons = Array.from({ length: n }, (_, k) => (k === hit ? { Code: "TransactionConflict", Message: "Transaction is ongoing for the item" } : { Code: "None" }));
        return new TransactionCanceledException({ message: "Transaction cancelled, please refer cancellation reasons for specific reasons [" + reasons.map((r) => r.Code).join(", ") + "]", CancellationReasons: reasons, ...meta });
      }
      return new TransactionConflictException({ message: "Transaction is ongoing for the item", ...meta });
    }
    if (kind === "Throttling") {
      throttleFlip = !throttleFlip;
      if (throttleFlip) return new ProvisionedThroughputExceededException({ message: "The level of configured provisioned throughput for the table was exceeded.", ...meta });
      const e = new Error("Rate of requests exceeds the allowed throughput.");
      e.name = "ThrottlingException";
      Object.assign(e, { $fault: "client", $metadata: meta.$metadata });
      return e;
    }
    void touches;
    return new InternalServerError({ message: "Internal server error", $metadata: { httpStatusCode: 500 } });
  };

  const send = async (cmd: Cmd, ...rest: unknown[]): Promise<unknown> => {
    stats.calls++;
    const name = cmd.constructor.name;
    const target = doc as unknown as { send(c: unknown, ...r: unknown[]): Promise<unknown> };
    if (WRITES.has(name)) {
      const touches = touchesOf(cmd, opts.tables);
      if (predicates.size > 0) {
        for (const t of touches) if (t.item === undefined) t.item = await preImage(t);
        for (const p of predicates) {
          if (touches.some((t) => p(t))) {
            stats.predicateFailures++;
            const e = new Error("injected write failure (failWritesFor)");
            e.name = "InjectedWriteFault";
            Object.assign(e, { $fault: "client", $metadata: { httpStatusCode: 400 } });
            throw e;
          }
        }
      }
      if (rate > 0 && rand() < rate) {
        const pool = kinds;
        const kind = pool[Math.floor(rand() * pool.length)];
        if (kind === "TransactionConflict") throw inject(kind, cmd, touches);
        if (kind !== undefined) {
          // Emulate the SDK's own retries: surface only if every attempt faults.
          let all = true;
          for (let a = 1; a < (opts.sdkAttempts ?? 3); a++) if (rand() >= rate) all = false;
          if (all) throw inject(kind, cmd, touches);
        }
      }
      if (trackStale) {
        const before = new Map<string, Item | null>();
        for (const t of touches) before.set(stamp(t), (await preImage(t)) ?? null);
        const res = await target.send(cmd, ...rest);
        for (const [k, v] of before) prev.set(k, v);
        return res;
      }
      return target.send(cmd, ...rest);
    }
    if (READS.has(name)) {
      if (opts.reads === true && rate > 0 && rand() < rate) {
        throw inject(rand() < 0.5 ? "Throttling" : "InternalServerError", cmd, []);
      }
      const eventual = cmd.input.ConsistentRead !== true;
      if (staleLeft > 0 && eventual && (name === "GetCommand" || name === "QueryCommand")) {
        const res = (await target.send(cmd, ...rest)) as { Item?: Item; Items?: Item[] };
        if (name === "GetCommand") {
          const k = stamp({ table: cmd.input.TableName, key: keyOf(cmd.input.Key) });
          if (prev.has(k)) {
            staleLeft--;
            stats.staleServed++;
            const old = prev.get(k);
            const copy = { ...res };
            if (old === null || old === undefined) delete copy.Item;
            else copy.Item = old;
            return copy;
          }
        } else if (res.Items !== undefined) {
          let used = false;
          const items: Item[] = [];
          for (const it of res.Items) {
            const k = stamp({ table: cmd.input.TableName, key: keyOf(it) });
            if (prev.has(k)) {
              used = true;
              const old = prev.get(k);
              if (old !== null && old !== undefined) items.push(old);
            } else items.push(it);
          }
          if (used) {
            staleLeft--;
            stats.staleServed++;
            return { ...res, Items: items, Count: items.length };
          }
        }
        return res;
      }
    }
    return target.send(cmd, ...rest);
  };

  const control: FaultControl = {
    failWritesFor(predicate) {
      predicates.add(predicate);
      return () => void predicates.delete(predicate);
    },
    staleReads(n) {
      trackStale = true;
      staleLeft = n;
    },
    clearFaults() {
      predicates.clear();
      staleLeft = 0;
    },
    setFaultRate(r) {
      rate = r;
    },
    faultStats: () => ({ ...stats, injected: { ...stats.injected } }),
  };

  return new Proxy(doc, {
    get(target, prop) {
      if (prop === "send") return send;
      if (prop in control) return control[prop as keyof FaultControl];
      const v = Reflect.get(target, prop, target);
      return typeof v === "function" ? v.bind(target) : v;
    },
  }) as FaultyDoc;
}
