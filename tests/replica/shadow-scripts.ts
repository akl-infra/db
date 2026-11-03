// The replay scripts are plain .mjs (no .d.ts), typed loosely here once so the tests can import them the way
// tests/tools/rehost-guard.test.ts imports scripts/rehost.mjs.
/* eslint-disable @typescript-eslint/no-explicit-any */
// @ts-expect-error -- plain script, no declaration file
import * as diffMod from "../../scripts/lab/shadow/replay/diff.mjs";
// @ts-expect-error -- plain script, no declaration file
import * as planMod from "../../scripts/lab/shadow/replay/plan.mjs";
// @ts-expect-error -- plain script, no declaration file
import * as reportMod from "../../scripts/lab/shadow/replay/report.mjs";
// @ts-expect-error -- plain script, no declaration file
import * as routesMod from "../../scripts/lab/shadow/replay/routes.mjs";
// @ts-expect-error -- plain script, no declaration file
import * as runMod from "../../scripts/lab/shadow/replay/run.mjs";
// @ts-expect-error -- plain script, no declaration file
import * as sourceMod from "../../scripts/lab/shadow/replay/source.mjs";
// @ts-expect-error -- plain script, no declaration file
import * as cliMod from "../../scripts/lab/shadow/replay.mjs";

export const judge: (item: any, prod: any, shadow: any, ctx?: any) => { verdict: string; reason?: string; problems: { kind: string; detail: string }[]; heads: unknown } = (diffMod as any).judge;
export const buildPlan: (reqs: any[], opts?: any) => any = (planMod as any).buildPlan;
export const renderMarkdown: (records: any[], meta?: any) => string = (reportMod as any).renderMarkdown;
export const summarize: (records: any[]) => any = (reportMod as any).summarize;
export const classify: (p: string) => { class: string; group: string } | null = (routesMod as any).classify;
export const headOfEtag: (e: string) => number | null = (routesMod as any).headOfEtag;
export const normalizeQuery: (q: string) => string = (routesMod as any).normalizeQuery;
export const STATE_KINDS: Record<string, string[]> = (routesMod as any).STATE_KINDS;
export const runReplay: (o: any) => Promise<any[]> = (runMod as any).runReplay;
export const extractRequest: (ev: any) => any = (sourceMod as any).extractRequest;
export const fetchTelemetry: (o: any) => Promise<{ events: any[]; pages: number; truncated: boolean }> = (sourceMod as any).fetchTelemetry;
export const readLogpush: (root: string) => any[] = (sourceMod as any).readLogpush;
export const CREDENTIAL_HEADERS: string[] = (sourceMod as any).CREDENTIAL_HEADERS;
export const checkBase: (base: string, allowLocal: boolean) => string = (cliMod as any).checkBase;
export const parseArgs: (argv: string[]) => any = (cliMod as any).parseArgs;
