// App wiring for the ports (design/aws-port.md §4.1). The Hono app itself
// still lives in src/index.ts during P1; this file is the seam every route
// moves onto: `AppEnv` is the context type, `platformMiddleware` puts the
// request's `Platform` on `c.var.platform`, and `platformOf(c)` reads it.
// P1 agents switch their routes from `c.env.DB` to `platformOf(c).store`.
import type { Context, MiddlewareHandler } from "hono";
import type { ActorVariables } from "./auth/actor";
import type { Bindings } from "./env";
import type { Platform } from "./platform/port";
import { workersPlatform } from "./platform/workers";

export type AppVariables = ActorVariables & { platform: Platform };
export type AppEnv = { Bindings: Bindings; Variables: AppVariables };

function executionCtxOf(c: Context): { waitUntil(p: Promise<unknown>): void } | undefined {
  try {
    return c.executionCtx;
  } catch {
    return undefined; // app.request() in tests has no ExecutionContext
  }
}

/**
 * A host other than Workers (Node lab server, tests on DynamoDB, Lambda)
 * passes its own platform factory on the env object as `PLATFORM`
 * (design/p2-p5-briefs.md, frozen contract). Workers never sets it.
 */
export type PlatformFactory = (env: Bindings, ctx: { waitUntil(p: Promise<unknown>): void } | undefined) => Platform;

/** The platform for `env` outside a request (scheduled jobs, dumps): Workers unless the env names another. */
export function platformFor(env: Bindings, ctx: { waitUntil(p: Promise<unknown>): void } | undefined): Platform {
  const factory = (env as unknown as { PLATFORM?: PlatformFactory }).PLATFORM ?? workersPlatform;
  return factory(env, ctx);
}

/** Registered first in src/index.ts: builds this request's platform. */
export const platformMiddleware: MiddlewareHandler<AppEnv> = async (c, next) => {
  c.set("platform", platformFor(c.env, executionCtxOf(c)));
  await next();
};

/** The request's platform. Routes on a Hono app typed with `AppEnv` can also use `c.var.platform`. */
export function platformOf(c: Context): Platform {
  const platform = c.get("platform") as Platform | undefined;
  if (platform === undefined) throw new Error("platformOf: platformMiddleware did not run for this request");
  return platform;
}
