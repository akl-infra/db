// check_name (09 §2.4): the bot's util/layout.check_name (a5b0fe35^) ported
// rule for rule, in the bot's own order, plus two rules of ours after it.
// Applied by POST and rename (PATCH {name}) only -- imported and tombstone
// names are never checked (LDB-I5). Pure and total: never throws, one
// answer per input.
import { isUlidShaped } from "./records";

const MIN_LENGTH = 3;
const MAX_LENGTH = 64;

// The bot's NAME_SET (util/consts.py) minus the space (09 §0.1: the bot
// splits args on whitespace, so a name containing one is unreachable
// through it, and 0.1 measured none in the live corpus).
const ALLOWED_CHAR = /^[A-Za-z0-9_'()\-:~]$/;

export type NameCheck = { ok: true } | { ok: false; message: string };

export function checkName(name: string): NameCheck {
  if (name.startsWith("_")) {
    return { ok: false, message: "names cannot start with an underscore" };
  }
  if (name.length < MIN_LENGTH) {
    return { ok: false, message: "names must be at least 3 characters long" };
  }
  // First offending character in string order (deterministic; the bot's own
  // `set` iteration order is unspecified -- 09 §2.4).
  for (const c of name) {
    if (!ALLOWED_CHAR.test(c)) {
      return { ok: false, message: `names cannot contain \`${c}\`` };
    }
  }
  if (name.length > MAX_LENGTH) {
    return { ok: false, message: "names must be at most 64 characters long" };
  }
  if (isUlidShaped(name)) {
    return { ok: false, message: "names cannot look like a layout id" };
  }
  return { ok: true };
}
