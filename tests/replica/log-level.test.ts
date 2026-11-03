// [LDB-RP9] Report lines carry their level: `akldb-alarm:` lines at ERROR, every healthy line (`akldb-boot:`,
// `akldb-cold:`, `akldb-snapshot:`, `akldb-retention:`, `akldb-proof:`, `akldb-seed:`, ...) at INFO. In Lambda's JSON log
// format the level is the console method; staging showed healthy boot/cold lines arriving as ERROR (2026-11-03).
import { afterEach, describe, expect, it, vi } from "vitest";
import { ALARM_PREFIX, alarmLine, logByLevel } from "../../src/replica/alarm";
import { consoleLog } from "../../src/replica/snapshot";

afterEach(() => vi.restoreAllMocks());

function levels(fn: (line: string) => void, line: string): { error: number; info: number; log: number; warn: number } {
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  const info = vi.spyOn(console, "info").mockImplementation(() => {});
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  fn(line);
  const out = { error: error.mock.calls.length, info: info.mock.calls.length, log: log.mock.calls.length, warn: warn.mock.calls.length };
  vi.restoreAllMocks();
  return out;
}

const HEALTHY = [
  "akldb-boot: path=pointer seq=120 ms=310",
  "akldb-cold: first=GET /v1/meta initMs=218 requestMs=352",
  "akldb-snapshot: slot=2 seq=120 bytes=4900000 compressMs=2800",
  "akldb-retention: anchor=daily/07 expired=0",
  "akldb-proof: equal seq=120",
  "akldb-seed: ok seq=49132",
];

describe("log level per prefix", () => {
  for (const sink of [logByLevel, consoleLog]) {
    it(`[LDB-RP9] ${sink === logByLevel ? "logByLevel" : "consoleLog (the replica default)"}: healthy lines go to INFO, never ERROR`, () => {
      for (const line of HEALTHY) expect(levels(sink, line), line).toEqual({ error: 0, info: 1, log: 0, warn: 0 });
    });

    it(`[LDB-RP9] ${sink === logByLevel ? "logByLevel" : "consoleLog (the replica default)"}: an akldb-alarm line goes to ERROR, once`, () => {
      const line = alarmLine("boot", "POINTER failed verification; trying PREV");
      expect(line.startsWith(ALARM_PREFIX)).toBe(true);
      expect(levels(sink, line)).toEqual({ error: 1, info: 0, log: 0, warn: 0 });
    });
  }
});
