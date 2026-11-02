// Fault injection around ANY CommitLog (the DynamoDB log under the lab server
// and the fuzzer): the same four failures MemoryLog injects natively, drawn
// from a seeded stream. Nothing is ever applied by an injected conflict,
// throttle or timeout-before; timeout-after applies the append and then throws.
import { AmbiguousAppendError, LogThrottledError, type CommitLog } from "./log";
import { seededRandom, type MemoryLogFaults } from "./log-memory";

export function withLogFaults(inner: CommitLog, faults: MemoryLogFaults): CommitLog & { readonly injected: { conflicts: number; throttles: number; timeoutsBefore: number; timeoutsAfter: number } } {
  const rng = seededRandom(faults.seed ?? 1);
  const injected = { conflicts: 0, throttles: 0, timeoutsBefore: 0, timeoutsAfter: 0 };
  const throttle = (): void => {
    if ((faults.throttle ?? 0) > 0 && rng() < (faults.throttle ?? 0)) {
      injected.throttles++;
      throw new LogThrottledError("injected throttle");
    }
  };
  return {
    injected,
    async head() {
      throttle();
      return inner.head();
    },
    async read(a, b) {
      throttle();
      return inner.read(a, b);
    },
    async get(s) {
      throttle();
      return inner.get(s);
    },
    async append(expectedHead, entry) {
      const r = rng();
      let edge = faults.throttle ?? 0;
      if (r < edge) {
        injected.throttles++;
        throw new LogThrottledError("injected throttle");
      }
      edge += faults.conflict ?? 0;
      if (r < edge) {
        injected.conflicts++;
        return "conflict";
      }
      edge += faults.timeoutBefore ?? 0;
      if (r < edge) {
        injected.timeoutsBefore++;
        throw new AmbiguousAppendError("injected timeout before the commit");
      }
      edge += faults.timeoutAfter ?? 0;
      const out = await inner.append(expectedHead, entry);
      if (r < edge) {
        injected.timeoutsAfter++;
        throw new AmbiguousAppendError("injected timeout after the commit");
      }
      return out;
    },
  };
}
