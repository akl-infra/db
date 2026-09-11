// [MF-7 = LDB-F25] design/layout-db/21-formats.md §2.5/§4: "Derived formats
// are never stored. A `?format=mana2/1` read never writes, and its
// response names `derived_from`. A read of a stored format is never
// derived." Checked two ways per read route: (a) reading `mana2/1` -- an
// output format, derived from the layout's own `spark/1` row -- changes
// no row anywhere (`events`, `layout_formats`, `layout_revs` counts, and
// the layout's own `modified_at`/`layout_rev`, are byte-identical before
// and after) and the response carries `derived_from: "spark/1"`; (b)
// reading `spark/1` itself never carries `derived_from` at all, on the
// detail route, the list route, and `full=1`.
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { Bindings } from "../../src/env";
import { commitWrite, type CommitInput } from "../../src/core/events";
import { fixedClock } from "../../src/core/time";
import { ulid } from "ulidx";
import { writeFetch } from "./write-support";

const db = (env as unknown as Bindings).DB;
const clock = fixedClock("2026-07-18T00:00:00.000Z");
const OWNER = "owner-mf7";

let uniqueCounter = 0;
function uniqueName(prefix: string): string {
  return `${prefix}-${uniqueCounter++}`;
}

async function seed(): Promise<string> {
  const input: CommitInput = {
    layoutId: ulid(),
    creating: true,
    currentN: 0,
    currentLayout: null,
    currentFormats: new Map(),
    layout: { kind: "created", name: uniqueName("mf7"), owner: OWNER, created_at: clock(), deleted: false },
    format: { kind: "format_added", lineage: "spark", format: "spark/1", payload: { keys: { a: { finger: "L1", row: 1, col: 1 } } }, hasMagic: false },
    modified_at: clock(),
    actor: OWNER,
    via: "discord",
    source: { client: "discord-app:test", version: null },
    upstream: null,
  };
  const { layout } = await commitWrite(db, clock, input);
  return layout.id;
}

interface Counts {
  events: number;
  layout_formats: number;
  layout_revs: number;
  layoutRow: unknown;
}

async function snapshot(id: string): Promise<Counts> {
  const [events, formats, revs, layoutRow] = await Promise.all([
    db.prepare("SELECT COUNT(*) AS n FROM events WHERE layout_id = ?").bind(id).first<{ n: number }>(),
    db.prepare("SELECT COUNT(*) AS n FROM layout_formats WHERE layout_id = ?").bind(id).first<{ n: number }>(),
    db.prepare("SELECT COUNT(*) AS n FROM layout_revs WHERE layout_id = ?").bind(id).first<{ n: number }>(),
    db.prepare("SELECT * FROM layouts WHERE id = ?").bind(id).first(),
  ]);
  return { events: events!.n, layout_formats: formats!.n, layout_revs: revs!.n, layoutRow };
}

describe("[MF-7 = LDB-F25] a ?format=mana2/1 read derives, never writes", () => {
  it("[MF-7] [LDB-F25] GET detail ?format=mana2/1 leaves every row byte-identical and answers derived_from: spark/1", async () => {
    const id = await seed();
    const before = await snapshot(id);

    const res = await writeFetch(`/v1/layouts/${id}?format=mana2/1`, "GET");
    expect(res.status).toBe(200);
    const body = await res.json<{ format: string; derived_from?: string }>();
    expect(body.format).toBe("mana2/1");
    expect(body.derived_from).toBe("spark/1");

    const after = await snapshot(id);
    expect(after).toEqual(before);

    // Never stored: no `layout_formats` row for lineage 'mana2' exists,
    // full stop -- not just "unchanged count", the row itself is absent.
    const manaRow = await db.prepare("SELECT 1 FROM layout_formats WHERE layout_id = ? AND lineage = 'mana2'").bind(id).first();
    expect(manaRow).toBeNull();
  });

  it("[MF-7] [LDB-F25] GET list ?format=mana2/1 also derives without writing", async () => {
    const id = await seed();
    const before = await snapshot(id);

    const res = await writeFetch(`/v1/layouts?owner=${OWNER}&format=mana2/1`, "GET");
    expect(res.status).toBe(200);
    const body = await res.json<{ items: { id: string; format: string; derived_from?: string }[] }>();
    const item = body.items.find((i) => i.id === id);
    expect(item?.format).toBe("mana2/1");
    expect(item?.derived_from).toBe("spark/1");

    expect(await snapshot(id)).toEqual(before);
  });
});

describe("[MF-7 = LDB-F25] a read of a stored format is never derived", () => {
  it("[MF-7] [LDB-F25] GET detail ?format=spark/1 -> no derived_from key at all", async () => {
    const id = await seed();
    const res = await writeFetch(`/v1/layouts/${id}?format=spark/1`, "GET");
    expect(res.status).toBe(200);
    const body = await res.json<{ format: string; derived_from?: string }>();
    expect(body.format).toBe("spark/1");
    expect(body.derived_from).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(body, "derived_from")).toBe(false);
  });

  it("[MF-7] [LDB-F25] GET list ?format=spark/1 -> no derived_from key on the item", async () => {
    const id = await seed();
    const res = await writeFetch(`/v1/layouts?owner=${OWNER}&format=spark/1`, "GET");
    expect(res.status).toBe(200);
    const body = await res.json<{ items: { id: string; format: string; derived_from?: string }[] }>();
    const item = body.items.find((i) => i.id === id);
    expect(item?.format).toBe("spark/1");
    expect(item === undefined ? undefined : Object.prototype.hasOwnProperty.call(item, "derived_from")).toBe(false);
  });

  it("[MF-7] [LDB-F25] GET ?full=1&format=spark/1 -> no derived_from key on the item", async () => {
    const id = await seed();
    const res = await writeFetch(`/v1/layouts?full=1&format=spark/1`, "GET");
    expect(res.status).toBe(200);
    const body = await res.json<{ items: { id: string; format: string; derived_from?: string }[] }>();
    const item = body.items.find((i) => i.id === id);
    expect(item?.format).toBe("spark/1");
    expect(item === undefined ? undefined : Object.prototype.hasOwnProperty.call(item, "derived_from")).toBe(false);
  });

  it("[MF-7] [LDB-F25] GET ?full=1&format=mana2/1 -> derived_from: spark/1 on the item, never written", async () => {
    const id = await seed();
    const before = await snapshot(id);
    const res = await writeFetch(`/v1/layouts?full=1&format=mana2/1`, "GET");
    expect(res.status).toBe(200);
    const body = await res.json<{ items: { id: string; format: string; derived_from?: string }[] }>();
    const item = body.items.find((i) => i.id === id);
    expect(item?.format).toBe("mana2/1");
    expect(item?.derived_from).toBe("spark/1");
    expect(await snapshot(id)).toEqual(before);
  });
});
