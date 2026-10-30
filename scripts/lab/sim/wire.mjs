// Lane Q: a stream step -> the HTTP request one side receives. The same step gives both sides the same bytes except for
// `{{name}}` tokens (resolved from that side's `vars`), so a diff is never the simulator's doing.
//
// A step: { label, method, path, json? | rawBody?, headers?, actor? (client lane, signed for that user id), bearer? (the
//   fake-Discord bearer lane for that user id), badSignature?, interaction?: {spec, step}, stepMs, conditional?, restart?,
//   observe?, user?, client?: {seed, id} (sign with a client the admin pack registered, not the lab client) }   (the fuzzer's shape, plus `interaction`)
import { createSigner, labKey } from "../replay/sign.mjs";
import { INTERACTION_PATH, materialize, signBody } from "./interactions.mjs";

export const CLOCK0 = Date.parse("2026-10-25T12:00:00.000Z");
export { createSigner, labKey };

const clientSigners = new Map();
/** The signer of a client registered by the rare admin pack: `{seed, id}` -> signs with labKey(seed) as client `id`. */
export function clientSigner(client) {
  const k = `${client.seed}:${client.id}`;
  if (!clientSigners.has(k)) clientSigners.set(k, createSigner({ key: labKey(client.seed), clientId: client.id }));
  return clientSigners.get(k);
}

export function substitute(text, vars) {
  if (vars === undefined) return text;
  return text.replace(/\{\{([^}]+)\}\}/g, (m, k) => (Object.hasOwn(vars, k) ? vars[k] : m));
}

/**
 * @param {object} step
 * @param {{nowMs:number, seed:string|number, nonceSeed:string|number, signer:ReturnType<typeof createSigner>, vars?:Record<string,string>,
 *          discord?:{privateKey:any, wrongKey?:any, messageIdFor:(key:string)=>string|undefined, modalIdFor:(specId:string)=>string|undefined}}} ctx
 */
export function wireFor(step, ctx) {
  let bodyText;
  let path = substitute(step.path, ctx.vars);
  const headers = { "x-lab-now": new Date(ctx.nowMs).toISOString(), "x-lab-seed": String(ctx.seed) };
  if (step.interaction !== undefined) {
    const { spec, step: n } = step.interaction;
    const doc = materialize(spec, { messageId: ctx.discord?.messageIdFor(spec.messageKey) ?? "1100000000000000000", modalId: ctx.discord?.modalIdFor(spec.id) ?? "00000000-0000-4000-8000-000000000000", step: n });
    const signed = signBody(JSON.stringify(doc), { nowMs: ctx.nowMs, privateKey: ctx.discord.privateKey, wrongKey: ctx.discord.wrongKey, mode: spec.signature });
    Object.assign(headers, signed.headers, step.headers ?? {});
    return { method: "POST", pathWithQuery: INTERACTION_PATH, headers, body: Buffer.from(signed.body) };
  }
  if (step.rawBody !== undefined) bodyText = step.rawBody;
  else if (step.json !== undefined) bodyText = JSON.stringify(step.json);
  if (bodyText !== undefined) bodyText = substitute(bodyText, ctx.vars);
  const body = bodyText === undefined ? undefined : Buffer.from(bodyText);
  Object.assign(headers, step.headers ?? {});
  if (body !== undefined && headers["Content-Type"] === undefined) headers["Content-Type"] = "application/json";
  if (step.badSignature) {
    Object.assign(headers, { "X-Akl-Client": ctx.signer.clientId, "X-Akl-Timestamp": "1", "X-Akl-Nonce": "AAAA", "X-Akl-Actor": step.actor, "X-Akl-Signature": "AAAA" });
  } else if (step.actor !== undefined) {
    Object.assign(headers, (step.client === undefined ? ctx.signer : clientSigner(step.client)).sign({ method: step.method, pathWithQuery: path, body, actor: step.actor, nowMs: ctx.nowMs, nonceSeed: ctx.nonceSeed }));
  }
  if (step.bearer !== undefined) headers.Authorization = `Bearer lab-${step.bearer}`;
  return { method: step.method, pathWithQuery: path, headers, body };
}

// ---- the JSONL stream --------------------------------------------------------------------------------------------

/** One JSON line per step: the recorded request stream. `i` is the position, `tMs` the lab clock offset from CLOCK0. */
export function streamLine(step, i, tMs, extra = {}) {
  return JSON.stringify({ i, tMs, ...step, ...extra }) + "\n";
}

/** Parse a recorded stream back into steps (blank lines ignored, a malformed line is an error with its number). */
export function parseStream(text) {
  const out = [];
  text.split("\n").forEach((line, n) => {
    if (line.trim() === "") return;
    try {
      out.push(JSON.parse(line));
    } catch (e) {
      throw new Error(`stream line ${n + 1} is not JSON: ${e instanceof Error ? e.message : e}`);
    }
  });
  return out;
}
