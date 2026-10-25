// Turns the production mirror's tee on for one unit of work (a request or a scheduled run), design/aws-port.md §5.2.
// With TEE_URL or TEE_SECRET unset it returns `env` itself, so the default build is byte-identical. Set, it returns
// the same env with `DB` replaced by an observed handle that carries the unit's sender: every `toStore(env.DB)` and
// the platform's own store then record their writes, whichever code path holds the binding.
import type { Bindings } from "../env";
import { observeD1 } from "./observe-d1";
import { recordingStore } from "./recorder";
import { createTeeSender } from "./sender";
import { TEE_TAG, type TeeTag } from "./tag";

export function teeEnv<E extends Bindings>(env: E, ctx: { waitUntil(p: Promise<unknown>): void } | undefined): E {
  const { TEE_URL: url, TEE_SECRET: secret } = env as unknown as { TEE_URL?: string; TEE_SECRET?: string };
  if (!url || !secret) return env;
  if ((env.DB as unknown as Record<symbol, unknown>)[TEE_TAG] !== undefined) return env;
  const sender = createTeeSender({
    url,
    secret,
    direction: "d1->ddb",
    background(task) {
      const guarded = task.catch((e: unknown) => console.error(`TEE_FAILED background: ${e instanceof Error ? e.message : String(e)}`));
      if (ctx !== undefined) ctx.waitUntil(guarded);
    },
  });
  const tag: TeeTag = { wrap: (store) => recordingStore(store, (call) => sender.add(call)) };
  const db = observeD1(env.DB, tag);
  return new Proxy(env, {
    get(target, prop) {
      return prop === "DB" ? db : (Reflect.get(target, prop, target) as unknown);
    },
  });
}
