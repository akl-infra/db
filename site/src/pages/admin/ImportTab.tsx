import type { Component } from "solid-js";
import { For, Show, createSignal } from "solid-js";
import { copy } from "../../copy.ts";
import { adminHealth, adminImportPause, adminImportResume, adminImportTick } from "../../api.ts";
import { createAsync } from "../../lib/asyncData.ts";
import { loadErrorMessage } from "../../lib/apiError.ts";

type Action = "pause" | "resume" | "tick";

/** Health's shape is deliberately untyped past `Record<string, unknown>`
 * (`GET /v1/admin/health` -- `api.ts`'s own comment) -- flattened into
 * plain key/value rows exactly as the deliverable asks for, rather than
 * this UI guessing at (and drifting from) its real fields. */
function flatten(value: unknown, prefix = ""): [string, string][] {
  if (value === null || typeof value !== "object") return [[prefix || "value", String(value)]];
  const out: [string, string][] = [];
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v !== null && typeof v === "object" && !Array.isArray(v)) out.push(...flatten(v, key));
    else out.push([key, Array.isArray(v) ? JSON.stringify(v) : String(v)]);
  }
  return out;
}

/** Admin console, Import tab: pause/resume/manually-tick the cmini import,
 * and `GET /v1/admin/health` rendered as plain key/value rows. Every
 * action's own response is read for a `seq` (none of these routes carry
 * one today -- `api.ts`'s `adminImportTick` types its result as
 * `{ran, [k: string]: unknown}` precisely so a future one wouldn't need a
 * type change here to show up). */
const ImportTab: Component = () => {
  const [refreshTick, setRefreshTick] = createSignal(0);
  const health = createAsync(
    () => refreshTick(),
    () => adminHealth(),
  );
  const [pending, setPending] = createSignal<Action | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  const [seq, setSeq] = createSignal<number | null>(null);

  async function run(action: Action): Promise<void> {
    setPending(action);
    setError(null);
    const result = action === "pause" ? await adminImportPause() : action === "resume" ? await adminImportResume() : await adminImportTick();
    setPending(null);
    if (!result.ok) {
      setError(result.message ?? result.error);
      return;
    }
    const withSeq = result.data as { seq?: unknown };
    setSeq(typeof withSeq.seq === "number" ? withSeq.seq : null);
    setRefreshTick((t) => t + 1);
  }

  const rows = () => {
    const h = health.data();
    return h?.ok ? flatten(h.data) : [];
  };
  const loadError = (): string | null => loadErrorMessage(health.data(), copy.admin.import.healthLoadError);

  return (
    <div>
      <div class="akl-action-row">
        <button class="akl-btn" disabled={pending() !== null} onClick={() => void run("pause")}>
          {copy.admin.import.pause}
        </button>
        <button class="akl-btn" disabled={pending() !== null} onClick={() => void run("resume")}>
          {copy.admin.import.resume}
        </button>
        <button class="akl-btn" disabled={pending() !== null} onClick={() => void run("tick")}>
          {copy.admin.import.tick}
        </button>
        <Show when={error()}>{(msg) => <span class="akl-inline-error">{msg()}</span>}</Show>
        <Show when={seq()}>{(s) => <span class="akl-seq-note">{copy.actions.seqNotice(s())}</span>}</Show>
      </div>

      <h2>{copy.admin.import.healthTitle}</h2>
      <Show when={health.error() || loadError()}>
        <div class="akl-error">{loadError() ?? copy.admin.import.healthLoadError}</div>
      </Show>
      <Show when={!health.loading() && !health.error() && !loadError()}>
        <dl class="akl-kv">
          <For each={rows()}>
            {([k, v]) => (
              <>
                <dt>{k}</dt>
                <dd>{v}</dd>
              </>
            )}
          </For>
        </dl>
      </Show>
    </div>
  );
};

export default ImportTab;
