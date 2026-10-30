// Lane Q: the rare admin pack (design/aws-port.md §5.1, "Rare admin pack"). Production rarely or never sends these, so
// neither the replay nor the organic mix reaches them; each runs at least once a day on the lab and its state is diffed.
//
//   magic-seed ........ POST /v1/admin/magic-seed: the real run, a repeat, and the refusals (magic_edited, a layout with
//                       no seedable magic = missing/deleted ref, bad bodies, non-admin, unsigned)
//   relabel ........... POST /v1/admin/relabel-magic-thumbs: dry run (query and body), real run, a repeat (idempotent)
//   client lifecycle .. register -> the new client signs a request -> suspend -> its next request refused -> reactivate ->
//                       works -> destructive write -> revert (dry, real, repeat) -> revoke -> refused -> reactivate/suspend
//                       of a revoked client refused -> revoke again, unknown ids
//   admins ............ add, duplicate add, remove, remove of a non-admin, and removal down to the last-two-admins refusal
//
// `run(env)` is imperative: `env.pair(step)` sends one step to both sides, diffs the pair and returns `{a, b, ja, problems}`
// (`ja` = the oracle side's JSON body). The pack never decides pass/fail itself; the differ does. It only checks that it
// still reaches the operation it names (`env.expect`): a drifted pack would otherwise pass by hitting 404s on both sides.
import { ADMIN_ID, USER_IDS } from "../fuzz/generator.mjs";
import { labKey } from "./wire.mjs";

export const ADMIN_PACK_OPS = [
  "magic-seed.real", "magic-seed.repeat", "magic-seed.magic_edited", "magic-seed.missing", "magic-seed.bad-body", "magic-seed.non-admin",
  "relabel.dry-run", "relabel.dry-run-body", "relabel.real", "relabel.repeat", "relabel.non-admin",
  "client.register", "client.signed-ok", "client.suspend", "client.suspended-refused", "client.reactivate", "client.reactivated-ok",
  "client.revert-dry", "client.revert-real", "client.revert-repeat", "client.revoke", "client.revoked-refused",
  "client.reactivate-revoked", "client.suspend-revoked", "client.unknown-id", "client.register-invalid",
  "admin.add", "admin.add-duplicate", "admin.remove", "admin.remove-not-admin", "admin.last-two",
];

const SEED_USER = USER_IDS[0];
const NEW_ADMINS = ["100000000000000041", "100000000000000042", "100000000000000043"];

export async function rareAdminPack(env) {
  const rng = env.rng;
  const warnings = [];
  const covered = new Set();
  const A = { actor: ADMIN_ID, user: ADMIN_ID };
  const run = async (op, step, ok) => {
    const res = await env.pair({ stepMs: 1000, ...step });
    if (op !== null) {
      covered.add(op);
      if (ok !== undefined && !ok.includes(res.a.status)) warnings.push(`${op}: oracle answered ${res.a.status}, the pack expected ${ok.join("/")}`);
    }
    return res;
  };
  // One corpus entry that has magic: the seedable layout carries its keys without the magic, the seed supplies that magic,
  // and the "edited" layout carries both (a person's magic: the seed must refuse it).
  const withMagicEntry = env.corpus.find((c) => c.magic !== undefined);
  const entry = structuredClone(withMagicEntry ?? env.corpus[0] ?? { keys: [] });
  const magic = withMagicEntry?.magic ?? {};
  const payloadOf = (withMagic) => {
    const p = structuredClone(entry);
    if (!withMagic) delete p.magic;
    return p;
  };

  // ---- magic seed -----------------------------------------------------------------------------------------
  const mk = async (label, withMagic) => (await run(null, { label, method: "POST", path: "/v1/layouts", json: { name: `pack-${label}-${rng.int(0, 99999)}`, format: "spark/1", payload: payloadOf(withMagic) }, actor: SEED_USER, user: SEED_USER })).ja;
  const bare = await mk("seedable", false);
  const edited = await mk("magic-by-user", true);
  const seed = (ref, body, who = A) => ({ label: `magic-seed ${ref}`, method: "POST", path: "/v1/admin/magic-seed", json: body, ...who });
  if (bare?.id !== undefined) {
    await run("magic-seed.real", seed(bare.id, { ref: bare.id, magic }), [200]);
    await run("magic-seed.repeat", seed(bare.id, { ref: bare.id, magic }), [200]);
  }
  if (edited?.id !== undefined) await run("magic-seed.magic_edited", seed(edited.id, { ref: edited.id, magic }), [409]);
  await run("magic-seed.missing", seed("missing", { ref: "no-such-layout-pack", magic }), [404]);
  await run("magic-seed.bad-body", seed("bad", { ref: "", magic: [] }), [400]);
  await run("magic-seed.bad-body", seed("bad2", { ref: "x", magic: "no" }), [400]);
  await run("magic-seed.non-admin", seed("non-admin", { ref: bare?.id ?? "x", magic }, { actor: SEED_USER, user: SEED_USER }), [403]);
  await run(null, { label: "magic-seed unsigned", method: "POST", path: "/v1/admin/magic-seed", json: { ref: "x", magic } });

  // ---- relabel magic thumbs -------------------------------------------------------------------------------
  const rl = (label, extra = {}, who = A) => ({ label: `relabel ${label}`, method: "POST", path: "/v1/admin/relabel-magic-thumbs", ...extra, ...who });
  await run("relabel.dry-run", rl("dry (query)", { path: "/v1/admin/relabel-magic-thumbs?dry_run=1" }), [200]);
  await run("relabel.dry-run-body", rl("dry (body)", { json: { dry_run: true } }), [200]);
  await run("relabel.real", rl("real", { json: {} }), [200]);
  await run("relabel.repeat", rl("repeat"), [200]);
  await run("relabel.non-admin", rl("non-admin", {}, { actor: SEED_USER, user: SEED_USER }), [403]);

  // ---- client lifecycle -----------------------------------------------------------------------------------
  const seedText = `pack-client-${env.dayKey ?? "d"}`;
  const key = labKey(seedText);
  const t0 = new Date(env.clock()).toISOString();
  const reg = await run("client.register", { label: "client register", method: "POST", path: "/v1/admin/clients", json: { name: "sim-pack-client", pubkey: key.pubRaw, owner_user_id: ADMIN_ID, caps: "act-as-user,feed:wait" }, ...A }, [201]);
  const cid = reg.ja?.id;
  if (typeof cid === "string") {
    const as = { client: { seed: seedText, id: cid }, actor: SEED_USER, user: SEED_USER };
    const me = (label) => ({ label, method: "GET", path: "/v1/me", ...as });
    const mut = (label) => ({ label, method: "POST", path: "/v1/layouts", json: { name: `pack-by-client-${rng.int(0, 99999)}`, format: "spark/1", payload: payloadOf(false) }, ...as });
    const admin = (op, label, sub, json) => run(op, { label, method: "POST", path: `/v1/admin/clients/${sub}`, ...(json === undefined ? {} : { json }), ...A });
    await run("client.signed-ok", me("client: first signed request"), [200]);
    const created = await run(null, mut("client: create a layout"), [201]);
    if (created.ja?.id !== undefined) await run(null, { label: "client: delete it", method: "DELETE", path: `/v1/layouts/${created.ja.id}`, headers: { "If-Match": created.b.headers.etag ?? "*" }, ...as });
    await admin("client.suspend", "client suspend", `${cid}/suspend`, { reason: "pack" });
    await run("client.suspended-refused", me("client: request while suspended"));
    await admin("client.reactivate", "client reactivate", `${cid}/reactivate`);
    await run("client.reactivated-ok", me("client: request after reactivate"), [200]);
    await admin("client.suspend", "client suspend again", `${cid}/suspend`, {});
    await admin("client.reactivate", "client reactivate again", `${cid}/reactivate`);
    await admin("client.revert-dry", "client revert (dry run)", `${cid}/revert`, { since: t0, dry_run: true });
    await admin("client.revert-real", "client revert", `${cid}/revert`, { since: t0 });
    await admin("client.revert-repeat", "client revert (repeat)", `${cid}/revert`, { since: t0 });
    await run(null, { label: "client revert (bad body)", method: "POST", path: `/v1/admin/clients/${cid}/revert`, json: {}, ...A });
    await run("client.revoke", { label: "client revoke", method: "DELETE", path: `/v1/admin/clients/${cid}`, ...A }, [200]);
    await run("client.revoked-refused", me("client: request after revoke"));
    await admin("client.reactivate-revoked", "reactivate a revoked client", `${cid}/reactivate`);
    await admin("client.suspend-revoked", "suspend a revoked client", `${cid}/suspend`, {});
    await run(null, { label: "client revoke (again)", method: "DELETE", path: `/v1/admin/clients/${cid}`, ...A });
    await run(null, { label: "clients list", method: "GET", path: "/v1/admin/clients", ...A }, [200]);
  }
  await run("client.unknown-id", { label: "client revoke unknown", method: "DELETE", path: "/v1/admin/clients/01JAB0000000000000000NONE0", ...A }, [404]);
  await run("client.unknown-id", { label: "client suspend unknown", method: "POST", path: "/v1/admin/clients/01JAB0000000000000000NONE0/suspend", json: {}, ...A }, [404]);
  await run("client.register-invalid", { label: "client register (invalid)", method: "POST", path: "/v1/admin/clients", json: { name: "", pubkey: "x", owner_user_id: "nope", caps: 5 }, ...A }, [400]);
  await run(null, { label: "client register (non-admin)", method: "POST", path: "/v1/admin/clients", json: { name: "n", pubkey: key.pubRaw, owner_user_id: ADMIN_ID, caps: "act-as-user" }, actor: SEED_USER, user: SEED_USER });

  // ---- admins ---------------------------------------------------------------------------------------------
  const post = (label, id, extra) => ({ label, method: "POST", path: "/v1/admin/admins", json: { user_id: id, note: "pack", ...(extra ?? {}) }, ...A });
  const del = (label, id) => ({ label, method: "DELETE", path: `/v1/admin/admins/${id}`, ...A });
  await run(null, { label: "admins list", method: "GET", path: "/v1/admin/admins", ...A }, [200]);
  await run("admin.add", post("admin add", NEW_ADMINS[0]), [200, 201]);
  await run("admin.add-duplicate", post("admin add (duplicate)", NEW_ADMINS[0]));
  await run("admin.add", post("admin add", NEW_ADMINS[1]), [200, 201]);
  await run("admin.remove", del("admin remove", NEW_ADMINS[1]), [200, 204]);
  await run("admin.remove-not-admin", del("admin remove (not an admin)", NEW_ADMINS[1]), [404]);
  await run(null, post("admin add (invalid id)", "not-a-snowflake"));
  // The last-two-admins refusal: with the lab's one seeded admin plus NEW_ADMINS[0], removing either would leave one.
  const last = await run("admin.last-two", del("admin remove (would leave one)", NEW_ADMINS[0]));
  if (last.a.status < 400) warnings.push("admin.last-two: the oracle removed the admin, so the last-two refusal was not reached (the lab has more than one seeded admin)");
  await run(null, del("admin remove (self, would leave one)", ADMIN_ID));
  await run(null, { label: "admins list (end)", method: "GET", path: "/v1/admin/admins", ...A }, [200]);
  return { covered: [...covered], missing: ADMIN_PACK_OPS.filter((o) => !covered.has(o)), warnings };
}
