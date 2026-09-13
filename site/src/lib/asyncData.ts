// solid-js 2.0.0-rc.1 has no `createResource`/`onMount` (design/
// SOLID-CONVENTIONS.md's "removed in 2.0" list, confirmed against the real
// package -- its 2.0 data story is a bigger rework, `action`/`Loading`/
// `Errored` boundaries, not needed for this small a site). This is the
// minimal fetch-on-change primitive every page here needs instead, built on
// the split-effect shape rule 8a/8b requires: `compute` reads the reactive
// source (establishing the dependency), `apply` does the actual async work
// and returns its own cleanup (a stale in-flight request is marked
// cancelled so it can never clobber a NEWER request's result -- the same
// race `<For>`/`<Show>` would otherwise render a flash of).
import { createEffect, createSignal } from "solid-js";

export interface AsyncState<T> {
  data: () => T | undefined;
  loading: () => boolean;
  error: () => boolean;
}

export function createAsync<S, T>(source: () => S, fetcher: (s: S) => Promise<T>): AsyncState<T> {
  const [data, setData] = createSignal<T | undefined>(undefined);
  const [loading, setLoading] = createSignal(true);
  const [error, setError] = createSignal(false);

  createEffect(
    () => source(),
    (s) => {
      let cancelled = false;
      setLoading(true);
      setError(false);
      fetcher(s).then(
        (result) => {
          if (cancelled) return;
          setData(() => result);
          setLoading(false);
        },
        () => {
          if (cancelled) return;
          setError(true);
          setLoading(false);
        },
      );
      return () => {
        cancelled = true;
      };
    },
  );

  return { data, loading, error };
}
