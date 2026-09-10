// [LDB-N1] [LDB-P4] [LDB-I5] `check_name` at the API boundary (09 §2.4):
// every rule with the bot's verbatim message, in the bot's order; rule 3's
// deterministic first-offender; POST on an existing name -> 409 name_taken
// with `holder`; the POST/POST race; imported names outside `NAME_SET'`
// survive a PUT untouched (never re-checked on non-renaming writes).
import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Bindings } from "../../src/env";
import { appendWrite } from "../../src/core/events";
import { fixedClock } from "../../src/core/time";
import { AKL_PAYLOAD, CMINI_PAYLOAD, actorFixture, register, uniqueName, writeFetch } from "./write-support";

const db = (env as unknown as Bindings).DB;
const clock = fixedClock("2026-07-07T00:00:00.000Z");
const OWNER = "owner-names-1";

afterEach(() => {
  vi.unstubAllGlobals();
});

function ownerHeaders(token: string) {
  const fake = actorFixture();
  return register(fake, token, OWNER);
}

async function postLayout(name: string, headers: Record<string, string>) {
  return writeFetch("/v1/layouts", "POST", headers, { name, format: "akl/1", payload: AKL_PAYLOAD });
}

describe("[LDB-N1] check_name at POST", () => {
  const table: { name: string; ok: boolean; message?: string }[] = [
    { name: "_abc", ok: false, message: "names cannot start with an underscore" },
    { name: "ab", ok: false, message: "names must be at least 3 characters long" },
    { name: "abc", ok: true },
    { name: "a.b;c", ok: false, message: "names cannot contain `.`" }, // first offender in string order
    { name: "a b", ok: false, message: "names cannot contain ` `" }, // the space, excluded from NAME_SET'
    { name: "graphite_v2", ok: true },
    { name: "a-b_c'd(e)f:g~h", ok: true }, // every allowed punctuation char
    { name: "a".repeat(64), ok: true },
    { name: "a".repeat(65), ok: false, message: "names must be at most 64 characters long" },
    { name: "01ARZ3NDEKTSV4RRFFQ69G5FAV", ok: false, message: "names cannot look like a layout id" },
  ];

  for (const { name, ok, message } of table) {
    it(`'${name.length > 20 ? name.slice(0, 20) + "…" : name}' -> ${ok ? "accepted" : `refused: ${message}`}`, async () => {
      const headers = ownerHeaders(`tok-${uniqueName("name")}`);
      // Each accepted name in the table is already distinct from every
      // other -- no uniquifying suffix, since two of them (the 64/65-char
      // cases) are exact boundary lengths a suffix would break.
      const res = await postLayout(name, headers);
      if (ok) {
        expect(res.status).toBe(201);
      } else {
        expect(res.status).toBe(400);
        const body = await res.json<{ error: string; message: string; name: string }>();
        expect(body.error).toBe("invalid_name");
        expect(body.message).toBe(message);
      }
    });
  }

  it("[LDB-N1] rule order: an underscore-led, too-short name is refused for the underscore, not the length", async () => {
    const headers = ownerHeaders("tok-order");
    const res = await postLayout("_a", headers); // both rules would fire; underscore is rule 1
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toMatchObject({ message: "names cannot start with an underscore" });
  });
});

describe("[LDB-P4] POST on an existing name", () => {
  it("-> 409 name_taken with holder", async () => {
    const name = uniqueName("dup-name");
    const headersA = ownerHeaders("tok-dup-a");
    const first = await postLayout(name, headersA);
    expect(first.status).toBe(201);
    const firstBody = await first.json<{ id: string; owner: string }>();

    const headersB = ownerHeaders("tok-dup-b");
    const second = await postLayout(name.toUpperCase(), headersB); // case-insensitive clash
    expect(second.status).toBe(409);
    const body = await second.json<{ error: string; name: string; holder: { id: string; owner: string } }>();
    expect(body.error).toBe("name_taken");
    expect(body.holder).toEqual({ id: firstBody.id, owner: firstBody.owner });
  });

  it("[LDB-P4] race: two POSTs with one name -> one 201, one 409 name_taken, no orphan", async () => {
    const name = uniqueName("race-name");
    const fake = actorFixture();
    const headersA = register(fake, "tok-race-a", OWNER);
    const post = (h: Record<string, string>) => postLayout(name, h);

    const [a, b] = await Promise.all([post(headersA), post(headersA)]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([201, 409]);

    const live = await db.prepare("SELECT COUNT(*) AS n FROM layouts WHERE name = ? AND deleted = 0").bind(name).first<{ n: number }>();
    expect(live?.n).toBe(1);
    const orphanRevs = await db
      .prepare("SELECT COUNT(*) AS n FROM layout_revs r LEFT JOIN layouts l ON l.id = r.layout_id WHERE l.id IS NULL")
      .first<{ n: number }>();
    expect(orphanRevs?.n).toBe(0);
  });
});

describe("[LDB-I5] imported names outside NAME_SET' survive a PUT untouched", () => {
  it("a name with a space, a dot, and lowercase-only survive an update (never re-checked on PUT)", async () => {
    for (const importedName of ["io", "AdNW", "a.dotted.name", "a name with spaces"]) {
      const { record } = await appendWrite(db, clock, {
      upstream: null,
        kind: "imported",
        name: importedName,
        owner: OWNER,
        modified_at: clock(),
        format: "cmini/1",
        payload: CMINI_PAYLOAD,
        actor: "system:cmini-import",
        via: "import:cmini",
        source: { client: "system:cmini-import", version: null },
        hasMagic: false,
      });

      const headers = ownerHeaders(`tok-${uniqueName("imp")}`);
      const res = await writeFetch(`/v1/layouts/${record.id}`, "PUT", { ...headers, "If-Match": `"${record.rev}"` }, { format: "akl/1", payload: AKL_PAYLOAD });
      expect(res.status, importedName).toBe(200);
      const body = await res.json<{ name: string }>();
      expect(body.name).toBe(importedName); // untouched, check_name never ran
    }
  });
});
