// Shared by tests/ddb/catalog*.test.ts (lane H): a writer that goes through the
// real DynamoDB store (commitWrite / appendLike), a log of what each operation
// returned (so the exact view at any seq can be replayed), and a reset of the
// table pair.
import { BatchWriteCommand, ScanCommand } from "@aws-sdk/lib-dynamodb";
import type { CommitInput } from "../../src/core/events";
import type { FormatRow, LayoutRow } from "../../src/core/records";
import { createDdbStore } from "../../src/store/ddb";
import type { CatalogLayout, CatalogView, DdbContext } from "../../src/store/ddb/contracts";
import type { Store } from "../../src/store/port";
import { ddbHarness } from "../harness/ddb";

export const ctxOf = (doc: DdbContext["doc"] = ddbHarness.doc): DdbContext => ({ ...ddbHarness.ctxBase, doc, catalog: undefined as never });

export async function resetTables(): Promise<void> {
  for (const t of [ddbHarness.tables.main, ddbHarness.tables.ephemeral]) {
    const keys: { pk: string; sk: string }[] = [];
    let last: Record<string, unknown> | undefined;
    do {
      const r = await ddbHarness.raw.send(new ScanCommand({ TableName: t, ExclusiveStartKey: last, ProjectionExpression: "pk, sk", ConsistentRead: true }));
      for (const i of r.Items ?? []) keys.push({ pk: i.pk as string, sk: i.sk as string });
      last = r.LastEvaluatedKey;
    } while (last !== undefined);
    for (let i = 0; i < keys.length; i += 25) {
      await ddbHarness.raw.send(
        new BatchWriteCommand({ RequestItems: { [t]: keys.slice(i, i + 25).map((Key) => ({ DeleteRequest: { Key } })) } }),
      );
    }
  }
}

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SRC = { client: "test", version: "1" };

interface State {
  layout: LayoutRow;
  formats: Map<string, FormatRow>;
  likers: Set<string>;
}

/** What one operation left behind for one layout, valid from `seq` (its last event) on. */
export interface LogEntry {
  seq: number;
  id: string;
  state: State;
}

export class Writer {
  private readonly state = new Map<string, State>();
  readonly log: LogEntry[] = [];
  private readonly events: Store["events"];
  private tick = Math.floor(Date.now() / 1000);
  // a fresh store per writer: its catalog is private, so a table reset can't leave a stale cache behind
  constructor(store: Store = createDdbStore(ddbHarness.ctxBase)) {
    this.events = store.events;
  }
  private readonly now = () => new Date(this.tick++ * 1000).toISOString();

  /** The seq of the last event any operation of this writer committed (the HEAD seq when it is the only writer). */
  get lastSeq(): number {
    return this.log.reduce((m, e) => Math.max(m, e.seq), 0);
  }

  hasLike(id: string, user: string): boolean {
    return this.state.get(id)!.likers.has(user);
  }

  private record(id: string, seq: number, st: State): number {
    this.state.set(id, st);
    this.log.push({ seq, id, state: { layout: st.layout, formats: new Map(st.formats), likers: new Set(st.likers) } });
    return seq;
  }

  private async commit(id: string, over: Partial<CommitInput>): Promise<number> {
    const cur = this.state.get(id) ?? null;
    const r = await this.events.commitWrite(this.now, {
      layoutId: id, creating: cur === null, currentN: cur?.layout.n ?? 0, currentLayout: cur?.layout ?? null,
      currentFormats: cur?.formats ?? new Map(), actor: "o", via: "test", source: SRC, upstream: null, modified_at: "", ...over,
    });
    return this.record(id, Math.max(...r.seqs), { layout: r.layout, formats: r.formats, likers: cur?.likers ?? new Set() });
  }

  async create(id: string, name: string, owner: string, at: string, payloadJson = '{"k":1}'): Promise<number> {
    return this.commit(id, {
      layout: { kind: "created", name, owner, created_at: at, deleted: false },
      format: { kind: "created", lineage: "spark", format: "spark/1", payload: JSON.parse(payloadJson), hasMagic: false },
      modified_at: at,
    });
  }

  async update(id: string, at: string, payloadJson: string): Promise<number> {
    return this.commit(id, {
      format: { kind: "updated", lineage: "spark", format: "spark/1", payload: JSON.parse(payloadJson), hasMagic: payloadJson.length % 2 === 1 },
      modified_at: at,
    });
  }

  async remove(id: string, at: string): Promise<number> {
    const l = this.state.get(id)!.layout;
    return this.commit(id, { layout: { kind: "deleted", name: l.name, owner: l.owner, created_at: l.created_at, deleted: true }, modified_at: at });
  }

  private async likeOp(kind: "liked" | "unliked", id: string, user: string): Promise<number> {
    const r = await this.events.appendLike(this.now, { kind, layoutId: id, userId: user, via: "test", source: SRC });
    const cur = this.state.get(id)!;
    const likers = new Set(cur.likers);
    if (kind === "liked") likers.add(user);
    else likers.delete(user);
    return this.record(id, r.seq, { layout: { ...cur.layout, like_count: r.like_count }, formats: cur.formats, likers });
  }

  // `at` is accepted for call-site symmetry; a like's time is the writer's clock
  async like(id: string, user: string, _at?: string): Promise<number> {
    return this.likeOp("liked", id, user);
  }

  async unlike(id: string, user: string, _at?: string): Promise<number> {
    return this.likeOp("unliked", id, user);
  }

  /** The exact view at `seq`, replayed from the log (the last entry per layout at or before `seq`). */
  async expectedAt(seq: number): Promise<Map<string, CatalogLayout>> {
    const latest = new Map<string, LogEntry>();
    for (const e of this.log) if (e.seq <= seq && (latest.get(e.id)?.seq ?? 0) < e.seq) latest.set(e.id, e);
    const out = new Map<string, CatalogLayout>();
    for (const [id, e] of latest) out.set(id, { layout: e.state.layout, formats: e.state.formats, likers: [...e.state.likers].sort() });
    return out;
  }
}

export function viewBrief(v: CatalogView): unknown {
  return { seq: v.seq, ids: [...v.layouts.keys()].sort() };
}
