// Shared by tests/ddb/catalog*.test.ts (lane H): a small writer that makes the
// same writes the layout store will (one runEventTx per operation naming the
// layout, CAT item + name claim + like items), a shadow of what each
// operation leaves behind, and a reset of the table pair. Lane G's
// commitWrite replaces it as the writer once it lands; the catalog does not
// care who wrote the items.
import { BatchWriteCommand, ScanCommand } from "@aws-sdk/lib-dynamodb";
import type { CatalogLayout, CatalogView, DdbContext, EventInput, D1Row } from "../../src/store/ddb/contracts";
import { toCatalogLayout } from "../../src/store/ddb/catalog";
import { likeKey, nameKey, userLikeKey } from "../../src/store/ddb/keys";
import { catItem, inlinePayloads } from "../../src/store/ddb/schema/core";
import { runEventTx } from "../../src/store/ddb/tx";
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

interface Shadow {
  layout: D1Row;
  formats: D1Row[];
  likers: Set<string>;
}

/** What one operation left behind for one layout, valid from `seq` on. */
export interface LogEntry {
  seq: number;
  id: string;
  state: Shadow | null;
}

const ev = (kind: EventInput["kind"], id: string, at: string, over: Partial<EventInput> = {}): EventInput => ({
  at, kind, layout_id: id, name: "n", owner: "o", format: null, rev: null, actor: "o", via: "test", admin: 0,
  detail_json: null, before_json: null, after_json: null, source_client: null, source_version: null, ...over,
});

export class Writer {
  readonly shadow = new Map<string, Shadow>();
  readonly log: LogEntry[] = [];
  constructor(private readonly ctx: DdbContext = ctxOf()) {}

  /** Runs one operation; if it fails (retries exhausted under contention), the shadow goes back to what it was. */
  private async guard(id: string, op: () => Promise<number>): Promise<number> {
    const prev = this.shadow.has(id) ? this.copy(this.shadow.get(id)!) : null;
    try {
      return await op();
    } catch (e) {
      if (prev === null) this.shadow.delete(id);
      else this.shadow.set(id, prev);
      throw e;
    }
  }

  private copy(s: Shadow): Shadow {
    return { layout: { ...s.layout }, formats: s.formats.map((f) => ({ ...f })), likers: new Set(s.likers) };
  }

  /** CAT item for the shadow, spilled payloads written to the blob store first. */
  private async catPut(s: Shadow) {
    const spilled = new Map<string, string>();
    const item = catItem(s.layout, s.formats, spilled);
    for (const [ref, json] of spilled) await this.ctx.blobs.put(ref, json, "application/json");
    return { Put: { TableName: this.ctx.tables.main, Item: item } };
  }

  private async commit(id: string, e: EventInput, extra: (add: (tag: string, i: object) => void) => void, live = 0): Promise<number> {
    const snap = this.shadow.has(id) ? this.copy(this.shadow.get(id)!) : null;
    const cat = snap === null ? null : await this.catPut(snap);
    // Under LAB_FAULT_RATE a many-item transaction can exhaust runEventTx's eight attempts; the fixture tries again
    // (a writer that gave up leaves nothing behind).
    let seqs: number[] = [];
    for (let attempt = 0; ; attempt++) {
      try {
        ({ seqs } = await runEventTx(this.ctx, (b) => {
          b.event(e);
          if (cat !== null) b.item("cat", cat);
          extra((tag, i) => b.item(tag, i as never));
          if (live !== 0) b.addLive(live);
        }));
        break;
      } catch (err) {
        if (attempt >= 5 || (err as { status?: number }).status !== 500) throw err;
      }
    }
    this.log.push({ seq: seqs[0]!, id, state: snap });
    return seqs[0]!;
  }

  async create(id: string, name: string, owner: string, at: string, payloadJson = '{"k":1}'): Promise<number> {
    return this.guard(id, async () => {
      this.shadow.set(id, {
        layout: {
          id, name, owner, n: 1, layout_rev: 1, created_at: at, modified_at: at, deleted: 0, like_count: 0, like_adjust: 0, link: null,
          upstream_source: null, upstream_id: null, upstream_state: null, source_client: "test", source_version: "1",
        },
        formats: [{
          layout_id: id, lineage: "spark", format: "spark/1", rev: 1, created_at: at, modified_at: at, payload_json: payloadJson,
          has_magic: 0, has_alts: 0, has_combos: 0, source_client: "test", source_version: "1",
        }],
        likers: new Set(),
      });
      return this.commit(id, ev("created", id, at, { name, owner }), (add) => add("name", { Put: { TableName: this.ctx.tables.main, Item: { ...nameKey(name), id } } }), 1);
    });
  }

  async update(id: string, at: string, payloadJson: string): Promise<number> {
    return this.guard(id, async () => {
      const s = this.shadow.get(id)!;
      s.layout.n = (s.layout.n as number) + 1;
      s.layout.modified_at = at;
      s.formats[0] = { ...s.formats[0]!, rev: (s.formats[0]!.rev as number) + 1, modified_at: at, payload_json: payloadJson, has_magic: payloadJson.length % 2 };
      return this.commit(id, ev("updated", id, at, { format: "spark/1", rev: s.formats[0]!.rev as number }), () => {});
    });
  }

  async remove(id: string, at: string): Promise<number> {
    return this.guard(id, async () => {
      const s = this.shadow.get(id)!;
      s.layout.deleted = 1;
      s.layout.n = (s.layout.n as number) + 1;
      s.layout.modified_at = at;
      return this.commit(id, ev("deleted", id, at), (add) => add("name", { Delete: { TableName: this.ctx.tables.main, Key: nameKey(s.layout.name as string) } }), -1);
    });
  }

  async like(id: string, user: string, at: string): Promise<number> {
    return this.guard(id, async () => {
      const s = this.shadow.get(id)!;
      s.likers.add(user);
      s.layout.like_count = s.likers.size;
      const body = { layout_id: id, user_id: user, at, via: "test" };
      return this.commit(id, ev("liked" as never, id, at, { actor: user }), (add) => {
        add("lk", { Put: { TableName: this.ctx.tables.main, Item: { ...likeKey(id, user), ...body } } });
        add("ulk", { Put: { TableName: this.ctx.tables.main, Item: { ...userLikeKey(user, id), ...body } } });
      });
    });
  }

  async unlike(id: string, user: string, at: string): Promise<number> {
    return this.guard(id, async () => {
      const s = this.shadow.get(id)!;
      s.likers.delete(user);
      s.layout.like_count = s.likers.size;
      return this.commit(id, ev("unliked" as never, id, at, { actor: user }), (add) => {
        add("lk", { Delete: { TableName: this.ctx.tables.main, Key: likeKey(id, user) } });
        add("ulk", { Delete: { TableName: this.ctx.tables.main, Key: userLikeKey(user, id) } });
      });
    });
  }

  /** The exact view at `seq`, replayed from the log (the last entry per layout at or before `seq`). */
  async expectedAt(seq: number): Promise<Map<string, CatalogLayout>> {
    const latest = new Map<string, LogEntry>();
    for (const e of this.log) if (e.seq <= seq && (latest.get(e.id)?.seq ?? 0) < e.seq) latest.set(e.id, e);
    const out = new Map<string, CatalogLayout>();
    for (const [id, e] of latest) {
      const s = e.state!;
      const [item] = await inlinePayloads(this.ctx.blobs, [catItem(s.layout, s.formats, new Map())]);
      out.set(id, toCatalogLayout(item!, [...s.likers].sort()));
    }
    return out;
  }
}

export function viewBrief(v: CatalogView): unknown {
  return { seq: v.seq, ids: [...v.layouts.keys()].sort() };
}
