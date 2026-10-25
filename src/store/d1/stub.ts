// A placeholder area implementation for P1: every method throws until the
// owning agent replaces the file's factory with the real D1 code.
export function notImplemented<T extends object>(agent: string, area: string): T {
  return new Proxy({} as T, {
    get(_target, prop) {
      if (typeof prop === "symbol" || prop === "then") return undefined;
      return () => {
        throw new Error(`store/d1 ${area}.${prop} is not implemented yet (P1 agent ${agent})`);
      };
    },
  });
}
