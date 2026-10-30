// Runtime flags of the AWS side (design/aws-port.md §5.2; LDB-CUT20-free: pinned by CUT14/CUT19): the mirror mode (apply | record | off)
// and whether the scheduled jobs run, kept as `STATE/…` items next to `cutover.mode` and read per invocation with a 1 s cache. The
// cutover flips these as DATA, so the switch never waits on a control-plane change (CloudFormation, Lambda configuration, schedules).
// A missing or unreadable-as-valid item means the deploy-time default (the stack parameter / environment variable).
import type { StateStore } from "../store/port";

export type MirrorMode = "apply" | "record" | "off";
export const MIRROR_MODE_KEY = "mirror.mode";
export const JOBS_ENABLED_KEY = "jobs.enabled";
export const FLAG_CACHE_MS = 1000;

export interface FlagDefaults {
  mirrorMode: MirrorMode;
  jobsEnabled: boolean;
}

export function parseMirrorMode(v: string | null | undefined): MirrorMode | null {
  return v === "apply" || v === "record" || v === "off" ? v : null;
}
export function parseOnOff(v: string | null | undefined): boolean | null {
  return v === "on" ? true : v === "off" ? false : null;
}
export function defaultsFromEnv(env: { MIRROR_MODE?: string; JOBS_ENABLED?: string }): FlagDefaults {
  return { mirrorMode: parseMirrorMode(env.MIRROR_MODE) ?? "off", jobsEnabled: parseOnOff(env.JOBS_ENABLED) ?? true };
}

export function createRuntimeFlags(read: (key: string) => Promise<string | null>, defaults: FlagDefaults, opts: { cacheMs?: number; nowMs?: () => number } = {}) {
  const ttl = opts.cacheMs ?? FLAG_CACHE_MS;
  const clock = opts.nowMs ?? (() => Date.now());
  const cache = new Map<string, { at: number; v: string | null }>();
  async function cached(key: string): Promise<string | null> {
    const t = clock();
    const hit = cache.get(key);
    if (hit !== undefined && t - hit.at < ttl) return hit.v;
    const v = await read(key);
    cache.set(key, { at: t, v });
    return v;
  }
  return {
    async mirrorMode(): Promise<MirrorMode> {
      return parseMirrorMode(await cached(MIRROR_MODE_KEY)) ?? defaults.mirrorMode;
    },
    async jobsEnabled(): Promise<boolean> {
      return parseOnOff(await cached(JOBS_ENABLED_KEY)) ?? defaults.jobsEnabled;
    },
  };
}

/** The flags over a store's `STATE` area (D1 `import_state`, DynamoDB `STATE/…`). */
export function storeFlags(state: Pick<StateStore, "get">, env: { MIRROR_MODE?: string; JOBS_ENABLED?: string }, opts?: { cacheMs?: number; nowMs?: () => number }) {
  return createRuntimeFlags((k) => state.get(k), defaultsFromEnv(env), opts);
}
