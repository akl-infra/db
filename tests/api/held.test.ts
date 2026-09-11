// [LDB-F9] A held record keeps name/owner/rev and reads as its own format
// (01 §4, 07 §6 S6). spark/1 and mana2/1 always translate both ways, so a
// genuine held response can only be produced with a format that isn't
// wired to anything -- `registry.ts`'s `registerForTest` hook exists for
// exactly this. This file's own storage is isolated (vitest-pool-workers per-file
// isolation), so registering a stub here can't leak into another test
// file; it's still unregistered in `afterAll` so nothing in THIS file runs
// after it with a polluted registry.
import { SELF } from "cloudflare:test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appendWrite } from "../../src/core/events";
import { fixedClock } from "../../src/core/time";
import { registerForTest, type FormatModule } from "../../src/formats/registry";
import { db } from "./support";

const HELD_FORMAT: FormatModule = {
  id: "held/1",
  owner: "test",
  description: "test-only format with no translations (LDB-F9)",
  schema: {},
  role: "stored",
  validate: () => ({ ok: true }),
  to: {},
  from: {},
  hasMagic: () => false,
};

describe("[LDB-F9] held/1 records", () => {
  let unregister: () => void;
  let recordId: string;

  beforeAll(async () => {
    unregister = registerForTest(HELD_FORMAT);
    const { record } = await appendWrite(db, fixedClock("2026-06-08T00:00:00.000Z"), {
      upstream: null,
      kind: "created",
      name: "held-record",
      owner: "1",
      modified_at: "2026-06-08T00:00:00.000Z",
      format: "held/1",
      payload: { anything: true },
      actor: "1",
      via: "discord",
      source: { client: "discord-app:test", version: null },
    });
    recordId = record.id;
  });

  afterAll(() => {
    unregister();
  });

  it("[LDB-F9] lists among live records", async () => {
    const res = await SELF.fetch("https://example.com/v1/layouts?format=held/1");
    expect(res.status).toBe(200);
    const body = await res.json<{ items: { id: string; format: string }[] }>();
    const row = body.items.find((i) => i.id === recordId);
    expect(row).toBeDefined();
    expect(row?.format).toBe("held/1");
  });

  it("[LDB-F9] reads as its own format", async () => {
    const res = await SELF.fetch(`https://example.com/v1/layouts/${recordId}?as=held/1`);
    expect(res.status).toBe(200);
    const body = await res.json<{ payload: unknown; format: string }>();
    expect(body.format).toBe("held/1");
    expect(body.payload).toEqual({ anything: true });
  });

  it("[LDB-F9] 409s for as=spark/1 with see: 'held/1'", async () => {
    const res = await SELF.fetch(`https://example.com/v1/layouts/${recordId}?as=spark/1`);
    expect(res.status).toBe(409);
    const body = await res.json<{ error: string; held: boolean; format: string; see?: string }>();
    expect(body.error).toBe("held");
    expect(body.held).toBe(true);
    expect(body.format).toBe("spark/1");
    expect(body.see).toBe("held/1");
  });
});
